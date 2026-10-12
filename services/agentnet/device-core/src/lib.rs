//! Durable owner for AgentNet device public-key bindings and one-shot PoP.
//!
//! Authentication is deliberately external: callers must pass a freshly
//! validated `SessionContext`. This crate stores no bearer token and performs
//! no HTTP admission, certificate issuance, JWT signing, or relay work.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use myagents_agent_network_protocol::budget;
use p256::ecdsa::{signature::Verifier as _, Signature, VerifyingKey};
use rand::RngCore;
use rcgen::{CertificateSigningRequestParams, PublicKeyData, PKCS_ECDSA_P256_SHA256};
use rusqlite::{
    params, Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior,
};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;
use zeroize::Zeroize;

const DB_NAME: &str = "devices.sqlite3";
const MAX_CSR_BYTES: usize = 65_536;
const MAX_GENERATION: i64 = 9_007_199_254_740_991;
const MAX_PENDING_PER_DEVICE: i64 = 8;
const CHALLENGE_RETENTION_SECONDS: i64 = 86_400;
const POP_DOMAIN: &[u8] = b"MyAgents Agent Network PoP v1\n";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceError {
    UnsafePath,
    Storage,
    InvalidSession,
    InvalidInput,
    DeviceNotFound,
    DeviceAlreadyClaimed,
    OwnerMismatch,
    GenerationConflict,
    ChallengeRejected,
    ChallengeExpired,
    ProofInvalid,
    GenerationExhausted,
}

impl std::fmt::Display for DeviceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::UnsafePath => "device state path is unsafe",
            Self::Storage => "device state is unavailable",
            Self::InvalidSession => "validated session context is invalid or expired",
            Self::InvalidInput => "device operation input is invalid",
            Self::DeviceNotFound => "device was not found",
            Self::DeviceAlreadyClaimed => "device already has an immutable key owner",
            Self::OwnerMismatch => "device belongs to another principal",
            Self::GenerationConflict => "device key generation changed",
            Self::ChallengeRejected => "proof challenge is invalid, consumed, or out of scope",
            Self::ChallengeExpired => "proof challenge expired",
            Self::ProofInvalid => "device proof of possession is invalid",
            Self::GenerationExhausted => "device key generation is exhausted",
        })
    }
}
impl std::error::Error for DeviceError {}

/// Authenticated by the caller immediately before invoking this crate.
/// `session_handle` must be an independently generated durable UUID, never a
/// derivation of a bearer token. No raw credential is accepted or retained.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionContext {
    pub principal_id: String,
    pub network_id: String,
    pub device_id: String,
    pub session_handle: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceRecord {
    pub principal_id: String,
    pub network_id: String,
    pub device_id: String,
    pub identity_binding_id: String,
    pub key_generation: u64,
    /// SHA-256 of DER SubjectPublicKeyInfo, matching the desktop
    /// `DevicePrivateKey::public_fingerprint()` identity protocol field.
    pub key_fingerprint: String,
    /// Verified original CSR, retained for the certificate issuer. HTTP status
    /// handlers must not return this field to clients.
    pub csr_pem: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChallengeOperation {
    RecoverQuery,
    Renew,
    Rotate,
}

impl ChallengeOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::RecoverQuery => "recover-query",
            Self::Renew => "renew",
            Self::Rotate => "rotate",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PopChallenge {
    pub challenge_id: String,
    pub nonce: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone)]
struct CsrPublicKey {
    sec1: Vec<u8>,
    fingerprint: String,
}

pub struct DeviceStore {
    connection: Mutex<Connection>,
    _state_dir: PathBuf,
}

