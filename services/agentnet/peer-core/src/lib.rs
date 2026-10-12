//! Durable snapshots of public device peer credentials issued by this service.
//!
//! The HTTP owner must validate DPoP and the live AuthStore session before
//! lookup. This crate verifies issued JWTs and certificates before persisting
//! them, but never authenticates an HTTP caller or stores bearer/private keys.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use myagents_agent_network_crypto::{certificate_chain, certificate_fingerprint};
use myagents_agent_network_protocol::{budget, validate_access, validate_signed_peer, PeerBinding};
use myagents_agentnet_device_core::{csr_fingerprint, DeviceRecord, SessionContext};
use myagents_agentnet_identity_core::{IssuedIdentity, IssuerProfile, ServiceKeys};
use p256::ecdsa::VerifyingKey;
use rcgen::{CertificateSigningRequestParams, PublicKeyData, PKCS_ECDSA_P256_SHA256};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use url::Url;
use uuid::Uuid;

const DB_NAME: &str = "peers.sqlite3";
const MAX_SNAPSHOTS: i64 = 100_000;
const MAX_TOTAL_SNAPSHOT_BYTES: i64 = 256 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES: usize = 256 * 1024;
const MAX_CERT_CHAIN_BYTES: usize = 196_608;
const MAX_TOKEN_BYTES: usize = 32_768;
const MAX_GENERATION: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerError {
    Configuration,
    UnsafePath,
    Storage,
    InvalidSession,
    ScopeMismatch,
    InvalidIssuedIdentity,
    SnapshotExpired,
    JtiConflict,
    Capacity,
}

impl std::fmt::Display for PeerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Configuration => "peer snapshot profile is invalid",
            Self::UnsafePath => "peer snapshot state path is unsafe",
            Self::Storage => "peer snapshot state is unavailable",
            Self::InvalidSession => "validated session context is invalid or expired",
            Self::ScopeMismatch => "issued identity does not match the current device scope",
            Self::InvalidIssuedIdentity => "issued public identity failed verification",
            Self::SnapshotExpired => "issued public identity has expired",
            Self::JtiConflict => "access token identifier is already bound to different content",
            Self::Capacity => "peer snapshot capacity is exhausted",
        })
    }
}
impl std::error::Error for PeerError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerProfile {
    pub issuer: String,
    pub service_id: String,
    pub environment: String,
    pub network_id: String,
}

impl From<&IssuerProfile> for PeerProfile {
    fn from(value: &IssuerProfile) -> Self {
        Self {
            issuer: value.issuer.clone(),
            service_id: value.service_id.clone(),
            environment: value.environment.clone(),
            network_id: value.network_id.clone(),
        }
    }
}

/// Only public certificate material and scope metadata are retained.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSnapshot {
    pub access_jti: String,
    pub issuer: String,
    pub service_id: String,
    pub environment: String,
    pub network_id: String,
    pub principal_id: String,
    pub device_id: String,
    pub session_handle: String,
    pub key_generation: u64,
    pub key_fingerprint: String,
    pub identity_binding_id: String,
    pub certificate: String,
    pub certificate_chain: Vec<String>,
    pub certificate_fingerprint: String,
    pub signed_binding: String,
    pub access_expires_at: i64,
    pub session_expires_at: i64,
    pub peer_expires_at: i64,
}

impl std::fmt::Debug for PeerSnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PeerSnapshot")
            .field("access_jti", &self.access_jti)
            .field("service_id", &self.service_id)
            .field("environment", &self.environment)
            .field("network_id", &"[redacted]")
            .field("principal_id", &"[redacted]")
            .field("device_id", &"[redacted]")
            .field("session_handle", &"[redacted]")
            .field("key_generation", &self.key_generation)
            .field("key_fingerprint", &self.key_fingerprint)
            .field("identity_binding_id", &"[redacted]")
            .field("certificate", &"[public certificate]")
            .field("certificate_chain", &"[public certificate chain]")
            .field("certificate_fingerprint", &self.certificate_fingerprint)
            .field("signed_binding", &"[public signed binding]")
            .field("access_expires_at", &self.access_expires_at)
            .field("session_expires_at", &self.session_expires_at)
            .field("peer_expires_at", &self.peer_expires_at)
            .finish()
    }
}

pub struct PeerStore {
    connection: Mutex<Connection>,
    profile: PeerProfile,
    _state_dir: PathBuf,
    clock: Arc<dyn Fn() -> Result<i64, PeerError> + Send + Sync>,
}

