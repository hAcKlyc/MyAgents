//! One-shot operator controller using the production authenticated TLS owner.
use crate::connector::catalog_ack;
use crate::{
    agent_network::{
        connection::{initial_hello, send},
        identity::NetworkIdentity,
        management_controller::{self, ManagementRequest, ManagementResponse},
        memory::MemoryBudget,
        owned_admission, owned_profile,
        pairs::Pairs,
        policy,
        transport::{NetworkRoute, NetworkSocket, NetworkTransport},
        NetworkError,
    },
    connector,
    owned::Connection,
};
use futures_util::{SinkExt, StreamExt};
use myagents_agent_network_protocol::{
    ClientMessage, ConnectionScope, DeviceScope, ServerEnvelope, ServerMessage,
};
use myagents_host_management_protocol::{CanonicalUuid, ManagementMethod, PeerRole, RequestParams};
use serde::Deserialize;
use std::{
    fs::File,
    io::Read,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    },
    path::Path,
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};
use tokio_tungstenite::tungstenite::Message;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    device_id: String,
    target_scope: Option<DeviceScope>,
    method: ManagementMethod,
    params: RequestParams,
}
fn read_request(path: &Path) -> Result<Input, NetworkError> {
    let fail = || NetworkError::new("HOST_MANAGEMENT_INPUT_INVALID");
    if !path.is_absolute() {
        return Err(fail());
    }
    // Anchor every component so a symlinked parent cannot redirect this read.
    let mut directory = File::open("/").map_err(|_| fail())?;
    let components: Vec<_> = path.components().skip(1).collect();
    let mut file = None;
    for (index, component) in components.iter().enumerate() {
        let std::path::Component::Normal(name) = component else {
            return Err(fail());
        };
        use std::os::unix::ffi::OsStrExt;
        let name = std::ffi::CString::new(name.as_bytes()).map_err(|_| fail())?;
        let last = index + 1 == components.len();
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | libc::O_CLOEXEC
            | if last { 0 } else { libc::O_DIRECTORY };
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(fail());
        }
        let opened = unsafe { File::from_raw_fd(fd) };
        if last {
            file = Some(opened);
        } else {
            directory = opened;
        }
    }
    let mut file = file.ok_or_else(fail)?;
    let meta = file.metadata().map_err(|_| fail())?;
    if !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o7777 != 0o600
        || meta.nlink() != 1
        || meta.len() > 65536
    {
        return Err(fail());
    }
    let mut bytes = zeroize::Zeroizing::new(Vec::new());
    file.by_ref()
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| fail())?;
    if bytes.len() > 65536 {
        return Err(fail());
    }
    let input: Input = serde_json::from_slice(&bytes).map_err(|_| fail())?;
    if uuid::Uuid::parse_str(&input.device_id)
        .map(|id| id.to_string())
        .as_deref()
        != Ok(input.device_id.as_str())
    {
        return Err(fail());
    }
    // Validate the closed method/params and target requirement before any network IO.
    make_request(input, "local".into(), "local".into(), "local".into()).and_then(|request| {
        request
            .message(CanonicalUuid::new(uuid::Uuid::new_v4()))
            .map(|_| Input {
                device_id: request.device_id,
                target_scope: request.target_scope,
                method: request.method,
                params: request.params,
            })
    })
}
fn make_request(
    input: Input,
    connection_id: String,
    principal_id: String,
    network_id: String,
) -> Result<ManagementRequest, NetworkError> {
    // This one-shot owner has one local generation. The actual encrypted account
    // binding and its ensure_current CAS guard fence every network operation.
    Ok(ManagementRequest {
        connection_id,
        auth_generation: 0,
        principal_id,
        network_id,
        device_id: input.device_id,
        target_scope: input.target_scope,
        method: input.method,
        params: input.params,
    })
}
fn require_empty_source(empty: bool) -> Result<(), NetworkError> {
    if empty {
        Ok(())
    } else {
        Err(NetworkError::new("SOURCE_CATALOG_NOT_EMPTY"))
    }
}
async fn ready(
    socket: &mut NetworkSocket,
    transport: &NetworkTransport,
    identity: &NetworkIdentity,
) -> Result<(ConnectionScope, DeviceScope), NetworkError> {
    send(
        socket,
        ClientMessage::Hello {
            client_version: env!("CARGO_PKG_VERSION").into(),
            capabilities: vec!["tls13-mtls".into()],
            previous_connection: None,
        },
    )
    .await?;
    let (scope, local, _) = initial_hello(socket, identity).await?;
    // Self preservation is live-epoch authenticated but deliberately does not
    // require the new catalog ACK or public directory Ready state.
    require_empty_source(transport.catalog_self_preservation(&identity.token).await?)?;
    let ack = transport
        .json(
            NetworkRoute::Catalog,
            &identity.token,
            Some(connector::empty_catalog(scope.connection_epoch.clone())?),
        )
        .await?;
    catalog_ack::validate_catalog_ack(&ack, &scope.connection_epoch, 1)
        .map_err(|_| NetworkError::new("CATALOG_INVALID"))?;
    let hydrated = policy::hydrate_owned(transport, &identity.token, &local).await?;
    if !hydrated.joined {
        return Err(NetworkError::new("OWNED_MEMBERSHIP_REQUIRED"));
    }
    send(
        socket,
        ClientMessage::Ready {
            scope: scope.clone(),
            catalog_seq: 1,
        },
    )
    .await?;
    for _ in 0..256 {
        identity.account.ensure_current()?;
        match socket.next().await {
            Some(Ok(Message::Ping(bytes))) => socket
                .send(Message::Pong(bytes))
                .await
                .map_err(|_| NetworkError::new("NETWORK_CONNECTION_CLOSED"))?,
            Some(Ok(Message::Pong(_))) => {}
            Some(Ok(Message::Text(text))) if text == "ma-network-pong" => {}
            Some(Ok(Message::Text(text))) => {
                let envelope = ServerEnvelope::parse(text.as_bytes())
                    .map_err(|_| NetworkError::new("CONTROL_INVALID"))?;
                owned_profile::control(&envelope.message)?;
                connector::control_gate(&envelope.message, &scope, true, true)?;
                match envelope.message {
                    ServerMessage::Ready { catalog_seq: 1, .. } => return Ok((scope, local)),
                    ServerMessage::Changed { .. } => {
                        if !policy::hydrate_owned(transport, &identity.token, &local)
                            .await?
                            .joined
                        {
                            return Err(NetworkError::new("OWNED_MEMBERSHIP_REQUIRED"));
                        }
                    }
                    ServerMessage::ChannelOffer { channel_id, .. } => {
                        send(
                            socket,
                            ClientMessage::Close {
                                scope: scope.clone(),
                                channel_id,
                                reason: "TARGET_UNAVAILABLE".into(),
                            },
                        )
                        .await?;
                    }
                    ServerMessage::Error { code, .. } => {
                        return Err(NetworkError::cloud(&code, 400))
                    }
                    _ => return Err(NetworkError::new("CONTROL_UNEXPECTED")),
                }
            }
            _ => return Err(NetworkError::new("NETWORK_CONNECTION_CLOSED")),
        }
    }
    Err(NetworkError::new("HOST_MANAGEMENT_CAPACITY"))
}
pub(crate) async fn run(
    connection: &Connection,
    path: &Path,
) -> Result<ManagementResponse, NetworkError> {
    let input = read_request(path)?;
    let setup = async {
        let account = connection.account(false).await?;
        let request = make_request(
            input,
            account.binding_id().into(),
            account.principal_id()?.into(),
            connection.instance.network_id.clone(),
        )?;
        let identity =
            NetworkIdentity::initialize_with_store(account, None, connection.owner.store.clone())
                .await?;
        let memory = MemoryBudget::default();
        let transport = NetworkTransport::new_with_public_ca(
            &identity.network_url,
            identity.device_key(),
            memory.clone(),
            identity.account.public_tls_ca(),
        )?;
        owned_admission::enroll(&identity, &transport, false).await?;
        let socket = transport.websocket(&identity.token).await?;
        Ok::<_, NetworkError>((request, identity, memory, transport, socket))
    };
    let (request, identity, memory, transport, mut socket) =
        tokio::time::timeout(Duration::from_secs(60), setup)
            .await
            .map_err(|_| NetworkError::new("HOST_MANAGEMENT_NOT_COMPLETED"))??;
    let result = async {
        let (scope, local) = tokio::time::timeout(
            Duration::from_secs(30),
            ready(&mut socket, &transport, &identity),
        )
        .await
        .map_err(|_| NetworkError::new("HOST_MANAGEMENT_NOT_COMPLETED"))??;
        identity.account.ensure_current()?;
        let mut pairs = Pairs::new_management(memory, PeerRole::Controller);
        management_controller::execute(
            &mut socket,
            &transport,
            &identity,
            &local,
            &scope,
            &mut pairs,
            &request,
            Arc::new(AtomicBool::new(false)),
        )
        .await
    }
    .await;
    let _ = tokio::time::timeout(Duration::from_secs(1), socket.close(None)).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    fn valid() -> String {
        serde_json::json!({"deviceId":uuid::Uuid::new_v4().to_string(),"targetScope":null,"method":"host.snapshot","params":{}}).to_string()
    }
    #[test]
    fn private_request_rejects_symlink_permissions_hardlinks_and_unknown_authority() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let path = root.join("request");
        std::fs::write(&path, valid()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(read_request(&path).is_ok());
        let link = root.join("link");
        symlink(&path, &link).unwrap();
        assert!(read_request(&link).is_err());
        let parent = root.join("alias");
        symlink(&root, &parent).unwrap();
        assert!(read_request(&parent.join("request")).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        assert!(read_request(&path).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::hard_link(&path, root.join("hard")).unwrap();
        assert!(read_request(&path).is_err());
    }
    #[test]
    fn closed_input_rejects_locators_duplicate_keys_and_unscoped_receipts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let path = root.join("request");
        for body in [valid().replace("\"params\":{}","\"params\":{},\"connectionId\":\"foreign\""),valid().replace("\"targetScope\":null","\"targetScope\":null,\"targetScope\":null"),serde_json::json!({"deviceId":uuid::Uuid::new_v4().to_string(),"targetScope":null,"method":"receipt.get","params":{"owner":"config","mutationId":uuid::Uuid::new_v4().to_string()}}).to_string(),"x".repeat(65537)] {
      std::fs::write(&path,body).unwrap();std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o600)).unwrap();assert!(read_request(&path).is_err());
    }
    }
    #[test]
    fn owner_constructs_locator_and_uses_original_target_scope() {
        let input: Input = serde_json::from_str(&valid()).unwrap();
        let request = make_request(
            input,
            "actual-binding".into(),
            "actual-principal".into(),
            "actual-network".into(),
        )
        .unwrap();
        assert_eq!(request.connection_id, "actual-binding");
        assert_eq!(request.principal_id, "actual-principal");
        assert_eq!(request.network_id, "actual-network");
        assert_eq!(request.auth_generation, 0);
        assert!(request.target_scope.is_none());
        assert!(request
            .message(CanonicalUuid::new(uuid::Uuid::new_v4()))
            .is_ok());
    }
    #[test]
    fn preservation_must_explicitly_prove_empty_before_put() {
        assert!(require_empty_source(true).is_ok());
        assert_eq!(
            require_empty_source(false).unwrap_err().code,
            "SOURCE_CATALOG_NOT_EMPTY"
        );
    }
}