impl DeviceStore {
    /// Open a separate, private SQLite owner database in an existing 0700
    /// state directory. Existing invalid state is rejected, never recreated.
    pub fn open(state_dir: impl AsRef<Path>) -> Result<Self, DeviceError> {
        let state_dir = validate_state_dir(state_dir.as_ref())?;
        let database = state_dir.join(DB_NAME);
        create_private_database_file(&database)?;
        let connection = Connection::open_with_flags(
            &database,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NOFOLLOW
                | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
        )
        .map_err(|_| DeviceError::Storage)?;
        validate_database_file(&database)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| DeviceError::Storage)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|_| DeviceError::Storage)?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|_| DeviceError::Storage)?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE IF NOT EXISTS devices (
                   network_id TEXT NOT NULL,
                   device_id TEXT NOT NULL,
                   principal_id TEXT NOT NULL,
                   identity_binding_id TEXT NOT NULL,
                   key_generation INTEGER NOT NULL CHECK(key_generation > 0),
                   key_fingerprint TEXT NOT NULL,
                   public_key BLOB NOT NULL,
                   csr_pem TEXT NOT NULL,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL,
                   PRIMARY KEY(network_id, device_id)
                 );
                 CREATE INDEX IF NOT EXISTS devices_owner
                   ON devices(network_id, principal_id);
                 CREATE TABLE IF NOT EXISTS pop_challenges (
                   challenge_id TEXT PRIMARY KEY,
                   nonce BLOB NOT NULL,
                   operation TEXT NOT NULL,
                   network_id TEXT NOT NULL,
                   principal_id TEXT NOT NULL,
                   device_id TEXT NOT NULL,
                   session_handle TEXT NOT NULL,
                   key_generation INTEGER NOT NULL,
                   key_fingerprint TEXT NOT NULL,
                   expires_at INTEGER NOT NULL,
                   consumed_at INTEGER
                 );
                 CREATE INDEX IF NOT EXISTS pop_challenges_pending
                   ON pop_challenges(network_id, device_id, consumed_at, expires_at);",
            )
            .map_err(|_| DeviceError::Storage)?;
        validate_database_file(&database)?;
        Ok(Self {
            connection: Mutex::new(connection),
            _state_dir: state_dir,
        })
    }

    /// Claim a device exactly once. The CSR signature is parsed and verified
    /// by rcgen; only its P-256 public key is retained. A key owner can never
    /// be replaced through this method.
    pub fn claim_initial(
        &self,
        context: &SessionContext,
        csr_pem: &str,
    ) -> Result<DeviceRecord, DeviceError> {
        validate_context(context)?;
        let key = parse_csr_public_key(csr_pem)?;
        let binding_id = Uuid::new_v4().to_string();
        let mut connection = self.connection.lock().map_err(|_| DeviceError::Storage)?;
        validate_context(context)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| DeviceError::Storage)?;
        validate_context(context)?;
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM devices WHERE network_id=?1 AND device_id=?2)",
                params![context.network_id, context.device_id],
                |row| row.get(0),
            )
            .map_err(|_| DeviceError::Storage)?;
        if exists {
            return Err(DeviceError::DeviceAlreadyClaimed);
        }
        let now = unix_seconds()?;
        validate_context_at(context, now)?;
        transaction
            .execute(
                "INSERT INTO devices(network_id,device_id,principal_id,identity_binding_id,
                   key_generation,key_fingerprint,public_key,csr_pem,created_at,updated_at)
                 VALUES(?1,?2,?3,?4,1,?5,?6,?7,?8,?8)",
                params![
                    context.network_id,
                    context.device_id,
                    context.principal_id,
                    binding_id,
                    key.fingerprint,
                    key.sec1,
                    csr_pem,
                    now
                ],
            )
            .map_err(|_| DeviceError::DeviceAlreadyClaimed)?;
        validate_context(context)?;
        transaction.commit().map_err(|_| DeviceError::Storage)?;
        validate_context(context)?;
        Ok(DeviceRecord {
            principal_id: context.principal_id.clone(),
            network_id: context.network_id.clone(),
            device_id: context.device_id.clone(),
            identity_binding_id: binding_id,
            key_generation: 1,
            key_fingerprint: key.fingerprint,
            csr_pem: csr_pem.to_owned(),
        })
    }

    /// Same-principal, same-network lookup used by IdentityState. It never
    /// grants mutation authority over another device.
    pub fn read_state(
        &self,
        context: &SessionContext,
        target_device_id: &str,
    ) -> Result<Option<DeviceRecord>, DeviceError> {
        validate_context(context)?;
        if !canonical_uuid(target_device_id) {
            return Err(DeviceError::InvalidInput);
        }
        let connection = self.connection.lock().map_err(|_| DeviceError::Storage)?;
        validate_context(context)?;
        let record = connection
            .query_row(
                "SELECT principal_id,network_id,device_id,identity_binding_id,key_generation,key_fingerprint,csr_pem
                 FROM devices WHERE network_id=?1 AND device_id=?2",
                params![context.network_id, target_device_id],
                row_record,
            )
            .optional()
            .map_err(|_| DeviceError::Storage)?;
        validate_context(context)?;
        let Some(record) = record else {
            return Ok(None);
        };
        if record.principal_id != context.principal_id {
            return Ok(None);
        }
        Ok(Some(record))
    }

    /// Mint a single-use challenge bound to the current device key and the
    /// exact authenticated session handle. Only the context's own device can
    /// be challenged; read_state's cross-device lookup is read-only.
    pub fn create_challenge(
        &self,
        context: &SessionContext,
        operation: ChallengeOperation,
        expected_generation: u64,
        target_fingerprint: &str,
    ) -> Result<PopChallenge, DeviceError> {
        validate_context(context)?;
        if expected_generation == 0
            || expected_generation > MAX_GENERATION as u64
            || !canonical_fingerprint(target_fingerprint)
        {
            return Err(DeviceError::InvalidInput);
        }
        let now = unix_seconds()?;
        let ttl = i64::try_from(budget("popSeconds")).map_err(|_| DeviceError::Storage)?;
        if ttl <= 0 {
            return Err(DeviceError::Storage);
        }
        let expires_at = now
            .checked_add(ttl)
            .ok_or(DeviceError::Storage)?
            .min(context.expires_at);
        if expires_at <= now {
            return Err(DeviceError::InvalidSession);
        }
        let challenge_id = Uuid::new_v4().to_string();
        let mut nonce = [0u8; 32];
        rand::rng().fill_bytes(&mut nonce);
        let nonce_encoded = URL_SAFE_NO_PAD.encode(nonce);
        let mut connection = self.connection.lock().map_err(|_| DeviceError::Storage)?;
        validate_context(context)?;
        if unix_seconds()? >= expires_at {
            return Err(DeviceError::ChallengeExpired);
        }
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| DeviceError::Storage)?;
        validate_context(context)?;
        if unix_seconds()? >= expires_at {
            return Err(DeviceError::ChallengeExpired);
        }
        let record = read_owned_device(&transaction, context)?;
        if record.key_generation != expected_generation {
            return Err(DeviceError::GenerationConflict);
        }
        if record.key_fingerprint != target_fingerprint {
            return Err(DeviceError::GenerationConflict);
        }
        let insert_now = unix_seconds()?;
        validate_context_at(context, insert_now)?;
        if insert_now >= expires_at {
            return Err(DeviceError::ChallengeExpired);
        }
        transaction
            .execute(
                "DELETE FROM pop_challenges
                 WHERE consumed_at IS NOT NULL OR expires_at<=?1",
                params![insert_now.saturating_sub(CHALLENGE_RETENTION_SECONDS)],
            )
            .map_err(|_| DeviceError::Storage)?;
        let pending: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM pop_challenges
                 WHERE network_id=?1 AND device_id=?2 AND consumed_at IS NULL AND expires_at>?3",
                params![context.network_id, context.device_id, insert_now],
                |row| row.get(0),
            )
            .map_err(|_| DeviceError::Storage)?;
        if pending >= MAX_PENDING_PER_DEVICE {
            return Err(DeviceError::ChallengeRejected);
        }
        transaction
            .execute(
                "INSERT INTO pop_challenges(challenge_id,nonce,operation,network_id,principal_id,
                   device_id,session_handle,key_generation,key_fingerprint,expires_at,consumed_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,NULL)",
                params![
                    challenge_id,
                    nonce.as_slice(),
                    operation.as_str(),
                    context.network_id,
                    context.principal_id,
                    context.device_id,
                    context.session_handle,
                    expected_generation as i64,
                    target_fingerprint,
                    expires_at
                ],
            )
            .map_err(|_| DeviceError::Storage)?;
        let before_commit = unix_seconds()?;
        validate_context_at(context, before_commit)?;
        if before_commit >= expires_at {
            return Err(DeviceError::ChallengeExpired);
        }
        transaction.commit().map_err(|_| DeviceError::Storage)?;
        nonce.zeroize();
        let before_return = unix_seconds()?;
        if before_return >= expires_at || before_return >= context.expires_at {
            consume_expired_challenge(&mut connection, &challenge_id, before_return)?;
            return Err(DeviceError::ChallengeExpired);
        }
        Ok(PopChallenge {
            challenge_id,
            nonce: nonce_encoded,
            expires_at,
        })
    }

    /// Consume a query/renew challenge. Bad signatures and stale generations
    /// are committed as consumed, so a failed proof cannot be replayed.
    pub fn consume_proof(
        &self,
        context: &SessionContext,
        operation: ChallengeOperation,
        expected_generation: u64,
        challenge_id: &str,
        proof: &str,
    ) -> Result<DeviceRecord, DeviceError> {
        if operation == ChallengeOperation::Rotate {
            return Err(DeviceError::InvalidInput);
        }
        validate_context(context)?;
        validate_generation(expected_generation)?;
        let mut connection = self.connection.lock().map_err(|_| DeviceError::Storage)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| DeviceError::Storage)?;
        let challenge = load_challenge(&transaction, context, challenge_id)?;
        if challenge.operation != operation.as_str()
            || challenge.key_generation != expected_generation as i64
            || challenge.expires_at > context.expires_at
        {
            return Err(DeviceError::ChallengeRejected);
        }
        if challenge.consumed_at.is_some() {
            return Err(DeviceError::ChallengeRejected);
        }
        let after_read = unix_seconds()?;
        if challenge_expired(context, challenge.expires_at, after_read) {
            consume_challenge_row(&transaction, challenge_id, after_read)?;
            transaction.commit().map_err(|_| DeviceError::Storage)?;
            return Err(DeviceError::ChallengeExpired);
        }
        let current = read_owned_device(&transaction, context)?;
        let is_current = current.key_generation == challenge.key_generation as u64
            && current.key_fingerprint == challenge.key_fingerprint;
        let valid_proof = is_current
            && verify_proof(&challenge.public_key, challenge_id, &challenge.nonce, proof);
        let before_consume = unix_seconds()?;
        if challenge_expired(context, challenge.expires_at, before_consume) {
            consume_challenge_row(&transaction, challenge_id, before_consume)?;
            transaction.commit().map_err(|_| DeviceError::Storage)?;
            return Err(DeviceError::ChallengeExpired);
        }
        consume_challenge_row(&transaction, challenge_id, before_consume)?;
        commit_consumed_challenge(transaction, context, challenge.expires_at)?;
        let before_return = unix_seconds()?;
        if challenge_expired(context, challenge.expires_at, before_return) {
            return Err(DeviceError::ChallengeExpired);
        }
        if !is_current {
            return Err(DeviceError::GenerationConflict);
        }
        if !valid_proof {
            return Err(DeviceError::ProofInvalid);
        }
        Ok(current)
    }

    /// Rotate the key only after an old-key PoP tied to this exact operation,
    /// owner, device, session, and generation. Proof consumption and CAS update
    /// share one IMMEDIATE transaction.
    pub fn rotate_with_proof(
        &self,
        context: &SessionContext,
        expected_generation: u64,
        challenge_id: &str,
        proof: &str,
        new_csr_pem: &str,
    ) -> Result<DeviceRecord, DeviceError> {
        validate_context(context)?;
        validate_generation(expected_generation)?;
        let new_key = parse_csr_public_key(new_csr_pem)?;
        let mut connection = self.connection.lock().map_err(|_| DeviceError::Storage)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| DeviceError::Storage)?;
        let challenge = load_challenge(&transaction, context, challenge_id)?;
        if challenge.operation != ChallengeOperation::Rotate.as_str()
            || challenge.key_generation != expected_generation as i64
            || challenge.expires_at > context.expires_at
        {
            return Err(DeviceError::ChallengeRejected);
        }
        if challenge.consumed_at.is_some() {
            return Err(DeviceError::ChallengeRejected);
        }
        let after_read = unix_seconds()?;
        if challenge_expired(context, challenge.expires_at, after_read) {
            consume_challenge_row(&transaction, challenge_id, after_read)?;
            transaction.commit().map_err(|_| DeviceError::Storage)?;
            return Err(DeviceError::ChallengeExpired);
        }
        let current = read_owned_device(&transaction, context)?;
        let is_current = current.key_generation == challenge.key_generation as u64
            && current.key_fingerprint == challenge.key_fingerprint
            && current.key_generation == expected_generation;
        let valid_proof = is_current
            && verify_proof(&challenge.public_key, challenge_id, &challenge.nonce, proof);
        let before_consume = unix_seconds()?;
        if challenge_expired(context, challenge.expires_at, before_consume) {
            consume_challenge_row(&transaction, challenge_id, before_consume)?;
            transaction.commit().map_err(|_| DeviceError::Storage)?;
            return Err(DeviceError::ChallengeExpired);
        }
        consume_challenge_row(&transaction, challenge_id, before_consume)?;
        if !is_current {
            commit_consumed_challenge(transaction, context, challenge.expires_at)?;
            return Err(DeviceError::GenerationConflict);
        }
        if !valid_proof {
            commit_consumed_challenge(transaction, context, challenge.expires_at)?;
            return Err(DeviceError::ProofInvalid);
        }
        let Some(next_generation) = expected_generation
            .checked_add(1)
            .filter(|generation| *generation <= MAX_GENERATION as u64)
        else {
            commit_consumed_challenge(transaction, context, challenge.expires_at)?;
            return Err(DeviceError::GenerationExhausted);
        };
        transaction
            .execute_batch("SAVEPOINT rotate_update")
            .map_err(|_| DeviceError::Storage)?;
        let now = unix_seconds()?;
        if challenge_expired(context, challenge.expires_at, now) {
            transaction
                .execute_batch("ROLLBACK TO rotate_update; RELEASE rotate_update")
                .map_err(|_| DeviceError::Storage)?;
            transaction.commit().map_err(|_| DeviceError::Storage)?;
            return Err(DeviceError::ChallengeExpired);
        }
        let updated = transaction
            .execute(
                 "UPDATE devices SET key_generation=?1,key_fingerprint=?2,public_key=?3,csr_pem=?4,updated_at=?5
                 WHERE network_id=?6 AND device_id=?7 AND principal_id=?8 AND key_generation=?9",
                params![
                    next_generation as i64,
                    new_key.fingerprint,
                    new_key.sec1,
                    new_csr_pem,
                    now,
                    context.network_id,
                    context.device_id,
                    context.principal_id,
                    expected_generation as i64
                ],
            )
            .map_err(|_| DeviceError::Storage)?;
        if updated != 1 {
            transaction
                .execute_batch("RELEASE rotate_update")
                .map_err(|_| DeviceError::Storage)?;
            transaction.commit().map_err(|_| DeviceError::Storage)?;
            return Err(DeviceError::GenerationConflict);
        }
        let before_commit = unix_seconds()?;
        if challenge_expired(context, challenge.expires_at, before_commit) {
            transaction
                .execute_batch("ROLLBACK TO rotate_update; RELEASE rotate_update")
                .map_err(|_| DeviceError::Storage)?;
            transaction.commit().map_err(|_| DeviceError::Storage)?;
            return Err(DeviceError::ChallengeExpired);
        }
        transaction
            .execute_batch("RELEASE rotate_update")
            .map_err(|_| DeviceError::Storage)?;
        transaction.commit().map_err(|_| DeviceError::Storage)?;
        let after_commit = unix_seconds()?;
        if challenge_expired(context, challenge.expires_at, after_commit) {
            return Err(DeviceError::ChallengeExpired);
        }
        Ok(DeviceRecord {
            key_generation: next_generation,
            key_fingerprint: new_key.fingerprint,
            csr_pem: new_csr_pem.to_owned(),
            ..current
        })
    }
}

