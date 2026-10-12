use crate::{AuthConfig, VerifiedSubject};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::random;
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AuthError {
    #[error("service authentication configuration is invalid")]
    Configuration,
    #[error("authentication state path is unsafe")]
    UnsafePath,
    #[error("authentication state is unavailable")]
    Storage,
    #[error("OIDC configuration is invalid")]
    OidcConfiguration,
    #[error("OIDC identity was rejected")]
    OidcRejected,
    #[error("login transaction is invalid, expired, cancelled, or already used")]
    LoginTransaction,
    #[error("login proof of possession is invalid")]
    LoginProof,
    #[error("session is invalid, expired, or revoked")]
    SessionRejected,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountProjection {
    pub principal_id: String,
    pub network_id: String,
}

/// A bearer credential is returned exactly once to its caller. Only its SHA-256
/// digest is durable; Debug intentionally does not reveal it.
pub struct IssuedSession {
    token: Zeroizing<String>,
    pub expires_at: i64,
    pub account: AccountProjection,
}

impl IssuedSession {
    pub fn into_token(self) -> Zeroizing<String> {
        self.token
    }
}

impl std::fmt::Debug for IssuedSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IssuedSession")
            .field("token", &"[redacted]")
            .field("expires_at", &self.expires_at)
            .field("account", &self.account)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionProjection {
    pub account: AccountProjection,
    pub device_id: String,
    pub expires_at: i64,
}

pub struct AuthStore {
    connection: Mutex<Connection>,
    network_id: String,
    session_ttl_seconds: i64,
    _state_dir: PathBuf,
}

impl AuthStore {
    pub fn open(state_dir: impl AsRef<Path>, config: &AuthConfig) -> Result<Self, AuthError> {
        let network_id = canonical_uuid(&config.network_id).ok_or(AuthError::Configuration)?;
        let ttl = i64::try_from(config.session_ttl.as_secs())
            .ok()
            .filter(|seconds| (60..=31_536_000).contains(seconds))
            .ok_or(AuthError::Configuration)?;
        let state_dir = validate_state_dir(state_dir.as_ref())?;
        let database = state_dir.join("auth.sqlite3");
        create_private_database_file(&database)?;
        let connection = Connection::open_with_flags(
            &database,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NOFOLLOW
                | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
        )
        .map_err(|_| AuthError::Storage)?;
        validate_database_file(&database)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| AuthError::Storage)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|_| AuthError::Storage)?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|_| AuthError::Storage)?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE IF NOT EXISTS principals (
                   issuer TEXT NOT NULL,
                   subject TEXT NOT NULL,
                   principal_id TEXT NOT NULL UNIQUE,
                   network_id TEXT NOT NULL,
                   created_at INTEGER NOT NULL,
                   PRIMARY KEY (issuer, subject)
                 );
                 CREATE TABLE IF NOT EXISTS sessions (
                   token_hash BLOB PRIMARY KEY,
                   principal_id TEXT NOT NULL REFERENCES principals(principal_id),
                   device_id TEXT NOT NULL,
                   created_at INTEGER NOT NULL,
                   expires_at INTEGER NOT NULL,
                   revoked_at INTEGER
                 );
                 CREATE INDEX IF NOT EXISTS sessions_principal
                   ON sessions(principal_id, expires_at);",
            )
            .map_err(|_| AuthError::Storage)?;
        validate_database_file(&database)?;
        Ok(Self {
            connection: Mutex::new(connection),
            network_id,
            session_ttl_seconds: ttl,
            _state_dir: state_dir,
        })
    }

    pub(crate) fn issue_session(
        &self,
        subject: &VerifiedSubject,
        device_id: &str,
    ) -> Result<IssuedSession, AuthError> {
        let device_id = canonical_uuid(device_id).ok_or(AuthError::LoginTransaction)?;
        if subject.issuer().is_empty()
            || subject.issuer().len() > 2048
            || subject.subject().is_empty()
            || subject.subject().len() > 512
        {
            return Err(AuthError::OidcRejected);
        }
        let token = Zeroizing::new(URL_SAFE_NO_PAD.encode(random::<[u8; 32]>()));
        let token_hash = Sha256::digest(token.as_bytes()).to_vec();
        let now = unix_seconds()?;
        let expires_at = now
            .checked_add(self.session_ttl_seconds)
            .ok_or(AuthError::Storage)?;
        let mut connection = self.connection.lock().map_err(|_| AuthError::Storage)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthError::Storage)?;
        transaction
            .execute(
                "INSERT INTO principals(issuer,subject,principal_id,network_id,created_at)
                 VALUES(?1,?2,?3,?4,?5) ON CONFLICT(issuer,subject) DO NOTHING",
                params![
                    subject.issuer(),
                    subject.subject(),
                    Uuid::new_v4().to_string(),
                    self.network_id,
                    now
                ],
            )
            .map_err(|_| AuthError::Storage)?;
        let account = transaction
            .query_row(
                "SELECT principal_id, network_id FROM principals WHERE issuer=?1 AND subject=?2",
                params![subject.issuer(), subject.subject()],
                |row| {
                    Ok(AccountProjection {
                        principal_id: row.get(0)?,
                        network_id: row.get(1)?,
                    })
                },
            )
            .map_err(|_| AuthError::Storage)?;
        if account.network_id != self.network_id {
            return Err(AuthError::Storage);
        }
        transaction
            .execute(
                "INSERT INTO sessions(token_hash,principal_id,device_id,created_at,expires_at)
                 VALUES(?1,?2,?3,?4,?5)",
                params![token_hash, account.principal_id, device_id, now, expires_at],
            )
            .map_err(|_| AuthError::Storage)?;
        transaction.commit().map_err(|_| AuthError::Storage)?;
        Ok(IssuedSession {
            token,
            expires_at,
            account,
        })
    }

    pub fn validate_session(&self, token: &str) -> Result<SessionProjection, AuthError> {
        if token.len() != 43
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return Err(AuthError::SessionRejected);
        }
        let token_hash = Sha256::digest(token.as_bytes()).to_vec();
        let now = unix_seconds().map_err(|_| AuthError::SessionRejected)?;
        let connection = self.connection.lock().map_err(|_| AuthError::Storage)?;
        connection
            .query_row(
                "SELECT p.principal_id,p.network_id,s.device_id,s.expires_at
                 FROM sessions s JOIN principals p ON p.principal_id=s.principal_id
                 WHERE s.token_hash=?1 AND s.revoked_at IS NULL AND s.expires_at>?2",
                params![token_hash, now],
                |row| {
                    Ok(SessionProjection {
                        account: AccountProjection {
                            principal_id: row.get(0)?,
                            network_id: row.get(1)?,
                        },
                        device_id: row.get(2)?,
                        expires_at: row.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(|_| AuthError::Storage)?
            .ok_or(AuthError::SessionRejected)
    }

    pub fn revoke_session(&self, token: &str) -> Result<(), AuthError> {
        if token.len() != 43 {
            return Err(AuthError::SessionRejected);
        }
        let digest = Sha256::digest(token.as_bytes()).to_vec();
        let now = unix_seconds()?;
        let connection = self.connection.lock().map_err(|_| AuthError::Storage)?;
        connection
            .execute(
                "UPDATE sessions SET revoked_at=?2 WHERE token_hash=?1 AND revoked_at IS NULL",
                params![digest, now],
            )
            .map_err(|_| AuthError::Storage)?;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn expire_session_for_test(&self, token: &str) -> Result<(), AuthError> {
        let digest = Sha256::digest(token.as_bytes()).to_vec();
        self.connection
            .lock()
            .map_err(|_| AuthError::Storage)?
            .execute(
                "UPDATE sessions SET expires_at=0 WHERE token_hash=?1",
                params![digest],
            )
            .map_err(|_| AuthError::Storage)?;
        Ok(())
    }
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

fn canonical_uuid(value: &str) -> Option<String> {
    let parsed = Uuid::parse_str(value).ok()?;
    (parsed.to_string() == value).then(|| value.to_owned())
}

#[cfg(unix)]
fn create_private_database_file(path: &Path) -> Result<(), AuthError> {
    use std::os::unix::fs::OpenOptionsExt;
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(file) => {
            file.sync_all().map_err(|_| AuthError::Storage)?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            validate_database_file(path)
        }
        Err(_) => Err(AuthError::UnsafePath),
    }
}

#[cfg(not(unix))]
fn create_private_database_file(path: &Path) -> Result<(), AuthError> {
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(file) => file.sync_all().map_err(|_| AuthError::Storage),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            validate_database_file(path)
        }
        Err(_) => Err(AuthError::UnsafePath),
    }
}

#[cfg(unix)]
fn validate_state_dir(path: &Path) -> Result<PathBuf, AuthError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let metadata = std::fs::symlink_metadata(path).map_err(|_| AuthError::UnsafePath)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != nix::unistd::Uid::current().as_raw()
        || metadata.permissions().mode() & 0o777 != 0o700
    {
        return Err(AuthError::UnsafePath);
    }
    path.canonicalize().map_err(|_| AuthError::UnsafePath)
}

#[cfg(not(unix))]
fn validate_state_dir(path: &Path) -> Result<PathBuf, AuthError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| AuthError::UnsafePath)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(AuthError::UnsafePath);
    }
    path.canonicalize().map_err(|_| AuthError::UnsafePath)
}

#[cfg(unix)]
fn validate_database_file(path: &Path) -> Result<(), AuthError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let metadata = std::fs::symlink_metadata(path).map_err(|_| AuthError::UnsafePath)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != nix::unistd::Uid::current().as_raw()
        || metadata.nlink() != 1
        || metadata.permissions().mode() & 0o777 != 0o600
    {
        return Err(AuthError::UnsafePath);
    }
    Ok(())
}

#[cfg(not(unix))]
fn validate_database_file(path: &Path) -> Result<(), AuthError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| AuthError::UnsafePath)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(AuthError::UnsafePath);
    }
    Ok(())
}
