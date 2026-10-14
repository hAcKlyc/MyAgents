//! Browser-login secrets are owned by the desktop process and stored only in
//! the explicitly selected operating-system credential backend.
use super::{
    account::OwnedAccount,
    owned_login::{OwnedClient, OwnedInstance, OwnedPoll, OwnedSession},
    NetworkError,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard, OnceLock,
    },
};
use zeroize::Zeroizing;

const SERVICE: &str = "com.myagents.owned-agentnet.v1";
const VERSION: u8 = 1;
const SESSION_GUARD_LIMIT: usize = 128;

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum SecretRecord {
    Pending {
        version: u8,
        instance: OwnedInstance,
        public_tls_ca: Option<String>,
        device_id: String,
        attempt_id: String,
        transaction_id: String,
        verifier: String,
        authorization_url: String,
        expires_at: u64,
        consuming: bool,
    },
    Session {
        version: u8,
        instance: OwnedInstance,
        public_tls_ca: Option<String>,
        device_id: String,
        principal_id: String,
        network_id: String,
        session: OwnedSession,
        connection_id: String,
        binding_id: String,
    },
}

struct Attempt {
    client: OwnedClient,
    instance: OwnedInstance,
    public_tls_ca: Option<String>,
    device_id: String,
    attempt_id: String,
    transaction_id: String,
    verifier: Zeroizing<String>,
    authorization_url: String,
    expires_at: u64,
    consuming: bool,
    completed: Option<CompletedLogin>,
}
#[derive(Clone)]
pub(crate) struct CompletedLogin {
    pub attempt_id: String,
    pub connection_id: String,
    pub binding_id: String,
    pub instance: OwnedInstance,
    pub public_tls_ca: Option<String>,
    pub device_id: String,
    pub session: OwnedSession,
    guard: Arc<AuthorizedSessionGuard>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartedLogin {
    pub attempt_id: String,
    pub authorization_url: String,
    pub expires_at: u64,
}
#[derive(Default)]
struct State {
    attempts: HashMap<String, Attempt>,
    current_by_scope: HashMap<String, String>,
    generation_by_scope: HashMap<String, u64>,
}
impl State {
    fn begin(&mut self, scope: &str) -> (u64, Option<String>) {
        let generation = self
            .generation_by_scope
            .get(scope)
            .copied()
            .unwrap_or(0)
            .saturating_add(1);
        self.generation_by_scope
            .insert(scope.to_owned(), generation);
        (generation, self.current_by_scope.remove(scope))
    }
    fn register(&mut self, scope: &str, generation: u64, attempt_id: &str) -> bool {
        if self.generation_by_scope.get(scope).copied() != Some(generation) {
            return false;
        }
        self.current_by_scope
            .insert(scope.to_owned(), attempt_id.to_owned());
        true
    }
    fn is_current(&self, scope: &str, attempt_id: &str) -> bool {
        self.current_by_scope.get(scope).map(String::as_str) == Some(attempt_id)
    }
    fn invalidate(&mut self, scope: &str, attempt_id: &str) -> bool {
        if !self.is_current(scope, attempt_id) {
            return false;
        }
        self.current_by_scope.remove(scope);
        let generation = self
            .generation_by_scope
            .get(scope)
            .copied()
            .unwrap_or(0)
            .saturating_add(1);
        self.generation_by_scope
            .insert(scope.to_owned(), generation);
        true
    }
}
#[derive(Default)]
pub(crate) struct OwnedLoginManager {
    state: tokio::sync::Mutex<State>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct SessionSlot {
    app_profile: String,
    profile: String,
    issuer: String,
    login_issuer: String,
    service_id: String,
    environment: String,
    network_id: String,
    device_id: String,
    principal_id: String,
    ca_hash: String,
}

impl SessionSlot {
    fn new(
        instance: &OwnedInstance,
        device_id: &str,
        principal_id: &str,
        public_tls_ca: Option<&str>,
    ) -> Result<Self, NetworkError> {
        let ca_hash = public_tls_ca
            .map(|pem| URL_SAFE_NO_PAD.encode(Sha256::digest(pem.as_bytes())))
            .unwrap_or_else(|| "platform".to_owned());
        Ok(Self {
            app_profile: crate::app_dirs::APP_DATA_DIR_NAME.to_owned(),
            profile: instance.profile.clone(),
            issuer: instance.issuer.clone(),
            // OwnedInstance has already validated the fixed OIDC issuer. Keep
            // its path: `/dex` is issuer identity, not an HTTP origin suffix.
            login_issuer: instance.login_issuer.clone(),
            service_id: instance.service_id.clone(),
            environment: instance.environment.clone(),
            network_id: instance.network_id.clone(),
            device_id: device_id.to_owned(),
            principal_id: principal_id.to_owned(),
            ca_hash,
        })
    }
}

struct AuthorizedSessionGuard {
    binding_id: String,
    connection_id: String,
    generation: u64,
    expires_at: u64,
    valid: AtomicBool,
}

impl AuthorizedSessionGuard {
    fn check(&self) -> Result<(), NetworkError> {
        if self.generation == 0 || !self.valid.load(Ordering::Acquire) || self.expires_at <= now() {
            return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
        }
        Ok(())
    }
}

#[derive(Default)]
struct SessionGuardCacheState {
    entries: HashMap<SessionSlot, Arc<AuthorizedSessionGuard>>,
    next_generation: u64,
}

#[derive(Default)]
struct SessionGuardCache {
    state: Mutex<SessionGuardCacheState>,
}

impl SessionGuardCache {
    fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
        mutex.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn prune(state: &mut SessionGuardCacheState) {
        state.entries.retain(|_, guard| {
            let live = guard.valid.load(Ordering::Acquire) && guard.expires_at > now();
            if !live {
                guard.valid.store(false, Ordering::Release);
            }
            live
        });
    }

    fn ensure_capacity(&self, slot: &SessionSlot) -> Result<(), NetworkError> {
        let mut state = Self::lock(&self.state);
        Self::prune(&mut state);
        if !state.entries.contains_key(slot) && state.entries.len() >= SESSION_GUARD_LIMIT {
            return Err(NetworkError::new("NETWORK_REQUEST_CAPACITY"));
        }
        Ok(())
    }

    fn authorize(
        &self,
        slot: SessionSlot,
        binding_id: &str,
        connection_id: &str,
        expires_at: u64,
    ) -> Result<Arc<AuthorizedSessionGuard>, NetworkError> {
        if expires_at <= now() {
            return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
        }
        let mut state = Self::lock(&self.state);
        Self::prune(&mut state);
        if let Some(existing) = state.entries.get(&slot) {
            if existing.binding_id == binding_id
                && existing.connection_id == connection_id
                && existing.expires_at == expires_at
            {
                return Ok(existing.clone());
            }
        }
        if !state.entries.contains_key(&slot) && state.entries.len() >= SESSION_GUARD_LIMIT {
            return Err(NetworkError::new("NETWORK_REQUEST_CAPACITY"));
        }
        if let Some(previous) = state.entries.remove(&slot) {
            previous.valid.store(false, Ordering::Release);
        }
        state.next_generation = state.next_generation.saturating_add(1);
        let generation = state.next_generation;
        let guard = Arc::new(AuthorizedSessionGuard {
            binding_id: binding_id.to_owned(),
            connection_id: connection_id.to_owned(),
            generation,
            expires_at,
            valid: AtomicBool::new(true),
        });
        state.entries.insert(slot, guard.clone());
        Ok(guard)
    }

