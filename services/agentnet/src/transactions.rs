use crate::{AuthConfig, AuthError, AuthStore, IssuedSession, OidcVerifier, VerifiedSubject};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::random;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;
use uuid::Uuid;
use zeroize::Zeroizing;

/// Non-secret transaction identifiers plus the OIDC values the caller must
/// bind into state/nonce. Callers must not log or persist this short-lived object.
pub struct LoginStart {
    pub transaction_id: String,
    pub state: Zeroizing<String>,
    pub nonce: Zeroizing<String>,
    pub expires_at: i64,
}

/// Callback material is short-lived and intentionally does not implement Debug.
pub struct LoginCallback<'a> {
    pub transaction_id: &'a str,
    pub state: &'a str,
    pub device_id: &'a str,
    pub pkce_verifier: &'a Zeroizing<String>,
    pub id_token: &'a Zeroizing<String>,
}

struct PendingLogin {
    device_id: String,
    pkce_challenge: String,
    state: Zeroizing<String>,
    nonce: Zeroizing<String>,
    expires_at: i64,
}

pub struct LoginTransactions {
    pending: Mutex<HashMap<String, PendingLogin>>,
    ttl: Duration,
}

impl LoginTransactions {
    pub fn new(config: &AuthConfig) -> Result<Self, AuthError> {
        if !(Duration::from_secs(30)..=Duration::from_secs(900)).contains(&config.login_ttl) {
            return Err(AuthError::Configuration);
        }
        Ok(Self {
            pending: Mutex::new(HashMap::new()),
            ttl: config.login_ttl,
        })
    }

    /// Starts a memory-only, device-bound OIDC transaction. PKCE verifier stays
    /// with the initiating client; only its canonical S256 challenge is stored.
    pub fn begin(&self, device_id: &str, pkce_challenge: &str) -> Result<LoginStart, AuthError> {
        let device_id = canonical_uuid(device_id).ok_or(AuthError::LoginTransaction)?;
        if !valid_base64url_32(pkce_challenge) {
            return Err(AuthError::LoginProof);
        }
        let now = unix_seconds()?;
        let expires_at = now
            .checked_add(i64::try_from(self.ttl.as_secs()).map_err(|_| AuthError::Configuration)?)
            .ok_or(AuthError::Configuration)?;
        let transaction_id = Uuid::new_v4().to_string();
        let state = URL_SAFE_NO_PAD.encode(random::<[u8; 32]>()).to_owned();
        let nonce = URL_SAFE_NO_PAD.encode(random::<[u8; 32]>()).to_owned();
        let mut pending = self.pending.lock().map_err(|_| AuthError::Storage)?;
        pending.retain(|_, transaction| transaction.expires_at > now);
        if pending.len() >= 1024 {
            return Err(AuthError::Storage);
        }
        pending.insert(
            transaction_id.clone(),
            PendingLogin {
                device_id,
                pkce_challenge: pkce_challenge.to_owned(),
                state: Zeroizing::new(state.clone()),
                nonce: Zeroizing::new(nonce.clone()),
                expires_at,
            },
        );
        Ok(LoginStart {
            transaction_id,
            state: Zeroizing::new(state),
            nonce: Zeroizing::new(nonce),
            expires_at,
        })
    }

    /// Completes an OAuth authorization-code exchange after the trusted OIDC
    /// adapter has received the provider ID token. The ID token is cryptographically
    /// validated here before a principal can reach durable storage.
    pub fn complete_with_id_token(
        &self,
        store: &AuthStore,
        oidc: &OidcVerifier,
        callback: LoginCallback<'_>,
    ) -> Result<IssuedSession, AuthError> {
        self.complete_with_id_token_using_clock(store, oidc, callback, unix_seconds)
    }