impl PeerStore {
    pub fn open(state_dir: impl AsRef<Path>, profile: PeerProfile) -> Result<Self, PeerError> {
        validate_profile(&profile)?;
        let state_dir = validate_state_dir(state_dir.as_ref())?;
        let database = state_dir.join(DB_NAME);
        create_private_database_file(&database)?;
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_FULL_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let mut connection =
            Connection::open_with_flags(&database, flags).map_err(|_| PeerError::Storage)?;
        validate_database_file(&database)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| PeerError::Storage)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|_| PeerError::Storage)?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|_| PeerError::Storage)?;
        pin_database_profile(&mut connection, &profile)?;
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS peer_snapshots (
                   access_jti TEXT PRIMARY KEY,
                   network_id TEXT NOT NULL,
                   principal_id TEXT NOT NULL,
                   device_id TEXT NOT NULL,
                   session_handle TEXT NOT NULL,
                   key_generation INTEGER NOT NULL CHECK(key_generation>0),
                   key_fingerprint TEXT NOT NULL,
                   access_expires_at INTEGER NOT NULL,
                   peer_expires_at INTEGER NOT NULL,
                   content_hash TEXT NOT NULL,
                   snapshot_json TEXT NOT NULL,
                   created_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS peer_snapshots_scope
                   ON peer_snapshots(network_id,principal_id,device_id,session_handle,key_generation);",
            )
            .map_err(|_| PeerError::Storage)?;
        validate_database_file(&database)?;
        Ok(Self {
            connection: Mutex::new(connection),
            profile,
            _state_dir: state_dir,
            clock: Arc::new(now_seconds),
        })
    }

    /// Verify an identity returned by this service's signer and durably retain
    /// the exact public snapshot. No access token is persisted.
    pub fn record_issued(
        &self,
        context: &SessionContext,
        device: &DeviceRecord,
        keys: &ServiceKeys,
        issued: &IssuedIdentity,
    ) -> Result<PeerSnapshot, PeerError> {
        validate_context(context)?;
        validate_device_scope(context, device)?;
        let now = (self.clock)()?;
        let snapshot = verify_issued(&self.profile, context, device, keys, issued, now)?;
        let bytes = serde_json::to_vec(&snapshot).map_err(|_| PeerError::Storage)?;
        if bytes.len() > MAX_SNAPSHOT_BYTES {
            return Err(PeerError::InvalidIssuedIdentity);
        }
        let payload_hash = digest(&bytes);
        let snapshot_json = String::from_utf8(bytes).map_err(|_| PeerError::Storage)?;

        let mut connection = self.connection.lock().map_err(|_| PeerError::Storage)?;
        validate_context(context)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| PeerError::Storage)?;
        let locked_now = (self.clock)()?;
        validate_live(&snapshot, context, locked_now)?;
        prune_expired_payloads(&tx, locked_now)?;
        let existing: Option<(String, String, i64, i64)> = tx
            .query_row(
                "SELECT content_hash,snapshot_json,access_expires_at,peer_expires_at
                 FROM peer_snapshots WHERE access_jti=?1",
                params![snapshot.access_jti],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|_| PeerError::Storage)?;
        if let Some((old_hash, old_json, access_exp, peer_exp)) = existing {
            if old_json.is_empty() || access_exp <= locked_now || peer_exp <= locked_now {
                return Err(PeerError::SnapshotExpired);
            }
            let old_snapshot: PeerSnapshot =
                serde_json::from_str(&old_json).map_err(|_| PeerError::Storage)?;
            if old_snapshot.session_expires_at < context.expires_at {
                return Err(PeerError::ScopeMismatch);
            }
            let mut comparable_snapshot = snapshot.clone();
            comparable_snapshot.session_expires_at = old_snapshot.session_expires_at;
            let comparable_bytes =
                serde_json::to_vec(&comparable_snapshot).map_err(|_| PeerError::Storage)?;
            if old_hash != digest(&comparable_bytes) {
                return Err(PeerError::JtiConflict);
            }
            validate_context(context)?;
            validate_live(&old_snapshot, context, (self.clock)()?)?;
            tx.commit().map_err(|_| PeerError::Storage)?;
            return Ok(old_snapshot);
        }
        let count: i64 = tx
            .query_row("SELECT COUNT(*) FROM peer_snapshots", [], |row| row.get(0))
            .map_err(|_| PeerError::Storage)?;
        if count >= MAX_SNAPSHOTS {
            return Err(PeerError::Capacity);
        }
        let total_bytes: i64 = tx
            .query_row(
                "SELECT COALESCE(SUM(LENGTH(snapshot_json)),0) FROM peer_snapshots",
                [],
                |row| row.get(0),
            )
            .map_err(|_| PeerError::Storage)?;
        if total_bytes.saturating_add(snapshot_json.len() as i64) > MAX_TOTAL_SNAPSHOT_BYTES {
            return Err(PeerError::Capacity);
        }
        tx.execute(
            "INSERT INTO peer_snapshots(access_jti,network_id,principal_id,device_id,session_handle,
               key_generation,key_fingerprint,access_expires_at,peer_expires_at,content_hash,snapshot_json,created_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![
                snapshot.access_jti,
                snapshot.network_id,
                snapshot.principal_id,
                snapshot.device_id,
                snapshot.session_handle,
                snapshot.key_generation as i64,
                snapshot.key_fingerprint,
                snapshot.access_expires_at,
                snapshot.peer_expires_at,
                payload_hash,
                snapshot_json,
                locked_now
            ],
        )
        .map_err(|_| PeerError::Storage)?;
        validate_context(context)?;
        validate_live(&snapshot, context, (self.clock)()?)?;
        tx.commit().map_err(|_| PeerError::Storage)?;
        Ok(snapshot)
    }

    /// Return a previously verified public identity only when every live scope
    /// dimension, the current generation/SPKI and both expiry bounds match.
    /// `snapshot.session_expires_at` is the authority ceiling; callers may
    /// shorten it with their current authenticated context, never extend it.
    pub fn lookup(
        &self,
        context: &SessionContext,
        access_jti: &str,
        key_generation: u64,
        key_fingerprint: &str,
    ) -> Result<Option<PeerSnapshot>, PeerError> {
        validate_context(context)?;
        if !canonical_uuid(access_jti)
            || key_generation == 0
            || key_generation > MAX_GENERATION
            || !canonical_fingerprint(key_fingerprint)
        {
            return Err(PeerError::ScopeMismatch);
        }
        let mut connection = self.connection.lock().map_err(|_| PeerError::Storage)?;
        validate_context(context)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| PeerError::Storage)?;
        let now = (self.clock)()?;
        validate_context_at(context, now)?;
        let row: Option<(String, i64, i64)> = tx
            .query_row(
                "SELECT snapshot_json,access_expires_at,peer_expires_at FROM peer_snapshots
                 WHERE access_jti=?1 AND network_id=?2 AND principal_id=?3 AND device_id=?4
                   AND session_handle=?5 AND key_generation=?6 AND key_fingerprint=?7",
                params![
                    access_jti,
                    context.network_id,
                    context.principal_id,
                    context.device_id,
                    context.session_handle,
                    key_generation as i64,
                    key_fingerprint
                ],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|_| PeerError::Storage)?;
        let Some((payload, access_exp, peer_exp)) = row else {
            validate_context(context)?;
            tx.commit().map_err(|_| PeerError::Storage)?;
            return Ok(None);
        };
        if payload.is_empty() || access_exp <= now || peer_exp <= now {
            return Err(PeerError::SnapshotExpired);
        }
        let snapshot: PeerSnapshot =
            serde_json::from_str(&payload).map_err(|_| PeerError::Storage)?;
        if snapshot.issuer != self.profile.issuer
            || snapshot.service_id != self.profile.service_id
            || snapshot.environment != self.profile.environment
            || snapshot.network_id != context.network_id
            || snapshot.principal_id != context.principal_id
            || snapshot.device_id != context.device_id
            || snapshot.session_handle != context.session_handle
            || snapshot.key_generation != key_generation
            || snapshot.key_fingerprint != key_fingerprint
            || snapshot.access_jti != access_jti
        {
            return Err(PeerError::Storage);
        }
        if snapshot.session_expires_at < context.expires_at {
            return Err(PeerError::ScopeMismatch);
        }
        validate_context(context)?;
        validate_live(&snapshot, context, (self.clock)()?)?;
        tx.commit().map_err(|_| PeerError::Storage)?;
        Ok(Some(snapshot))
    }
}

