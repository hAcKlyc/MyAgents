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

// QA uses the same closed reader protocol inside its separately verified private
// Keychain. The account hash also includes APP_DATA_DIR_NAME; no slot migration.
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
    owner_device_id: String,
    child_epoch: u64,
    candidates: Vec<super::registry::StoredOwnedConnection>,
    selected_id: String,
    reuse_identity: bool,
    expected_principal: Option<String>,
    resolved_candidate: Option<super::registry::StoredOwnedConnection>,
    staged_session: Option<OwnedSession>,
    commit_unconfirmed: bool,
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
    pub owner_device_id: String,
    pub session_bound: bool,
    pub candidates: Vec<super::registry::StoredOwnedConnection>,
    pub replaces: Option<String>,
    pub session: OwnedSession,
    pub identity_store: Option<Arc<dyn super::crypto::IdentityStore>>,
    pub preserve_membership: bool,
    guard: Arc<AuthorizedSessionGuard>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartedLogin {
    pub attempt_id: String,
    pub authorization_url: String,
    pub expires_at: u64,
}
pub(crate) enum LoginProgress {
    Pending,
    Reauthorize(StartedLogin),
    Authenticated(CompletedLogin),
}
#[derive(Default)]
struct State {
    attempts: HashMap<String, Attempt>,
    current_by_scope: HashMap<String, String>,
    generation_by_scope: HashMap<String, u64>,
}
impl State {
    fn ensure_startable(&self, scope: &str) -> Result<(), NetworkError> {
        if self
            .current_by_scope
            .get(scope)
            .and_then(|id| self.attempts.get(id))
            .is_some_and(|attempt| attempt.commit_unconfirmed)
        {
            return Err(NetworkError::new("OWNED_LOGIN_COMMIT_UNCONFIRMED"));
        }
        Ok(())
    }
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
    if crate::app_dirs::IS_UPDATER_QA {
        return Err(NetworkError::new("UPDATER_QA_CREDENTIALS_DISABLED"));
    }
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
fn session_key(
    instance: &OwnedInstance,
    device: &str,
    principal: &str,
    ca: Option<&str>,
    binding: Option<&str>,
) -> String {
    let legacy = key(instance, device, principal, ca);
    binding
        .map(|binding| {
            URL_SAFE_NO_PAD.encode(Sha256::digest(
                format!("{legacy}\nbinding:{binding}").as_bytes(),
            ))
        })
        .unwrap_or(legacy)
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
    #[cfg(all(
        target_os = "macos",
        myagents_moxbot,
        not(test),
        not(myagents_isolated_qa)
    ))]
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
    binding: Option<&str>,
) -> Result<Entry, NetworkError> {
    let hash = session_key(instance, device_id, principal, public_tls_ca, binding);
    #[cfg(all(
        target_os = "macos",
        myagents_moxbot,
        not(test),
        not(myagents_isolated_qa)
    ))]
    let hash = session_physical_hash(
        &hash,
        super::credential_slots::selection(&format!("session:{hash}"))?,
    )?
    .ok_or_else(|| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))?;
    // A committed route never falls back when its current item is missing.
    entry(&format!("session:{hash}"))
}
#[cfg(all(
    target_os = "macos",
    myagents_moxbot,
    not(test),
    not(myagents_isolated_qa)
))]
fn session_entry_for_route(
    instance: &OwnedInstance,
    device_id: &str,
    principal: &str,
    public_tls_ca: Option<&str>,
    selection: super::credential_slots::RouteSelection,
    binding: Option<&str>,
) -> Result<Entry, NetworkError> {
    let logical = session_key(instance, device_id, principal, public_tls_ca, binding);
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
    binding: Option<&str>,
    _preserve_existing: bool,
    before_commit: impl Fn() -> Result<(), NetworkError>,
) -> Result<(), NetworkError> {
    #[cfg(all(
        target_os = "macos",
        myagents_moxbot,
        not(test),
        not(myagents_isolated_qa)
    ))]
    {
        let legacy = session_key(instance, device_id, principal, public_tls_ca, binding);
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
    #[cfg(not(all(
        target_os = "macos",
        myagents_moxbot,
        not(test),
        not(myagents_isolated_qa)
    )))]
    {
        before_commit()?;
        write_unlocked(
            &session_entry(instance, device_id, principal, public_tls_ca, binding)?,
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
            #[cfg(all(
                target_os = "macos",
                myagents_moxbot,
                not(test),
                not(myagents_isolated_qa)
            ))]
            crate::ulog_info!(
                "[credential-migration] stage=session-confirm outcome=authorized-source"
            );
        } else {
            #[cfg(all(
                target_os = "macos",
                myagents_moxbot,
                not(test),
                not(myagents_isolated_qa)
            ))]
            crate::ulog_info!(
                "[credential-migration] stage=session-destination-read outcome=start"
            );
            let target_read = read(target);
            #[cfg(all(
                target_os = "macos",
                myagents_moxbot,
                not(test),
                not(myagents_isolated_qa)
            ))]
            crate::ulog_info!(
                "[credential-migration] stage=session-destination-read outcome={}",
                if target_read.is_ok() { "ok" } else { "failed" }
            );
            match target_read? {
                Some(existing) if existing.as_slice() == expected => target_confirmed = true,
                Some(_) => return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED")),
                None => {
                    #[cfg(all(
                        target_os = "macos",
                        myagents_moxbot,
                        not(test),
                        not(myagents_isolated_qa)
                    ))]
                    crate::ulog_info!(
                        "[credential-migration] stage=session-destination-write outcome=start"
                    );
                    let result = write(target);
                    #[cfg(all(
                        target_os = "macos",
                        myagents_moxbot,
                        not(test),
                        not(myagents_isolated_qa)
                    ))]
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
        #[cfg(all(
            target_os = "macos",
            myagents_moxbot,
            not(test),
            not(myagents_isolated_qa)
        ))]
        crate::ulog_info!("[credential-migration] stage=session-confirm outcome=start");
        let result = read(target);
        #[cfg(all(
            target_os = "macos",
            myagents_moxbot,
            not(test),
            not(myagents_isolated_qa)
        ))]
        crate::ulog_info!(
            "[credential-migration] stage=session-confirm outcome={}",
            if result.is_ok() { "read" } else { "failed" }
        );
        let confirmed =
            result?.ok_or_else(|| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))?;
        if confirmed.as_slice() != expected {
            return Err(NetworkError::new("NETWORK_CREDENTIAL_STORE_INVALID"));
        }
        #[cfg(all(
            target_os = "macos",
            myagents_moxbot,
            not(test),
            not(myagents_isolated_qa)
        ))]
        crate::ulog_info!("[credential-migration] stage=session-confirm outcome=ok");
    }
    before_commit()?;
    Ok(())
}
#[cfg(all(
    target_os = "macos",
    myagents_moxbot,
    not(test),
    not(myagents_isolated_qa)
))]
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
    #[cfg(all(target_os = "macos", myagents_model_qa, not(test)))]
    crate::modelqa_home::assert_private_default()
        .map_err(|_| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))?;
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
    #[cfg(all(target_os = "macos", myagents_model_qa, not(test)))]
    crate::modelqa_home::assert_private_default()
        .map_err(|_| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))?;
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
    #[cfg(all(target_os = "macos", myagents_model_qa, not(test)))]
    crate::modelqa_home::assert_private_default()
        .map_err(|_| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))?;
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
    #[cfg(all(target_os = "macos", myagents_model_qa, not(test)))]
    crate::modelqa_home::assert_private_default()
        .map_err(|_| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))?;
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