    pub(crate) fn complete_with_id_token_using_clock<F>(
        &self,
        store: &AuthStore,
        oidc: &OidcVerifier,
        callback: LoginCallback<'_>,
        mut clock: F,
    ) -> Result<IssuedSession, AuthError>
    where
        F: FnMut() -> Result<i64, AuthError>,
    {
        let device_id = canonical_uuid(callback.device_id).ok_or(AuthError::LoginTransaction)?;
        let transaction_id =
            canonical_uuid(callback.transaction_id).ok_or(AuthError::LoginTransaction)?;
        if !valid_pkce_verifier(callback.pkce_verifier.as_str()) {
            return Err(AuthError::LoginProof);
        }
        let now = clock()?;
        let pending = {
            let mut pending = self.pending.lock().map_err(|_| AuthError::Storage)?;
            pending.retain(|_, transaction| transaction.expires_at > now);
            let transaction = pending
                .get(&transaction_id)
                .ok_or(AuthError::LoginTransaction)?;
            if transaction.expires_at <= now
                || transaction.device_id != device_id
                || !constant_time_eq(transaction.state.as_bytes(), callback.state.as_bytes())
                || !constant_time_eq(
                    transaction.pkce_challenge.as_bytes(),
                    URL_SAFE_NO_PAD
                        .encode(Sha256::digest(callback.pkce_verifier.as_bytes()))
                        .as_bytes(),
                )
            {
                return Err(AuthError::LoginProof);
            }
            PendingLogin {
                device_id: transaction.device_id.clone(),
                pkce_challenge: transaction.pkce_challenge.clone(),
                state: Zeroizing::new(transaction.state.to_string()),
                nonce: Zeroizing::new(transaction.nonce.to_string()),
                expires_at: transaction.expires_at,
            }
        };
        let verified: VerifiedSubject =
            oidc.verify_id_token(callback.id_token, pending.nonce.as_str())?;
        {
            let mut transactions = self.pending.lock().map_err(|_| AuthError::Storage)?;
            let current = transactions
                .get(&transaction_id)
                .ok_or(AuthError::LoginTransaction)?;
            if current.expires_at != pending.expires_at
                || current.expires_at <= clock()?
                || current.device_id != device_id
                || !constant_time_eq(current.state.as_bytes(), pending.state.as_bytes())
            {
                transactions.remove(&transaction_id);
                return Err(AuthError::LoginTransaction);
            }
            transactions.remove(&transaction_id);
        }
        store.issue_session(&verified, &device_id)
    }

    pub fn cancel(&self, transaction_id: &str, device_id: &str) -> Result<bool, AuthError> {
        let transaction_id = canonical_uuid(transaction_id).ok_or(AuthError::LoginTransaction)?;
        let device_id = canonical_uuid(device_id).ok_or(AuthError::LoginTransaction)?;
        let mut pending = self.pending.lock().map_err(|_| AuthError::Storage)?;
        if pending
            .get(&transaction_id)
            .is_some_and(|transaction| transaction.device_id == device_id)
        {
            pending.remove(&transaction_id);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    #[cfg(test)]
    pub(crate) fn expire_for_test(&self, transaction_id: &str) -> Result<(), AuthError> {
        self.pending
            .lock()
            .map_err(|_| AuthError::Storage)?
            .get_mut(transaction_id)
            .ok_or(AuthError::LoginTransaction)?
            .expires_at = 0;
        Ok(())
    }
}

fn canonical_uuid(value: &str) -> Option<String> {
    let parsed = Uuid::parse_str(value).ok()?;
    (parsed.to_string() == value).then(|| value.to_owned())
}

fn valid_base64url_32(value: &str) -> bool {
    value.len() == 43
        && URL_SAFE_NO_PAD
            .decode(value)
            .is_ok_and(|decoded| decoded.len() == 32 && URL_SAFE_NO_PAD.encode(decoded) == value)
}

fn valid_pkce_verifier(value: &str) -> bool {
    (43..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~'))
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && bool::from(left.ct_eq(right))
}

fn unix_seconds() -> Result<i64, AuthError> {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| AuthError::Storage)?
            .as_secs(),
    )
    .map_err(|_| AuthError::Storage)
}