fn verify_issued(
    profile: &PeerProfile,
    context: &SessionContext,
    device: &DeviceRecord,
    keys: &ServiceKeys,
    issued: &IssuedIdentity,
    now: i64,
) -> Result<PeerSnapshot, PeerError> {
    if issued.certificate.is_none()
        || issued.certificate_fingerprint.is_none()
        || issued.signed_binding.is_none()
        || issued.certificate_expires_at.is_none()
        || issued.device_id != context.device_id
        || issued.key_generation != device.key_generation
        || issued.identity_binding_id != device.identity_binding_id
    {
        return Err(PeerError::InvalidIssuedIdentity);
    }
    let access = verify_signed_jwt(&issued.access_token, "ma-network-access+jwt", keys.jwks())?;
    validate_access(&access).map_err(|_| PeerError::InvalidIssuedIdentity)?;
    let binding_token = issued
        .signed_binding
        .as_deref()
        .ok_or(PeerError::InvalidIssuedIdentity)?;
    let peer = verify_signed_jwt(binding_token, "ma-network-peer+jwt", keys.jwks())?;
    validate_signed_peer(&peer).map_err(|_| PeerError::InvalidIssuedIdentity)?;

    let (csr_spki, csr_sec1) = csr_public_key(&device.csr_pem)?;
    if csr_fingerprint(&device.csr_pem).map_err(|_| PeerError::InvalidIssuedIdentity)?
        != device.key_fingerprint
    {
        return Err(PeerError::InvalidIssuedIdentity);
    }
    let jkt = jkt_from_sec1(&csr_sec1)?;
    let jti = string_claim(&access, "jti")?.to_owned();
    let access_exp = integer_claim(&access, "exp")?;
    let access_iat = integer_claim(&access, "iat")?;
    let access_nbf = integer_claim(&access, "nbf")?;
    if !canonical_uuid(&jti)
        || string_claim(&access, "iss")? != profile.issuer
        || string_claim(&access, "aud")? != profile.service_id
        || string_claim(&access, "environment")? != profile.environment
        || string_claim(&access, "sub")? != context.principal_id
        || string_claim(&access, "deviceId")? != context.device_id
        || string_claim(&access, "sessionHandle")? != context.session_handle
        || integer_claim(&access, "keyGeneration")? != device.key_generation as i64
        || access
            .get("cnf")
            .and_then(|v| v.get("jkt"))
            .and_then(Value::as_str)
            != Some(&jkt)
        || access_exp <= now
        || access_exp <= access_iat
        || access_exp.saturating_sub(access_iat) > budget("tokenSeconds") as i64
        || access_nbf > access_exp
        || access_exp != issued.access_token_expires_at as i64
        || access_iat > now.saturating_add(budget("clockSkewSeconds") as i64)
        || access_nbf > now.saturating_add(budget("clockSkewSeconds") as i64)
    {
        return Err(PeerError::InvalidIssuedIdentity);
    }

    let peer_binding: PeerBinding = serde_json::from_value(
        peer.get("binding")
            .cloned()
            .ok_or(PeerError::InvalidIssuedIdentity)?,
    )
    .map_err(|_| PeerError::InvalidIssuedIdentity)?;
    let peer_exp = integer_claim(&peer, "exp")?;
    let peer_iat = integer_claim(&peer, "iat")?;
    let peer_nbf = integer_claim(&peer, "nbf")?;
    let certificate = issued
        .certificate
        .as_deref()
        .ok_or(PeerError::InvalidIssuedIdentity)?;
    let certificate_fingerprint = issued
        .certificate_fingerprint
        .as_deref()
        .ok_or(PeerError::InvalidIssuedIdentity)?;
    let certificate_expires = i64::try_from(
        issued
            .certificate_expires_at
            .ok_or(PeerError::InvalidIssuedIdentity)?,
    )
    .map_err(|_| PeerError::InvalidIssuedIdentity)?;
    let san = format!(
        "{}.devices.{}.invalid",
        device.identity_binding_id, profile.service_id
    );
    if string_claim(&peer, "iss")? != profile.issuer
        || string_claim(&peer, "aud")? != "myagents-agent-peer"
        || string_claim(&peer, "sub")? != context.principal_id
        || !canonical_uuid(string_claim(&peer, "jti")?)
        || peer_exp != certificate_expires
        || peer_iat > now.saturating_add(budget("clockSkewSeconds") as i64)
        || peer_nbf > now.saturating_add(budget("clockSkewSeconds") as i64)
        || peer_exp <= now
        || peer_nbf > peer_exp
        || peer_iat > peer_exp
        || peer_exp.saturating_sub(peer_iat) > budget("certificateSeconds") as i64
        || peer_binding.service_id != profile.service_id
        || peer_binding.environment != profile.environment
        || peer_binding.principal_id != context.principal_id
        || peer_binding.device_id != context.device_id
        || peer_binding.key_generation != device.key_generation
        || peer_binding.identity_binding_id != device.identity_binding_id
        || peer_binding.certificate_fingerprint != certificate_fingerprint
        || peer_binding.san != san
        || peer_binding.certificate != certificate
        || peer_binding.expires_at != certificate_expires as u64
    {
        return Err(PeerError::InvalidIssuedIdentity);
    }

    let (verified_certificate_fingerprint, certificate_chain) = verify_certificate_chain(
        profile,
        device,
        keys,
        certificate,
        &issued.certificate_chain,
        ChainExpectation {
            csr_public: &csr_spki,
            now,
            not_after: certificate_expires,
        },
    )?;
    if verified_certificate_fingerprint != certificate_fingerprint {
        return Err(PeerError::InvalidIssuedIdentity);
    }
    let chain_bytes: usize = certificate_chain.iter().map(String::len).sum();
    if certificate.len() + chain_bytes > MAX_CERT_CHAIN_BYTES {
        return Err(PeerError::InvalidIssuedIdentity);
    }
    if access_exp <= now || context.expires_at <= now || certificate_expires <= now {
        return Err(PeerError::SnapshotExpired);
    }
    Ok(PeerSnapshot {
        access_jti: jti,
        issuer: profile.issuer.clone(),
        service_id: profile.service_id.clone(),
        environment: profile.environment.clone(),
        network_id: profile.network_id.clone(),
        principal_id: context.principal_id.clone(),
        device_id: context.device_id.clone(),
        session_handle: context.session_handle.clone(),
        key_generation: device.key_generation,
        key_fingerprint: device.key_fingerprint.clone(),
        identity_binding_id: device.identity_binding_id.clone(),
        certificate: certificate.to_owned(),
        certificate_chain,
        certificate_fingerprint: certificate_fingerprint.to_owned(),
        signed_binding: binding_token.to_owned(),
        access_expires_at: access_exp,
        session_expires_at: context.expires_at,
        peer_expires_at: certificate_expires,
    })
}