#[derive(Debug)]
struct StoredChallenge {
    nonce: Vec<u8>,
    operation: String,
    key_generation: i64,
    key_fingerprint: String,
    expires_at: i64,
    consumed_at: Option<i64>,
    public_key: Vec<u8>,
}

fn load_challenge(
    transaction: &Transaction<'_>,
    context: &SessionContext,
    challenge_id: &str,
) -> Result<StoredChallenge, DeviceError> {
    if !canonical_uuid(challenge_id) {
        return Err(DeviceError::ChallengeRejected);
    }
    let challenge = transaction
        .query_row(
            "SELECT c.nonce,c.operation,c.key_generation,c.key_fingerprint,c.expires_at,c.consumed_at,d.public_key
             FROM pop_challenges c JOIN devices d
               ON d.network_id=c.network_id AND d.device_id=c.device_id
             WHERE c.challenge_id=?1 AND c.network_id=?2 AND c.principal_id=?3
               AND c.device_id=?4 AND c.session_handle=?5",
            params![
                challenge_id,
                context.network_id,
                context.principal_id,
                context.device_id,
                context.session_handle
            ],
            |row| {
                Ok(StoredChallenge {
                    nonce: row.get(0)?,
                    operation: row.get(1)?,
                    key_generation: row.get(2)?,
                    key_fingerprint: row.get(3)?,
                    expires_at: row.get(4)?,
                    consumed_at: row.get(5)?,
                    public_key: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|_| DeviceError::Storage)?
        .ok_or(DeviceError::ChallengeRejected)?;
    Ok(challenge)
}

fn consume_challenge_row(
    transaction: &Transaction<'_>,
    challenge_id: &str,
    now: i64,
) -> Result<(), DeviceError> {
    let updated = transaction
        .execute(
            "UPDATE pop_challenges SET consumed_at=?1 WHERE challenge_id=?2 AND consumed_at IS NULL",
            params![now, challenge_id],
        )
        .map_err(|_| DeviceError::Storage)?;
    if updated != 1 {
        return Err(DeviceError::ChallengeRejected);
    }
    Ok(())
}

/// Commit a consumed challenge even when its deadline crossed immediately
/// after proof verification, and report expiry in preference to the original
/// proof outcome. This prevents a race from returning success after expiry.
fn commit_consumed_challenge(
    transaction: Transaction<'_>,
    context: &SessionContext,
    challenge_expires_at: i64,
) -> Result<(), DeviceError> {
    let now = unix_seconds()?;
    let expired = challenge_expired(context, challenge_expires_at, now);
    transaction.commit().map_err(|_| DeviceError::Storage)?;
    if expired {
        return Err(DeviceError::ChallengeExpired);
    }
    Ok(())
}

fn consume_expired_challenge(
    connection: &mut Connection,
    challenge_id: &str,
    now: i64,
) -> Result<(), DeviceError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| DeviceError::Storage)?;
    consume_challenge_row(&transaction, challenge_id, now)?;
    transaction.commit().map_err(|_| DeviceError::Storage)
}

fn read_owned_device(
    transaction: &Transaction<'_>,
    context: &SessionContext,
) -> Result<DeviceRecord, DeviceError> {
    let record = transaction
        .query_row(
            "SELECT principal_id,network_id,device_id,identity_binding_id,key_generation,key_fingerprint,csr_pem
             FROM devices WHERE network_id=?1 AND device_id=?2",
            params![context.network_id, context.device_id],
            row_record,
        )
        .optional()
        .map_err(|_| DeviceError::Storage)?
        .ok_or(DeviceError::DeviceNotFound)?;
    if record.principal_id != context.principal_id {
        return Err(DeviceError::OwnerMismatch);
    }
    Ok(record)
}

fn row_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeviceRecord> {
    let generation: i64 = row.get(4)?;
    Ok(DeviceRecord {
        principal_id: row.get(0)?,
        network_id: row.get(1)?,
        device_id: row.get(2)?,
        identity_binding_id: row.get(3)?,
        key_generation: generation.max(0) as u64,
        key_fingerprint: row.get(5)?,
        csr_pem: row.get(6)?,
    })
}

fn parse_csr_public_key(pem: &str) -> Result<CsrPublicKey, DeviceError> {
    if pem.is_empty() || pem.len() > MAX_CSR_BYTES {
        return Err(DeviceError::InvalidInput);
    }
    let request =
        CertificateSigningRequestParams::from_pem(pem).map_err(|_| DeviceError::InvalidInput)?;
    if request.public_key.algorithm() != &PKCS_ECDSA_P256_SHA256 {
        return Err(DeviceError::InvalidInput);
    }
    let sec1 = request.public_key.der_bytes().to_vec();
    let verifying_key =
        VerifyingKey::from_sec1_bytes(&sec1).map_err(|_| DeviceError::InvalidInput)?;
    let point = verifying_key.to_encoded_point(false);
    if point.as_bytes() != sec1 || sec1.len() != 65 {
        return Err(DeviceError::InvalidInput);
    }
    let spki_der = request.public_key.subject_public_key_info();
    let fingerprint = URL_SAFE_NO_PAD.encode(Sha256::digest(spki_der));
    Ok(CsrPublicKey { sec1, fingerprint })
}

/// Parse and cryptographically verify a CSR, then return the SHA-256
/// fingerprint of its P-256 SubjectPublicKeyInfo. Callers compare this with
/// the persisted device record before issuing a certificate.
pub fn csr_fingerprint(pem: &str) -> Result<String, DeviceError> {
    Ok(parse_csr_public_key(pem)?.fingerprint)
}

fn verify_proof(public_key: &[u8], challenge_id: &str, nonce: &[u8], proof: &str) -> bool {
    if nonce.len() != 32 || proof.len() != 86 || !canonical_uuid(challenge_id) {
        return false;
    }
    let Ok(signature_bytes) = URL_SAFE_NO_PAD.decode(proof) else {
        return false;
    };
    if signature_bytes.len() != 64 || URL_SAFE_NO_PAD.encode(&signature_bytes) != proof {
        return false;
    }
    let Ok(key) = VerifyingKey::from_sec1_bytes(public_key) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(&signature_bytes) else {
        return false;
    };
    let mut message = Vec::with_capacity(POP_DOMAIN.len() + 37 + nonce.len());
    message.extend_from_slice(POP_DOMAIN);
    message.extend_from_slice(challenge_id.as_bytes());
    message.push(b'\n');
    message.extend_from_slice(nonce);
    key.verify(&message, &signature).is_ok()
}

fn validate_context(context: &SessionContext) -> Result<(), DeviceError> {
    validate_context_shape(context)?;
    let now = unix_seconds()?;
    validate_context_at(context, now)
}

fn validate_context_at(context: &SessionContext, now: i64) -> Result<(), DeviceError> {
    validate_context_shape(context)?;
    if context.expires_at <= now {
        return Err(DeviceError::InvalidSession);
    }
    Ok(())
}

fn validate_context_shape(context: &SessionContext) -> Result<(), DeviceError> {
    if !canonical_uuid(&context.principal_id)
        || !canonical_uuid(&context.network_id)
        || !canonical_uuid(&context.device_id)
        || !canonical_uuid(&context.session_handle)
    {
        return Err(DeviceError::InvalidSession);
    }
    Ok(())
}

fn challenge_expired(context: &SessionContext, expires_at: i64, now: i64) -> bool {
    now >= expires_at || now >= context.expires_at
}

fn canonical_fingerprint(value: &str) -> bool {
    if value.len() != 43 {
        return false;
    }
    URL_SAFE_NO_PAD
        .decode(value)
        .is_ok_and(|bytes| bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == value)
}

fn validate_generation(generation: u64) -> Result<(), DeviceError> {
    if generation == 0 || generation > MAX_GENERATION as u64 {
        return Err(DeviceError::InvalidInput);
    }
    Ok(())
}

fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|parsed| parsed.to_string() == value)
}