fn eligible_candidates(
    instance: &OwnedInstance,
    ca: Option<&str>,
    principal: &str,
    candidates: &[super::registry::StoredOwnedConnection],
) -> Result<Vec<super::registry::StoredOwnedConnection>, NetworkError> {
    let mut eligible = Vec::new();
    for candidate in candidates.iter().filter(|candidate| {
        candidate.descriptor.issuer == instance.issuer && candidate.principal_id == principal
    }) {
        instance.ensure_same_trust(&candidate.descriptor)?;
        if candidate.public_tls_ca.as_deref() != ca
            || candidate.network_id != instance.network_id
            || candidate.removing
        {
            return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
        }
        eligible.push(candidate.clone());
    }
    Ok(eligible)
}

fn validate_pinned_candidate(
    instance: &OwnedInstance,
    ca: Option<&str>,
    candidates: &[super::registry::StoredOwnedConnection],
    record: &super::registry::StoredOwnedConnection,
) -> Result<(), NetworkError> {
    let eligible = eligible_candidates(instance, ca, &record.principal_id, candidates)?;
    if !record.join_authorized || !eligible.iter().any(|candidate| candidate == record) {
        return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
    }
    Ok(())
}
fn select_registered_candidate(
    candidates: &[super::registry::StoredOwnedConnection],
    registered: &[bool],
    selected: &str,
) -> Result<Option<super::registry::StoredOwnedConnection>, NetworkError> {
    if candidates.len() != registered.len() {
        return Err(NetworkError::new("IDENTITY_STATE_INVALID"));
    }
    let matching: Vec<_> = candidates
        .iter()
        .zip(registered)
        .filter_map(|(c, exists)| exists.then_some(c))
        .collect();
    if let Some(candidate) = matching.iter().find(|c| c.id == selected) {
        return Ok(Some((*candidate).clone()));
    }
    match matching.as_slice() {
        [] => Ok(None),
        [candidate] => Ok(Some((*candidate).clone())),
        _ => Err(NetworkError::new("OWNED_IDENTITY_SELECTION_REQUIRED")),
    }
}

async fn registered_candidates(
    client: &OwnedClient,
    instance: &OwnedInstance,
    session: &OwnedSession,
    candidates: &[super::registry::StoredOwnedConnection],
) -> Result<Vec<bool>, NetworkError> {
    let mut registered = Vec::new();
    for candidate in candidates {
        let operation = crate::space_cloud::agent_network::AccountOperation::IdentityState(
            candidate.device_id.clone(),
        );
        let (method, path, _) = operation.request()?;
        let value = client
            .identity_request(method, &path, None, &session.access_token)
            .await?;
        myagents_agent_network_protocol::validate_identity_state(&value)
            .map_err(|_| NetworkError::new("IDENTITY_STATE_INVALID"))?;
        let state: myagents_agent_network_protocol::IdentityState =
            serde_json::from_value(value)
                .map_err(|_| NetworkError::new("IDENTITY_STATE_INVALID"))?;
        registered.push(validate_candidate_state(
            instance,
            &candidate.device_id,
            state,
        )?);
    }
    Ok(registered)
}

fn validate_candidate_state(
    instance: &OwnedInstance,
    device: &str,
    state: myagents_agent_network_protocol::IdentityState,
) -> Result<bool, NetworkError> {
    if state.service_id != instance.service_id
        || state.environment != instance.environment
        || state.device_id != device
    {
        return Err(NetworkError::new("IDENTITY_SCOPE_MISMATCH"));
    }
    if state.key_generation.is_some() != state.key_fingerprint.is_some() {
        return Err(NetworkError::new("IDENTITY_STATE_INVALID"));
    }
    Ok(state.key_generation.is_some())
}

// Durable pointer switch: credentials are immutable per binding. The old slot
// remains usable across a crash. An unconfirmed config rollback keeps the new
// slot too, because disk may already point to it. This seam exercises real
// commit ordering with fault-injected persistence, without accessing Keychain.
fn commit_staged_slot<T, P, A>(
    write: impl FnOnce() -> Result<(), NetworkError>,
    persist: impl FnOnce() -> Result<(), NetworkError>,
    rollback: impl FnOnce() -> Result<(), NetworkError>,
    discard: impl Fn() -> Result<(), NetworkError>,
    acquire: impl FnOnce() -> P,
    authorize: impl FnOnce() -> Result<A, NetworkError>,
    publish: impl FnOnce(A) -> T,
) -> Result<T, NetworkError> {
    if let Err(error) = write() {
        discard()?;
        return Err(error);
    }
    if let Err(error) = persist() {
        if rollback().is_err() {
            return Err(NetworkError::new("OWNED_LOGIN_COMMIT_UNCONFIRMED"));
        }
        discard()?;
        return Err(error);
    }
    let publication = acquire();
    let authority = match authorize() {
        Ok(authority) => authority,
        Err(error) => {
            drop(publication);
            if rollback().is_err() {
                return Err(NetworkError::new("OWNED_LOGIN_COMMIT_UNCONFIRMED"));
            }
            discard()?;
            return Err(error);
        }
    };
    let result = publish(authority);
    drop(publication);
    Ok(result)
}