fn verify_signed_jwt(token: &str, expected_type: &str, jwks: Value) -> Result<Value, PeerError> {
    if token.is_empty() || token.len() > MAX_TOKEN_BYTES {
        return Err(PeerError::InvalidIssuedIdentity);
    }
    let segments: Vec<_> = token.split('.').collect();
    if segments.len() != 3
        || segments.iter().any(|segment| {
            !URL_SAFE_NO_PAD
                .decode(segment)
                .is_ok_and(|bytes| URL_SAFE_NO_PAD.encode(bytes) == *segment)
        })
    {
        return Err(PeerError::InvalidIssuedIdentity);
    }
    let header_bytes = URL_SAFE_NO_PAD
        .decode(segments[0])
        .map_err(|_| PeerError::InvalidIssuedIdentity)?;
    let header: Value =
        serde_json::from_slice(&header_bytes).map_err(|_| PeerError::InvalidIssuedIdentity)?;
    let header_object = header.as_object().ok_or(PeerError::InvalidIssuedIdentity)?;
    if header_object.len() != 3
        || header.get("alg").and_then(Value::as_str) != Some("ES256")
        || header.get("typ").and_then(Value::as_str) != Some(expected_type)
    {
        return Err(PeerError::InvalidIssuedIdentity);
    }
    let kid = header
        .get("kid")
        .and_then(Value::as_str)
        .ok_or(PeerError::InvalidIssuedIdentity)?;
    let key = jwks
        .get("keys")
        .and_then(Value::as_array)
        .filter(|keys| keys.len() == 1)
        .and_then(|keys| keys.first())
        .filter(|key| {
            key.get("kid").and_then(Value::as_str) == Some(kid)
                && key.get("kty").and_then(Value::as_str) == Some("EC")
                && key.get("crv").and_then(Value::as_str) == Some("P-256")
                && key.get("alg").and_then(Value::as_str) == Some("ES256")
                && key.get("use").and_then(Value::as_str) == Some("sig")
        })
        .ok_or(PeerError::InvalidIssuedIdentity)?;
    let x = key
        .get("x")
        .and_then(Value::as_str)
        .ok_or(PeerError::InvalidIssuedIdentity)?;
    let y = key
        .get("y")
        .and_then(Value::as_str)
        .ok_or(PeerError::InvalidIssuedIdentity)?;
    let decoding =
        DecodingKey::from_ec_components(x, y).map_err(|_| PeerError::InvalidIssuedIdentity)?;
    let mut validation = Validation::new(Algorithm::ES256);
    validation.validate_exp = false;
    validation.validate_nbf = false;
    validation.validate_aud = false;
    validation.required_spec_claims.clear();
    let token_data = decode::<Value>(token, &decoding, &validation)
        .map_err(|_| PeerError::InvalidIssuedIdentity)?;
    Ok(token_data.claims)
}

struct ChainExpectation<'a> {
    csr_public: &'a [u8],
    now: i64,
    not_after: i64,
}

fn verify_certificate_chain(
    profile: &PeerProfile,
    device: &DeviceRecord,
    keys: &ServiceKeys,
    leaf_pem: &str,
    chain_pems: &[String],
    expected: ChainExpectation<'_>,
) -> Result<(String, Vec<String>), PeerError> {
    if chain_pems.len() != 2 || leaf_pem.len() > 65_536 {
        return Err(PeerError::InvalidIssuedIdentity);
    }
    let leaf_der = certificate_chain(leaf_pem).map_err(|_| PeerError::InvalidIssuedIdentity)?;
    let issuer_der =
        certificate_chain(&chain_pems[0]).map_err(|_| PeerError::InvalidIssuedIdentity)?;
    let root_der =
        certificate_chain(&chain_pems[1]).map_err(|_| PeerError::InvalidIssuedIdentity)?;
    let pinned_root = certificate_chain(keys.root_certificate_pem())
        .map_err(|_| PeerError::InvalidIssuedIdentity)?;
    if leaf_der.len() != 1
        || issuer_der.len() != 1
        || root_der.len() != 1
        || pinned_root.len() != 1
        || root_der[0] != pinned_root[0]
    {
        return Err(PeerError::InvalidIssuedIdentity);
    }
    let (leaf_rest, leaf) = x509_parser::parse_x509_certificate(&leaf_der[0])
        .map_err(|_| PeerError::InvalidIssuedIdentity)?;
    let (issuer_rest, issuer) = x509_parser::parse_x509_certificate(&issuer_der[0])
        .map_err(|_| PeerError::InvalidIssuedIdentity)?;
    let (root_rest, root) = x509_parser::parse_x509_certificate(&root_der[0])
        .map_err(|_| PeerError::InvalidIssuedIdentity)?;
    if !leaf_rest.is_empty()
        || !issuer_rest.is_empty()
        || !root_rest.is_empty()
        || !leaf.validity().is_valid()
        || !issuer.validity().is_valid()
        || !root.validity().is_valid()
        || leaf.tbs_certificate.validity.not_after.timestamp() <= expected.now
        || leaf.tbs_certificate.validity.not_after.timestamp() != expected.not_after
        || leaf.tbs_certificate.issuer != issuer.tbs_certificate.subject
        || issuer.tbs_certificate.issuer != root.tbs_certificate.subject
        || root.tbs_certificate.issuer != root.tbs_certificate.subject
        || leaf
            .verify_signature(Some(&issuer.tbs_certificate.subject_pki))
            .is_err()
        || issuer
            .verify_signature(Some(&root.tbs_certificate.subject_pki))
            .is_err()
        || leaf.tbs_certificate.subject_pki.raw != expected.csr_public
        || !issuer.tbs_certificate.is_ca()
        || !root.tbs_certificate.is_ca()
        || leaf.tbs_certificate.is_ca()
        || !issuer
            .tbs_certificate
            .key_usage()
            .ok()
            .flatten()
            .is_some_and(|usage| usage.value.key_cert_sign())
        || !root
            .tbs_certificate
            .key_usage()
            .ok()
            .flatten()
            .is_some_and(|usage| usage.value.key_cert_sign())
        || !leaf
            .tbs_certificate
            .key_usage()
            .ok()
            .flatten()
            .is_some_and(|usage| usage.value.digital_signature())
        || !leaf
            .tbs_certificate
            .extended_key_usage()
            .ok()
            .flatten()
            .is_some_and(|usage| usage.value.client_auth && usage.value.server_auth)
        || root.verify_signature(None).is_err()
    {
        return Err(PeerError::InvalidIssuedIdentity);
    }
    let san = leaf
        .tbs_certificate
        .subject_alternative_name()
        .map_err(|_| PeerError::InvalidIssuedIdentity)?
        .ok_or(PeerError::InvalidIssuedIdentity)?;
    let expected_san = format!(
        "{}.devices.{}.invalid",
        device.identity_binding_id, profile.service_id
    );
    if san.value.general_names.len() != 1
        || !san.value.general_names.iter().any(|name| {
            matches!(name, x509_parser::extensions::GeneralName::DNSName(value) if *value == expected_san)
        })
    {
        return Err(PeerError::InvalidIssuedIdentity);
    }
    Ok((certificate_fingerprint(&leaf_der[0]), chain_pems.to_vec()))
}

fn csr_public_key(pem: &str) -> Result<(Vec<u8>, Vec<u8>), PeerError> {
    let request = CertificateSigningRequestParams::from_pem(pem)
        .map_err(|_| PeerError::InvalidIssuedIdentity)?;
    if request.public_key.algorithm() != &PKCS_ECDSA_P256_SHA256 {
        return Err(PeerError::InvalidIssuedIdentity);
    }
    let sec1 = request.public_key.der_bytes();
    if sec1.len() != 65 || sec1[0] != 4 {
        return Err(PeerError::InvalidIssuedIdentity);
    }
    VerifyingKey::from_sec1_bytes(sec1).map_err(|_| PeerError::InvalidIssuedIdentity)?;
    Ok((request.public_key.subject_public_key_info(), sec1.to_vec()))
}

