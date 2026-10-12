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
    sync::{atomic::AtomicBool, Arc},
};
use zeroize::Zeroizing;

const SERVICE: &str = "com.myagents.owned-agentnet.v1";
const VERSION: u8 = 1;

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

fn entry(user: &str) -> Result<Entry, NetworkError> {
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
    Ok(entry(&format!(
        "pending:{}",
        key(instance, device_id, "pending", public_tls_ca)
    ))?)
}
fn session_entry(
    instance: &OwnedInstance,
    device_id: &str,
    principal: &str,
    public_tls_ca: Option<&str>,
) -> Result<Entry, NetworkError> {
    entry(&format!(
        "session:{}",
        key(instance, device_id, principal, public_tls_ca)
    ))
}
fn write(entry: &Entry, secret: &SecretRecord) -> Result<(), NetworkError> {
    let json = Zeroizing::new(
        serde_json::to_string(secret)
            .map_err(|_| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))?,
    );
    entry
        .set_password(&json)
        .map_err(|_| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))
}
fn read(entry: &Entry) -> Result<Option<SecretRecord>, NetworkError> {
    let value = match entry.get_password() {
        Ok(value) => Zeroizing::new(value),
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(_) => return Err(NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE")),
    };
    serde_json::from_str(&value)
        .map(Some)
        .map_err(|_| NetworkError::new("NETWORK_CREDENTIAL_STORE_INVALID"))
}
fn delete(entry: &Entry) -> Result<(), NetworkError> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE")),
    }
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
                let account_entry = session_entry(
                    &instance,
                    &device_id,
                    &session.principal_id,
                    public_tls_ca.as_deref(),
                )?;
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
                write(&account_entry, &secret)?;
                let completed = CompletedLogin {
                    attempt_id: attempt_id.to_owned(),
                    connection_id,
                    binding_id,
                    instance: instance.clone(),
                    public_tls_ca: public_tls_ca.clone(),
                    device_id: device_id.clone(),
                    session,
                };
                attempt.completed = Some(completed.clone());
                delete(&secret_entry)?;
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
                delete(&session_entry(
                    &done.instance,
                    &done.device_id,
                    &done.session.principal_id,
                    done.public_tls_ca.as_deref(),
                )?)?;
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
    let expected_binding = login.binding_id.clone();
    let expected_device = login.device_id.clone();
    let expected_principal = login.session.principal_id.clone();
    let expected_network = login.session.network_id.clone();
    let guard_entry = session_entry(
        &login.instance,
        &login.device_id,
        &login.session.principal_id,
        login.public_tls_ca.as_deref(),
    )
    .expect("login identity was validated before keyring persistence");
    let guard = Arc::new(move || {
        let Some(SecretRecord::Session {
            version,
            binding_id,
            device_id,
            principal_id,
            network_id,
            session,
            ..
        }) = read(&guard_entry)?
        else {
            return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
        };
        if version != VERSION
            || binding_id != expected_binding
            || device_id != expected_device
            || principal_id != expected_principal
            || network_id != expected_network
            || session.expires_at <= now()
        {
            return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
        }
        Ok(())
    });
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
    let entry = session_entry(instance, device, principal, public_tls_ca)?;
    let Some(SecretRecord::Session { binding_id, .. }) = read(&entry)? else {
        return Ok(false);
    };
    if binding_id != expected_binding {
        return Ok(false);
    }
    delete(&entry)?;
    Ok(true)
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
    }) = read(&session_entry(instance, device, principal, public_tls_ca)?)?
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
    let completed = CompletedLogin {
        attempt_id: String::new(),
        connection_id: saved_connection,
        binding_id: saved_binding,
        instance: saved,
        public_tls_ca: saved_ca,
        device_id,
        session,
    };
    Ok(Some(account_from_login(&completed, join_authorized)))
}

pub(crate) fn load_session_for_removal(
    instance: &OwnedInstance,
    device: &str,
    principal: &str,
    connection_id: &str,
    binding_id: &str,
    public_tls_ca: Option<&str>,
) -> Result<Option<OwnedSession>, NetworkError> {
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
    }) = read(&session_entry(instance, device, principal, public_tls_ca)?)?
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
    use super::State;

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