fn staged_guard(connection: &str, binding: &str, expires_at: u64) -> Arc<AuthorizedSessionGuard> {
    Arc::new(AuthorizedSessionGuard {
        connection_id: connection.to_owned(),
        binding_id: binding.to_owned(),
        generation: 0,
        expires_at,
        valid: AtomicBool::new(false),
    })
}

fn current_child<'a>(
    state: &'a mut State,
    scope: &str,
    id: &str,
    epoch: u64,
) -> Result<&'a mut Attempt, NetworkError> {
    if !state.is_current(scope, id) {
        return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
    }
    state
        .attempts
        .get_mut(id)
        .filter(|attempt| attempt.child_epoch == epoch && attempt.consuming)
        .ok_or_else(|| NetworkError::new("OWNED_LOGIN_CANCELLED"))
}

fn check_fresh_session_slot(login: &CompletedLogin) -> Result<(), NetworkError> {
    // Each binding gets a new opaque hash under the existing credential route.
    // A crash before config switch leaves the old pointer and secret intact.
    let entry = session_entry(
        &login.instance,
        &login.device_id,
        &login.session.principal_id,
        login.public_tls_ca.as_deref(),
        Some(&login.binding_id),
    )?;
    if read_unlocked(&entry)?.is_some() {
        return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
    }
    Ok(())
}
fn discard_staged_session(login: &CompletedLogin) -> Result<(), NetworkError> {
    let entry = session_entry(
        &login.instance,
        &login.device_id,
        &login.session.principal_id,
        login.public_tls_ca.as_deref(),
        Some(&login.binding_id),
    )?;
    match read_unlocked(&entry)? {
        Some(SecretRecord::Session { binding_id, .. }) if binding_id == login.binding_id => {
            delete_unlocked(&entry)
        }
        None => Ok(()),
        _ => Err(NetworkError::new("ACCOUNT_BINDING_CHANGED")),
    }
}