fn unix_seconds() -> Result<i64, DeviceError> {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| DeviceError::Storage)?
            .as_secs(),
    )
    .map_err(|_| DeviceError::Storage)
}

fn validate_state_dir(path: &Path) -> Result<PathBuf, DeviceError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| DeviceError::UnsafePath)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
        || metadata.permissions().mode() & 0o777 != 0o700
    {
        return Err(DeviceError::UnsafePath);
    }
    path.canonicalize().map_err(|_| DeviceError::UnsafePath)
}

fn create_private_database_file(path: &Path) -> Result<(), DeviceError> {
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(file) => {
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|_| DeviceError::Storage)?;
            file.sync_all().map_err(|_| DeviceError::Storage)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            validate_database_file(path)
        }
        Err(_) => Err(DeviceError::UnsafePath),
    }
}

fn validate_database_file(path: &Path) -> Result<(), DeviceError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| DeviceError::UnsafePath)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
        || metadata.nlink() != 1
        || metadata.permissions().mode() & 0o777 != 0o600
    {
        return Err(DeviceError::UnsafePath);
    }
    Ok(())
}

fn effective_uid() -> u32 {
    nix::unistd::Uid::current().as_raw()
}

#[cfg(test)]
mod tests {
    use super::*;
    use myagents_agent_network_crypto::DevicePrivateKey;
    use std::{os::unix::fs::PermissionsExt, sync::Arc, thread};