    fn invalidate_binding(&self, slot: &SessionSlot, binding_id: &str) {
        let mut state = Self::lock(&self.state);
        if state
            .entries
            .get(slot)
            .is_some_and(|guard| guard.binding_id == binding_id)
        {
            if let Some(guard) = state.entries.remove(slot) {
                guard.valid.store(false, Ordering::Release);
            }
        }
    }
}

fn session_guard_cache() -> &'static SessionGuardCache {
    static CACHE: OnceLock<SessionGuardCache> = OnceLock::new();
    CACHE.get_or_init(SessionGuardCache::default)
}

fn storage_transaction_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

fn entry(user: &str) -> Result<Entry, NetworkError> {
    if crate::app_dirs::IS_UPDATER_QA { return Err(NetworkError::new("UPDATER_QA_CREDENTIALS_DISABLED")); }
    let builder: Box<keyring::credential::CredentialBuilder> = {
        #[cfg(target_os = "macos")]
        {
            Box::new(keyring::macos::MacCredentialBuilder {})
        }
        #[cfg(target_os = "windows")]
        {
            Box::new(keyring::windows::WinCredentialBuilder {})
        }
        #[cfg(target_os = "linux")]
        {
            Box::new(keyring::secret_service::SsCredentialBuilder::default())
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            return Err(NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"));
        }
    };
    let credential = builder
        .build(None, SERVICE, user)
        .map_err(|_| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))?;
    Ok(Entry::new_with_credential(credential))
}
fn key(
    instance: &OwnedInstance,
    device_id: &str,
    principal: &str,
    public_tls_ca: Option<&str>,
) -> String {
    let scope = format!(
        "{}\n{}\n{}\n{}\n{}\n{}\n{}",
        crate::app_dirs::APP_DATA_DIR_NAME,
        instance.profile,
        instance.issuer,
        instance.service_id,
        instance.environment,
        instance.network_id,
        device_id
    );
    let ca_hash = public_tls_ca
        .map(|pem| URL_SAFE_NO_PAD.encode(Sha256::digest(pem.as_bytes())))
        .unwrap_or_else(|| "platform".to_owned());
    let material = format!("{scope}\n{principal}\n{ca_hash}");
    URL_SAFE_NO_PAD.encode(Sha256::digest(material.as_bytes()))
}
fn attempt_scope(issuer: &str, device_id: &str) -> Result<String, NetworkError> {
    let origin = super::account::origin(issuer)?;
    Ok(format!(
        "{}\n{}\n{}",
        crate::app_dirs::APP_DATA_DIR_NAME,
        origin,
        device_id
    ))
}
fn pending_entry(
    instance: &OwnedInstance,
    device_id: &str,
    public_tls_ca: Option<&str>,
) -> Result<Entry, NetworkError> {
    let hash = key(instance, device_id, "pending", public_tls_ca);
    #[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
    let hash = session_physical_hash(&hash, super::credential_slots::selected_writer_selection()?)?
        .ok_or_else(|| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))?;
    // Pending transactions are newly created by this process, never migrated.
    entry(&format!("pending:{hash}"))
}
fn session_entry(
    instance: &OwnedInstance,
    device_id: &str,
    principal: &str,
    public_tls_ca: Option<&str>,
) -> Result<Entry, NetworkError> {
    let hash = key(instance, device_id, principal, public_tls_ca);
    #[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
    let hash = session_physical_hash(
        &hash,
        super::credential_slots::selection(&format!("session:{hash}"))?,
    )?
    .ok_or_else(|| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))?;
    // A committed route never falls back when its current item is missing.
    entry(&format!("session:{hash}"))
}
#[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
fn session_entry_for_route(
    instance: &OwnedInstance,
    device_id: &str,
    principal: &str,
    public_tls_ca: Option<&str>,
    selection: super::credential_slots::RouteSelection,
) -> Result<Entry, NetworkError> {
    let logical = key(instance, device_id, principal, public_tls_ca);
    let physical = session_physical_hash(&logical, selection)?
        .ok_or_else(|| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))?;
    entry(&format!("session:{physical}"))
}
#[cfg(any(test, all(target_os = "macos", myagents_moxbot)))]
fn session_physical_hash(
    legacy: &str,
    selection: super::credential_slots::RouteSelection,
) -> Result<Option<String>, NetworkError> {
    Ok(match selection {
        super::credential_slots::RouteSelection::Legacy => Some(legacy.to_owned()),
        super::credential_slots::RouteSelection::LocalV1 => {
            Some(super::credential_slots::session_hash(legacy)?)
        }
        super::credential_slots::RouteSelection::DeveloperIdV2 => {
            Some(super::credential_slots::developer_id_session_hash(legacy)?)
        }
        super::credential_slots::RouteSelection::Deleted => None,
    })
}
fn write_session_unlocked(
    instance: &OwnedInstance,
    device_id: &str,
    principal: &str,
    public_tls_ca: Option<&str>,
    secret: &SecretRecord,
    _preserve_existing: bool,
    before_commit: impl Fn() -> Result<(), NetworkError>,
) -> Result<(), NetworkError> {
    #[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
    {
        let legacy = key(instance, device_id, principal, public_tls_ca);
        let target_selection = super::credential_slots::selected_writer_selection()?;
        let expected = serialized_secret(secret)?;
        super::credential_slots::with_committed_route(&format!("session:{legacy}"), |selection| {
            write_session_family_route(
                selection,
                target_selection,
                _preserve_existing,
                expected.as_slice(),
                |family| {
                    let hash = session_physical_hash(&legacy, family)?
                        .ok_or_else(|| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))?;
                    read_unlocked(&entry(&format!("session:{hash}"))?)?
                        .as_ref()
                        .map(serialized_secret)
                        .transpose()
                },
                |family| {
                    let hash = session_physical_hash(&legacy, family)?
                        .ok_or_else(|| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))?;
                    write_unlocked(&entry(&format!("session:{hash}"))?, secret)
                },
                before_commit,
            )
        })
    }
    #[cfg(not(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa))))]
    {
        before_commit()?;
        write_unlocked(
            &session_entry(instance, device_id, principal, public_tls_ca)?,
            secret,
        )
    }
}
#[cfg(any(test, all(target_os = "macos", myagents_moxbot)))]
fn write_session_family_route(
    selection: super::credential_slots::RouteSelection,
    target: super::credential_slots::RouteSelection,
    preserve_existing: bool,
    expected: &[u8],
    mut read: impl FnMut(
        super::credential_slots::RouteSelection,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, NetworkError>,
    mut write: impl FnMut(super::credential_slots::RouteSelection) -> Result<(), NetworkError>,
    before_commit: impl Fn() -> Result<(), NetworkError>,
) -> Result<(), NetworkError> {
    before_commit()?;
    let mut target_confirmed = false;
    if !preserve_existing {
        write(target)?;
    } else {
        let source = match selection {
            super::credential_slots::RouteSelection::Legacy
            | super::credential_slots::RouteSelection::LocalV1
            | super::credential_slots::RouteSelection::DeveloperIdV2 => selection,
            super::credential_slots::RouteSelection::Deleted => {
                return Err(NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"));
            }
        };
        let current = read(source)?
            .ok_or_else(|| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))?;
        if current.as_slice() != expected {
            return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
        }
        if source == target {
            // The authorized source read is already the target readback.
            // Avoid a second Keychain read that can prompt again.
            target_confirmed = true;
            #[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
            crate::ulog_info!(
                "[credential-migration] stage=session-confirm outcome=authorized-source"
            );
        } else {
            #[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
            crate::ulog_info!(
                "[credential-migration] stage=session-destination-read outcome=start"
            );
            let target_read = read(target);
            #[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
            crate::ulog_info!(
                "[credential-migration] stage=session-destination-read outcome={}",
                if target_read.is_ok() { "ok" } else { "failed" }
            );
            match target_read? {
                Some(existing) if existing.as_slice() == expected => target_confirmed = true,
                Some(_) => return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED")),
                None => {
                    #[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
                    crate::ulog_info!(
                        "[credential-migration] stage=session-destination-write outcome=start"
                    );
                    let result = write(target);
                    #[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
                    crate::ulog_info!(
                        "[credential-migration] stage=session-destination-write outcome={}",
                        if result.is_ok() { "ok" } else { "failed" }
                    );
                    result?;
                }
            }
        }
    }
    if !target_confirmed {
        #[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
        crate::ulog_info!("[credential-migration] stage=session-confirm outcome=start");
        let result = read(target);
        #[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
        crate::ulog_info!(
            "[credential-migration] stage=session-confirm outcome={}",
            if result.is_ok() { "read" } else { "failed" }
        );
        let confirmed =
            result?.ok_or_else(|| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))?;
        if confirmed.as_slice() != expected {
            return Err(NetworkError::new("NETWORK_CREDENTIAL_STORE_INVALID"));
        }
        #[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
        crate::ulog_info!("[credential-migration] stage=session-confirm outcome=ok");
    }
    before_commit()?;
    Ok(())
}
#[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
fn serialized_secret(secret: &SecretRecord) -> Result<Zeroizing<Vec<u8>>, NetworkError> {
    serde_json::to_vec(secret)
        .map(Zeroizing::new)
        .map_err(|_| NetworkError::new("NETWORK_CREDENTIAL_STORE_INVALID"))
}
fn write_unlocked(entry: &Entry, secret: &SecretRecord) -> Result<(), NetworkError> {
    let json = Zeroizing::new(
        serde_json::to_string(secret)
            .map_err(|_| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))?,
    );
    write_encoded_unlocked(entry, json.as_bytes())
}
fn write_encoded_unlocked(entry: &Entry, bytes: &[u8]) -> Result<(), NetworkError> {
    #[cfg(all(target_os = "macos", not(test)))]
    let result = super::crypto::write_secret_noninteractive(entry, bytes);
    #[cfg(any(not(target_os = "macos"), test))]
    let result = std::str::from_utf8(bytes)
        .map_err(|_| {
            keyring::Error::PlatformFailure(Box::new(std::io::Error::other(
                "invalid encoded secret",
            )))
        })
        .and_then(|value| entry.set_password(value));
    result.map_err(|_| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))
}
fn write(entry: &Entry, secret: &SecretRecord) -> Result<(), NetworkError> {
    let _transaction = storage_transaction_lock();
    write_unlocked(entry, secret)
}
fn decode_secret_record(value: Zeroizing<Vec<u8>>) -> Result<Option<SecretRecord>, NetworkError> {
    serde_json::from_slice(&value)
        .map(Some)
        .map_err(|_| NetworkError::new("NETWORK_CREDENTIAL_STORE_INVALID"))
}
fn restore_if_not_cancelled<T>(
    restored: Option<T>,
    cancelled: &AtomicBool,
) -> Result<Option<T>, NetworkError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
    }
    Ok(restored)
}
#[cfg(test)]
thread_local! {
    static KEYRING_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
fn read_unlocked(entry: &Entry) -> Result<Option<SecretRecord>, NetworkError> {
    #[cfg(test)]
    KEYRING_READS.with(|reads| reads.set(reads.get().saturating_add(1)));
    #[cfg(all(target_os = "macos", not(test)))]
    let result = super::crypto::read_secret_noninteractive(entry);
    #[cfg(any(not(target_os = "macos"), test))]
    let result = entry.get_secret();
    let value = match result {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(None),
        #[cfg(all(target_os = "macos", not(test)))]
        Err(error) if super::crypto::credential_authorization_required(&error) => {
            return Err(NetworkError::new(
                "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED",
            ));
        }
        Err(_) => return Err(NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE")),
    };
    decode_secret_record(Zeroizing::new(value))
}
fn read_authorized_unlocked(
    entry: &Entry,
    cancelled: &AtomicBool,
) -> Result<Option<SecretRecord>, NetworkError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
    }
    #[cfg(target_os = "macos")]
    let result = super::crypto::read_secret_authorized(entry, cancelled);
    #[cfg(not(target_os = "macos"))]
    let result: keyring::Result<Vec<u8>> = Err(keyring::Error::PlatformFailure(Box::new(
        std::io::Error::other("authorized credential read unsupported"),
    )));
    let value = match result {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => {
            if cancelled.load(Ordering::Acquire) {
                return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
            }
            return Ok(None);
        }
        #[cfg(target_os = "macos")]
        Err(error) => {
            if cancelled.load(Ordering::Acquire) {
                return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
            }
            if super::crypto::credential_authorization_required(&error) {
                return Err(NetworkError::new(
                    "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED",
                ));
            }
            return Err(NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"));
        }
        #[cfg(not(target_os = "macos"))]
        Err(_) => return Err(NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE")),
    };
    let value = Zeroizing::new(value);
    if cancelled.load(Ordering::Acquire) {
        return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
    }
    decode_secret_record(value)
}
fn read(entry: &Entry) -> Result<Option<SecretRecord>, NetworkError> {
    let _transaction = storage_transaction_lock();
    read_unlocked(entry)
}
fn delete_unlocked(entry: &Entry) -> Result<(), NetworkError> {
    #[cfg(all(target_os = "macos", not(test)))]
    let result = super::crypto::delete_secret_noninteractive(entry);
    #[cfg(any(not(target_os = "macos"), test))]
    let result = entry.delete_credential();
    match result {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE")),
    }
}
fn delete(entry: &Entry) -> Result<(), NetworkError> {
    let _transaction = storage_transaction_lock();
    delete_unlocked(entry)
}
fn read_public_ca_file(path: Option<&str>) -> Result<Option<String>, NetworkError> {
    let Some(path) = path else {
        return Ok(None);
    };
    let path = std::path::Path::new(path);
    if !path.is_absolute() {
        return Err(NetworkError::new("OWNED_CA_FILE_INVALID"));
    }
    let metadata =
        std::fs::symlink_metadata(path).map_err(|_| NetworkError::new("OWNED_CA_FILE_INVALID"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 65_536 {
        return Err(NetworkError::new("OWNED_CA_FILE_INVALID"));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = options
        .open(path)
        .map_err(|_| NetworkError::new("OWNED_CA_FILE_INVALID"))?;
    let metadata = file
        .metadata()
        .map_err(|_| NetworkError::new("OWNED_CA_FILE_INVALID"))?;
    if !metadata.is_file() || metadata.len() > 65_536 {
        return Err(NetworkError::new("OWNED_CA_FILE_INVALID"));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(65_537)
        .read_to_end(&mut bytes)
        .map_err(|_| NetworkError::new("OWNED_CA_FILE_INVALID"))?;
    if bytes.is_empty() || bytes.len() > 65_536 {
        return Err(NetworkError::new("OWNED_CA_FILE_INVALID"));
    }
    let pem = String::from_utf8(bytes).map_err(|_| NetworkError::new("OWNED_CA_FILE_INVALID"))?;
    super::crypto::external_tls_config_with_ca(Some(&pem))?;
    Ok(Some(pem))
}
fn now() -> u64 {
    jsonwebtoken::get_current_timestamp()
}
fn pkce() -> (Zeroizing<String>, String) {
    // 4 UUIDv4 values yield 488 random bits in a 128-byte RFC 7636 verifier.
    let verifier = Zeroizing::new(
        (0..4)
            .map(|_| uuid::Uuid::new_v4().simple().to_string())
            .collect::<String>(),
    );
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}
fn record(attempt: &Attempt) -> SecretRecord {
    SecretRecord::Pending {
        version: VERSION,
        instance: attempt.instance.clone(),
        public_tls_ca: attempt.public_tls_ca.clone(),
        device_id: attempt.device_id.clone(),
        attempt_id: attempt.attempt_id.clone(),
        transaction_id: attempt.transaction_id.clone(),
        verifier: attempt.verifier.to_string(),
        authorization_url: attempt.authorization_url.clone(),
        expires_at: attempt.expires_at,
        consuming: attempt.consuming,
    }
}

impl OwnedLoginManager {
    pub(crate) async fn start(
        &self,
        issuer: &str,
        device_id: &str,
        public_tls_ca_file: Option<&str>,
    ) -> Result<StartedLogin, NetworkError> {
        if crate::app_dirs::IS_UPDATER_QA { return Err(NetworkError::new("UPDATER_QA_CREDENTIALS_DISABLED")); }
        let public_tls_ca = read_public_ca_file(public_tls_ca_file)?;
        let device = crate::device_identity::current_device_identity()
            .map_err(|_| NetworkError::new("DEVICE_ID_UNAVAILABLE"))?;
        if device.device_id != device_id {
            return Err(NetworkError::new("IDENTITY_SCOPE_MISMATCH"));
        }
        let scope = attempt_scope(issuer, device_id)?;
        let (generation, old_attempts, local_cleanup_failed) = {
            let mut state = self.state.lock().await;
            let (generation, old_id) = state.begin(&scope);
            let old = old_id
                .and_then(|id| state.attempts.remove(&id))
                .into_iter()
                .collect::<Vec<_>>();
            // Clear old local authority before allowing another same-scope start
            // to write the shared pending slot.
            let mut cleanup_failed = false;
            for attempt in &old {
                let result = pending_entry(
                    &attempt.instance,
                    &attempt.device_id,
                    attempt.public_tls_ca.as_deref(),
                )
                .and_then(|entry| delete(&entry));
                cleanup_failed |= result.is_err();
                if let Some(done) = &attempt.completed {
                    cleanup_failed |= delete_account_if_binding(
                        &done.instance,
                        &done.device_id,
                        &done.session.principal_id,
                        done.public_tls_ca.as_deref(),
                        &done.binding_id,
                    )
                    .is_err();
                }
            }
            (generation, old, cleanup_failed)
        };
        for old in old_attempts {
            if old.completed.is_none() {
                let _ = old
                    .client
                    .cancel(&old.device_id, &old.transaction_id, &old.verifier)
                    .await;
            }
            if let Some(done) = old.completed {
                let _ = old.client.logout(&done.session.access_token).await;
            }
        }
        if local_cleanup_failed {
            return Err(NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"));
        }
        let (client, instance) = OwnedClient::discover(issuer, public_tls_ca.as_deref()).await?;
        let (verifier, challenge) = pkce();
        let started = client.start(device_id, &challenge).await?;
        let attempt_id = uuid::Uuid::new_v4().to_string();
        let attempt = Attempt {
            client,
            instance: instance.clone(),
            public_tls_ca: public_tls_ca.clone(),
            device_id: device.device_id,
            attempt_id: attempt_id.clone(),
            transaction_id: started.transaction_id,
            verifier,
            authorization_url: started.authorization_url.clone(),
            expires_at: started.expires_at,
            consuming: false,
            completed: None,
        };
        let secret_entry = pending_entry(&instance, device_id, public_tls_ca.as_deref())?;
        let mut state = self.state.lock().await;
        if state.generation_by_scope.get(&scope).copied() != Some(generation) {
            drop(state);
            let _ = attempt
                .client
                .cancel(
                    &attempt.device_id,
                    &attempt.transaction_id,
                    &attempt.verifier,
                )
                .await;
            return Err(NetworkError::new("OWNED_LOGIN_SUPERSEDED"));
        }
        if let Err(error) = write(&secret_entry, &record(&attempt)) {
            drop(state);
            let _ = attempt
                .client
                .cancel(
                    &attempt.device_id,
                    &attempt.transaction_id,
                    &attempt.verifier,
                )
                .await;
            return Err(error);
        }
        let registered = state.register(&scope, generation, &attempt_id);
        debug_assert!(registered);
        state.attempts.insert(attempt_id.clone(), attempt);
        Ok(StartedLogin {
            attempt_id,
            authorization_url: started.authorization_url,
            expires_at: started.expires_at,
        })
    }
    pub(crate) async fn open(&self, attempt_id: &str) -> Result<(), NetworkError> {
        let state = self.state.lock().await;
        let attempt = state
            .attempts
            .get(attempt_id)
            .ok_or_else(|| NetworkError::new("OWNED_LOGIN_NOT_FOUND"))?;
        if attempt.expires_at <= now() || attempt.consuming {
            return Err(NetworkError::new("OWNED_LOGIN_EXPIRED"));
        }
        let url = url::Url::parse(&attempt.authorization_url)
            .map_err(|_| NetworkError::new("OWNED_LOGIN_INVALID"))?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(NetworkError::new("OWNED_LOGIN_INVALID"));
        }
        drop(state);
        crate::browser::open_external(url.as_str())
            .map_err(|_| NetworkError::new("OWNED_BROWSER_UNAVAILABLE"))
    }
    pub(crate) async fn poll(
        &self,
        attempt_id: &str,
    ) -> Result<Option<CompletedLogin>, NetworkError> {
        let (
            client,
            instance,
            public_tls_ca,
            device_id,
            transaction_id,
            verifier,
            scope,
            secret_entry,
        ) = {
            let mut state = self.state.lock().await;
            let scope = {
                let attempt = state
                    .attempts
                    .get(attempt_id)
                    .ok_or_else(|| NetworkError::new("OWNED_LOGIN_NOT_FOUND"))?;
                attempt_scope(&attempt.instance.issuer, &attempt.device_id)?
            };
            if !state.is_current(&scope, attempt_id) {
                return Err(NetworkError::new("OWNED_LOGIN_SUPERSEDED"));
            }
            let attempt = state
                .attempts
                .get_mut(attempt_id)
                .expect("attempt checked above");
            if let Some(done) = &attempt.completed {
                return Ok(Some(done.clone()));
            }
            if attempt.consuming || attempt.expires_at <= now() {
                return Err(NetworkError::new("OWNED_LOGIN_RESULT_UNAVAILABLE"));
            }
            let secret_entry = pending_entry(
                &attempt.instance,
                &attempt.device_id,
                attempt.public_tls_ca.as_deref(),
            )?;
            attempt.consuming = true;
            write(&secret_entry, &record(attempt))?;
            (
                attempt.client.clone(),
                attempt.instance.clone(),
                attempt.public_tls_ca.clone(),
                attempt.device_id.clone(),
                attempt.transaction_id.clone(),
                attempt.verifier.clone(),
                scope,
                secret_entry,
            )
        };
        let result = client.poll(&device_id, &transaction_id, &verifier).await;
        match result {
            Ok(OwnedPoll::Pending) => {
                let mut state = self.state.lock().await;
                if !state.is_current(&scope, attempt_id) {
                    return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
                }
                let Some(attempt) = state.attempts.get_mut(attempt_id) else {
                    return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
                };
                if !attempt.consuming {
                    return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
                }
                attempt.consuming = false;
                write(&secret_entry, &record(attempt))?;
                Ok(None)
            }
            Ok(OwnedPoll::Authenticated(session)) => {
                let connection_id = uuid::Uuid::new_v4().to_string();
                let binding_id = uuid::Uuid::new_v4().to_string();
                let mut state = self.state.lock().await;
                if !state.is_current(&scope, attempt_id) {
                    drop(state);
                    let _ = client.logout(&session.access_token).await;
                    return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
                }
                let Some(attempt) = state.attempts.get_mut(attempt_id) else {
                    drop(state);
                    let _ = client.logout(&session.access_token).await;
                    return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
                };
                if !attempt.consuming {
                    drop(state);
                    let _ = client.logout(&session.access_token).await;
                    return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
                }
                let secret = SecretRecord::Session {
                    version: VERSION,
                    instance: instance.clone(),
                    public_tls_ca: public_tls_ca.clone(),
                    device_id: device_id.clone(),
                    principal_id: session.principal_id.clone(),
                    network_id: session.network_id.clone(),
                    session: session.clone(),
                    connection_id: connection_id.clone(),
                    binding_id: binding_id.clone(),
                };
                // The consumed transaction is durably marked before the request. If
                // saving the returned session fails, no subsequent poll can replay it.
                session.validate(&instance)?;
                let slot = SessionSlot::new(
                    &instance,
                    &device_id,
                    &session.principal_id,
                    public_tls_ca.as_deref(),
                )?;
                let _storage = storage_transaction_lock();
                session_guard_cache().ensure_capacity(&slot)?;
                write_session_unlocked(
                    &instance,
                    &device_id,
                    &session.principal_id,
                    public_tls_ca.as_deref(),
                    &secret,
                    false,
                    || Ok(()),
                )?;
                let guard = session_guard_cache().authorize(
                    slot,
                    &binding_id,
                    &connection_id,
                    session.expires_at,
                )?;
                let completed = CompletedLogin {
                    attempt_id: attempt_id.to_owned(),
                    connection_id,
                    binding_id,
                    instance: instance.clone(),
                    public_tls_ca: public_tls_ca.clone(),
                    device_id: device_id.clone(),
                    session,
                    guard,
                };
                attempt.completed = Some(completed.clone());
                delete_unlocked(&secret_entry)?;
                Ok(Some(completed))
            }
            Err(error) => Err(error),
        }
    }
    pub(crate) async fn cancel(&self, attempt_id: &str) -> Result<(), NetworkError> {
        let attempt = {
            let mut state = self.state.lock().await;
            let Some(attempt) = state.attempts.remove(attempt_id) else {
                return Ok(());
            };
            if let Ok(scope) = attempt_scope(&attempt.instance.issuer, &attempt.device_id) {
                if state.current_by_scope.get(&scope).map(String::as_str) == Some(attempt_id) {
                    state.current_by_scope.remove(&scope);
                }
                let generation = state
                    .generation_by_scope
                    .get(&scope)
                    .copied()
                    .unwrap_or(0)
                    .saturating_add(1);
                state.generation_by_scope.insert(scope, generation);
            }
            delete(&pending_entry(
                &attempt.instance,
                &attempt.device_id,
                attempt.public_tls_ca.as_deref(),
            )?)?;
            if let Some(done) = &attempt.completed {
                done.guard.valid.store(false, Ordering::Release);
                delete_account_if_binding(
                    &done.instance,
                    &done.device_id,
                    &done.session.principal_id,
                    done.public_tls_ca.as_deref(),
                    &done.binding_id,
                )?;
            }
            attempt
        };
        if attempt.completed.is_none() {
            let _ = attempt
                .client
                .cancel(
                    &attempt.device_id,
                    &attempt.transaction_id,
                    &attempt.verifier,
                )
                .await;
        } else if let Some(done) = attempt.completed {
            if let Ok((client, _)) =
                OwnedClient::discover(&done.instance.issuer, done.public_tls_ca.as_deref()).await
            {
                let _ = client.logout(&done.session.access_token).await;
            }
        }
        Ok(())
    }
    pub(crate) async fn is_current(&self, login: &CompletedLogin) -> bool {
        let state = self.state.lock().await;
        let Ok(scope) = attempt_scope(&login.instance.issuer, &login.device_id) else {
            return false;
        };
        state.current_by_scope.get(&scope).map(String::as_str) == Some(login.attempt_id.as_str())
            && state
                .attempts
                .get(&login.attempt_id)
                .and_then(|attempt| attempt.completed.as_ref())
                .is_some_and(|done| {
                    done.binding_id == login.binding_id && done.connection_id == login.connection_id
                })
    }

    pub(crate) async fn commit_if_current<T>(
        &self,
        login: &CompletedLogin,
        guard: impl FnOnce() -> Result<(), NetworkError>,
        commit: impl FnOnce() -> Result<T, NetworkError>,
    ) -> Result<T, NetworkError> {
        let mut state = self.state.lock().await;
        let scope = attempt_scope(&login.instance.issuer, &login.device_id)?;
        let exact = state.is_current(&scope, &login.attempt_id)
            && state
                .attempts
                .get(&login.attempt_id)
                .and_then(|attempt| attempt.completed.as_ref())
                .is_some_and(|current| {
                    current.binding_id == login.binding_id
                        && current.connection_id == login.connection_id
                });
        if !exact {
            return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
        }
        guard()?;
        let result = commit()?;
        state.attempts.remove(&login.attempt_id);
        state.invalidate(&scope, &login.attempt_id);
        Ok(result)
    }

    pub(crate) async fn delete_saved_session_if_binding(
        &self,
        instance: &OwnedInstance,
        device: &str,
        principal: &str,
        public_tls_ca: Option<&str>,
        expected_binding: &str,
    ) -> Result<bool, NetworkError> {
        // Serialize keyring slot mutation with poll's durable session write.
        let _state = self.state.lock().await;
        delete_account_if_binding(instance, device, principal, public_tls_ca, expected_binding)
    }
}

pub(crate) fn account_from_login(
    login: &CompletedLogin,
    join_authorized: bool,
) -> Arc<OwnedAccount> {
    // Only poll-after-persist or validated restore can mint this private grant.
    // Per-operation guards remain process-local and never re-read Keychain.
    let authorized = login.guard.clone();
    let guard = Arc::new(move || authorized.check());
    Arc::new(OwnedAccount {
        connection_id: login.connection_id.clone(),
        descriptor: login.instance.clone(),
        active: Arc::new(AtomicBool::new(true)),
        session: login.session.clone(),
        public_tls_ca: login.public_tls_ca.clone(),
        join_authorized: AtomicBool::new(join_authorized),
        guard,
    })
}

/// Remove a session only if the slot still contains this login generation.
/// A late cancelled poll must never delete a newer login saved to the same slot.
pub(crate) fn delete_account_if_binding(
    instance: &OwnedInstance,
    device: &str,
    principal: &str,
    public_tls_ca: Option<&str>,
    expected_binding: &str,
) -> Result<bool, NetworkError> {
    let _storage = storage_transaction_lock();
    #[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
    {
        let legacy = key(instance, device, principal, public_tls_ca);
        let removed = super::credential_slots::with_deleted_route_family(
            &format!("session:{legacy}"),
            |selection| {
                let physical = match session_physical_hash(&legacy, selection)? {
                    Some(hash) => hash,
                    None => return Ok(None),
                };
                let selected = entry(&format!("session:{physical}"))?;
                let Some(SecretRecord::Session { binding_id, .. }) = read_unlocked(&selected)?
                else {
                    return Ok::<_, NetworkError>(None);
                };
                if binding_id != expected_binding {
                    return Ok(None);
                }
                Ok(Some(selected))
            },
            |selected| delete_unlocked(&selected),
        )?;
        let slot = SessionSlot::new(instance, device, principal, public_tls_ca)?;
        session_guard_cache().invalidate_binding(&slot, expected_binding);
        return Ok(removed);
    }
    #[cfg(not(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa))))]
    {
        let entry = session_entry(instance, device, principal, public_tls_ca)?;
        let Some(SecretRecord::Session { binding_id, .. }) = read_unlocked(&entry)? else {
            let slot = SessionSlot::new(instance, device, principal, public_tls_ca)?;
            session_guard_cache().invalidate_binding(&slot, expected_binding);
            return Ok(false);
        };
        if binding_id != expected_binding {
            return Ok(false);
        }
        delete_unlocked(&entry)?;
        let slot = SessionSlot::new(instance, device, principal, public_tls_ca)?;
        session_guard_cache().invalidate_binding(&slot, expected_binding);
        Ok(true)
    }
}

pub(crate) fn restore_account(
    instance: &OwnedInstance,
    device: &str,
    principal: &str,
    connection_id: &str,
    binding_id: &str,
    public_tls_ca: Option<&str>,
    join_authorized: bool,
) -> Result<Option<Arc<OwnedAccount>>, NetworkError> {
    let _storage = storage_transaction_lock();
    let record = read_unlocked(&session_entry(instance, device, principal, public_tls_ca)?)?;
    restore_account_from_record(
        instance,
        device,
        principal,
        connection_id,
        binding_id,
        public_tls_ca,
        join_authorized,
        record,
    )
}

pub(crate) fn restore_account_authorized(
    instance: &OwnedInstance,
    device: &str,
    principal: &str,
    connection_id: &str,
    binding_id: &str,
    public_tls_ca: Option<&str>,
    join_authorized: bool,
    cancelled: &AtomicBool,
) -> Result<Option<Arc<OwnedAccount>>, NetworkError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
    }
    let _storage = storage_transaction_lock();
    #[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
    let validated = {
        use super::credential_slots::RouteSelection as Selection;
        let logical = key(instance, device, principal, public_tls_ca);
        let route_id = format!("session:{logical}");
        let target = super::credential_slots::selected_writer_selection()?;
        let mut validated = None;
        crate::ulog_info!("[credential-migration] stage=session-source-read outcome=start");
        let transaction = super::credential_slots::with_committed_route(&route_id, |selection| {
            if cancelled.load(Ordering::Acquire) {
                return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
            }
            if selection == Selection::Deleted {
                return Err(NetworkError::new("NETWORK_CREDENTIAL_KEY_MISSING"));
            }
            let source_entry =
                session_entry_for_route(instance, device, principal, public_tls_ca, selection)?;
            let source_read = read_authorized_unlocked(&source_entry, cancelled);
            crate::ulog_info!(
                "[credential-migration] stage=session-source-read outcome={}",
                match &source_read {
                    Ok(Some(_)) => "read",
                    Ok(None) => "missing",
                    Err(_) => "failed",
                }
            );
            let record =
                source_read?.ok_or_else(|| NetworkError::new("OWNED_SESSION_RECORD_MISSING"))?;
            let encoded = serialized_secret(&record)?;
            let checked = validate_session_record(
                instance,
                device,
                principal,
                connection_id,
                binding_id,
                public_tls_ca,
                Some(record),
            );
            crate::ulog_info!(
                "[credential-migration] stage=session-source-read-validation outcome={}",
                if checked.is_ok() { "ok" } else { "failed" }
            );
            let checked =
                checked?.ok_or_else(|| NetworkError::new("OWNED_SESSION_RECORD_MISSING"))?;
            if cancelled.load(Ordering::Acquire) {
                return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
            }
            let target_entry =
                session_entry_for_route(instance, device, principal, public_tls_ca, target)?;
            write_session_family_route(
                selection,
                target,
                true,
                encoded.as_slice(),
                |family| {
                    if family == selection {
                        return Ok(Some(encoded.clone()));
                    }
                    let entry = session_entry_for_route(
                        instance,
                        device,
                        principal,
                        public_tls_ca,
                        family,
                    )?;
                    read_unlocked(&entry)?
                        .as_ref()
                        .map(serialized_secret)
                        .transpose()
                },
                |_| write_encoded_unlocked(&target_entry, encoded.as_slice()),
                || validate_restore_commit_fence(&checked, instance, cancelled),
            )?;
            validated = Some(checked);
            Ok(())
        });
        crate::ulog_info!(
            "[credential-migration] stage=session-route-commit outcome={}",
            if transaction.is_ok() { "ok" } else { "failed" }
        );
        transaction?;
        validated.ok_or_else(|| NetworkError::new("OWNED_SESSION_RECORD_MISSING"))?
    };
    #[cfg(not(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa))))]
    {
        let record = read_authorized_unlocked(
            &session_entry(instance, device, principal, public_tls_ca)?,
            cancelled,
        )?;
        let validated = validate_session_record(
            instance,
            device,
            principal,
            connection_id,
            binding_id,
            public_tls_ca,
            record,
        )?;
        if cancelled.load(Ordering::Acquire) {
            return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
        }
        return match validated {
            Some(validated) => {
                let restored = publish_validated_session(validated, join_authorized)?;
                restore_if_not_cancelled(Some(restored), cancelled)
            }
            None => Ok(None),
        };
    }
    #[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
    if cancelled.load(Ordering::Acquire) {
        return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
    }
    #[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
    let restored = publish_validated_session(validated, join_authorized)?;
    #[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
    restore_if_not_cancelled(Some(restored), cancelled)
}

#[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
fn current_account_binding(account: &OwnedAccount, device: &str) -> Result<String, NetworkError> {
    (account.guard)()?;
    let slot = SessionSlot::new(
        &account.descriptor,
        device,
        &account.session.principal_id,
        account.public_tls_ca.as_deref(),
    )?;
    let state = SessionGuardCache::lock(&session_guard_cache().state);
    let current = state
        .entries
        .get(&slot)
        .ok_or_else(|| NetworkError::new("ACCOUNT_BINDING_CHANGED"))?;
    current.check()?;
    if current.connection_id != account.connection_id
        || current.expires_at != account.session.expires_at
    {
        return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
    }
    Ok(current.binding_id.clone())
}

#[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
pub(crate) fn promote_current_account(
    account: &OwnedAccount,
    device: &str,
    cancelled: &AtomicBool,
) -> Result<(), NetworkError> {
    let binding = current_account_binding(account, device)?;
    promote_account(account, device, &binding, cancelled)
}

/// Persist only a session already validated by the account/identity owners.
/// Legacy encrypted records remain unchanged for rollback. The durable route
/// prevents a later missing/deleted current item from reviving a legacy token.
#[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
pub(crate) fn promote_account(
    account: &OwnedAccount,
    device: &str,
    binding: &str,
    cancelled: &AtomicBool,
) -> Result<(), NetworkError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
    }
    (account.guard)()?;
    if current_account_binding(account, device)? != binding {
        return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
    }
    let _storage = storage_transaction_lock();
    let record = SecretRecord::Session {
        version: VERSION,
        instance: account.descriptor.clone(),
        public_tls_ca: account.public_tls_ca.clone(),
        device_id: device.to_owned(),
        principal_id: account.session.principal_id.clone(),
        network_id: account.session.network_id.clone(),
        session: account.session.clone(),
        connection_id: account.connection_id.clone(),
        binding_id: binding.to_owned(),
    };
    account.session.validate(&account.descriptor)?;
    if cancelled.load(Ordering::Acquire) {
        return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
    }
    (account.guard)()?;
    write_session_unlocked(
        &account.descriptor,
        device,
        &account.session.principal_id,
        account.public_tls_ca.as_deref(),
        &record,
        true,
        || {
            if cancelled.load(Ordering::Acquire) {
                return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
            }
            (account.guard)()
        },
    )?;
    if cancelled.load(Ordering::Acquire) {
        return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
    }
    (account.guard)()?;
    Ok(())
}

/// Shared post-read validation. The caller holds the session storage transaction
/// lock across credential read and guard publication.
fn restore_account_from_record(
    instance: &OwnedInstance,
    device: &str,
    principal: &str,
    connection_id: &str,
    binding_id: &str,
    public_tls_ca: Option<&str>,
    join_authorized: bool,
    record: Option<SecretRecord>,
) -> Result<Option<Arc<OwnedAccount>>, NetworkError> {
    let Some(validated) = validate_session_record(
        instance,
        device,
        principal,
        connection_id,
        binding_id,
        public_tls_ca,
        record,
    )?
    else {
        return Ok(None);
    };
    publish_validated_session(validated, join_authorized).map(Some)
}

struct ValidatedSession {
    instance: OwnedInstance,
    public_tls_ca: Option<String>,
    device_id: String,
    session: OwnedSession,
    connection_id: String,
    binding_id: String,
}

fn validate_session_record(
    instance: &OwnedInstance,
    device: &str,
    principal: &str,
    connection_id: &str,
    binding_id: &str,
    public_tls_ca: Option<&str>,
    record: Option<SecretRecord>,
) -> Result<Option<ValidatedSession>, NetworkError> {
    let Some(SecretRecord::Session {
        version,
        instance: saved,
        public_tls_ca: saved_ca,
        device_id,
        principal_id,
        network_id,
        session,
        connection_id: saved_connection,
        binding_id: saved_binding,
    }) = record
    else {
        return Ok(None);
    };
    if version != VERSION
        || device_id != device
        || principal_id != principal
        || network_id != instance.network_id
        || saved_connection != connection_id
        || saved_binding != binding_id
        || saved_ca.as_deref() != public_tls_ca
    {
        return Err(NetworkError::new("NETWORK_CREDENTIAL_STORE_INVALID"));
    }
    instance.ensure_same_trust(&saved)?;
    session.validate(instance)?;
    Ok(Some(ValidatedSession {
        instance: saved,
        public_tls_ca: saved_ca,
        device_id,
        session,
        connection_id: saved_connection,
        binding_id: saved_binding,
    }))
}

#[cfg(any(test, all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa))))]
fn validate_restore_commit_fence(
    validated: &ValidatedSession,
    instance: &OwnedInstance,
    cancelled: &AtomicBool,
) -> Result<(), NetworkError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
    }
    validated.session.validate(instance)?;
    if cancelled.load(Ordering::Acquire) {
        return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
    }
    Ok(())
}