fn jkt_from_sec1(point: &[u8]) -> Result<String, PeerError> {
    if point.len() != 65 || point[0] != 4 {
        return Err(PeerError::InvalidIssuedIdentity);
    }
    let jwk = json!({
        "crv":"P-256", "kty":"EC",
        "x":URL_SAFE_NO_PAD.encode(&point[1..33]),
        "y":URL_SAFE_NO_PAD.encode(&point[33..])
    });
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(
        serde_json::to_vec(&jwk).map_err(|_| PeerError::InvalidIssuedIdentity)?,
    )))
}

fn validate_device_scope(context: &SessionContext, device: &DeviceRecord) -> Result<(), PeerError> {
    if device.principal_id != context.principal_id
        || device.network_id != context.network_id
        || device.device_id != context.device_id
        || !canonical_uuid(&device.identity_binding_id)
        || device.key_generation == 0
        || device.key_generation > MAX_GENERATION
        || !canonical_fingerprint(&device.key_fingerprint)
    {
        return Err(PeerError::ScopeMismatch);
    }
    Ok(())
}

fn validate_live(
    snapshot: &PeerSnapshot,
    context: &SessionContext,
    now: i64,
) -> Result<(), PeerError> {
    validate_context_at(context, now)?;
    if snapshot.session_handle != context.session_handle
        || snapshot.network_id != context.network_id
        || snapshot.principal_id != context.principal_id
        || snapshot.device_id != context.device_id
    {
        return Err(PeerError::ScopeMismatch);
    }
    if snapshot.session_expires_at < context.expires_at {
        return Err(PeerError::ScopeMismatch);
    }
    if snapshot.access_expires_at <= now
        || snapshot.session_expires_at <= now
        || snapshot.peer_expires_at <= now
    {
        return Err(PeerError::SnapshotExpired);
    }
    Ok(())
}

fn validate_context(context: &SessionContext) -> Result<(), PeerError> {
    validate_context_at(context, now_seconds()?)
}
fn validate_context_at(context: &SessionContext, now: i64) -> Result<(), PeerError> {
    if !canonical_uuid(&context.principal_id)
        || !canonical_uuid(&context.network_id)
        || !canonical_uuid(&context.device_id)
        || !canonical_uuid(&context.session_handle)
        || context.expires_at <= now
    {
        return Err(PeerError::InvalidSession);
    }
    Ok(())
}
fn validate_profile(profile: &PeerProfile) -> Result<(), PeerError> {
    let issuer = Url::parse(&profile.issuer).map_err(|_| PeerError::Configuration)?;
    if issuer.scheme() != "https"
        || !issuer.username().is_empty()
        || issuer.password().is_some()
        || issuer.query().is_some()
        || issuer.fragment().is_some()
        || issuer.path() != "/"
        || issuer.origin().ascii_serialization() != profile.issuer
        || !canonical_uuid(&profile.service_id)
        || !canonical_uuid(&profile.network_id)
        || !matches!(profile.environment.as_str(), "production" | "development")
    {
        return Err(PeerError::Configuration);
    }
    Ok(())
}
fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|parsed| parsed.to_string() == value)
}
fn canonical_fingerprint(value: &str) -> bool {
    value.len() == 43
        && URL_SAFE_NO_PAD
            .decode(value)
            .is_ok_and(|bytes| bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == value)
}
fn string_claim<'a>(claims: &'a Value, name: &str) -> Result<&'a str, PeerError> {
    claims
        .get(name)
        .and_then(Value::as_str)
        .ok_or(PeerError::InvalidIssuedIdentity)
}
fn integer_claim(claims: &Value, name: &str) -> Result<i64, PeerError> {
    claims
        .get(name)
        .and_then(Value::as_i64)
        .ok_or(PeerError::InvalidIssuedIdentity)
}
fn digest(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(bytes))
}
fn now_seconds() -> Result<i64, PeerError> {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| PeerError::Storage)?
            .as_secs(),
    )
    .map_err(|_| PeerError::Storage)
}