    fn private_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        dir
    }

    fn context() -> SessionContext {
        SessionContext {
            principal_id: Uuid::new_v4().to_string(),
            network_id: Uuid::new_v4().to_string(),
            device_id: Uuid::new_v4().to_string(),
            session_handle: Uuid::new_v4().to_string(),
            expires_at: unix_seconds().unwrap() + 3_600,
        }
    }

    fn claim(store: &DeviceStore, context: &SessionContext) -> DevicePrivateKey {
        let key = DevicePrivateKey::generate().unwrap();
        store.claim_initial(context, &key.csr().unwrap()).unwrap();
        key
    }

    fn challenge(
        store: &DeviceStore,
        context: &SessionContext,
        operation: ChallengeOperation,
    ) -> PopChallenge {
        let record = store
            .read_state(context, &context.device_id)
            .unwrap()
            .unwrap();
        store
            .create_challenge(
                context,
                operation,
                record.key_generation,
                &record.key_fingerprint,
            )
            .unwrap()
    }

    #[test]
    fn initial_claim_is_immutable_owner_scoped_and_survives_restart() {
        let dir = private_dir();
        let context = context();
        let first = DeviceStore::open(dir.path()).unwrap();
        assert_eq!(
            first.read_state(&context, &context.device_id).unwrap(),
            None
        );
        let key = DevicePrivateKey::generate().unwrap();
        let csr = key.csr().unwrap();
        let original = first.claim_initial(&context, &csr).unwrap();
        assert_eq!(original.key_generation, 1);
        assert_eq!(key.public_fingerprint().unwrap(), original.key_fingerprint);
        assert_ne!(key.public_thumbprint().unwrap(), original.key_fingerprint);
        assert_eq!(original.csr_pem, csr);
        assert_eq!(
            csr_fingerprint(&original.csr_pem).unwrap(),
            original.key_fingerprint
        );
        assert_eq!(
            first.read_state(&context, &context.device_id).unwrap(),
            Some(original.clone())
        );
        assert_eq!(
            first
                .claim_initial(
                    &context,
                    &DevicePrivateKey::generate().unwrap().csr().unwrap()
                )
                .unwrap_err(),
            DeviceError::DeviceAlreadyClaimed
        );

        let other_owner = SessionContext {
            principal_id: Uuid::new_v4().to_string(),
            ..context.clone()
        };
        assert_eq!(
            first.read_state(&other_owner, &context.device_id).unwrap(),
            None
        );
        assert_eq!(
            first
                .claim_initial(
                    &other_owner,
                    &DevicePrivateKey::generate().unwrap().csr().unwrap()
                )
                .unwrap_err(),
            DeviceError::DeviceAlreadyClaimed
        );
        assert_eq!(
            first
                .create_challenge(
                    &other_owner,
                    ChallengeOperation::Renew,
                    1,
                    &original.key_fingerprint
                )
                .unwrap_err(),
            DeviceError::OwnerMismatch
        );

        let second_device_context = SessionContext {
            device_id: Uuid::new_v4().to_string(),
            session_handle: Uuid::new_v4().to_string(),
            ..context.clone()
        };
        let second_device = DevicePrivateKey::generate().unwrap();
        let second_record = first
            .claim_initial(&second_device_context, &second_device.csr().unwrap())
            .unwrap();
        assert_eq!(
            first
                .read_state(&context, &second_device_context.device_id)
                .unwrap(),
            Some(second_record.clone())
        );
        assert_eq!(
            first
                .create_challenge(
                    &context,
                    ChallengeOperation::Renew,
                    second_record.key_generation,
                    &second_record.key_fingerprint
                )
                .unwrap_err(),
            DeviceError::GenerationConflict
        );

        drop(first);
        let reopened = DeviceStore::open(dir.path()).unwrap();
        assert_eq!(
            reopened.read_state(&context, &context.device_id).unwrap(),
            Some(original.clone())
        );
        let connection = reopened.connection.lock().unwrap();
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        let synchronous: i64 = connection
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .unwrap();
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        assert_eq!(synchronous, 2, "SQLite FULL synchronous mode");
        drop(connection);
        let database = dir.path().join(DB_NAME);
        let metadata = fs::metadata(&database).unwrap();
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        assert_eq!(metadata.nlink(), 1);
        assert_eq!(metadata.uid(), effective_uid());
        let wal = dir.path().join(format!("{DB_NAME}-wal"));
        if wal.exists() {
            let wal_metadata = fs::metadata(wal).unwrap();
            assert_eq!(wal_metadata.permissions().mode() & 0o777, 0o600);
            assert_eq!(wal_metadata.uid(), effective_uid());
            assert_eq!(wal_metadata.nlink(), 1);
        }
    }

    #[test]
    fn proof_is_exact_p1363_single_use_and_bad_attempt_is_consumed() {
        let dir = private_dir();
        let store = DeviceStore::open(dir.path()).unwrap();
        let context = context();
        let key = claim(&store, &context);

        let valid = challenge(&store, &context, ChallengeOperation::RecoverQuery);
        let proof = key.sign_proof(&valid.challenge_id, &valid.nonce).unwrap();
        drop(store);
        let store = DeviceStore::open(dir.path()).unwrap();
        let confirmed = store
            .consume_proof(
                &context,
                ChallengeOperation::RecoverQuery,
                1,
                &valid.challenge_id,
                &proof,
            )
            .unwrap();
        assert_eq!(confirmed.key_generation, 1);
        drop(store);
        let store = DeviceStore::open(dir.path()).unwrap();
        assert_eq!(
            store
                .consume_proof(
                    &context,
                    ChallengeOperation::RecoverQuery,
                    1,
                    &valid.challenge_id,
                    &proof
                )
                .unwrap_err(),
            DeviceError::ChallengeRejected
        );

        let failed = challenge(&store, &context, ChallengeOperation::Renew);
        let different_key = DevicePrivateKey::generate().unwrap();
        let wrong_but_well_formed_proof = different_key
            .sign_proof(&failed.challenge_id, &failed.nonce)
            .unwrap();
        assert_eq!(
            store
                .consume_proof(
                    &context,
                    ChallengeOperation::Renew,
                    1,
                    &failed.challenge_id,
                    &wrong_but_well_formed_proof
                )
                .unwrap_err(),
            DeviceError::ProofInvalid
        );
        let later_correct_proof = key.sign_proof(&failed.challenge_id, &failed.nonce).unwrap();
        assert_eq!(
            store
                .consume_proof(
                    &context,
                    ChallengeOperation::Renew,
                    1,
                    &failed.challenge_id,
                    &later_correct_proof
                )
                .unwrap_err(),
            DeviceError::ChallengeRejected
        );
    }

    #[test]
    fn expired_and_wrong_session_challenges_fail_closed() {
        let dir = private_dir();
        let store = DeviceStore::open(dir.path()).unwrap();
        let context = context();
        let key = claim(&store, &context);

        let expired = challenge(&store, &context, ChallengeOperation::Renew);
        store
            .connection
            .lock()
            .unwrap()
            .execute(
                "UPDATE pop_challenges SET expires_at=0 WHERE challenge_id=?1",
                params![expired.challenge_id],
            )
            .unwrap();
        let proof = key
            .sign_proof(&expired.challenge_id, &expired.nonce)
            .unwrap();
        assert_eq!(
            store
                .consume_proof(
                    &context,
                    ChallengeOperation::Renew,
                    1,
                    &expired.challenge_id,
                    &proof
                )
                .unwrap_err(),
            DeviceError::ChallengeExpired
        );
        assert_eq!(
            store
                .consume_proof(
                    &context,
                    ChallengeOperation::Renew,
                    1,
                    &expired.challenge_id,
                    &proof
                )
                .unwrap_err(),
            DeviceError::ChallengeRejected
        );

        let scoped = challenge(&store, &context, ChallengeOperation::RecoverQuery);
        let other_session = SessionContext {
            session_handle: Uuid::new_v4().to_string(),
            ..context.clone()
        };
        let other_proof = key.sign_proof(&scoped.challenge_id, &scoped.nonce).unwrap();
        assert_eq!(
            store
                .consume_proof(
                    &other_session,
                    ChallengeOperation::RecoverQuery,
                    1,
                    &scoped.challenge_id,
                    &other_proof
                )
                .unwrap_err(),
            DeviceError::ChallengeRejected
        );
        assert!(store
            .consume_proof(
                &context,
                ChallengeOperation::RecoverQuery,
                1,
                &scoped.challenge_id,
                &other_proof
            )
            .is_ok());
    }

    #[test]
    fn rotate_preserves_binding_and_concurrent_cas_allows_one_winner() {
        let dir = private_dir();
        let store = Arc::new(DeviceStore::open(dir.path()).unwrap());
        let second_store = Arc::new(DeviceStore::open(dir.path()).unwrap());
        let context = context();
        let old_key = claim(&store, &context);
        let original = store
            .read_state(&context, &context.device_id)
            .unwrap()
            .unwrap();
        let c1 = store
            .create_challenge(
                &context,
                ChallengeOperation::Rotate,
                1,
                &original.key_fingerprint,
            )
            .unwrap();
        let c2 = store
            .create_challenge(
                &context,
                ChallengeOperation::Rotate,
                1,
                &original.key_fingerprint,
            )
            .unwrap();
        let new_key1 = DevicePrivateKey::generate().unwrap();
        let new_key2 = DevicePrivateKey::generate().unwrap();
        let proof1 = old_key.sign_proof(&c1.challenge_id, &c1.nonce).unwrap();
        let proof2 = old_key.sign_proof(&c2.challenge_id, &c2.nonce).unwrap();
        let csr1 = new_key1.csr().unwrap();
        let csr2 = new_key2.csr().unwrap();
        let ctx1 = context.clone();
        let ctx2 = context.clone();
        let first_store = store.clone();
        let t1 = thread::spawn(move || {
            first_store.rotate_with_proof(&ctx1, 1, &c1.challenge_id, &proof1, &csr1)
        });
        let t2 = thread::spawn(move || {
            second_store.rotate_with_proof(&ctx2, 1, &c2.challenge_id, &proof2, &csr2)
        });
        let results = [t1.join().unwrap(), t2.join().unwrap()];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert!(results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .any(|error| { matches!(error, DeviceError::GenerationConflict) }));
        let current = store
            .read_state(&context, &context.device_id)
            .unwrap()
            .unwrap();
        assert_eq!(current.key_generation, 2);
        assert_eq!(current.identity_binding_id, original.identity_binding_id);
        assert_ne!(current.key_fingerprint, original.key_fingerprint);
        assert_eq!(
            csr_fingerprint(&current.csr_pem).unwrap(),
            current.key_fingerprint
        );
    }

    #[test]
    fn invalid_csr_and_unsafe_store_paths_are_rejected() {
        let dir = private_dir();
        let context = context();
        let store = DeviceStore::open(dir.path()).unwrap();
        assert_eq!(
            store.claim_initial(&context, "not a CSR").unwrap_err(),
            DeviceError::InvalidInput
        );
        let valid_key = DevicePrivateKey::generate().unwrap();
        let encoded = valid_key
            .csr()
            .unwrap()
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect::<String>();
        let mut der = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let last = der.len() - 1;
        der[last] ^= 1;
        let invalid_signature = format!(
            "-----BEGIN CERTIFICATE REQUEST-----\n{}\n-----END CERTIFICATE REQUEST-----\n",
            base64::engine::general_purpose::STANDARD.encode(der)
        );
        assert_eq!(
            store
                .claim_initial(&context, &invalid_signature)
                .unwrap_err(),
            DeviceError::InvalidInput
        );
        drop(store);

        let hardlink = dir.path().join("db-hardlink");
        fs::hard_link(dir.path().join(DB_NAME), &hardlink).unwrap();
        assert_eq!(
            DeviceStore::open(dir.path()).err().unwrap(),
            DeviceError::UnsafePath
        );
        fs::remove_file(&hardlink).unwrap();

        let alias = dir.path().with_extension("dir-link");
        std::os::unix::fs::symlink(dir.path(), &alias).unwrap();
        assert_eq!(
            DeviceStore::open(&alias).err().unwrap(),
            DeviceError::UnsafePath
        );
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            DeviceStore::open(dir.path()).err().unwrap(),
            DeviceError::UnsafePath
        );
    }

    #[test]
    fn claim_and_read_revalidate_session_after_lock_or_sqlite_wait() {
        let dir = private_dir();
        let store = Arc::new(DeviceStore::open(dir.path()).unwrap());
        let blocker_store = DeviceStore::open(dir.path()).unwrap();
        let mut claim_context = context();
        claim_context.expires_at = unix_seconds().unwrap() + 2;
        let csr = DevicePrivateKey::generate().unwrap().csr().unwrap();

        let mut blocker_connection = blocker_store.connection.lock().unwrap();
        let blocker = blocker_connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let worker_store = store.clone();
        let worker_context = claim_context.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let claim_thread = thread::spawn(move || {
            started_tx.send(()).unwrap();
            worker_store.claim_initial(&worker_context, &csr)
        });
        started_rx.recv().unwrap();
        thread::sleep(std::time::Duration::from_millis(150));
        assert!(!claim_thread.is_finished());
        thread::sleep(std::time::Duration::from_secs(3));
        blocker.commit().unwrap();
        assert_eq!(
            claim_thread.join().unwrap().unwrap_err(),
            DeviceError::InvalidSession
        );

        let mut valid_context = claim_context.clone();
        valid_context.expires_at = unix_seconds().unwrap() + 3_600;
        assert_eq!(
            store
                .read_state(&valid_context, &valid_context.device_id)
                .unwrap(),
            None
        );
        let key = DevicePrivateKey::generate().unwrap();
        store
            .claim_initial(&valid_context, &key.csr().unwrap())
            .unwrap();

        let mut expired_reader = valid_context.clone();
        expired_reader.expires_at = unix_seconds().unwrap() + 2;
        let held = store.connection.lock().unwrap();
        let worker_store = store.clone();
        let worker_context = expired_reader.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let read_thread = thread::spawn(move || {
            started_tx.send(()).unwrap();
            worker_store.read_state(&worker_context, &worker_context.device_id)
        });
        started_rx.recv().unwrap();
        thread::sleep(std::time::Duration::from_millis(150));
        assert!(!read_thread.is_finished());
        thread::sleep(std::time::Duration::from_secs(3));
        drop(held);
        assert_eq!(
            read_thread.join().unwrap().unwrap_err(),
            DeviceError::InvalidSession
        );
    }

    #[test]
    fn challenge_creation_does_not_outlive_session_after_sqlite_wait() {
        let dir = private_dir();
        let store = Arc::new(DeviceStore::open(dir.path()).unwrap());
        let blocker_store = DeviceStore::open(dir.path()).unwrap();
        let mut long_context = context();
        long_context.expires_at = unix_seconds().unwrap() + 3_600;
        let key = claim(&store, &long_context);
        let record = store
            .read_state(&long_context, &long_context.device_id)
            .unwrap()
            .unwrap();
        let mut short_context = long_context.clone();
        short_context.session_handle = Uuid::new_v4().to_string();
        short_context.expires_at = unix_seconds().unwrap() + 2;

        let mut blocker_connection = blocker_store.connection.lock().unwrap();
        let blocker = blocker_connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let worker_store = store.clone();
        let worker_context = short_context.clone();
        let expected_fingerprint = record.key_fingerprint.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let create_thread = thread::spawn(move || {
            started_tx.send(()).unwrap();
            worker_store.create_challenge(
                &worker_context,
                ChallengeOperation::Renew,
                1,
                &expected_fingerprint,
            )
        });
        started_rx.recv().unwrap();
        thread::sleep(std::time::Duration::from_millis(150));
        assert!(!create_thread.is_finished());
        thread::sleep(std::time::Duration::from_secs(3));
        blocker.commit().unwrap();
        assert_eq!(
            create_thread.join().unwrap().unwrap_err(),
            DeviceError::InvalidSession
        );
        let pending: i64 = store
            .connection
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM pop_challenges", [], |row| row.get(0))
            .unwrap();
        assert_eq!(pending, 0);
        assert_eq!(key.public_fingerprint().unwrap(), record.key_fingerprint);
    }

    #[test]
    fn expired_proof_and_rotate_waits_consume_once_without_accepting_expired_rotate() {
        let dir = private_dir();
        let store = Arc::new(DeviceStore::open(dir.path()).unwrap());
        let blocker_store = DeviceStore::open(dir.path()).unwrap();
        let context = context();
        let old_key = claim(&store, &context);

        let query_challenge = challenge(&store, &context, ChallengeOperation::RecoverQuery);
        let query_proof = old_key
            .sign_proof(&query_challenge.challenge_id, &query_challenge.nonce)
            .unwrap();
        store
            .connection
            .lock()
            .unwrap()
            .execute(
                "UPDATE pop_challenges SET expires_at=?1 WHERE challenge_id=?2",
                params![unix_seconds().unwrap() + 2, query_challenge.challenge_id],
            )
            .unwrap();
        let mut blocker_connection = blocker_store.connection.lock().unwrap();
        let blocker = blocker_connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let worker_store = store.clone();
        let worker_context = context.clone();
        let challenge_id = query_challenge.challenge_id.clone();
        let proof = query_proof.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let query_thread = thread::spawn(move || {
            started_tx.send(()).unwrap();
            worker_store.consume_proof(
                &worker_context,
                ChallengeOperation::RecoverQuery,
                1,
                &challenge_id,
                &proof,
            )
        });
        started_rx.recv().unwrap();
        thread::sleep(std::time::Duration::from_millis(150));
        assert!(!query_thread.is_finished());
        thread::sleep(std::time::Duration::from_secs(3));
        blocker.commit().unwrap();
        drop(blocker_connection);
        assert_eq!(
            query_thread.join().unwrap().unwrap_err(),
            DeviceError::ChallengeExpired
        );
        assert_eq!(
            store
                .consume_proof(
                    &context,
                    ChallengeOperation::RecoverQuery,
                    1,
                    &query_challenge.challenge_id,
                    &query_proof,
                )
                .unwrap_err(),
            DeviceError::ChallengeRejected
        );

        let rotate_challenge = challenge(&store, &context, ChallengeOperation::Rotate);
        let rotate_proof = old_key
            .sign_proof(&rotate_challenge.challenge_id, &rotate_challenge.nonce)
            .unwrap();
        let current = store
            .read_state(&context, &context.device_id)
            .unwrap()
            .unwrap();
        store
            .connection
            .lock()
            .unwrap()
            .execute(
                "UPDATE pop_challenges SET expires_at=?1 WHERE challenge_id=?2",
                params![unix_seconds().unwrap() + 2, rotate_challenge.challenge_id],
            )
            .unwrap();
        let mut blocker_connection = blocker_store.connection.lock().unwrap();
        let blocker = blocker_connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let worker_store = store.clone();
        let worker_context = context.clone();
        let challenge_id = rotate_challenge.challenge_id.clone();
        let proof = rotate_proof.clone();
        let replacement = DevicePrivateKey::generate().unwrap();
        let replacement_csr = replacement.csr().unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let rotate_thread = thread::spawn(move || {
            started_tx.send(()).unwrap();
            worker_store.rotate_with_proof(
                &worker_context,
                1,
                &challenge_id,
                &proof,
                &replacement_csr,
            )
        });
        started_rx.recv().unwrap();
        thread::sleep(std::time::Duration::from_millis(150));
        assert!(!rotate_thread.is_finished());
        thread::sleep(std::time::Duration::from_secs(3));
        blocker.commit().unwrap();
        assert_eq!(
            rotate_thread.join().unwrap().unwrap_err(),
            DeviceError::ChallengeExpired
        );
        assert_eq!(
            store
                .read_state(&context, &context.device_id)
                .unwrap()
                .unwrap(),
            current
        );
        assert_eq!(
            store
                .rotate_with_proof(
                    &context,
                    1,
                    &rotate_challenge.challenge_id,
                    &rotate_proof,
                    &DevicePrivateKey::generate().unwrap().csr().unwrap(),
                )
                .unwrap_err(),
            DeviceError::ChallengeRejected
        );
    }
}