fn publish_validated_session(
    validated: ValidatedSession,
    join_authorized: bool,
) -> Result<Arc<OwnedAccount>, NetworkError> {
    let slot = SessionSlot::new(
        &validated.instance,
        &validated.device_id,
        &validated.session.principal_id,
        validated.public_tls_ca.as_deref(),
    )?;
    session_guard_cache().ensure_capacity(&slot)?;
    let guard = session_guard_cache().authorize(
        slot,
        &validated.binding_id,
        &validated.connection_id,
        validated.session.expires_at,
    )?;
    let completed = CompletedLogin {
        attempt_id: String::new(),
        connection_id: validated.connection_id,
        binding_id: validated.binding_id,
        instance: validated.instance,
        public_tls_ca: validated.public_tls_ca,
        device_id: validated.device_id,
        guard,
        session: validated.session,
    };
    Ok(account_from_login(&completed, join_authorized))
}

pub(crate) fn load_session_for_removal(
    instance: &OwnedInstance,
    device: &str,
    principal: &str,
    connection_id: &str,
    binding_id: &str,
    public_tls_ca: Option<&str>,
) -> Result<Option<OwnedSession>, NetworkError> {
    let _storage = storage_transaction_lock();
    let Some(SecretRecord::Session {
        version,
        instance: saved,
        public_tls_ca: saved_ca,
        device_id,
        principal_id,
        network_id,
        session,
        connection_id: saved_connection,
        binding_id: saved_binding,
    }) = read_unlocked(&session_entry(instance, device, principal, public_tls_ca)?)?
    else {
        return Ok(None);
    };
    if version != VERSION
        || device_id != device
        || principal_id != principal
        || network_id != instance.network_id
        || saved_connection != connection_id
        || saved_ca.as_deref() != public_tls_ca
    {
        return Err(NetworkError::new("NETWORK_CREDENTIAL_STORE_INVALID"));
    }
    if saved_binding != binding_id {
        return Ok(None);
    }
    instance.ensure_same_trust(&saved)?;
    // Removal must still clear a locally stored expired token. Expiry affects
    // whether it can authorize requests, not whether it may be deleted/revoked.
    if uuid::Uuid::parse_str(&session.principal_id)
        .map(|id| id.to_string())
        .as_deref()
        != Ok(session.principal_id.as_str())
        || session.principal_id != principal
        || session.network_id != instance.network_id
        || session.access_token.len() != 43
        || !session
            .access_token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(NetworkError::new("NETWORK_CREDENTIAL_STORE_INVALID"));
    }
    Ok(Some(session))
}