fn validate_state_dir(path: &Path) -> Result<PathBuf, PeerError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| PeerError::UnsafePath)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
        || metadata.permissions().mode() & 0o777 != 0o700
    {
        return Err(PeerError::UnsafePath);
    }
    path.canonicalize().map_err(|_| PeerError::UnsafePath)
}
fn create_private_database_file(path: &Path) -> Result<(), PeerError> {
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(file) => {
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|_| PeerError::Storage)?;
            file.sync_all().map_err(|_| PeerError::Storage)?;
            let parent = path.parent().ok_or(PeerError::UnsafePath)?;
            let directory = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(parent)
                .map_err(|_| PeerError::UnsafePath)?;
            directory.sync_all().map_err(|_| PeerError::Storage)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            validate_database_file(path)
        }
        Err(_) => Err(PeerError::UnsafePath),
    }
}
fn validate_database_file(path: &Path) -> Result<(), PeerError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| PeerError::UnsafePath)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
        || metadata.nlink() != 1
        || metadata.permissions().mode() & 0o777 != 0o600
    {
        return Err(PeerError::UnsafePath);
    }
    Ok(())
}
fn effective_uid() -> u32 {
    nix::unistd::Uid::current().as_raw()
}
fn pin_database_profile(
    connection: &mut Connection,
    profile: &PeerProfile,
) -> Result<(), PeerError> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| PeerError::Storage)?;
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='service_profile')",
            [],
            |row| row.get(0),
        )
        .map_err(|_| PeerError::Storage)?;
    if exists {
        let pinned: Option<(String, String, String, String)> = tx
            .query_row(
                "SELECT issuer,service_id,environment,network_id FROM service_profile WHERE singleton=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|_| PeerError::Storage)?;
        let Some(pinned) = pinned else {
            return Err(PeerError::Storage);
        };
        if pinned
            != (
                profile.issuer.clone(),
                profile.service_id.clone(),
                profile.environment.clone(),
                profile.network_id.clone(),
            )
        {
            return Err(PeerError::Configuration);
        }
    } else {
        if has_user_table_rows(&tx)? {
            return Err(PeerError::Configuration);
        }
        tx.execute_batch(
            "CREATE TABLE service_profile (
               singleton INTEGER PRIMARY KEY CHECK(singleton=1),
               issuer TEXT NOT NULL,
               service_id TEXT NOT NULL,
               environment TEXT NOT NULL,
               network_id TEXT NOT NULL
             );",
        )
        .map_err(|_| PeerError::Storage)?;
        tx.execute(
            "INSERT INTO service_profile(singleton,issuer,service_id,environment,network_id)
             VALUES(1,?1,?2,?3,?4)",
            params![
                profile.issuer,
                profile.service_id,
                profile.environment,
                profile.network_id
            ],
        )
        .map_err(|_| PeerError::Storage)?;
    }
    tx.commit().map_err(|_| PeerError::Storage)
}
fn has_user_table_rows(connection: &Connection) -> Result<bool, PeerError> {
    let mut statement = connection
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .map_err(|_| PeerError::Storage)?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| PeerError::Storage)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| PeerError::Storage)?;
    for name in names {
        let quoted = format!("\"{}\"", name.replace('"', "\"\""));
        let has_rows: bool = connection
            .query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {quoted} LIMIT 1)"),
                [],
                |row| row.get(0),
            )
            .map_err(|_| PeerError::Storage)?;
        if has_rows {
            return Ok(true);
        }
    }
    Ok(false)
}
fn prune_expired_payloads(tx: &rusqlite::Transaction<'_>, now: i64) -> Result<(), PeerError> {
    // Keep each access jti and content hash permanently as an anti-reuse
    // tombstone; only public payload bytes are cleared after expiry.
    tx.execute(
        "UPDATE peer_snapshots SET snapshot_json='' WHERE (access_expires_at<=?1 OR peer_expires_at<=?1) AND snapshot_json<>''",
        params![now],
    )
    .map_err(|_| PeerError::Storage)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use myagents_agent_network_crypto::DevicePrivateKey;
    use std::{os::unix::fs::PermissionsExt, sync::Arc};

    struct Fixture {
        dir: tempfile::TempDir,
        profile: PeerProfile,
        context: SessionContext,
        device: DeviceRecord,
        keys: ServiceKeys,
        key_path: PathBuf,
        issued: IssuedIdentity,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
            let profile = PeerProfile {
                issuer: "https://agentnet.example.test".into(),
                service_id: Uuid::new_v4().to_string(),
                environment: "development".into(),
                network_id: Uuid::new_v4().to_string(),
            };
            let issuer = IssuerProfile {
                issuer: profile.issuer.clone(),
                service_id: profile.service_id.clone(),
                environment: profile.environment.clone(),
                network_id: profile.network_id.clone(),
            };
            let context = SessionContext {
                principal_id: Uuid::new_v4().to_string(),
                network_id: profile.network_id.clone(),
                device_id: Uuid::new_v4().to_string(),
                session_handle: Uuid::new_v4().to_string(),
                expires_at: now_seconds().unwrap() + 60 * 24 * 60 * 60,
            };
            let device_key = DevicePrivateKey::generate().unwrap();
            let csr_pem = device_key.csr().unwrap();
            let device = DeviceRecord {
                principal_id: context.principal_id.clone(),
                network_id: context.network_id.clone(),
                device_id: context.device_id.clone(),
                identity_binding_id: Uuid::new_v4().to_string(),
                key_generation: 1,
                key_fingerprint: csr_fingerprint(&csr_pem).unwrap(),
                csr_pem,
            };
            let key_path = dir.path().join("service-keys.json");
            let keys = ServiceKeys::generate_initial(&key_path).unwrap();
            let issued = keys
                .issue(
                    &issuer,
                    &myagents_agentnet_identity_core::IdentityRequest {
                        principal_id: context.principal_id.clone(),
                        device_id: context.device_id.clone(),
                        key_generation: device.key_generation,
                        identity_binding_id: device.identity_binding_id.clone(),
                        session_handle: context.session_handle.clone(),
                        csr_pem: device.csr_pem.clone(),
                    },
                )
                .unwrap();
            Self {
                dir,
                profile,
                context,
                device,
                keys,
                key_path,
                issued,
            }
        }

        fn store(&self) -> PeerStore {
            PeerStore::open(self.dir.path(), self.profile.clone()).unwrap()
        }
    }

    #[test]
    fn verified_snapshot_is_idempotent_public_restart_stable_and_scope_bound() {
        let f = Fixture::new();
        let store = f.store();
        let snapshot = store
            .record_issued(&f.context, &f.device, &f.keys, &f.issued)
            .unwrap();
        assert_eq!(snapshot.issuer, f.profile.issuer);
        assert_eq!(snapshot.network_id, f.context.network_id);
        assert_eq!(snapshot.principal_id, f.context.principal_id);
        assert_eq!(snapshot.device_id, f.context.device_id);
        assert_eq!(snapshot.key_fingerprint, f.device.key_fingerprint);
        assert_eq!(snapshot.identity_binding_id, f.device.identity_binding_id);
        assert_eq!(snapshot.certificate, f.issued.certificate.clone().unwrap());
        assert_eq!(
            snapshot.signed_binding,
            f.issued.signed_binding.clone().unwrap()
        );
        let serialized = serde_json::to_string(&snapshot).unwrap();
        assert!(!serialized.contains(&f.issued.access_token));
        assert!(!serialized.contains("accessToken"));
        assert_eq!(
            store
                .record_issued(&f.context, &f.device, &f.keys, &f.issued)
                .unwrap(),
            snapshot
        );
        let loaded = store
            .lookup(
                &f.context,
                &snapshot.access_jti,
                snapshot.key_generation,
                &snapshot.key_fingerprint,
            )
            .unwrap()
            .unwrap();
        assert_eq!(loaded, snapshot);
        assert!(snapshot.access_expires_at < f.context.expires_at);
        let mut bounded_context = f.context.clone();
        bounded_context.expires_at = now_seconds().unwrap() + 600;
        assert!(bounded_context.expires_at < f.context.expires_at);
        assert_eq!(
            store
                .lookup(
                    &bounded_context,
                    &snapshot.access_jti,
                    snapshot.key_generation,
                    &snapshot.key_fingerprint,
                )
                .unwrap(),
            Some(snapshot.clone()),
            "a live authenticated context may shorten the snapshot authority ceiling"
        );
        assert_eq!(
            store
                .record_issued(&bounded_context, &f.device, &f.keys, &f.issued)
                .unwrap(),
            snapshot,
            "retry with a shorter live projection returns the same authoritative snapshot"
        );
        let mut extended_context = f.context.clone();
        extended_context.expires_at += 1;
        assert_eq!(
            store.lookup(
                &extended_context,
                &snapshot.access_jti,
                snapshot.key_generation,
                &snapshot.key_fingerprint,
            ),
            Err(PeerError::ScopeMismatch),
            "a caller cannot extend the stored session authority"
        );
        drop(store);
        let restarted = f.store();
        assert_eq!(
            restarted
                .lookup(
                    &f.context,
                    &snapshot.access_jti,
                    snapshot.key_generation,
                    &snapshot.key_fingerprint,
                )
                .unwrap(),
            Some(snapshot.clone())
        );

        let mut other_session = f.context.clone();
        other_session.session_handle = Uuid::new_v4().to_string();
        assert_eq!(
            restarted.lookup(
                &other_session,
                &snapshot.access_jti,
                snapshot.key_generation,
                &snapshot.key_fingerprint,
            ),
            Ok(None)
        );
        assert!(matches!(
            restarted.lookup(
                &f.context,
                &snapshot.access_jti,
                snapshot.key_generation + 1,
                &snapshot.key_fingerprint
            ),
            Ok(None)
        ));
        let mut other_context = f.context.clone();
        other_context.principal_id = Uuid::new_v4().to_string();
        assert_eq!(
            restarted.lookup(
                &other_context,
                &snapshot.access_jti,
                snapshot.key_generation,
                &snapshot.key_fingerprint
            ),
            Ok(None)
        );
        let mut other_device = f.context.clone();
        other_device.device_id = Uuid::new_v4().to_string();
        assert_eq!(
            restarted.lookup(
                &other_device,
                &snapshot.access_jti,
                snapshot.key_generation,
                &snapshot.key_fingerprint
            ),
            Ok(None)
        );
        let mut expired_context = f.context.clone();
        expired_context.expires_at = now_seconds().unwrap() - 1;
        assert_eq!(
            restarted.lookup(
                &expired_context,
                &snapshot.access_jti,
                snapshot.key_generation,
                &snapshot.key_fingerprint
            ),
            Err(PeerError::InvalidSession)
        );
    }

    #[test]
    fn tampered_signature_scope_generation_and_profile_are_rejected() {
        let f = Fixture::new();
        let store = f.store();
        let mut bad_access = IssuedIdentity {
            device_id: f.issued.device_id.clone(),
            key_generation: f.issued.key_generation,
            identity_binding_id: f.issued.identity_binding_id.clone(),
            certificate: f.issued.certificate.clone(),
            certificate_chain: f.issued.certificate_chain.clone(),
            certificate_fingerprint: f.issued.certificate_fingerprint.clone(),
            signed_binding: f.issued.signed_binding.clone(),
            certificate_expires_at: f.issued.certificate_expires_at,
            access_token: f.issued.access_token.clone(),
            access_token_expires_at: f.issued.access_token_expires_at,
            bootstrap_grant: f.issued.bootstrap_grant.clone(),
        };
        bad_access.access_token.push('x');
        assert_eq!(
            store.record_issued(&f.context, &f.device, &f.keys, &bad_access),
            Err(PeerError::InvalidIssuedIdentity)
        );

        let mut bad_binding = IssuedIdentity {
            device_id: f.issued.device_id.clone(),
            key_generation: f.issued.key_generation,
            identity_binding_id: f.issued.identity_binding_id.clone(),
            certificate: f.issued.certificate.clone(),
            certificate_chain: f.issued.certificate_chain.clone(),
            certificate_fingerprint: f.issued.certificate_fingerprint.clone(),
            signed_binding: f.issued.signed_binding.clone(),
            certificate_expires_at: f.issued.certificate_expires_at,
            access_token: f.issued.access_token.clone(),
            access_token_expires_at: f.issued.access_token_expires_at,
            bootstrap_grant: f.issued.bootstrap_grant.clone(),
        };
        bad_binding.signed_binding.as_mut().unwrap().push('x');
        assert_eq!(
            store.record_issued(&f.context, &f.device, &f.keys, &bad_binding),
            Err(PeerError::InvalidIssuedIdentity)
        );

        let mut bad_certificate = IssuedIdentity {
            device_id: f.issued.device_id.clone(),
            key_generation: f.issued.key_generation,
            identity_binding_id: f.issued.identity_binding_id.clone(),
            certificate: f.issued.certificate.clone(),
            certificate_chain: f.issued.certificate_chain.clone(),
            certificate_fingerprint: f.issued.certificate_fingerprint.clone(),
            signed_binding: f.issued.signed_binding.clone(),
            certificate_expires_at: f.issued.certificate_expires_at,
            access_token: f.issued.access_token.clone(),
            access_token_expires_at: f.issued.access_token_expires_at,
            bootstrap_grant: f.issued.bootstrap_grant.clone(),
        };
        bad_certificate.certificate.as_mut().unwrap().push('x');
        assert_eq!(
            store.record_issued(&f.context, &f.device, &f.keys, &bad_certificate),
            Err(PeerError::InvalidIssuedIdentity)
        );

        let mut wrong_generation = f.device.clone();
        wrong_generation.key_generation = 2;
        assert_eq!(
            store.record_issued(&f.context, &wrong_generation, &f.keys, &f.issued),
            Err(PeerError::InvalidIssuedIdentity)
        );
        let mut wrong_context = f.context.clone();
        wrong_context.session_handle = Uuid::new_v4().to_string();
        assert_eq!(
            store.record_issued(&wrong_context, &f.device, &f.keys, &f.issued),
            Err(PeerError::InvalidIssuedIdentity)
        );
        let mut wrong_principal = f.context.clone();
        wrong_principal.principal_id = Uuid::new_v4().to_string();
        assert_eq!(
            store.record_issued(&wrong_principal, &f.device, &f.keys, &f.issued),
            Err(PeerError::ScopeMismatch)
        );
        let mut wrong_network = f.context.clone();
        wrong_network.network_id = Uuid::new_v4().to_string();
        assert_eq!(
            store.record_issued(&wrong_network, &f.device, &f.keys, &f.issued),
            Err(PeerError::ScopeMismatch)
        );
        let mut other_profiles = Vec::new();
        let mut changed = f.profile.clone();
        changed.service_id = Uuid::new_v4().to_string();
        other_profiles.push(changed);
        let mut changed = f.profile.clone();
        changed.environment = "production".into();
        other_profiles.push(changed);
        let mut changed = f.profile.clone();
        changed.network_id = Uuid::new_v4().to_string();
        other_profiles.push(changed);
        let mut changed = f.profile.clone();
        changed.issuer = "https://different.example.test".into();
        other_profiles.push(changed);
        for changed in other_profiles {
            assert!(matches!(
                PeerStore::open(f.dir.path(), changed),
                Err(PeerError::Configuration)
            ));
        }
    }

    #[test]
    fn jti_conflict_and_expired_snapshot_are_fail_closed() {
        let f = Fixture::new();
        let store = f.store();
        let snapshot = store
            .record_issued(&f.context, &f.device, &f.keys, &f.issued)
            .unwrap();

        let segments: Vec<_> = f.issued.access_token.split('.').collect();
        let claims: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(segments[1]).unwrap()).unwrap();
        let old_exp = integer_claim(&claims, "exp").unwrap();
        let jti = string_claim(&claims, "jti").unwrap().to_owned();
        let mut changed_claims = claims;
        changed_claims["exp"] = json!(old_exp - 1);
        let key_doc: Value = serde_json::from_slice(&fs::read(&f.key_path).unwrap()).unwrap();
        let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::ES256);
        header.typ = Some("ma-network-access+jwt".into());
        header.kid = f.keys.jwks()["keys"][0]["kid"].as_str().map(str::to_owned);
        use p256::pkcs8::{DecodePrivateKey, EncodePrivateKey};
        let signing_key =
            p256::ecdsa::SigningKey::from_pkcs8_pem(key_doc["signingKeyPem"].as_str().unwrap())
                .unwrap();
        let signing_der = signing_key.to_pkcs8_der().unwrap();
        let encoding_key = jsonwebtoken::EncodingKey::from_ec_der(signing_der.as_bytes());
        let changed_access = jsonwebtoken::encode(&header, &changed_claims, &encoding_key).unwrap();
        let same_jti_new_content = IssuedIdentity {
            device_id: f.issued.device_id.clone(),
            key_generation: f.issued.key_generation,
            identity_binding_id: f.issued.identity_binding_id.clone(),
            certificate: f.issued.certificate.clone(),
            certificate_chain: f.issued.certificate_chain.clone(),
            certificate_fingerprint: f.issued.certificate_fingerprint.clone(),
            signed_binding: f.issued.signed_binding.clone(),
            certificate_expires_at: f.issued.certificate_expires_at,
            access_token: changed_access,
            access_token_expires_at: (old_exp - 1) as u64,
            bootstrap_grant: f.issued.bootstrap_grant.clone(),
        };
        assert_eq!(
            store.record_issued(&f.context, &f.device, &f.keys, &same_jti_new_content),
            Err(PeerError::JtiConflict)
        );
        assert_eq!(snapshot.access_jti, jti);

        store
            .connection
            .lock()
            .unwrap()
            .execute(
                "UPDATE peer_snapshots SET access_expires_at=0 WHERE access_jti=?1",
                params![snapshot.access_jti],
            )
            .unwrap();
        assert_eq!(
            store.lookup(
                &f.context,
                &snapshot.access_jti,
                snapshot.key_generation,
                &snapshot.key_fingerprint
            ),
            Err(PeerError::SnapshotExpired)
        );
        assert_eq!(
            store.record_issued(&f.context, &f.device, &f.keys, &f.issued),
            Err(PeerError::SnapshotExpired),
            "expired jti is never reused to mint or replace a snapshot"
        );
    }

    #[test]
    fn duplicate_rechecks_expiry_after_locked_validation_and_preserves_snapshot() {
        use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

        let f = Fixture::new();
        let mut store = f.store();
        let original = store
            .record_issued(&f.context, &f.device, &f.keys, &f.issued)
            .unwrap();
        let initial_now = now_seconds().unwrap();
        let expiry = original.access_expires_at.min(original.peer_expires_at);
        assert!(expiry > initial_now);

        let calls = Arc::new(AtomicUsize::new(0));
        let simulated_now = Arc::new(AtomicI64::new(initial_now));
        let clock_calls = Arc::clone(&calls);
        let clock_now = Arc::clone(&simulated_now);
        store.clock = Arc::new(move || match clock_calls.fetch_add(1, Ordering::SeqCst) {
            // Signature/schema verification begins while the issued identity is live.
            0 => Ok(initial_now),
            // The transaction's locked-time check also sees it as live; expiry
            // then advances before the idempotent branch's final pre-commit check.
            1 => {
                clock_now.store(expiry, Ordering::SeqCst);
                Ok(initial_now)
            }
            _ => Ok(clock_now.load(Ordering::SeqCst)),
        });

        assert_eq!(
            store.record_issued(&f.context, &f.device, &f.keys, &f.issued),
            Err(PeerError::SnapshotExpired),
            "duplicate issuance must fail if access/peer expiry crosses after the locked check"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            3,
            "final fresh-time check ran"
        );

        store.clock = Arc::new(now_seconds);
        let still_persisted = store
            .lookup(
                &f.context,
                &original.access_jti,
                original.key_generation,
                &original.key_fingerprint,
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            still_persisted, original,
            "failed replay leaves original row intact"
        );
    }

    #[test]
    fn state_permissions_profile_race_legacy_and_capacity_are_bounded() {
        let f = Fixture::new();
        let _store = f.store();
        let db = f.dir.path().join(DB_NAME);
        let metadata = fs::metadata(&db).unwrap();
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        assert_eq!(metadata.nlink(), 1);
        let symlink_dir = tempfile::tempdir().unwrap();
        fs::set_permissions(symlink_dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        std::os::unix::fs::symlink(&db, symlink_dir.path().join(DB_NAME)).unwrap();
        assert!(matches!(
            PeerStore::open(symlink_dir.path(), f.profile.clone()),
            Err(PeerError::UnsafePath)
        ));

        let mut handles = Vec::new();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        for environment in ["development", "production"] {
            let barrier = barrier.clone();
            let path = f.dir.path().to_path_buf();
            let mut profile = f.profile.clone();
            profile.environment = environment.into();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                PeerStore::open(path, profile)
            }));
        }
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|r| matches!(r, Err(PeerError::Configuration)))
                .count(),
            1
        );

        let legacy_dir = tempfile::tempdir().unwrap();
        fs::set_permissions(legacy_dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let legacy_path = legacy_dir.path().join(DB_NAME);
        let legacy = Connection::open(&legacy_path).unwrap();
        legacy
            .execute("CREATE TABLE old_rows(value TEXT)", [])
            .unwrap();
        legacy
            .execute("INSERT INTO old_rows(value) VALUES('keep')", [])
            .unwrap();
        drop(legacy);
        fs::set_permissions(&legacy_path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(matches!(
            PeerStore::open(legacy_dir.path(), f.profile.clone()),
            Err(PeerError::Configuration)
        ));
        let legacy = Connection::open(&legacy_path).unwrap();
        let kept: String = legacy
            .query_row("SELECT value FROM old_rows", [], |row| row.get(0))
            .unwrap();
        assert_eq!(kept, "keep");

        let capacity_dir = tempfile::tempdir().unwrap();
        fs::set_permissions(capacity_dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let capacity_store = PeerStore::open(capacity_dir.path(), f.profile.clone()).unwrap();
        {
            let mut connection = capacity_store.connection.lock().unwrap();
            let tx = connection.transaction().unwrap();
            for i in 0..MAX_SNAPSHOTS {
                tx.execute(
                    "INSERT INTO peer_snapshots(access_jti,network_id,principal_id,device_id,session_handle,
                       key_generation,key_fingerprint,access_expires_at,peer_expires_at,content_hash,snapshot_json,created_at)
                     VALUES(?1,'n','p','d','s',1,'f',0,0,'h','',0)",
                    params![Uuid::new_v4().to_string() + &i.to_string()],
                ).unwrap();
            }
            tx.commit().unwrap();
        }
        assert_eq!(
            capacity_store.record_issued(&f.context, &f.device, &f.keys, &f.issued),
            Err(PeerError::Capacity)
        );
    }
}