impl OwnedLoginManager {
    pub(crate) async fn start(
        &self,
        issuer: &str,
        owner_device_id: &str,
        public_tls_ca_file: Option<&str>,
        candidates: Vec<super::registry::StoredOwnedConnection>,
        selected_id: String,
    ) -> Result<StartedLogin, NetworkError> {
        self.start_scoped(
            issuer,
            owner_device_id,
            read_public_ca_file(public_tls_ca_file)?,
            candidates,
            selected_id,
            None,
        )
        .await
    }
    /// CLI reauthentication is pinned before PKCE starts. It cannot fall back
    /// to a temporary/new device or select a different account registration.
    pub(crate) async fn start_existing(
        &self,
        owner_device_id: &str,
        record: super::registry::StoredOwnedConnection,
        candidates: Vec<super::registry::StoredOwnedConnection>,
    ) -> Result<StartedLogin, NetworkError> {
        self.start_scoped(
            &record.descriptor.issuer.clone(),
            owner_device_id,
            record.public_tls_ca.clone(),
            candidates,
            record.id.clone(),
            Some(record),
        )
        .await
    }
    async fn start_scoped(
        &self,
        issuer: &str,
        owner_device_id: &str,
        public_tls_ca: Option<String>,
        candidates: Vec<super::registry::StoredOwnedConnection>,
        selected_id: String,
        pinned: Option<super::registry::StoredOwnedConnection>,
    ) -> Result<StartedLogin, NetworkError> {
        if crate::app_dirs::IS_UPDATER_QA {
            return Err(NetworkError::new("UPDATER_QA_CREDENTIALS_DISABLED"));
        }
        let device = crate::device_identity::current_device_identity()
            .map_err(|_| NetworkError::new("DEVICE_ID_UNAVAILABLE"))?;
        if device.device_id != owner_device_id {
            return Err(NetworkError::new("IDENTITY_SCOPE_MISMATCH"));
        }
        // The logical attempt is installation/issuer scoped. Child PKCE device
        // identities must never become the cancellation/supersession key.
        let scope = attempt_scope(issuer, owner_device_id)?;
        let (generation, old, cleanup) = {
            let mut state = self.state.lock().await;
            state.ensure_startable(&scope)?;
            let (generation, old_id) = state.begin(&scope);
            let old = old_id.and_then(|id| state.attempts.remove(&id));
            let cleanup = old
                .as_ref()
                .map(|attempt| {
                    delete(&pending_entry(
                        &attempt.instance,
                        &attempt.owner_device_id,
                        attempt.public_tls_ca.as_deref(),
                    )?)
                })
                .transpose();
            (generation, old, cleanup)
        };
        if let Some(old) = old {
            if let Some(session) = old.staged_session {
                let _ = old.client.logout(&session.access_token).await;
            } else {
                let _ = old
                    .client
                    .cancel(&old.device_id, &old.transaction_id, &old.verifier)
                    .await;
            }
        }
        cleanup?;
        let (client, instance) = OwnedClient::discover(issuer, public_tls_ca.as_deref()).await?;
        let device_id = if let Some(record) = &pinned {
            validate_pinned_candidate(&instance, public_tls_ca.as_deref(), &candidates, record)?;
            record.device_id.clone()
        } else {
            uuid::Uuid::new_v4().to_string()
        };
        let (verifier, challenge) = pkce();
        let started = client.start(&device_id, &challenge).await?;
        let attempt_id = uuid::Uuid::new_v4().to_string();
        let attempt = Attempt {
            client,
            instance: instance.clone(),
            public_tls_ca: public_tls_ca.clone(),
            device_id,
            owner_device_id: owner_device_id.to_owned(),
            child_epoch: 0,
            candidates,
            selected_id,
            reuse_identity: pinned.is_some(),
            expected_principal: pinned.as_ref().map(|record| record.principal_id.clone()),
            resolved_candidate: pinned,
            staged_session: None,
            commit_unconfirmed: false,
            attempt_id: attempt_id.clone(),
            transaction_id: started.transaction_id,
            verifier,
            authorization_url: started.authorization_url.clone(),
            expires_at: started.expires_at,
            consuming: false,
            completed: None,
        };
        let secret_entry = pending_entry(&instance, owner_device_id, public_tls_ca.as_deref())?;
        let mut state = self.state.lock().await;
        let result = if state.generation_by_scope.get(&scope).copied() != Some(generation) {
            Err(NetworkError::new("OWNED_LOGIN_SUPERSEDED"))
        } else {
            write(&secret_entry, &record(&attempt))
        };
        if let Err(error) = result {
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
    pub(crate) async fn existing_attempts(&self) -> Vec<serde_json::Value> {
        let state = self.state.lock().await;
        let mut attempts: Vec<_> = state.attempts.values().filter(|a| a.reuse_identity && a.expires_at > now()).map(|a|
            serde_json::json!({"attemptId":a.attempt_id,"connectionId":a.selected_id,"expiresAt":a.expires_at})
        ).collect();
        attempts.sort_by(|a, b| a["attemptId"].as_str().cmp(&b["attemptId"].as_str()));
        attempts
    }
    pub(crate) async fn existing_started(
        &self,
        attempt_id: &str,
    ) -> Result<StartedLogin, NetworkError> {
        let state = self.state.lock().await;
        let a = state
            .attempts
            .get(attempt_id)
            .filter(|a| a.reuse_identity && a.expires_at > now())
            .ok_or_else(|| NetworkError::new("OWNED_LOGIN_NOT_FOUND"))?;
        Ok(StartedLogin {
            attempt_id: a.attempt_id.clone(),
            authorization_url: a.authorization_url.clone(),
            expires_at: a.expires_at,
        })
    }
    pub(crate) async fn require_existing_attempt(
        &self,
        attempt_id: &str,
    ) -> Result<(), NetworkError> {
        let state = self.state.lock().await;
        if state
            .attempts
            .get(attempt_id)
            .is_some_and(|attempt| attempt.reuse_identity)
        {
            Ok(())
        } else {
            Err(NetworkError::new("OWNED_LOGIN_NOT_FOUND"))
        }
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
    pub(crate) async fn poll(&self, attempt_id: &str) -> Result<LoginProgress, NetworkError> {
        let (
            client,
            instance,
            ca,
            device,
            owner,
            transaction,
            verifier,
            scope,
            epoch,
            expected,
            candidates,
            selected,
            resolved,
            reuse_identity,
        ) = {
            let mut state = self.state.lock().await;
            let attempt = state
                .attempts
                .get(attempt_id)
                .ok_or_else(|| NetworkError::new("OWNED_LOGIN_NOT_FOUND"))?;
            let scope = attempt_scope(&attempt.instance.issuer, &attempt.owner_device_id)?;
            if !state.is_current(&scope, attempt_id) {
                return Err(NetworkError::new("OWNED_LOGIN_SUPERSEDED"));
            }
            let attempt = state.attempts.get_mut(attempt_id).expect("checked attempt");
            if attempt.commit_unconfirmed {
                return Err(NetworkError::new("OWNED_LOGIN_COMMIT_UNCONFIRMED"));
            }
            if let Some(done) = &attempt.completed {
                return Ok(LoginProgress::Authenticated(done.clone()));
            }
            if attempt.consuming || attempt.expires_at <= now() {
                return Err(NetworkError::new("OWNED_LOGIN_RESULT_UNAVAILABLE"));
            }
            attempt.consuming = true;
            write(
                &pending_entry(
                    &attempt.instance,
                    &attempt.owner_device_id,
                    attempt.public_tls_ca.as_deref(),
                )?,
                &record(attempt),
            )?;
            (
                attempt.client.clone(),
                attempt.instance.clone(),
                attempt.public_tls_ca.clone(),
                attempt.device_id.clone(),
                attempt.owner_device_id.clone(),
                attempt.transaction_id.clone(),
                attempt.verifier.clone(),
                scope,
                attempt.child_epoch,
                attempt.expected_principal.clone(),
                attempt.candidates.clone(),
                attempt.selected_id.clone(),
                attempt.resolved_candidate.clone(),
                attempt.reuse_identity,
            )
        };
        let result = client.poll(&device, &transaction, &verifier).await?;
        let session = match result {
            OwnedPoll::Pending => {
                let mut state = self.state.lock().await;
                let attempt = current_child(&mut state, &scope, attempt_id, epoch)?;
                attempt.consuming = false;
                write(
                    &pending_entry(&instance, &owner, ca.as_deref())?,
                    &record(attempt),
                )?;
                return Ok(LoginProgress::Pending);
            }
            OwnedPoll::Authenticated(session) => session,
        };
        {
            let mut state = self.state.lock().await;
            match current_child(&mut state, &scope, attempt_id, epoch) {
                Ok(attempt) => attempt.staged_session = Some(session.clone()),
                Err(error) => {
                    drop(state);
                    let _ = client.logout(&session.access_token).await;
                    return Err(error);
                }
            }
        }
        if expected
            .as_ref()
            .is_some_and(|principal| *principal != session.principal_id)
        {
            let _ = client.logout(&session.access_token).await;
            return Err(NetworkError::new("OWNED_ACCOUNT_MISMATCH"));
        }
        let eligible =
            eligible_candidates(&instance, ca.as_deref(), &session.principal_id, &candidates)?;
        let replacement = if expected.is_some() {
            resolved
        } else {
            // Every candidate query must complete. A rejected/malformed/unknown
            // read is not evidence of absence and must not cause a fresh identity.
            let registered = registered_candidates(&client, &instance, &session, &eligible).await?;
            if let Some(candidate) = select_registered_candidate(&eligible, &registered, &selected)?
            {
                // PKCE tokens remain device-bound. Restore the old identity only
                // after retiring this temporary session and authorizing that ID.
                client.logout(&session.access_token).await?;
                {
                    let mut state = self.state.lock().await;
                    current_child(&mut state, &scope, attempt_id, epoch)?.staged_session = None;
                }
                let (next_verifier, challenge) = pkce();
                let started = client.start(&candidate.device_id, &challenge).await?;
                let mut state = self.state.lock().await;
                let attempt = match current_child(&mut state, &scope, attempt_id, epoch) {
                    Ok(attempt) => attempt,
                    Err(error) => {
                        drop(state);
                        let _ = client
                            .cancel(
                                &candidate.device_id,
                                &started.transaction_id,
                                &next_verifier,
                            )
                            .await;
                        return Err(error);
                    }
                };
                attempt.device_id = candidate.device_id.clone();
                attempt.child_epoch = epoch + 1;
                attempt.expected_principal = Some(session.principal_id.clone());
                attempt.resolved_candidate = Some(candidate);
                attempt.transaction_id = started.transaction_id;
                attempt.verifier = next_verifier;
                attempt.authorization_url = started.authorization_url.clone();
                attempt.expires_at = started.expires_at;
                attempt.consuming = false;
                if let Err(error) = write(
                    &pending_entry(&instance, &owner, ca.as_deref())?,
                    &record(attempt),
                ) {
                    let child_device = attempt.device_id.clone();
                    let child_transaction = attempt.transaction_id.clone();
                    let child_verifier = attempt.verifier.clone();
                    attempt.consuming = true;
                    drop(state);
                    let _ = client
                        .cancel(&child_device, &child_transaction, &child_verifier)
                        .await;
                    return Err(error);
                }
                return Ok(LoginProgress::Reauthorize(StartedLogin {
                    attempt_id: attempt_id.to_owned(),
                    authorization_url: started.authorization_url,
                    expires_at: started.expires_at,
                }));
            }
            // Configuration alone does not prove enrollment. Reuse its UI
            // connection ID when repairing an unregistered failed login, while
            // leaving its old credential/key slots intact.
            eligible
                .iter()
                .find(|c| c.id == selected)
                .cloned()
                .or_else(|| (eligible.len() == 1).then(|| eligible[0].clone()))
        };
        let identity_store = if reuse_identity {
            let record = replacement.as_ref().ok_or_else(|| NetworkError::new("ACCOUNT_BINDING_CHANGED"))?;
            validate_pinned_candidate(&instance, ca.as_deref(), &candidates, record)?;
            if record.device_id != device || record.principal_id != session.principal_id {
                return Err(NetworkError::new("IDENTITY_SCOPE_MISMATCH"));
            }
            let operation = crate::space_cloud::agent_network::AccountOperation::IdentityState(device.clone());
            let (method, path, _) = operation.request()?;
            let value = client.identity_request(method, &path, None, &session.access_token).await?;
            Some(super::identity_desktop::existing_owned_identity(&instance, &session.principal_id, &device, value).await?)
        } else { None };
        let connection_id = replacement
            .as_ref()
            .map(|c| c.id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let binding_id = uuid::Uuid::new_v4().to_string();
        let completed = CompletedLogin {
            attempt_id: attempt_id.to_owned(),
            connection_id: connection_id.clone(),
            binding_id: binding_id.clone(),
            instance: instance.clone(),
            public_tls_ca: ca.clone(),
            device_id: device,
            owner_device_id: owner.clone(),
            session_bound: true,
            identity_store,
            preserve_membership: reuse_identity,
            candidates: eligible,
            replaces: replacement.map(|c| c.id),
            guard: staged_guard(&connection_id, &binding_id, session.expires_at),
            session,
        };
        let mut state = self.state.lock().await;
        let attempt = current_child(&mut state, &scope, attempt_id, epoch)?;
        // No durable session or active guard is published by polling.
        delete(&pending_entry(&instance, &owner, ca.as_deref())?)?;
        attempt.completed = Some(completed.clone());
        Ok(LoginProgress::Authenticated(completed))
    }
    pub(crate) async fn cancel(&self, attempt_id: &str) -> Result<(), NetworkError> {
        let (attempt, cleanup) = {
            let mut state = self.state.lock().await;
            // The disk pointer may already reference this token. Closing the UI
            // must not revoke it or discard its generation. A fresh process
            // reconciles using the atomic config pointer and immutable slots.
            if state
                .attempts
                .get(attempt_id)
                .is_some_and(|attempt| attempt.commit_unconfirmed)
            {
                return Ok(());
            }
            let Some(attempt) = state.attempts.remove(attempt_id) else {
                return Ok(());
            };
            let scope = attempt_scope(&attempt.instance.issuer, &attempt.owner_device_id)?;
            state.invalidate(&scope, attempt_id);
            let cleanup = delete(&pending_entry(
                &attempt.instance,
                &attempt.owner_device_id,
                attempt.public_tls_ca.as_deref(),
            )?);
            (attempt, cleanup)
        };
        if let Some(session) = attempt.staged_session {
            let _ = attempt.client.logout(&session.access_token).await;
        } else {
            let _ = attempt
                .client
                .cancel(
                    &attempt.device_id,
                    &attempt.transaction_id,
                    &attempt.verifier,
                )
                .await;
        }
        cleanup
    }
    pub(crate) async fn commit_if_current<T, P>(
        &self,
        login: &CompletedLogin,
        validate: impl Fn() -> Result<(), NetworkError>,
        persist: impl FnOnce() -> Result<(), NetworkError>,
        rollback: impl FnOnce() -> Result<(), NetworkError>,
        acquire_publication: impl FnOnce() -> P,
        publish: impl FnOnce(&CompletedLogin) -> T,
    ) -> Result<T, NetworkError> {
        // Cancel and commit linearize at this lock; no network awaits inside.
        let mut state = self.state.lock().await;
        let scope = attempt_scope(&login.instance.issuer, &login.owner_device_id)?;
        let exact = state.is_current(&scope, &login.attempt_id)
            && state
                .attempts
                .get(&login.attempt_id)
                .is_some_and(|attempt| {
                    attempt.expires_at > now()
                        && attempt.completed.as_ref().is_some_and(|done| {
                            done.binding_id == login.binding_id
                                && done.connection_id == login.connection_id
                        })
                });
        if !exact {
            return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
        }
        validate()?;
        login.session.validate(&login.instance)?;
        let slot = SessionSlot::new(
            &login.instance,
            &login.device_id,
            &login.session.principal_id,
            login.public_tls_ca.as_deref(),
        )?;
        let _storage = storage_transaction_lock();
        session_guard_cache().ensure_capacity(&slot)?;
        check_fresh_session_slot(login)?;
        let secret = SecretRecord::Session {
            version: VERSION,
            instance: login.instance.clone(),
            public_tls_ca: login.public_tls_ca.clone(),
            device_id: login.device_id.clone(),
            principal_id: login.session.principal_id.clone(),
            network_id: login.session.network_id.clone(),
            session: login.session.clone(),
            connection_id: login.connection_id.clone(),
            binding_id: login.binding_id.clone(),
        };
        let result = commit_staged_slot(
            || {
                write_session_unlocked(
                    &login.instance,
                    &login.device_id,
                    &login.session.principal_id,
                    login.public_tls_ca.as_deref(),
                    &secret,
                    Some(&login.binding_id),
                    false,
                    || Ok(()),
                )
            },
            persist,
            rollback,
            || discard_staged_session(login),
            acquire_publication,
            || {
                validate()?;
                login.session.validate(&login.instance)?;
                session_guard_cache().authorize(
                    slot,
                    &login.binding_id,
                    &login.connection_id,
                    login.session.expires_at,
                )
            },
            |guard| {
                let mut committed = login.clone();
                committed.guard = guard;
                publish(&committed)
            },
        );
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                if error.code == "OWNED_LOGIN_COMMIT_UNCONFIRMED" {
                    if let Some(attempt) = state.attempts.get_mut(&login.attempt_id) {
                        attempt.commit_unconfirmed = true;
                    }
                }
                return Err(error);
            }
        };
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
        session_bound: bool,
    ) -> Result<bool, NetworkError> {
        // Serialize removal with the final durable login commit.
        let _state = self.state.lock().await;
        delete_account_if_binding(
            instance,
            device,
            principal,
            public_tls_ca,
            expected_binding,
            session_bound,
        )
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
        binding_id: login.binding_id.clone(),
        connection_id: login.connection_id.clone(),
        descriptor: login.instance.clone(),
        device_id: login.device_id.clone(),
        session_bound: login.session_bound,
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
    session_bound: bool,
) -> Result<bool, NetworkError> {
    let _storage = storage_transaction_lock();
    #[cfg(all(
        target_os = "macos",
        myagents_moxbot,
        not(test),
        not(myagents_isolated_qa)
    ))]
    {
        let legacy = session_key(
            instance,
            device,
            principal,
            public_tls_ca,
            session_bound.then_some(expected_binding),
        );
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
    #[cfg(not(all(
        target_os = "macos",
        myagents_moxbot,
        not(test),
        not(myagents_isolated_qa)
    )))]
    {
        let entry = session_entry(
            instance,
            device,
            principal,
            public_tls_ca,
            session_bound.then_some(expected_binding),
        )?;
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
    session_bound: bool,
) -> Result<Option<Arc<OwnedAccount>>, NetworkError> {
    let _storage = storage_transaction_lock();
    let record = read_unlocked(&session_entry(
        instance,
        device,
        principal,
        public_tls_ca,
        session_bound.then_some(binding_id),
    )?)?;
    restore_account_from_record(
        instance,
        device,
        principal,
        connection_id,
        binding_id,
        public_tls_ca,
        join_authorized,
        record,
        session_bound,
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
    session_bound: bool,
) -> Result<Option<Arc<OwnedAccount>>, NetworkError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
    }
    let _storage = storage_transaction_lock();
    #[cfg(all(
        target_os = "macos",
        myagents_moxbot,
        not(test),
        not(myagents_isolated_qa)
    ))]
    let validated = {
        use super::credential_slots::RouteSelection as Selection;
        let logical = session_key(
            instance,
            device,
            principal,
            public_tls_ca,
            session_bound.then_some(binding_id),
        );
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
            let source_entry = session_entry_for_route(
                instance,
                device,
                principal,
                public_tls_ca,
                selection,
                session_bound.then_some(binding_id),
            )?;
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
            let target_entry = session_entry_for_route(
                instance,
                device,
                principal,
                public_tls_ca,
                target,
                session_bound.then_some(binding_id),
            )?;
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
                        session_bound.then_some(binding_id),
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
    #[cfg(not(all(
        target_os = "macos",
        myagents_moxbot,
        not(test),
        not(myagents_isolated_qa)
    )))]
    {
        let record = read_authorized_unlocked(
            &session_entry(
                instance,
                device,
                principal,
                public_tls_ca,
                session_bound.then_some(binding_id),
            )?,
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
                let restored =
                    publish_validated_session(validated, join_authorized, session_bound)?;
                restore_if_not_cancelled(Some(restored), cancelled)
            }
            None => Ok(None),
        };
    }
    #[cfg(all(
        target_os = "macos",
        myagents_moxbot,
        not(test),
        not(myagents_isolated_qa)
    ))]
    if cancelled.load(Ordering::Acquire) {
        return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
    }
    #[cfg(all(
        target_os = "macos",
        myagents_moxbot,
        not(test),
        not(myagents_isolated_qa)
    ))]
    let restored = publish_validated_session(validated, join_authorized, session_bound)?;
    #[cfg(all(
        target_os = "macos",
        myagents_moxbot,
        not(test),
        not(myagents_isolated_qa)
    ))]
    restore_if_not_cancelled(Some(restored), cancelled)
}