#[cfg(test)]
mod tests {
    use super::{
        account_from_login, now, storage_transaction_lock, AuthorizedSessionGuard, CompletedLogin,
        OwnedInstance, SessionGuardCache, SessionSlot, State, KEYRING_READS,
    };
    use crate::agent_network::{credential_slots, NetworkError};
    use std::sync::{atomic::AtomicBool, mpsc, Arc, Mutex};
    use zeroize::Zeroizing;

    fn instance(network_id: &str) -> OwnedInstance {
        OwnedInstance {
            version: 1,
            profile: "owned-device-relay-v1".into(),
            service_id: "00000000-0000-0000-0000-000000000001".into(),
            environment: "development".into(),
            network_id: network_id.into(),
            name: "test service".into(),
            issuer: format!("https://{network_id}.example"),
            login_issuer: "https://login.example/dex".into(),
            protocol: 1,
            capabilities: vec!["tls13-mtls".into()],
            root_certificate: "test root".into(),
            jwks: serde_json::json!({}),
        }
    }

    fn slot(network_id: &str, ca: Option<&str>) -> SessionSlot {
        SessionSlot::new(&instance(network_id), "device-1", "principal-1", ca).unwrap()
    }

    #[test]
    fn session_route_migration_uses_authorized_source_and_confirms_before_commit() {
        use crate::agent_network::credential_slots::RouteSelection as R;
        use std::{cell::RefCell, collections::HashMap};

        let records = RefCell::new(HashMap::<u8, Vec<u8>>::from([(1, b"old".to_vec())]));
        let read = |selection| {
            let key = match selection {
                R::Legacy => 0,
                R::LocalV1 => 1,
                R::DeveloperIdV2 => 2,
                R::Deleted => {
                    return Err(NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))
                }
            };
            Ok(records.borrow().get(&key).cloned().map(Zeroizing::new))
        };
        let writes = std::cell::Cell::new(0);
        let write = |selection| {
            let key = match selection {
                R::Legacy => 0,
                R::LocalV1 => 1,
                R::DeveloperIdV2 => 2,
                R::Deleted => {
                    return Err(NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))
                }
            };
            writes.set(writes.get() + 1);
            records.borrow_mut().insert(key, b"old".to_vec());
            Ok(())
        };
        let committed = std::cell::Cell::new(false);
        super::write_session_family_route(
            R::LocalV1,
            R::DeveloperIdV2,
            true,
            b"old",
            read,
            write,
            || {
                committed.set(true);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(writes.get(), 1);
        assert_eq!(
            records.borrow().get(&2).map(Vec::as_slice),
            Some(b"old".as_slice())
        );
        assert!(committed.get());
    }

    #[test]
    fn session_route_source_authorization_failure_does_not_read_or_write_destination() {
        use crate::agent_network::credential_slots::RouteSelection as R;
        use std::cell::Cell;

        let destination_reads = Cell::new(0);
        let writes = Cell::new(0);
        let error = super::write_session_family_route(
            R::LocalV1,
            R::DeveloperIdV2,
            true,
            b"session",
            |selection| {
                if selection == R::DeveloperIdV2 {
                    destination_reads.set(destination_reads.get() + 1);
                }
                assert_eq!(selection, R::LocalV1);
                Err(NetworkError::new(
                    "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED",
                ))
            },
            |_| {
                writes.set(writes.get() + 1);
                Ok(())
            },
            || Ok(()),
        )
        .unwrap_err();
        assert_eq!(
            error.code,
            "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED"
        );
        assert_eq!(destination_reads.get(), 0);
        assert_eq!(writes.get(), 0);
    }

    #[test]
    fn session_same_family_authorized_read_is_the_readback() {
        use crate::agent_network::credential_slots::RouteSelection as R;
        use std::cell::Cell;

        let reads = Cell::new(0);
        super::write_session_family_route(
            R::DeveloperIdV2,
            R::DeveloperIdV2,
            true,
            b"same",
            |_| {
                reads.set(reads.get() + 1);
                Ok(Some(Zeroizing::new(b"same".to_vec())))
            },
            |_| panic!("same-family recovery must not write"),
            || Ok(()),
        )
        .unwrap();
        assert_eq!(reads.get(), 1);
    }

    #[test]
    fn session_expiring_during_destination_write_does_not_commit_route() {
        use crate::agent_network::credential_slots::RouteSelection as R;
        use std::{cell::RefCell, collections::HashMap};

        let instance = instance("expiry-fence");
        let validated = RefCell::new(super::ValidatedSession {
            instance: instance.clone(),
            public_tls_ca: None,
            device_id: "device-1".into(),
            session: super::OwnedSession {
                access_token: "a".repeat(43),
                expires_at: now().saturating_add(600),
                principal_id: "00000000-0000-4000-8000-000000000003".into(),
                network_id: instance.network_id.clone(),
            },
            connection_id: "connection".into(),
            binding_id: "binding".into(),
        });
        let records = RefCell::new(HashMap::<u8, Vec<u8>>::from([(1, b"session".to_vec())]));
        let write_seen = std::cell::Cell::new(false);
        let reads = |family| {
            let key = match family {
                R::Legacy => 0,
                R::LocalV1 => 1,
                R::DeveloperIdV2 => 2,
                R::Deleted => {
                    return Err(NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))
                }
            };
            Ok(records.borrow().get(&key).cloned().map(Zeroizing::new))
        };
        let writes = |family| {
            assert_eq!(family, R::DeveloperIdV2);
            records.borrow_mut().insert(2, b"session".to_vec());
            write_seen.set(true);
            Ok(())
        };
        let cancelled = AtomicBool::new(false);
        let checks = std::cell::Cell::new(0);
        let committed = std::cell::Cell::new(false);
        let result = super::write_session_family_route(
            R::LocalV1,
            R::DeveloperIdV2,
            true,
            b"session",
            reads,
            writes,
            || {
                let check = checks.get() + 1;
                checks.set(check);
                if check == 2 {
                    // Model the authorized target operation crossing expiry.
                    validated.borrow_mut().session.expires_at = now();
                }
                super::validate_restore_commit_fence(&validated.borrow(), &instance, &cancelled)
            },
        );
        if result.is_ok() {
            committed.set(true);
        }
        assert_eq!(result.unwrap_err().code, "OWNED_SESSION_INVALID");
        assert!(write_seen.get());
        assert_eq!(checks.get(), 2);
        assert!(!committed.get());
    }

    #[test]
    fn session_route_refuses_binding_change_and_deleted_restore_but_allows_fresh_auth() {
        use crate::agent_network::credential_slots::RouteSelection as R;
        use std::cell::Cell;

        let writes = Cell::new(0);
        let mismatch = super::write_session_family_route(
            R::LocalV1,
            R::DeveloperIdV2,
            true,
            b"expected",
            |_| Ok(Some(Zeroizing::new(b"new binding".to_vec()))),
            |_| {
                writes.set(writes.get() + 1);
                Ok(())
            },
            || Ok(()),
        )
        .unwrap_err();
        assert_eq!(mismatch.code, "ACCOUNT_BINDING_CHANGED");
        let deleted = super::write_session_family_route(
            R::Deleted,
            R::DeveloperIdV2,
            true,
            b"fresh",
            |_| panic!("deleted preserve-existing route must not read storage"),
            |_| {
                writes.set(writes.get() + 1);
                Ok(())
            },
            || Ok(()),
        )
        .unwrap_err();
        assert_eq!(deleted.code, "NETWORK_CREDENTIAL_STORE_UNAVAILABLE");

        let stored = std::cell::RefCell::new(None);
        super::write_session_family_route(
            R::Deleted,
            R::DeveloperIdV2,
            false,
            b"fresh",
            |_| Ok(stored.borrow().clone().map(Zeroizing::new)),
            |_| {
                *stored.borrow_mut() = Some(b"fresh".to_vec());
                Ok(())
            },
            || Ok(()),
        )
        .unwrap();
        assert_eq!(stored.borrow().as_deref(), Some(b"fresh".as_slice()));
        assert_eq!(writes.get(), 0);
    }

    #[test]
    fn session_route_unknown_write_or_cancellation_never_reports_commit_success() {
        use crate::agent_network::credential_slots::RouteSelection as R;
        use std::{
            cell::Cell,
            sync::atomic::{AtomicBool, Ordering},
        };

        let stored = Cell::new(false);
        let unknown = super::write_session_family_route(
            R::Legacy,
            R::DeveloperIdV2,
            false,
            b"fresh",
            |_| Ok(stored.get().then(|| Zeroizing::new(b"fresh".to_vec()))),
            |_| {
                stored.set(true); // Simulate an OS write whose acknowledgement is lost.
                Err(NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))
            },
            || Ok(()),
        )
        .unwrap_err();
        assert_eq!(unknown.code, "NETWORK_CREDENTIAL_STORE_UNAVAILABLE");
        assert!(stored.get());

        let cancelled = AtomicBool::new(false);
        let checks = Cell::new(0);
        let result = super::write_session_family_route(
            R::Legacy,
            R::DeveloperIdV2,
            false,
            b"new",
            |_| Ok(Some(Zeroizing::new(b"new".to_vec()))),
            |_| {
                cancelled.store(true, Ordering::Release);
                Ok(())
            },
            || {
                if checks.get() > 0 || cancelled.load(Ordering::Acquire) {
                    return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
                }
                checks.set(checks.get() + 1);
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(result.code, "OWNED_LOGIN_CANCELLED");
        assert_eq!(checks.get(), 1);
    }

    #[test]
    fn session_slot_preserves_and_isolates_full_oidc_issuer_path() {
        let dex = instance("network-issuer-path");
        let mut other_path = dex.clone();
        other_path.login_issuer = "https://login.example/another-tenant".into();

        let dex_slot = SessionSlot::new(&dex, "device-1", "principal-1", None).unwrap();
        let other_slot = SessionSlot::new(&other_path, "device-1", "principal-1", None).unwrap();

        assert_eq!(dex_slot.login_issuer, "https://login.example/dex");
        assert_eq!(
            other_slot.login_issuer,
            "https://login.example/another-tenant"
        );
        assert_ne!(dex_slot, other_slot);
    }

    #[test]
    fn session_physical_slot_selection_keeps_legacy_local_and_developer_families_distinct() {
        let instance = instance("slot-family");
        let logical = super::key(&instance, "device-1", "principal-1", None);
        let legacy =
            super::session_physical_hash(&logical, credential_slots::RouteSelection::Legacy)
                .unwrap()
                .unwrap();
        let old = super::session_physical_hash(&logical, credential_slots::RouteSelection::LocalV1)
            .unwrap()
            .unwrap();
        let current =
            super::session_physical_hash(&logical, credential_slots::RouteSelection::DeveloperIdV2)
                .unwrap()
                .unwrap();
        assert_eq!(legacy, logical);
        assert_eq!(old, credential_slots::session_hash(&logical).unwrap());
        assert_eq!(
            current,
            credential_slots::developer_id_session_hash(&logical).unwrap()
        );
        assert_ne!(old, current);
        assert_eq!(
            super::session_physical_hash(&logical, credential_slots::RouteSelection::Deleted,)
                .unwrap(),
            None
        );
    }

    #[test]
    fn guard_cache_replaces_exact_binding_and_isolates_full_scope() {
        let cache = SessionGuardCache::default();
        let first_slot = slot("network-1", Some("ca-one"));
        let other_slot = slot("network-2", Some("ca-one"));
        let expires = now() + 3600;
        let old = cache
            .authorize(first_slot.clone(), "binding-old", "connection-old", expires)
            .unwrap();
        let isolated = cache
            .authorize(
                other_slot.clone(),
                "binding-other",
                "connection-other",
                expires,
            )
            .unwrap();
        old.check().unwrap();

        let current = cache
            .authorize(first_slot.clone(), "binding-new", "connection-new", expires)
            .unwrap();
        assert_eq!(old.check().unwrap_err().code, "ACCOUNT_BINDING_CHANGED");
        cache.invalidate_binding(&first_slot, "binding-old");
        current.check().unwrap();
        isolated.check().unwrap();

        // Starting a replacement login does not revoke a still-durable session.
        // Its guard is replaced only after a new session has been persisted.
        current.check().unwrap();
        isolated.check().unwrap();
        let replacement = cache
            .authorize(first_slot, "binding-final", "connection-final", expires)
            .unwrap();
        assert_eq!(current.check().unwrap_err().code, "ACCOUNT_BINDING_CHANGED");
        replacement.check().unwrap();
    }

    #[test]
    fn cancelled_restore_does_not_invalidate_an_existing_shared_guard() {
        let cache = SessionGuardCache::default();
        let slot = slot("network-cancelled-restore", None);
        let guard = cache
            .authorize(slot, "binding-current", "connection-current", now() + 3600)
            .unwrap();
        let cancelled = AtomicBool::new(true);
        assert_eq!(
            super::restore_if_not_cancelled(Some(()), &cancelled)
                .unwrap_err()
                .code,
            "OWNED_LOGIN_CANCELLED"
        );
        guard.check().unwrap();
    }

    #[test]
    fn repeated_account_validation_uses_cached_guard_without_keyring_reads() {
        let instance = instance("network-check");
        let session = super::super::owned_login::OwnedSession {
            access_token: "a".repeat(43),
            expires_at: now() + 3600,
            principal_id: "00000000-0000-0000-0000-000000000002".into(),
            network_id: instance.network_id.clone(),
        };
        let guard = Arc::new(AuthorizedSessionGuard {
            binding_id: "binding".into(),
            connection_id: "connection".into(),
            generation: 1,
            expires_at: session.expires_at,
            valid: AtomicBool::new(true),
        });
        let login = CompletedLogin {
            attempt_id: "attempt".into(),
            connection_id: "connection".into(),
            binding_id: "binding".into(),
            instance,
            public_tls_ca: None,
            device_id: "device-1".into(),
            session,
            guard,
        };
        let account = account_from_login(&login, true);
        let account = super::super::account::NetworkAccountSession::Owned(account);
        let reads_before = KEYRING_READS.with(|reads| reads.get());
        for _ in 0..8 {
            account.ensure_current().unwrap();
        }
        let reads_after = KEYRING_READS.with(|reads| reads.get());
        assert_eq!(reads_after, reads_before);
    }

    #[test]
    fn guard_expiry_and_capacity_fail_closed_without_evicting_live_sessions() {
        let cache = SessionGuardCache::default();
        let expired_slot = slot("network-expired", None);
        assert_eq!(
            cache
                .authorize(
                    expired_slot,
                    "binding",
                    "connection",
                    now().saturating_sub(1),
                )
                .err()
                .unwrap()
                .code,
            "ACCOUNT_BINDING_CHANGED"
        );

        let expiry = now() + 3600;
        let mut first = None;
        for index in 0..super::SESSION_GUARD_LIMIT {
            let network_id = format!("network-{index}");
            let grant = cache
                .authorize(
                    slot(&network_id, None),
                    &format!("binding-{index}"),
                    &format!("connection-{index}"),
                    expiry,
                )
                .unwrap();
            if index == 0 {
                first = Some(grant);
            }
        }
        let overflow = cache.ensure_capacity(&slot("network-overflow", None));
        assert_eq!(overflow.unwrap_err().code, "NETWORK_REQUEST_CAPACITY");
        first.unwrap().check().unwrap();
    }

    #[test]
    fn serialized_restore_cannot_republish_old_guard_after_new_poll_commit() {
        let cache = Arc::new(SessionGuardCache::default());
        let session_slot = slot("network-race", None);
        let persisted = Arc::new(Mutex::new((
            "binding-old".to_owned(),
            "connection-old".to_owned(),
        )));
        let (read_tx, read_rx) = mpsc::channel();
        let (continue_tx, continue_rx) = mpsc::channel();
        let restore_cache = cache.clone();
        let restore_slot = session_slot.clone();
        let restore_persisted = persisted.clone();
        let restore = std::thread::spawn(move || {
            let _transaction = storage_transaction_lock();
            let snapshot = restore_persisted.lock().unwrap().clone();
            read_tx.send(()).unwrap();
            continue_rx.recv().unwrap();
            restore_cache
                .authorize(restore_slot, &snapshot.0, &snapshot.1, now() + 3600)
                .unwrap()
        });
        read_rx.recv().unwrap();

        let poll_cache = cache.clone();
        let poll_slot = session_slot.clone();
        let poll_persisted = persisted.clone();
        let (poll_started_tx, poll_started_rx) = mpsc::channel();
        let poll = std::thread::spawn(move || {
            poll_started_tx.send(()).unwrap();
            let _transaction = storage_transaction_lock();
            *poll_persisted.lock().unwrap() =
                ("binding-new".to_owned(), "connection-new".to_owned());
            poll_cache
                .authorize(poll_slot, "binding-new", "connection-new", now() + 3600)
                .unwrap()
        });
        poll_started_rx.recv().unwrap();
        continue_tx.send(()).unwrap();
        let restored_guard = restore.join().unwrap();
        let polled_guard = poll.join().unwrap();
        assert_eq!(
            restored_guard.check().unwrap_err().code,
            "ACCOUNT_BINDING_CHANGED"
        );
        polled_guard.check().unwrap();
    }

    #[test]
    fn cancel_invalidates_late_poll_completion() {
        let mut state = State::default();
        let (generation, _) = state.begin("issuer/device");
        assert!(state.register("issuer/device", generation, "attempt-old"));
        assert!(state.is_current("issuer/device", "attempt-old"));

        // A poll may be in flight without holding the manager mutex. Cancel
        // first removes its local authority, then performs network cleanup.
        assert!(state.invalidate("issuer/device", "attempt-old"));
        assert!(!state.is_current("issuer/device", "attempt-old"));
        assert!(!state.register("issuer/device", generation, "attempt-old"));
    }

    #[test]
    fn newer_attempt_fences_old_start_and_poll_results() {
        let mut state = State::default();
        let (old_generation, _) = state.begin("issuer/device");
        assert!(state.register("issuer/device", old_generation, "attempt-old"));

        // Starting again advances the scope generation before any remote await.
        let (new_generation, old_id) = state.begin("issuer/device");
        assert_eq!(old_id.as_deref(), Some("attempt-old"));
        assert!(!state.register("issuer/device", old_generation, "attempt-old"));
        assert!(state.register("issuer/device", new_generation, "attempt-new"));

        // A late response from the old poll cannot be mistaken for the current attempt.
        assert!(!state.is_current("issuer/device", "attempt-old"));
        assert!(state.is_current("issuer/device", "attempt-new"));
    }
}

#[cfg(all(test, myagents_updater_qa))]
mod updater_qa_credential_tests {
    #[test]
    fn qa_never_constructs_an_os_keyring_entry() {
        let error = super::entry("synthetic-only").err().expect("QA entry is disabled");
        assert_eq!(error.code, "UPDATER_QA_CREDENTIALS_DISABLED");
    }
}
