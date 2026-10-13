//! Explicit owned-service login adapter. Credentials remain encrypted and Rust-owned.
use crate::{
    agent_network::{
        account::{NetworkAccountSession, OwnedAccount},
        owned_login::{OwnedClient, OwnedInstance, OwnedPoll, OwnedSession},
        NetworkError,
    },
    owned_state::{Owner, Scope},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use myagents_agent_network_crypto::EncryptedIdentityStore;
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    os::unix::fs::MetadataExt,
    path::Path,
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};
use zeroize::Zeroizing;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstancePin {
    version: u8,
    device_id: String,
    instance: OwnedInstance,
    public_ca: Option<String>,
}
fn pin_namespace(origin: &str, device: &str) -> String {
    format!(
        "owned-instance:{:x}",
        Sha256::digest(format!("{origin}\n{device}").as_bytes())
    )
}
fn load_pin(
    store: &EncryptedIdentityStore,
    origin: &str,
    device: &str,
) -> Result<Option<InstancePin>, NetworkError> {
    let Some(raw) = store.load_state(&pin_namespace(origin, device))? else {
        return Ok(None);
    };
    let pin: InstancePin =
        serde_json::from_slice(&raw).map_err(|_| NetworkError::new("OWNED_PIN_CORRUPT"))?;
    if pin.version != 1 || pin.device_id != device {
        return Err(NetworkError::new("OWNED_PIN_CORRUPT"));
    }
    pin.instance.validate(origin)?;
    Scope {
        issuer: origin.into(),
        service_id: pin.instance.service_id.clone(),
        environment: pin.instance.environment.clone(),
        network_id: pin.instance.network_id.clone(),
        device_id: device.into(),
    }
    .validate()?;
    Ok(Some(pin))
}
pub(crate) struct Connection {
    pub client: OwnedClient,
    pub instance: OwnedInstance,
    pub owner: Arc<Owner>,
    pub public_ca: Option<String>,
}
impl Connection {
    pub async fn discover(
        origin: &str,
        ca_file: Option<&Path>,
        store: Arc<EncryptedIdentityStore>,
        device: &str,
    ) -> Result<Self, NetworkError> {
        crate::state::bind_device(&store, device)?;
        let public_ca = ca_file.map(read_ca).transpose()?;
        if let Some(pin) = load_pin(&store, origin, device)? {
            if pin.public_ca != public_ca {
                return Err(NetworkError::new("OWNED_INSTANCE_TRUST_CHANGED"));
            }
        }
        let (client, instance) = OwnedClient::discover(origin, public_ca.as_deref()).await?;
        if let Some(pin) = load_pin(&store, origin, device)? {
            pin.instance.ensure_same_trust(&instance)?;
            if pin.public_ca != public_ca {
                return Err(NetworkError::new("OWNED_INSTANCE_TRUST_CHANGED"));
            }
        } else {
            let pin = InstancePin {
                version: 1,
                device_id: device.into(),
                instance: instance.clone(),
                public_ca: public_ca.clone(),
            };
            let bytes = Zeroizing::new(
                serde_json::to_vec(&pin).map_err(|_| NetworkError::new("OWNED_PIN_CORRUPT"))?,
            );
            store.compare_exchange_state(&pin_namespace(origin, device), None, &bytes)?;
        }
        Self::assemble(client, instance, public_ca, store, device)
    }
    pub fn from_pinned(
        origin: &str,
        ca_file: Option<&Path>,
        store: Arc<EncryptedIdentityStore>,
        device: &str,
    ) -> Result<Self, NetworkError> {
        let pin = load_pin(&store, origin, device)?
            .ok_or_else(|| NetworkError::new("OWNED_INSTANCE_NOT_PINNED"))?;
        if let Some(path) = ca_file {
            if Some(read_ca(path)?) != pin.public_ca {
                return Err(NetworkError::new("OWNED_INSTANCE_TRUST_CHANGED"));
            }
        }
        let client = OwnedClient::pinned(pin.instance.clone(), pin.public_ca.as_deref())?;
        Self::assemble(client, pin.instance, pin.public_ca, store, device)
    }
    fn assemble(
        client: OwnedClient,
        instance: OwnedInstance,
        public_ca: Option<String>,
        store: Arc<EncryptedIdentityStore>,
        device: &str,
    ) -> Result<Self, NetworkError> {
        let trust = serde_json::json!({"issuer":instance.issuer,"serviceId":instance.service_id,"environment":instance.environment,
            "networkId":instance.network_id,"loginIssuer":instance.login_issuer,"profile":instance.profile,"protocol":instance.protocol,
            "rootCertificate":instance.root_certificate,"jwks":instance.jwks,"publicTlsCa":public_ca});
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&trust)
                    .map_err(|_| NetworkError::new("OWNED_INSTANCE_INVALID"))?
            )
        );
        let owner = Arc::new(Owner {
            store,
            scope: Scope {
                issuer: instance.issuer.clone(),
                service_id: instance.service_id.clone(),
                environment: instance.environment.clone(),
                network_id: instance.network_id.clone(),
                device_id: device.into(),
            },
            trust_fingerprint: fingerprint,
        });
        let (s, raw) = owner.read()?;
        if raw.is_none() {
            owner.commit(None, &s)?;
        }
        Ok(Self {
            client,
            instance,
            owner,
            public_ca,
        })
    }
    pub async fn account(
        &self,
        join_authorized: bool,
    ) -> Result<NetworkAccountSession, NetworkError> {
        self.instance
            .ensure_same_trust(&self.client.public_instance().await?)?;
        let (s, _) = self.owner.read()?;
        let a = s
            .account
            .as_ref()
            .ok_or_else(|| NetworkError::new("OWNED_REAUTH_REQUIRED"))?;
        self.owner.ensure_binding(&a.binding)?;
        let session = OwnedSession {
            access_token: a.token.clone(),
            expires_at: a.expires_at,
            principal_id: a.principal.clone(),
            network_id: self.instance.network_id.clone(),
        };
        self.client
            .validate_session(&self.owner.scope.device_id, &session)
            .await?;
        self.owner.ensure_binding(&a.binding)?;
        let owner = self.owner.clone();
        let binding = a.binding.clone();
        Ok(NetworkAccountSession::Owned(Arc::new(OwnedAccount {
            connection_id: binding.clone(),
            descriptor: self.instance.clone(),
            active: Arc::new(AtomicBool::new(true)),
            session,
            public_tls_ca: self.public_ca.clone(),
            join_authorized: AtomicBool::new(join_authorized),
            guard: Arc::new(move || owner.ensure_binding(&binding)),
        })))
    }
    pub async fn start(&self) -> Result<serde_json::Value, NetworkError> {
        // Revocation of the previous local generation happens before any external request.
        self.cancel().await?;
        let (mut s, raw) = self.owner.read()?;
        let verifier = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        s.begin(verifier, jsonwebtoken::get_current_timestamp());
        self.owner
            .commit(raw.as_deref().map(|v| v.as_slice()), &s)?;
        let committed = Zeroizing::new(
            serde_json::to_vec(&s).map_err(|_| NetworkError::new("OWNED_STATE_CORRUPT"))?,
        );
        let started = self
            .client
            .start(&self.owner.scope.device_id, &challenge)
            .await?;
        if started.expires_at <= jsonwebtoken::get_current_timestamp()
            || started.expires_at > s.pending.as_ref().unwrap().expires_at
        {
            return Err(NetworkError::new("AUTH_EXPIRY_INVALID"));
        }
        let p = s.pending.as_mut().unwrap();
        p.transaction_id = Some(started.transaction_id.clone());
        p.expires_at = started.expires_at;
        self.owner.commit(Some(&committed), &s)?;
        Ok(
            serde_json::json!({"authorizationUrl":started.authorization_url,"expiresAt":started.expires_at}),
        )
    }
    pub async fn wait(&self) -> Result<(), NetworkError> {
        let attempt = self
            .owner
            .read()?
            .0
            .pending
            .as_ref()
            .ok_or_else(|| NetworkError::new("AUTH_NOT_PENDING"))?
            .attempt
            .clone();
        loop {
            let (mut s, raw) = self.owner.read()?;
            if let Err(error) = s.claim_poll(&attempt, jsonwebtoken::get_current_timestamp()) {
                if error.code == "AUTH_EXPIRED" {
                    s.clear();
                    self.owner
                        .commit(raw.as_deref().map(|v| v.as_slice()), &s)?;
                }
                return Err(error);
            }
            let p = s.pending.as_ref().unwrap();
            let transaction = p.transaction_id.clone().unwrap();
            let verifier = Zeroizing::new(p.verifier.clone());
            self.owner
                .commit(raw.as_deref().map(|v| v.as_slice()), &s)?;
            // Use the exact bytes this claim committed. Never adopt another actor's generation.
            let claimed = Zeroizing::new(
                serde_json::to_vec(&s).map_err(|_| NetworkError::new("OWNED_STATE_CORRUPT"))?,
            );
            let result = tokio::select! { r=self.client.poll(&self.owner.scope.device_id,&transaction,&verifier)=>r?, _=crate::shutdown()=>{self.cancel().await?;return Err(NetworkError::new("AUTH_CANCELLED"));} };
            match result {
                OwnedPoll::Pending => {
                    let p = s.pending.as_mut().unwrap();
                    if p.expires_at <= jsonwebtoken::get_current_timestamp() {
                        s.clear();
                        self.owner.commit(Some(&claimed), &s)?;
                        return Err(NetworkError::new("AUTH_EXPIRED"));
                    }
                    p.poll_consumed = false;
                    self.owner.commit(Some(&claimed), &s)?;
                }
                OwnedPoll::Authenticated(session) => {
                    if session.network_id != self.instance.network_id {
                        return Err(NetworkError::new("AUTH_SCOPE_MISMATCH"));
                    }
                    s.publish_account(
                        &attempt,
                        session.principal_id.clone(),
                        session.access_token.clone(),
                        session.expires_at,
                        jsonwebtoken::get_current_timestamp(),
                    )?;
                    self.owner.commit(Some(&claimed), &s)?;
                    return Ok(());
                }
            }
            tokio::select! {_=tokio::time::sleep(Duration::from_secs(2))=>{},_=crate::shutdown()=>{self.cancel().await?;return Err(NetworkError::new("AUTH_CANCELLED"));}}
        }
    }
    pub async fn cancel(&self) -> Result<(), NetworkError> {
        let (mut s, raw) = self.owner.read()?;
        let previous = s.pending.take();
        let account = s.account.take();
        s.clear();
        self.owner
            .commit(raw.as_deref().map(|v| v.as_slice()), &s)?;
        if let Some(p) = previous {
            if let Some(tx) = &p.transaction_id {
                self.client
                    .cancel(&self.owner.scope.device_id, tx, &p.verifier)
                    .await?;
            }
        }
        if let Some(a) = account {
            self.client.logout(&a.token).await?;
        }
        Ok(())
    }
}
fn read_ca(path: &Path) -> Result<String, NetworkError> {
    use std::{
        ffi::CString,
        fs::File,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::ffi::OsStrExt,
        },
        path::Component,
    };
    if !path.is_absolute() {
        return Err(NetworkError::new("PUBLIC_TLS_CA_UNSAFE"));
    }
    let unavailable = || NetworkError::new("PUBLIC_TLS_CA_UNAVAILABLE");
    let unsafe_path = || NetworkError::new("PUBLIC_TLS_CA_UNSAFE");
    let handle = unsafe {
        libc::open(
            c"/".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if handle < 0 {
        return Err(unavailable());
    }
    let mut file = unsafe { File::from_raw_fd(handle) };
    let components = path.components().collect::<Vec<_>>();
    let mut opened_file = false;
    for (index, component) in components.iter().enumerate() {
        match component {
            Component::RootDir => {}
            Component::Normal(part) => {
                let name = CString::new(part.as_bytes()).map_err(|_| unsafe_path())?;
                let last = index + 1 == components.len();
                let flags = libc::O_RDONLY
                    | libc::O_NOFOLLOW
                    | libc::O_CLOEXEC
                    | if last { 0 } else { libc::O_DIRECTORY };
                let handle = unsafe { libc::openat(file.as_raw_fd(), name.as_ptr(), flags) };
                if handle < 0 {
                    return Err(unsafe_path());
                }
                file = unsafe { File::from_raw_fd(handle) };
                let meta = file.metadata().map_err(|_| unavailable())?;
                if ![0, unsafe { libc::geteuid() }].contains(&meta.uid()) {
                    return Err(unsafe_path());
                }
                if !last
                    && meta.mode() & 0o022 != 0
                    && !(meta.uid() == 0 && meta.mode() & 0o1000 != 0)
                {
                    return Err(unsafe_path());
                }
                opened_file = last;
            }
            _ => return Err(unsafe_path()),
        }
    }
    let meta = file.metadata().map_err(|_| unavailable())?;
    if !opened_file
        || !meta.is_file()
        || meta.nlink() != 1
        // The CA is public trust material: group/other read is required for
        // the dedicated service UID to open it. Keep write access private and
        // reject special bits, but allow 0644/0444.
        || meta.mode() & 0o7022 != 0
        || meta.len() == 0
        || meta.len() > 65536
    {
        return Err(unsafe_path());
    }
    let mut bytes = Vec::new();
    file.take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| unavailable())?;
    if bytes.len() > 65536 {
        return Err(unsafe_path());
    }
    String::from_utf8(bytes).map_err(|_| NetworkError::new("PUBLIC_TLS_CA_INVALID"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    #[tokio::test]
    async fn pinned_restart_cancels_locally_before_unreachable_service_and_rejects_changed_trust() {
        use crate::agent_network::crypto;
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let store = Arc::new(EncryptedIdentityStore::for_test(&root, &[31; 32]).unwrap());
        let device = uuid::Uuid::new_v4().to_string();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!(
            "https://127.0.0.1:{}",
            listener.local_addr().unwrap().port()
        );
        drop(listener);
        let mut jwk = crypto::DevicePrivateKey::generate()
            .unwrap()
            .public_jwk()
            .unwrap();
        jwk["kid"] = serde_json::json!("owned-test");
        jwk["alg"] = serde_json::json!("ES256");
        jwk["use"] = serde_json::json!("sig");
        let instance = OwnedInstance {
            version: 1,
            profile: "owned-device-relay-v1".into(),
            service_id: uuid::Uuid::new_v4().to_string(),
            environment: "development".into(),
            network_id: uuid::Uuid::new_v4().to_string(),
            name: "Isolated".into(),
            issuer: origin.clone(),
            login_issuer: "https://login.example.test/dex".into(),
            protocol: 1,
            capabilities: vec!["tls13-mtls".into()],
            root_certificate: crypto::tests::Fixture::new().ca.pem(),
            jwks: serde_json::json!({"keys":[jwk]}),
        };
        instance.validate(&origin).unwrap();
        let pin = InstancePin {
            version: 1,
            device_id: device.clone(),
            instance: instance.clone(),
            public_ca: None,
        };
        store
            .compare_exchange_state(
                &pin_namespace(&origin, &device),
                None,
                &serde_json::to_vec(&pin).unwrap(),
            )
            .unwrap();
        let connection = Connection::from_pinned(&origin, None, store.clone(), &device).unwrap();
        let (mut state, raw) = connection.owner.read().unwrap();
        let now = jsonwebtoken::get_current_timestamp();
        state.begin("x".repeat(43), now);
        state.pending.as_mut().unwrap().transaction_id = Some(uuid::Uuid::new_v4().to_string());
        let attempt = state.revision.clone();
        state.claim_poll(&attempt, now).unwrap();
        state
            .publish_account(
                &attempt,
                uuid::Uuid::new_v4().to_string(),
                "z".repeat(43),
                now + 300,
                now,
            )
            .unwrap();
        let binding = state.account.as_ref().unwrap().binding.clone();
        connection
            .owner
            .commit(raw.as_deref().map(|v| v.as_slice()), &state)
            .unwrap();
        drop(connection);
        let restarted_store = Arc::new(EncryptedIdentityStore::for_test(&root, &[31; 32]).unwrap());
        let restarted = Connection::from_pinned(&origin, None, restarted_store, &device).unwrap();
        restarted.owner.ensure_binding(&binding).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(3), restarted.cancel())
            .await
            .unwrap();
        assert!(result.is_err()); // Remote revoke unconfirmed; local revocation is already durable.
        assert!(restarted.owner.read().unwrap().0.account.is_none());
        assert_eq!(
            restarted.owner.ensure_binding(&binding).unwrap_err().code,
            "OWNED_REAUTH_REQUIRED"
        );
        let mut changed = instance;
        changed.root_certificate = crypto::tests::Fixture::new().ca.pem();
        assert!(pin.instance.ensure_same_trust(&changed).is_err());
        let ca = root.join("new-ca.pem");
        std::fs::write(&ca, changed.root_certificate).unwrap();
        std::fs::set_permissions(&ca, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            Connection::from_pinned(&origin, Some(&ca), store, &device)
                .err()
                .unwrap()
                .code,
            "OWNED_INSTANCE_TRUST_CHANGED"
        );
    }
    #[test]
    fn public_ca_allows_readable_modes_but_rejects_writes_special_bits_and_links() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let ca = root.join("ca.pem");
        std::fs::write(&ca, "fixture-public-ca").unwrap();
        std::fs::set_permissions(&ca, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(read_ca(&ca).unwrap(), "fixture-public-ca");
        std::fs::set_permissions(&ca, std::fs::Permissions::from_mode(0o444)).unwrap();
        assert_eq!(read_ca(&ca).unwrap(), "fixture-public-ca");
        for mode in [0o662, 0o646, 0o4644] {
            std::fs::set_permissions(&ca, std::fs::Permissions::from_mode(mode)).unwrap();
            assert_eq!(read_ca(&ca).unwrap_err().code, "PUBLIC_TLS_CA_UNSAFE");
        }
        std::fs::set_permissions(&ca, std::fs::Permissions::from_mode(0o644)).unwrap();
        let link = root.join("link");
        symlink(&ca, &link).unwrap();
        assert!(read_ca(&link).is_err());
        let hardlink = root.join("hardlink.pem");
        std::fs::hard_link(&ca, &hardlink).unwrap();
        assert_eq!(read_ca(&ca).unwrap_err().code, "PUBLIC_TLS_CA_UNSAFE");
        assert!(read_ca(Path::new("ca.pem")).is_err());
    }
}