#[cfg(all(
    target_os = "macos",
    myagents_moxbot,
    not(test),
    not(myagents_isolated_qa)
))]
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

#[cfg(all(
    target_os = "macos",
    myagents_moxbot,
    not(test),
    not(myagents_isolated_qa)
))]
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
#[cfg(all(
    target_os = "macos",
    myagents_moxbot,
    not(test),
    not(myagents_isolated_qa)
))]
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
        account.session_bound.then_some(binding),
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
    session_bound: bool,
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
    publish_validated_session(validated, join_authorized, session_bound).map(Some)
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

#[cfg(any(
    test,
    all(
        target_os = "macos",
        myagents_moxbot,
        not(test),
        not(myagents_isolated_qa)
    )
))]
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
    session_bound: bool,
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
        owner_device_id: validated.device_id.clone(),
        session_bound,
        device_id: validated.device_id,
        candidates: Vec::new(),
        replaces: None,
        identity_store: None,
        preserve_membership: true,
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
    session_bound: bool,
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
    }) = read_unlocked(&session_entry(
        instance,
        device,
        principal,
        public_tls_ca,
        session_bound.then_some(binding_id),
    )?)?
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

    fn candidate(id: &str, principal: &str) -> super::super::registry::StoredOwnedConnection {
        let instance = instance("network-candidate");
        super::super::registry::StoredOwnedConnection {
            id: id.into(),
            network_id: instance.network_id.clone(),
            descriptor: instance,
            public_tls_ca: None,
            device_id: format!("device-{id}"),
            principal_id: principal.into(),
            binding_id: format!("binding-{id}"),
            session_bound: false,
            join_authorized: true,
            removing: false,
        }
    }

    #[test]
    fn cli_pinned_login_cannot_change_registration_account_trust_or_membership() {
        let record = candidate("saved", "owner");
        let candidates = vec![record.clone()];
        super::validate_pinned_candidate(&record.descriptor, None, &candidates, &record).unwrap();
        for field in 0..6 {
            let mut changed = record.clone();
            match field {
                0 => changed.principal_id = "other".into(),
                1 => changed.device_id = "other-device".into(),
                2 => changed.binding_id = "other-binding".into(),
                3 => changed.public_tls_ca = Some("other-root".into()),
                4 => changed.removing = true,
                _ => changed.join_authorized = false,
            }
            assert!(super::validate_pinned_candidate(&record.descriptor, None, &candidates, &changed).is_err());
        }
        let mut trust = record.descriptor.clone(); trust.root_certificate = "changed".into();
        assert!(super::validate_pinned_candidate(&trust, None, &candidates, &record).is_err());
    }

    #[test]
    fn candidate_selection_uses_registration_not_merely_saved_config() {
        let candidates = vec![candidate("old", "p"), candidate("failed", "p")];
        assert_eq!(
            super::select_registered_candidate(&candidates, &[true, false], "failed")
                .unwrap()
                .unwrap()
                .id,
            "old"
        );
        assert!(
            super::select_registered_candidate(&candidates, &[false, false], "failed")
                .unwrap()
                .is_none()
        );
        assert!(
            super::select_registered_candidate(&candidates, &[true, true], "unrelated").is_err()
        );
        assert_eq!(
            super::select_registered_candidate(&candidates, &[true, true], "old")
                .unwrap()
                .unwrap()
                .id,
            "old"
        );
    }

    #[test]
    fn candidates_never_cross_accounts_trust_or_removal_boundaries() {
        let first = candidate("one", "p");
        let mut other = candidate("other", "q");
        let eligible = super::eligible_candidates(
            &first.descriptor,
            None,
            "p",
            &[first.clone(), other.clone()],
        )
        .unwrap();
        assert_eq!(eligible.len(), 1);
        other.principal_id = "p".into();
        other.public_tls_ca = Some("different-ca".into());
        assert!(
            super::eligible_candidates(&first.descriptor, None, "p", &[other.clone()]).is_err()
        );
        other.public_tls_ca = None;
        other.removing = true;
        assert!(super::eligible_candidates(&first.descriptor, None, "p", &[other]).is_err());
    }

    #[test]
    fn half_empty_identity_state_cannot_trigger_a_new_device() {
        let instance = instance("state-pair");
        for (generation, fingerprint) in [(None, Some("x".repeat(43))), (Some(1), None)] {
            let state = myagents_agent_network_protocol::IdentityState {
                service_id: instance.service_id.clone(),
                environment: instance.environment.clone(),
                device_id: "device".into(),
                key_generation: generation,
                key_fingerprint: fingerprint,
            };
            assert_eq!(
                super::validate_candidate_state(&instance, "device", state)
                    .unwrap_err()
                    .code,
                "IDENTITY_STATE_INVALID"
            );
        }
    }

    #[test]
    fn binding_slots_preserve_legacy_and_separate_login_generations() {
        let instance = instance("binding-slot");
        let legacy = super::key(&instance, "device", "p", None);
        assert_eq!(
            super::session_key(&instance, "device", "p", None, None),
            legacy
        );
        let first = super::session_key(&instance, "device", "p", None, Some("first"));
        let second = super::session_key(&instance, "device", "p", None, Some("second"));
        assert_ne!(first, legacy);
        assert_ne!(first, second);
        assert_eq!(first.len(), 43);
        assert_ne!(
            first,
            super::session_key(&instance, "device", "other", None, Some("first"))
        );
        let json = serde_json::to_value(candidate("one", "p")).unwrap();
        assert!(json.get("sessionBound").is_none());
        let restored: super::super::registry::StoredOwnedConnection =
            serde_json::from_value(json).unwrap();
        assert!(!restored.session_bound);
    }

    #[test]
    fn crash_between_secret_and_config_leaves_the_old_binding_usable() {
        use std::cell::RefCell;
        let slots = RefCell::new(std::collections::HashMap::from([("old", "old-secret")]));
        let pointer = RefCell::new("old");
        let crash = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _: Result<(), NetworkError> = super::commit_staged_slot(
                || {
                    slots.borrow_mut().insert("new", "new-secret");
                    Ok(())
                },
                || panic!("injected process exit before pointer switch"),
                || {
                    *pointer.borrow_mut() = "old";
                    Ok(())
                },
                || {
                    slots.borrow_mut().remove("new");
                    Ok(())
                },
                || (),
                || Ok::<(), NetworkError>(()),
                |_| (),
            );
        }));
        assert!(crash.is_err());
        assert_eq!(slots.borrow().get(*pointer.borrow()), Some(&"old-secret"));
    }

    #[test]
    fn unconfirmed_config_rollback_keeps_both_binding_slots() {
        use std::cell::RefCell;
        let slots = RefCell::new(std::collections::HashMap::from([("old", "old-secret")]));
        let result: Result<(), NetworkError> = super::commit_staged_slot(
            || {
                slots.borrow_mut().insert("new", "new-secret");
                Ok(())
            },
            || Err(NetworkError::new("NETWORK_CONFIG_WRITE_FAILED")),
            || Err(NetworkError::new("NETWORK_CONFIG_WRITE_FAILED")),
            || {
                slots.borrow_mut().remove("new");
                Ok(())
            },
            || (),
            || -> Result<(), NetworkError> { panic!("must not authorize") },
            |_| (),
        );
        assert_eq!(result.unwrap_err().code, "OWNED_LOGIN_COMMIT_UNCONFIRMED");
        assert_eq!(slots.borrow().len(), 2);
    }

    #[tokio::test]
    async fn closing_unconfirmed_login_cannot_revoke_its_possibly_committed_token() {
        let mut instance = instance("00000000-0000-0000-0000-000000000003");
        instance.root_certificate = crate::agent_network::crypto::tests::Fixture::new().ca.pem();
        let mut jwk = crate::agent_network::crypto::DevicePrivateKey::generate()
            .unwrap()
            .public_jwk()
            .unwrap();
        jwk["kid"] = serde_json::json!("unconfirmed-test");
        jwk["alg"] = serde_json::json!("ES256");
        jwk["use"] = serde_json::json!("sig");
        instance.jwks = serde_json::json!({"keys": [jwk]});
        let manager = super::OwnedLoginManager::default();
        let scope = super::attempt_scope(&instance.issuer, "installation").unwrap();
        let attempt = super::Attempt {
            client: super::OwnedClient::pinned(instance.clone(), None).unwrap(),
            instance,
            public_tls_ca: None,
            device_id: "scoped-device".into(),
            owner_device_id: "installation".into(),
            child_epoch: 1,
            candidates: vec![],
            selected_id: "old".into(),
            reuse_identity: false,
            expected_principal: None,
            resolved_candidate: None,
            staged_session: Some(super::OwnedSession {
                access_token: "a".repeat(43),
                principal_id: "00000000-0000-0000-0000-000000000002".into(),
                network_id: "00000000-0000-0000-0000-000000000003".into(),
                expires_at: now() + 3600,
            }),
            commit_unconfirmed: true,
            attempt_id: "uncertain".into(),
            transaction_id: "transaction".into(),
            verifier: Zeroizing::new("verifier".into()),
            authorization_url: "https://login.example".into(),
            expires_at: now() + 3600,
            consuming: true,
            completed: None,
        };
        {
            let mut state = manager.state.lock().await;
            let (generation, _) = state.begin(&scope);
            assert!(state.register(&scope, generation, "uncertain"));
            state.attempts.insert("uncertain".into(), attempt);
        }
        // Production cancel returns before Keychain or HTTP cleanup. The
        // possibly committed token must remain available for disk recovery.
        manager.cancel("uncertain").await.unwrap();
        let state = manager.state.lock().await;
        assert!(state.attempts["uncertain"].staged_session.is_some());
        assert!(state.is_current(&scope, "uncertain"));
        assert_eq!(
            state.ensure_startable(&scope).unwrap_err().code,
            "OWNED_LOGIN_COMMIT_UNCONFIRMED"
        );
        drop(state);
        let error = manager.poll("uncertain").await.err().unwrap();
        assert_eq!(error.code, "OWNED_LOGIN_COMMIT_UNCONFIRMED");
        // A new process reconciles the stored pointer; no transient attempt
        // survives, so a disk-restored session is never logged out on startup.
        assert!(State::default().ensure_startable(&scope).is_ok());
    }

    #[test]
    fn cancelled_publication_rolls_back_without_authorizing_or_deleting_old_session() {
        use std::cell::Cell;
        let pointer = Cell::new("old");
        let discarded = Cell::new(false);
        let published = Cell::new(false);
        let old_guard = staged_guard_for_test();
        let result: Result<(), NetworkError> = super::commit_staged_slot(
            || Ok(()),
            || {
                pointer.set("new");
                Ok(())
            },
            || {
                pointer.set("old");
                Ok(())
            },
            || {
                discarded.set(true);
                Ok(())
            },
            || (),
            || Err::<(), _>(NetworkError::new("OWNED_LOGIN_CANCELLED")),
            |_| {
                published.set(true);
            },
        );
        assert!(result.is_err());
        assert_eq!(pointer.get(), "old");
        assert!(discarded.get());
        assert!(!published.get());
        old_guard.check().unwrap();
    }

    fn staged_guard_for_test() -> Arc<AuthorizedSessionGuard> {
        Arc::new(AuthorizedSessionGuard {
            binding_id: "old".into(),
            connection_id: "old".into(),
            generation: 1,
            expires_at: now() + 100,
            valid: AtomicBool::new(true),
        })
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
            owner_device_id: "device-1".into(),
            session_bound: false,
            candidates: Vec::new(),
            replaces: None,
            identity_store: None,
            preserve_membership: false,
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
        let error = super::entry("synthetic-only")
            .err()
            .expect("QA entry is disabled");
        assert_eq!(error.code, "UPDATER_QA_CREDENTIALS_DISABLED");
    }
}
