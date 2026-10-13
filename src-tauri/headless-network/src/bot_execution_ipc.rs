//! Independent finite-Bot reverse Unix IPC. The Node peer never receives cloud
//! credentials. The listener accepts exactly the configured non-root Node UID.
use crate::agent_network::NetworkError;
use myagents_agentnet_execution_core::{
    BotSnapshot, ExecutionScope, HostContext, HostObservation, Receipt, ReceiptStatus,
    MAX_SAFE_INTEGER,
};
use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "linux", test))]
use std::os::unix::fs::PermissionsExt;
use std::{
    fs,
    os::unix::{
        ffi::OsStrExt,
        fs::{FileTypeExt, MetadataExt},
    },
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
#[cfg(any(target_os = "linux", test))]
use tokio::net::UnixListener;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
    sync::{watch, Mutex, Notify},
};

pub(crate) const NAMESPACE: &str = "moxbot.bot.execution.ipc/v1";
pub(crate) const MAX_FRAME: usize = 1024 * 1024;
const IPC_TIMEOUT: Duration = Duration::from_secs(30);
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ContextBase {
    pub local_auth_generation: u64,
    pub boot_epoch: String,
    pub connection_epoch: String,
    pub membership_revision: u64,
}
impl ContextBase {
    pub fn validate(&self) -> Result<(), NetworkError> {
        self.with_nonce(uuid::Uuid::nil().to_string())
            .validate()
            .map_err(|_| error("BOT_EXECUTION_CONTEXT_INVALID"))
    }
    pub fn with_nonce(&self, challenge_nonce: String) -> HostContext {
        HostContext {
            challenge_nonce,
            local_auth_generation: self.local_auth_generation,
            boot_epoch: self.boot_epoch.clone(),
            connection_epoch: self.connection_epoch.clone(),
            membership_revision: self.membership_revision,
        }
    }
    pub fn matches(&self, c: &HostContext) -> bool {
        c.local_auth_generation == self.local_auth_generation
            && c.boot_epoch == self.boot_epoch
            && c.connection_epoch == self.connection_epoch
            && c.membership_revision == self.membership_revision
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum InvalidationReason {
    ConnectionClosed,
    AccountChanged,
    MembershipChanged,
    LeaseExpired,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum RequestPayload {
    PendingReceipts {},
    AckReceipt {
        lease_id: String,
        mutation_id: String,
        request_hash: String,
    },
    Status {},
    Context {
        scope: ExecutionScope,
        host_context: ContextBase,
    },
    Grant {
        token: String,
    },
    Execute {
        intent_token: String,
        lease_token: String,
    },
    Revoke {
        revocation_token: String,
        grant_id: String,
        bot_id: String,
        revoked_generation: u64,
    },
    Invalidate {
        reason: InvalidationReason,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum ResponsePayload {
    PendingReceipts { receipts: Vec<PendingReceipt> },
    ReceiptAck { lease_id: String },
    Status { observation: HostObservation },
    Challenge { host_context: HostContext },
    Grant { grant_id: String, generation: u64 },
    Receipt { receipt: Receipt },
    Snapshot { snapshot: BotSnapshot },
    Invalidated {},
    Error { code: String },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PendingReceipt {
    pub lease_id: String,
    pub mutation_id: String,
    pub request_hash: String,
    pub receipt: Receipt,
}
impl PendingReceipt {
    pub(crate) fn validate(&self) -> bool {
        uuid(&self.lease_id)
            && self.mutation_id == self.receipt.mutation_id
            && self.request_hash == self.receipt.request_hash
            && self.receipt.validate().is_ok()
            && self.receipt.status != ReceiptStatus::Unconfirmed
            && (self.receipt.status != ReceiptStatus::Persisted || self.receipt.snapshot.is_some())
    }
}
#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct RequestFrame<'a> {
    namespace: &'static str,
    version: u8,
    request_id: &'a str,
    payload: &'a RequestPayload,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResponseFrame {
    namespace: String,
    version: u8,
    request_id: String,
    payload: ResponsePayload,
}
fn error(code: &'static str) -> NetworkError {
    NetworkError::new(code)
}
fn uuid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok_and(|v| v.to_string() == s)
}
fn safe_code(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}
fn validate_request(r: &RequestPayload) -> Result<(), NetworkError> {
    let proof = |s: &str| {
        !s.is_empty()
            && s.len() <= 128 * 1024
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    };
    let valid = match r {
        RequestPayload::Context {
            scope,
            host_context,
        } => {
            scope
                .validate()
                .map_err(|_| error("BOT_EXECUTION_IPC_REQUEST_INVALID"))?;
            host_context.validate()?;
            true
        }
        RequestPayload::Grant { token } => proof(token),
        RequestPayload::Execute {
            intent_token,
            lease_token,
        } => proof(intent_token) && proof(lease_token),
        RequestPayload::Revoke {
            revocation_token,
            grant_id,
            bot_id,
            revoked_generation,
        } => {
            proof(revocation_token)
                && uuid(grant_id)
                && uuid(bot_id)
                && *revoked_generation > 0
                && *revoked_generation <= MAX_SAFE_INTEGER
        }
        RequestPayload::AckReceipt {
            lease_id,
            mutation_id,
            request_hash,
        } => {
            uuid(lease_id)
                && uuid(mutation_id)
                && request_hash.len() == 64
                && request_hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }
        RequestPayload::Invalidate { .. }
        | RequestPayload::Status {}
        | RequestPayload::PendingReceipts {} => true,
    };
    if valid {
        Ok(())
    } else {
        Err(error("BOT_EXECUTION_IPC_REQUEST_INVALID"))
    }
}
fn decode_response(
    bytes: &[u8],
    id: &str,
    request: &RequestPayload,
) -> Result<ResponsePayload, NetworkError> {
    let frame: ResponseFrame =
        serde_json::from_slice(bytes).map_err(|_| error("BOT_EXECUTION_IPC_RESPONSE_INVALID"))?;
    if frame.namespace != NAMESPACE || frame.version != 1 || frame.request_id != id {
        return Err(error("BOT_EXECUTION_IPC_RESPONSE_INVALID"));
    }
    let valid = match (request, &frame.payload) {
        (_, ResponsePayload::Error { code }) => safe_code(code),
        (
            RequestPayload::Context { host_context, .. },
            ResponsePayload::Challenge {
                host_context: received,
            },
        ) => received.validate().is_ok() && host_context.matches(received),
        (
            RequestPayload::Grant { .. },
            ResponsePayload::Grant {
                grant_id,
                generation,
            },
        ) => uuid(grant_id) && *generation > 0 && *generation <= MAX_SAFE_INTEGER,
        (RequestPayload::Execute { .. }, ResponsePayload::Receipt { receipt }) => {
            receipt.validate().is_ok()
        }
        (RequestPayload::Revoke { bot_id, .. }, ResponsePayload::Snapshot { snapshot }) => {
            snapshot.validate().is_ok() && snapshot.bot_id == *bot_id
        }
        (RequestPayload::Invalidate { .. }, ResponsePayload::Invalidated {}) => true,
        (RequestPayload::Status {}, ResponsePayload::Status { observation }) => {
            observation.validate().is_ok()
        }
        (RequestPayload::PendingReceipts {}, ResponsePayload::PendingReceipts { receipts }) => {
            receipts.len() <= 64
                && receipts.iter().all(PendingReceipt::validate)
                && receipts
                    .iter()
                    .map(|r| &r.lease_id)
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    == receipts.len()
        }
        (
            RequestPayload::AckReceipt { lease_id, .. },
            ResponsePayload::ReceiptAck { lease_id: received },
        ) => lease_id == received,
        _ => false,
    };
    if !valid {
        return Err(error("BOT_EXECUTION_IPC_RESPONSE_INVALID"));
    }
    if let ResponsePayload::Error { code } = &frame.payload {
        let _ = code;
        return Err(error("BOT_EXECUTION_NODE_REJECTED"));
    }
    Ok(frame.payload)
}

#[derive(Clone)]
pub(crate) struct BotExecutionIpcConfig {
    pub socket: PathBuf,
    pub node_uid: u32,
    pub ipc_gid: u32,
}
struct RequestSlot<'a> {
    slot: tokio::sync::MutexGuard<'a, Option<UnixStream>>,
    keep_alive: bool,
}
impl Drop for RequestSlot<'_> {
    fn drop(&mut self) {
        if !self.keep_alive {
            *self.slot = None;
        }
    }
}
pub(crate) struct BotExecutionIpc {
    socket: PathBuf,
    dev: u64,
    ino: u64,
    node_uid: u32,
    ipc_gid: u32,
    connection: Arc<Mutex<Option<UnixStream>>>,
    notify: Arc<Notify>,
    accept: tokio::task::JoinHandle<()>,
    cancel: watch::Sender<u64>,
}
fn validate_parent(path: &Path, gid: u32) -> Result<(), NetworkError> {
    if !path.is_absolute()
        || path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
        || path.as_os_str().as_bytes().len() > 4096
    {
        return Err(error("BOT_EXECUTION_IPC_PATH_INVALID"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| error("BOT_EXECUTION_IPC_PATH_INVALID"))?;
    if parent
        .canonicalize()
        .map_err(|_| error("BOT_EXECUTION_IPC_PATH_INVALID"))?
        != parent
    {
        return Err(error("BOT_EXECUTION_IPC_PATH_INVALID"));
    }
    let uid = unsafe { libc::geteuid() };
    let mut current = PathBuf::from("/");
    for c in parent.components().skip(1) {
        current.push(c);
        let m =
            fs::symlink_metadata(&current).map_err(|_| error("BOT_EXECUTION_IPC_PATH_INVALID"))?;
        if !m.is_dir()
            || m.file_type().is_symlink()
            || m.mode() & 0o022 != 0
            || (m.uid() != 0 && m.uid() != uid)
        {
            return Err(error("BOT_EXECUTION_IPC_PATH_INVALID"));
        }
    }
    let m = fs::symlink_metadata(parent).map_err(|_| error("BOT_EXECUTION_IPC_PATH_INVALID"))?;
    if m.uid() != uid || m.gid() != gid || m.mode() & 0o777 != 0o750 {
        return Err(error("BOT_EXECUTION_IPC_PATH_INVALID"));
    }
    Ok(())
}
impl BotExecutionIpc {
    pub(crate) fn bind(config: &BotExecutionIpcConfig) -> Result<Self, NetworkError> {
        #[cfg(not(target_os = "linux"))]
        {
            validate_parent(&config.socket, config.ipc_gid)?;
            if config.node_uid == 0 {
                return Err(error("BOT_EXECUTION_IPC_IDENTITY_INVALID"));
            }
            Err(error("BOT_EXECUTION_IPC_LINUX_REQUIRED"))
        }
        #[cfg(target_os = "linux")]
        {
            Self::bind_inner(config, false)
        }
    }
    #[cfg(any(target_os = "linux", test))]
    fn bind_inner(
        config: &BotExecutionIpcConfig,
        test_same_uid: bool,
    ) -> Result<Self, NetworkError> {
        // This standalone headless crate does not use Tauri's global runtime.
        // Check the caller runtime before creating filesystem state; missing
        // context must be a closed error rather than a spawn panic.
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| error("BOT_EXECUTION_IPC_RUNTIME_REQUIRED"))?;
        let uid = unsafe { libc::geteuid() };
        if uid == 0
            || config.node_uid == 0
            || config.ipc_gid == 0
            || (!test_same_uid && config.node_uid == uid)
        {
            return Err(error("BOT_EXECUTION_IPC_IDENTITY_INVALID"));
        }
        validate_parent(&config.socket, config.ipc_gid)?;
        if fs::symlink_metadata(&config.socket).is_ok() {
            return Err(error("BOT_EXECUTION_IPC_PATH_EXISTS"));
        }
        let listener = UnixListener::bind(&config.socket)
            .map_err(|_| error("BOT_EXECUTION_IPC_BIND_FAILED"))?;
        let original = fs::symlink_metadata(&config.socket)
            .map_err(|_| error("BOT_EXECUTION_IPC_PATH_INVALID"))?;
        let path = std::ffi::CString::new(config.socket.as_os_str().as_bytes())
            .map_err(|_| error("BOT_EXECUTION_IPC_PATH_INVALID"))?;
        let result = unsafe { libc::lchown(path.as_ptr(), uid, config.ipc_gid) };
        if result != 0 {
            remove_owned(&config.socket, original.dev(), original.ino());
            return Err(error("BOT_EXECUTION_IPC_PATH_INVALID"));
        }
        if fs::set_permissions(&config.socket, fs::Permissions::from_mode(0o660)).is_err() {
            remove_owned(&config.socket, original.dev(), original.ino());
            return Err(error("BOT_EXECUTION_IPC_PATH_INVALID"));
        }
        let current = fs::symlink_metadata(&config.socket)
            .map_err(|_| error("BOT_EXECUTION_IPC_PATH_INVALID"))?;
        if current.dev() != original.dev()
            || current.ino() != original.ino()
            || !current.file_type().is_socket()
            || current.uid() != uid
            || current.gid() != config.ipc_gid
            || current.nlink() != 1
            || current.mode() & 0o777 != 0o660
        {
            remove_owned(&config.socket, original.dev(), original.ino());
            return Err(error("BOT_EXECUTION_IPC_PATH_INVALID"));
        }
        let connection = Arc::new(Mutex::new(None));
        let notify = Arc::new(Notify::new());
        let slot = connection.clone();
        let wake = notify.clone();
        let expected = config.node_uid;
        let accept = runtime.spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                if stream.peer_cred().map(|c| c.uid()).ok() != Some(expected) {
                    continue;
                }
                if let Ok(mut guard) = slot.try_lock() {
                    if guard.is_none() {
                        *guard = Some(stream);
                        wake.notify_one();
                    }
                }
            }
        });
        let (cancel, _) = watch::channel(0u64);
        Ok(Self {
            socket: config.socket.clone(),
            dev: current.dev(),
            ino: current.ino(),
            node_uid: config.node_uid,
            ipc_gid: config.ipc_gid,
            connection,
            notify,
            accept,
            cancel,
        })
    }
    fn verify_inode(&self) -> Result<(), NetworkError> {
        validate_parent(&self.socket, self.ipc_gid)?;
        let m = fs::symlink_metadata(&self.socket)
            .map_err(|_| error("BOT_EXECUTION_IPC_PATH_INVALID"))?;
        if !m.file_type().is_socket()
            || m.dev() != self.dev
            || m.ino() != self.ino
            || m.nlink() != 1
            || m.uid() != unsafe { libc::geteuid() }
            || m.gid() != self.ipc_gid
            || m.mode() & 0o777 != 0o660
        {
            return Err(error("BOT_EXECUTION_IPC_PATH_INVALID"));
        }
        Ok(())
    }
    pub(crate) fn cancel_pending(&self) {
        self.cancel.send_modify(|g| *g = g.wrapping_add(1));
        if let Ok(mut slot) = self.connection.try_lock() {
            *slot = None;
        }
    }
    pub(crate) async fn request(
        &self,
        request: RequestPayload,
    ) -> Result<ResponsePayload, NetworkError> {
        self.request_timeout(request, IPC_TIMEOUT).await
    }
    async fn request_timeout(
        &self,
        request: RequestPayload,
        timeout: Duration,
    ) -> Result<ResponsePayload, NetworkError> {
        let mut cancelled = self.cancel.subscribe();
        self.verify_inode()?;
        validate_request(&request)?;
        let id = uuid::Uuid::new_v4().to_string();
        let payload = serde_json::to_vec(&RequestFrame {
            namespace: NAMESPACE,
            version: 1,
            request_id: &id,
            payload: &request,
        })
        .map_err(|_| error("BOT_EXECUTION_IPC_REQUEST_INVALID"))?;
        if payload.is_empty() || payload.len() > MAX_FRAME {
            return Err(error("BOT_EXECUTION_IPC_REQUEST_TOO_LARGE"));
        }
        let wait = tokio::time::timeout(timeout, async {
            loop {
                let wake = self.notify.notified();
                let guard = self.connection.lock().await;
                if guard.is_some() {
                    break guard;
                }
                drop(guard);
                wake.await;
            }
        });
        let mut slot = tokio::select! {
            r=wait=>r.map_err(|_|error("BOT_EXECUTION_IPC_UNAVAILABLE"))?,
            _=cancelled.changed()=>return Err(error("BOT_EXECUTION_CONTEXT_INVALIDATED")),
        };
        if cancelled.has_changed().unwrap_or(true) {
            *slot = None;
            return Err(error("BOT_EXECUTION_CONTEXT_INVALIDATED"));
        }
        let mut slot = RequestSlot {
            slot,
            keep_alive: false,
        };
        let stream = slot
            .slot
            .as_mut()
            .ok_or_else(|| error("BOT_EXECUTION_IPC_UNAVAILABLE"))?;
        let op = async {
            self.verify_inode()?;
            if stream.peer_cred().map(|c| c.uid()).ok() != Some(self.node_uid) {
                return Err(error("BOT_EXECUTION_IPC_PEER_REJECTED"));
            }
            stream
                .write_all(&(payload.len() as u32).to_be_bytes())
                .await
                .map_err(|_| error("BOT_EXECUTION_IPC_UNCONFIRMED"))?;
            stream
                .write_all(&payload)
                .await
                .map_err(|_| error("BOT_EXECUTION_IPC_UNCONFIRMED"))?;
            let mut prefix = [0u8; 4];
            stream
                .read_exact(&mut prefix)
                .await
                .map_err(|_| error("BOT_EXECUTION_IPC_UNCONFIRMED"))?;
            let len = u32::from_be_bytes(prefix) as usize;
            if len == 0 || len > MAX_FRAME {
                return Err(error("BOT_EXECUTION_IPC_RESPONSE_TOO_LARGE"));
            }
            let mut bytes = vec![0; len];
            stream
                .read_exact(&mut bytes)
                .await
                .map_err(|_| error("BOT_EXECUTION_IPC_UNCONFIRMED"))?;
            self.verify_inode()?;
            decode_response(&bytes, &id, &request)
        };
        let result = tokio::select! {r=tokio::time::timeout(timeout,op)=>r.unwrap_or_else(|_|Err(error("BOT_EXECUTION_IPC_UNCONFIRMED"))),_=cancelled.changed()=>Err(error("BOT_EXECUTION_CONTEXT_INVALIDATED"))};
        if result.is_ok() {
            slot.keep_alive = true;
        }
        result
    }
}
fn remove_owned(path: &Path, dev: u64, ino: u64) {
    if let Ok(m) = fs::symlink_metadata(path) {
        if m.file_type().is_socket() && m.dev() == dev && m.ino() == ino {
            let _ = fs::remove_file(path);
        }
    }
}
impl Drop for BotExecutionIpc {
    fn drop(&mut self) {
        self.accept.abort();
        remove_owned(&self.socket, self.dev, self.ino);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn context() -> ContextBase {
        ContextBase {
            local_auth_generation: 1,
            boot_epoch: uuid::Uuid::new_v4().to_string(),
            connection_epoch: uuid::Uuid::new_v4().to_string(),
            membership_revision: 1,
        }
    }
    fn endpoint() -> (tempfile::TempDir, BotExecutionIpcConfig) {
        let home = PathBuf::from(std::env::var_os("HOME").unwrap())
            .canonicalize()
            .unwrap();
        let dir = tempfile::Builder::new()
            .prefix("finite-ipc-")
            .tempdir_in(home)
            .unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o750)).unwrap();
        let m = fs::metadata(dir.path()).unwrap();
        let config = BotExecutionIpcConfig {
            socket: dir.path().join("finite.sock"),
            node_uid: unsafe { libc::geteuid() },
            ipc_gid: m.gid(),
        };
        (dir, config)
    }
    #[test]
    fn status_is_a_closed_finite_namespace_report() {
        let f: serde_json::Value = serde_json::from_str(include_str!(
            "../../../services/agentnet/execution-core/fixtures/wire-v1.json"
        ))
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let request = RequestPayload::Status {};
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            serde_json::json!({"method":"status"})
        );
        let mut response = serde_json::json!({"namespace":NAMESPACE,"version":1,"request_id":id,"payload":{"method":"status","observation":f["observation"]}});
        assert!(decode_response(&serde_json::to_vec(&response).unwrap(), &id, &request).is_ok());
        response["payload"]["observation"]["remote_enabled"] = serde_json::json!(true);
        assert!(decode_response(&serde_json::to_vec(&response).unwrap(), &id, &request).is_err());
    }
    #[test]
    fn listener_without_runtime_fails_before_creating_socket() {
        let (_dir, cfg) = endpoint();
        assert!(matches!(
            BotExecutionIpc::bind_inner(&cfg, true),
            Err(e) if e.code == "BOT_EXECUTION_IPC_RUNTIME_REQUIRED"
        ));
        assert!(!cfg.socket.exists());
    }
    #[test]
    fn closed_namespace_context_and_response_correlation() {
        let base = context();
        let req = RequestPayload::Invalidate {
            reason: InvalidationReason::ConnectionClosed,
        };
        let id = uuid::Uuid::new_v4().to_string();
        let valid = serde_json::json!({"namespace":NAMESPACE,"version":1,"request_id":id,"payload":{"method":"invalidated"}});
        assert!(decode_response(&serde_json::to_vec(&valid).unwrap(), &id, &req).is_ok());
        let mut bad = valid.clone();
        bad["payload"]["authorized"] = serde_json::json!(true);
        assert!(decode_response(&serde_json::to_vec(&bad).unwrap(), &id, &req).is_err());
        let mut bad = valid.clone();
        bad["request_id"] = serde_json::json!(uuid::Uuid::new_v4().to_string());
        assert!(decode_response(&serde_json::to_vec(&bad).unwrap(), &id, &req).is_err());
        let mut bad = valid;
        bad["namespace"] = serde_json::json!("host.management");
        assert!(decode_response(&serde_json::to_vec(&bad).unwrap(), &id, &req).is_err());
        assert!(base.validate().is_ok());
    }
    #[tokio::test]
    async fn original_final_receipt_and_exact_ack_roundtrip_over_authenticated_unix_peer() {
        let (_dir, cfg) = endpoint();
        let ipc = BotExecutionIpc::bind_inner(&cfg, true).unwrap();
        let mut node = UnixStream::connect(&cfg.socket).await.unwrap();
        let f: serde_json::Value = serde_json::from_str(include_str!(
            "../../../services/agentnet/execution-core/fixtures/wire-v1.json"
        ))
        .unwrap();
        let receipt: Receipt = serde_json::from_value(f["receipt"].clone()).unwrap();
        let pending = PendingReceipt {
            lease_id: uuid::Uuid::new_v4().to_string(),
            mutation_id: receipt.mutation_id.clone(),
            request_hash: receipt.request_hash.clone(),
            receipt,
        };
        let expected = pending.clone();
        let peer=tokio::runtime::Handle::current().spawn(async move {
            for method in ["pending_receipts","ack_receipt"] {
                let mut prefix=[0;4];node.read_exact(&mut prefix).await.unwrap();let mut b=vec![0;u32::from_be_bytes(prefix)as usize];node.read_exact(&mut b).await.unwrap();let frame:serde_json::Value=serde_json::from_slice(&b).unwrap();assert_eq!(frame["payload"]["method"],method);
                let payload=if method=="pending_receipts" {serde_json::json!({"method":method,"receipts":[expected]})}else{assert_eq!(frame["payload"]["mutation_id"],expected.mutation_id);assert_eq!(frame["payload"]["request_hash"],expected.request_hash);serde_json::json!({"method":"receipt_ack","lease_id":expected.lease_id})};
                let body=serde_json::to_vec(&serde_json::json!({"namespace":NAMESPACE,"version":1,"request_id":frame["request_id"],"payload":payload})).unwrap();node.write_all(&(body.len()as u32).to_be_bytes()).await.unwrap();node.write_all(&body).await.unwrap();
            }
        });
        let ResponsePayload::PendingReceipts { receipts } = ipc
            .request(RequestPayload::PendingReceipts {})
            .await
            .unwrap()
        else {
            panic!("wrong response")
        };
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].receipt, pending.receipt);
        assert!(
            matches!(ipc.request(RequestPayload::AckReceipt {lease_id:pending.lease_id.clone(),mutation_id:pending.mutation_id,request_hash:pending.request_hash}).await.unwrap(),ResponsePayload::ReceiptAck {lease_id}if lease_id==pending.lease_id)
        );
        peer.await.unwrap();
    }
    #[test]
    fn pending_receipts_reject_uncertain_effects_wrong_tuple_unknown_fields_and_wrong_ack() {
        let f: serde_json::Value = serde_json::from_str(include_str!(
            "../../../services/agentnet/execution-core/fixtures/wire-v1.json"
        ))
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let lease = uuid::Uuid::new_v4().to_string();
        let pending = serde_json::json!({"lease_id":lease,"mutation_id":f["receipt"]["mutation_id"],"request_hash":f["receipt"]["request_hash"],"receipt":f["receipt"]});
        let response = serde_json::json!({"namespace":NAMESPACE,"version":1,"request_id":id,"payload":{"method":"pending_receipts","receipts":[pending]}});
        for mutate in [
            |v: &mut serde_json::Value| {
                v["payload"]["receipts"][0]["mutation_id"] =
                    serde_json::json!(uuid::Uuid::new_v4().to_string())
            },
            |v: &mut serde_json::Value| {
                v["payload"]["receipts"][0]["receipt"]["status"] = serde_json::json!("unconfirmed")
            },
            |v: &mut serde_json::Value| {
                v["payload"]["receipts"][0]["authorized"] = serde_json::json!(true)
            },
        ] {
            let mut bad = response.clone();
            mutate(&mut bad);
            assert!(decode_response(
                &serde_json::to_vec(&bad).unwrap(),
                &id,
                &RequestPayload::PendingReceipts {}
            )
            .is_err());
        }
        let mut bad = response;
        bad["payload"]["receipts"] = serde_json::json!(vec![pending; 65]);
        assert!(decode_response(
            &serde_json::to_vec(&bad).unwrap(),
            &id,
            &RequestPayload::PendingReceipts {}
        )
        .is_err());
        let request = RequestPayload::AckReceipt {
            lease_id: lease,
            mutation_id: f["receipt"]["mutation_id"].as_str().unwrap().into(),
            request_hash: f["receipt"]["request_hash"].as_str().unwrap().into(),
        };
        let wrong = serde_json::json!({"namespace":NAMESPACE,"version":1,"request_id":id,"payload":{"method":"receipt_ack","lease_id":uuid::Uuid::new_v4().to_string()}});
        assert!(decode_response(&serde_json::to_vec(&wrong).unwrap(), &id, &request).is_err());
    }
    #[tokio::test]
    async fn authenticated_local_peer_framing_and_no_unrelated_replacement() {
        let (_dir, cfg) = endpoint();
        let ipc = BotExecutionIpc::bind_inner(&cfg, true).unwrap();
        let mut node = UnixStream::connect(&cfg.socket).await.unwrap();
        let peer = tokio::runtime::Handle::current().spawn(async move {
            let mut p = [0; 4];
            node.read_exact(&mut p).await.unwrap();
            let mut b = vec![0; u32::from_be_bytes(p) as usize];
            node.read_exact(&mut b).await.unwrap();
            let r: serde_json::Value = serde_json::from_slice(&b).unwrap();
            assert_eq!(r["payload"]["method"], "invalidate");
            assert!(r.get("token").is_none());
            let response = serde_json::json!({"namespace":NAMESPACE,"version":1,"request_id":r["request_id"],"payload":{"method":"invalidated"}});
            let b = serde_json::to_vec(&response).unwrap();
            node.write_all(&(b.len() as u32).to_be_bytes())
                .await
                .unwrap();
            node.write_all(&b).await.unwrap();
        });
        assert!(matches!(
            ipc.request(RequestPayload::Invalidate {
                reason: InvalidationReason::ConnectionClosed
            })
            .await
            .unwrap(),
            ResponsePayload::Invalidated {}
        ));
        peer.await.unwrap();
        let original = fs::symlink_metadata(&cfg.socket).unwrap();
        fs::remove_file(&cfg.socket).unwrap();
        let replacement = std::os::unix::net::UnixListener::bind(&cfg.socket).unwrap();
        assert_ne!(
            fs::symlink_metadata(&cfg.socket).unwrap().ino(),
            original.ino()
        );
        assert!(ipc.verify_inode().is_err());
        drop(ipc);
        assert!(cfg.socket.exists());
        drop(replacement);
    }
    #[tokio::test]
    async fn rejects_wrong_uid_and_existing_or_unsafe_socket() {
        let (_dir, mut cfg) = endpoint();
        let current = cfg.node_uid;
        cfg.node_uid = current + 1;
        let ipc = BotExecutionIpc::bind_inner(&cfg, true).unwrap();
        let _wrong = UnixStream::connect(&cfg.socket).await.unwrap();
        let e = ipc
            .request_timeout(
                RequestPayload::Invalidate {
                    reason: InvalidationReason::ConnectionClosed,
                },
                Duration::from_millis(60),
            )
            .await
            .unwrap_err();
        assert_eq!(e.code, "BOT_EXECUTION_IPC_UNAVAILABLE");
        assert!(BotExecutionIpc::bind_inner(&cfg, true).is_err());
        drop(ipc);
        fs::set_permissions(
            cfg.socket.parent().unwrap(),
            fs::Permissions::from_mode(0o770),
        )
        .unwrap();
        assert!(BotExecutionIpc::bind_inner(&cfg, true).is_err());
    }
    #[tokio::test]
    async fn context_invalidation_cancels_inflight_socket_and_node_observes_eof() {
        let (_dir, cfg) = endpoint();
        let ipc = Arc::new(BotExecutionIpc::bind_inner(&cfg, true).unwrap());
        let mut node = UnixStream::connect(&cfg.socket).await.unwrap();
        let work = ipc.clone();
        let job = tokio::runtime::Handle::current().spawn(async move {
            work.request(RequestPayload::Invalidate {
                reason: InvalidationReason::ConnectionClosed,
            })
            .await
        });
        let mut prefix = [0; 4];
        node.read_exact(&mut prefix).await.unwrap();
        let mut payload = vec![0; u32::from_be_bytes(prefix) as usize];
        node.read_exact(&mut payload).await.unwrap();
        ipc.cancel_pending();
        let result = job.await.unwrap().unwrap_err();
        assert_eq!(result.code, "BOT_EXECUTION_CONTEXT_INVALIDATED");
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), node.read(&mut prefix))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    }
    #[tokio::test]
    async fn aborting_poll_drops_pending_node_socket_instead_of_preserving_stale_context() {
        let (_dir, cfg) = endpoint();
        let ipc = Arc::new(BotExecutionIpc::bind_inner(&cfg, true).unwrap());
        let mut node = UnixStream::connect(&cfg.socket).await.unwrap();
        let work = ipc.clone();
        let job = tokio::runtime::Handle::current().spawn(async move {
            work.request(RequestPayload::Invalidate {
                reason: InvalidationReason::ConnectionClosed,
            })
            .await
        });
        let mut prefix = [0; 4];
        node.read_exact(&mut prefix).await.unwrap();
        let mut payload = vec![0; u32::from_be_bytes(prefix) as usize];
        node.read_exact(&mut payload).await.unwrap();
        job.abort();
        assert!(job.await.unwrap_err().is_cancelled());
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), node.read(&mut prefix))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    }
}
