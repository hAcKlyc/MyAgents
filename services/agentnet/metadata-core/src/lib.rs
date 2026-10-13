//! Owner-scoped AgentNet metadata projections and HTTP mutation receipts.
//!
//! The caller supplies an AuthStore-validated session and device-core identity.
//! This crate does not authenticate bearer tokens, accept relay frames, or issue
//! certificates. Mount mutation and callable-agent/peer-binding behavior are
//! deliberately out of scope until a real relay owner is connected.

use myagents_agent_network_protocol::{
    budget, validate_catalog, validate_device_name_mutation, validate_metadata, CatalogSnapshot,
    MetadataKind,
};
use myagents_agentnet_device_core::{DeviceRecord, SessionContext};
use rusqlite::{
    params, Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

const DB_NAME: &str = "metadata.sqlite3";
const MAX_GENERATION: i64 = 9_007_199_254_740_991;
const SNAPSHOT_TTL: i64 = 60;
const RECEIPT_TTL: i64 = 86_400;
const MAX_RECEIPTS_PER_OWNER: i64 = 100_000;
const MAX_RECEIPTS_TOTAL: i64 = 1_000_000;
const MAX_SNAPSHOTS: i64 = 32;
const MAX_SNAPSHOT_BYTES: i64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MetadataError {
    UnsafePath,
    Storage,
    InvalidSession,
    InvalidInput,
    DeviceNotRegistered,
    DeviceOwnerMismatch,
    IdentityConflict,
    MembershipConflict,
    NameConflict,
    CatalogConflict,
    CatalogStale,
    ReceiptConflict,
    ReceiptNotFound,
    ReceiptExpired,
    ReceiptCapacity,
    InvalidCursor,
    SnapshotCapacity,
    Unsupported,
    ProfileMismatch,
    UnboundDatabase,
}

impl std::fmt::Display for MetadataError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::UnsafePath => "metadata state path is unsafe",
            Self::Storage => "metadata state is unavailable",
            Self::InvalidSession => "validated session context is invalid or expired",
            Self::InvalidInput => "metadata operation input is invalid",
            Self::DeviceNotRegistered => "device is not registered",
            Self::DeviceOwnerMismatch => "device belongs to another principal",
            Self::IdentityConflict => "registered device identity conflicts",
            Self::MembershipConflict => "membership revision changed",
            Self::NameConflict => "device name changed",
            Self::CatalogConflict => "catalog sequence was reused with different content",
            Self::CatalogStale => "catalog epoch or sequence is stale",
            Self::ReceiptConflict => "mutation id was reused with different content",
            Self::ReceiptNotFound => "mutation receipt was not found",
            Self::ReceiptExpired => "mutation receipt expired",
            Self::ReceiptCapacity => "mutation receipt capacity is exhausted",
            Self::InvalidCursor => "directory cursor is invalid or expired",
            Self::SnapshotCapacity => "directory snapshot capacity is exhausted",
            Self::Unsupported => "metadata operation is not supported by this owner",
            Self::ProfileMismatch => "metadata database is pinned to another service profile",
            Self::UnboundDatabase => "non-empty metadata database has no service profile pin",
        })
    }
}
impl std::error::Error for MetadataError {}

#[derive(Debug, Clone)]
pub struct MetadataProfile {
    pub service_id: String,
    pub environment: String,
    pub network_name: String,
}

#[derive(Debug, Clone)]
pub struct DeviceInfo {
    pub name: String,
    pub platform: String,
    pub os_version: String,
    pub app_version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Presence {
    Offline,
    Syncing,
    Ready,
}

/// Durable metadata snapshot used by the relay's WebSocket admission path.
/// `durable_ack_seq` is populated only from an intact persisted catalog whose
/// epoch still matches the device's current connection epoch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayMetadataState {
    pub key_generation: u64,
    pub identity_binding_id: String,
    pub key_fingerprint: String,
    pub joined: bool,
    pub membership_revision: u64,
    pub network_revision: u64,
    pub connection_epoch: Option<String>,
    pub catalog_epoch: Option<String>,
    pub catalog_seq: u64,
    pub durable_ack_seq: Option<u64>,
    pub presence: Presence,
}
impl Presence {
    fn as_str(self) -> &'static str {
        match self {
            Self::Offline => "offline",
            Self::Syncing => "syncing",
            Self::Ready => "ready",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
    pub complete: bool,
}

pub struct MetadataStore {
    connection: Mutex<Connection>,
    _state_dir: PathBuf,
    profile: MetadataProfile,
}

impl MetadataStore {
    /// Opens a private SQLite owner file inside an existing 0700 directory.
    /// Existing unsafe state is rejected, never silently recreated.
    pub fn open(
        state_dir: impl AsRef<Path>,
        profile: MetadataProfile,
    ) -> Result<Self, MetadataError> {
        validate_profile(&profile)?;
        let state_dir = validate_state_dir(state_dir.as_ref())?;
        let database = state_dir.join(DB_NAME);
        create_private_database_file(&database)?;
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_FULL_MUTEX;
        let flags = flags | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let mut connection =
            Connection::open_with_flags(&database, flags).map_err(|_| MetadataError::Storage)?;
        validate_database_file(&database)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| MetadataError::Storage)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|_| MetadataError::Storage)?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|_| MetadataError::Storage)?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE IF NOT EXISTS devices (
                   network_id TEXT NOT NULL,
                   principal_id TEXT NOT NULL,
                   device_id TEXT NOT NULL,
                   identity_binding_id TEXT NOT NULL,
                   key_generation INTEGER NOT NULL CHECK(key_generation>0),
                   key_fingerprint TEXT NOT NULL,
                   name TEXT NOT NULL,
                   platform TEXT NOT NULL,
                   os_version TEXT NOT NULL,
                   app_version TEXT NOT NULL,
                   account_seen_at INTEGER NOT NULL,
                   joined INTEGER NOT NULL DEFAULT 0 CHECK(joined IN (0,1)),
                   membership_revision INTEGER NOT NULL DEFAULT 0,
                   presence TEXT NOT NULL DEFAULT 'offline' CHECK(presence IN ('offline','syncing','ready')),
                   connection_epoch TEXT,
                   catalog_epoch TEXT,
                   catalog_seq INTEGER NOT NULL DEFAULT 0,
                   catalog_synced_at INTEGER,
                   last_network_seen_at INTEGER,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL,
                   PRIMARY KEY(network_id,principal_id,device_id),
                   UNIQUE(network_id,device_id)
                 );
                 CREATE TABLE IF NOT EXISTS owner_state (
                   network_id TEXT NOT NULL,
                   principal_id TEXT NOT NULL,
                   roster_revision INTEGER NOT NULL DEFAULT 0,
                   PRIMARY KEY(network_id,principal_id)
                 );
                 CREATE TABLE IF NOT EXISTS catalogs (
                   network_id TEXT NOT NULL,
                   principal_id TEXT NOT NULL,
                   device_id TEXT NOT NULL,
                   connection_epoch TEXT NOT NULL,
                   catalog_seq INTEGER NOT NULL,
                   payload_hash TEXT NOT NULL,
                   payload_json TEXT NOT NULL,
                   synced_at INTEGER NOT NULL,
                   PRIMARY KEY(network_id,principal_id,device_id),
                   FOREIGN KEY(network_id,principal_id,device_id)
                     REFERENCES devices(network_id,principal_id,device_id) ON DELETE CASCADE
                 );
                 CREATE TABLE IF NOT EXISTS catalog_items (
                   network_id TEXT NOT NULL,
                   principal_id TEXT NOT NULL,
                   device_id TEXT NOT NULL,
                   local_agent_id TEXT NOT NULL,
                   mount_id TEXT NOT NULL,
                   item_json TEXT NOT NULL,
                   enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
                   enable_revision INTEGER NOT NULL DEFAULT 0,
                   description TEXT,
                   description_revision INTEGER NOT NULL DEFAULT 0,
                   PRIMARY KEY(network_id,principal_id,device_id,local_agent_id),
                   UNIQUE(network_id,principal_id,mount_id),
                   FOREIGN KEY(network_id,principal_id,device_id)
                     REFERENCES devices(network_id,principal_id,device_id) ON DELETE CASCADE
                 );
                 CREATE TABLE IF NOT EXISTS mutation_receipts (
                   network_id TEXT NOT NULL,
                   principal_id TEXT NOT NULL,
                   mutation_id TEXT NOT NULL,
                   method TEXT NOT NULL,
                   target_id TEXT NOT NULL,
                   payload_hash TEXT NOT NULL,
                   response_json TEXT NOT NULL,
                   created_at INTEGER NOT NULL,
                   expires_at INTEGER NOT NULL,
                   PRIMARY KEY(network_id,principal_id,mutation_id)
                 );
                 CREATE TABLE IF NOT EXISTS directory_snapshots (
                   snapshot_id TEXT PRIMARY KEY,
                   network_id TEXT NOT NULL,
                   principal_id TEXT NOT NULL,
                   query_key TEXT NOT NULL,
                   items_json TEXT NOT NULL,
                   byte_count INTEGER NOT NULL,
                   created_at INTEGER NOT NULL,
                   expires_at INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS directory_cursors (
                   cursor_id TEXT PRIMARY KEY,
                   snapshot_id TEXT NOT NULL,
                   offset INTEGER NOT NULL,
                   FOREIGN KEY(snapshot_id) REFERENCES directory_snapshots(snapshot_id) ON DELETE CASCADE
                 );
                 CREATE INDEX IF NOT EXISTS directory_snapshots_owner
                   ON directory_snapshots(network_id,principal_id,expires_at);
                 CREATE INDEX IF NOT EXISTS catalog_items_device
                   ON catalog_items(network_id,principal_id,device_id);",
            )
            .map_err(|_| MetadataError::Storage)?;
        pin_database_profile(&mut connection, &profile)?;
        validate_database_file(&database)?;
        Ok(Self {
            connection: Mutex::new(connection),
            _state_dir: state_dir,
            profile,
        })
    }

    /// Registers or refreshes only an identity already owned by device-core.
    /// Membership and revision are preserved on reconnect/key rotation.
    pub fn register_device(
        &self,
        context: &SessionContext,
        identity: &DeviceRecord,
        info: &DeviceInfo,
    ) -> Result<(), MetadataError> {
        validate_context(context)?;
        validate_registration(context, identity, info)?;
        let mut connection = self.connection.lock().map_err(|_| MetadataError::Storage)?;
        validate_context(context)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| MetadataError::Storage)?;
        validate_context(context)?;
        let now = now_seconds()?;
        let existing = tx
            .query_row(
                "SELECT identity_binding_id,key_generation,key_fingerprint,joined,membership_revision
                 FROM devices WHERE network_id=?1 AND principal_id=?2 AND device_id=?3",
                params![context.network_id, context.principal_id, context.device_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, bool>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| MetadataError::Storage)?;
        if let Some((binding, generation, fingerprint, joined, membership_revision)) = existing {
            if binding != identity.identity_binding_id
                || identity.key_generation < generation as u64
                || (identity.key_generation == generation as u64
                    && fingerprint != identity.key_fingerprint)
            {
                return Err(MetadataError::IdentityConflict);
            }
            tx.execute(
                "UPDATE devices SET key_generation=?1,key_fingerprint=?2,platform=?3,
                   os_version=?4,app_version=?5,account_seen_at=?6,updated_at=?6,
                   presence=CASE WHEN key_generation<?1 THEN 'offline' ELSE presence END,
                   connection_epoch=CASE WHEN key_generation<?1 THEN NULL ELSE connection_epoch END
                 WHERE network_id=?7 AND principal_id=?8 AND device_id=?9",
                params![
                    identity.key_generation as i64,
                    identity.key_fingerprint,
                    info.platform,
                    info.os_version,
                    info.app_version,
                    now,
                    context.network_id,
                    context.principal_id,
                    context.device_id
                ],
            )
            .map_err(|_| MetadataError::Storage)?;
            let _ = (joined, membership_revision);
            bump_roster(&tx, context)?;
        } else {
            let network_owner_exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM devices WHERE network_id=?1 AND device_id=?2)",
                    params![context.network_id, context.device_id],
                    |row| row.get(0),
                )
                .map_err(|_| MetadataError::Storage)?;
            if network_owner_exists {
                return Err(MetadataError::DeviceOwnerMismatch);
            }
            tx.execute(
                "INSERT INTO devices(network_id,principal_id,device_id,identity_binding_id,
                   key_generation,key_fingerprint,name,platform,os_version,app_version,account_seen_at,joined,
                   membership_revision,presence,catalog_seq,created_at,updated_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,0,0,'offline',0,?11,?11)",
                params![
                    context.network_id,
                    context.principal_id,
                    context.device_id,
                    identity.identity_binding_id,
                    identity.key_generation as i64,
                    identity.key_fingerprint,
                    info.name,
                    info.platform,
                    info.os_version,
                    info.app_version,
                    now
                ],
            )
            .map_err(|_| MetadataError::Storage)?;
            bump_roster(&tx, context)?;
        }
        validate_context(context)?;
        tx.commit().map_err(|_| MetadataError::Storage)
    }

    /// Updates relay-owned presence. A Ready signal must identify the exact
    /// catalog sequence already durably acknowledged for the supplied epoch.
    pub fn set_presence(
        &self,
        context: &SessionContext,
        key_generation: u64,
        current_epoch: &str,
        presence: Presence,
        ready_catalog_seq: Option<u64>,
    ) -> Result<(), MetadataError> {
        validate_context(context)?;
        if !canonical_uuid(current_epoch) || key_generation == 0 {
            return Err(MetadataError::InvalidInput);
        }
        let mut connection = self.connection.lock().map_err(|_| MetadataError::Storage)?;
        validate_context(context)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| MetadataError::Storage)?;
        validate_context(context)?;
        let record = get_device(&tx, context, &context.device_id)?;
        if record.key_generation != key_generation as i64 {
            return Err(MetadataError::IdentityConflict);
        }
        let persisted_epoch: Option<String> = tx
            .query_row(
                "SELECT connection_epoch FROM devices WHERE network_id=?1 AND principal_id=?2 AND device_id=?3",
                params![context.network_id, context.principal_id, context.device_id],
                |row| row.get(0),
            )
            .map_err(|_| MetadataError::Storage)?;
        if presence != Presence::Syncing && persisted_epoch.as_deref() != Some(current_epoch) {
            return Err(MetadataError::CatalogStale);
        }
        if presence == Presence::Ready {
            let seq = ready_catalog_seq.ok_or(MetadataError::CatalogStale)?;
            let current: Option<(String, i64)> = tx
                .query_row(
                    "SELECT connection_epoch,catalog_seq FROM catalogs
                     WHERE network_id=?1 AND principal_id=?2 AND device_id=?3",
                    params![context.network_id, context.principal_id, context.device_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|_| MetadataError::Storage)?;
            if current.as_ref().is_none_or(|(epoch, stored_seq)| {
                epoch != current_epoch || *stored_seq != seq as i64
            }) {
                return Err(MetadataError::CatalogStale);
            }
        }
        let now = now_seconds()?;
        tx.execute(
            "UPDATE devices SET presence=?1,connection_epoch=?2,last_network_seen_at=?3,updated_at=?3
             WHERE network_id=?4 AND principal_id=?5 AND device_id=?6 AND key_generation=?7",
            params![
                presence.as_str(),
                current_epoch,
                now,
                context.network_id,
                context.principal_id,
                context.device_id,
                key_generation as i64
            ],
        )
        .map_err(|_| MetadataError::Storage)?;
        validate_context(context)?;
        tx.commit().map_err(|_| MetadataError::Storage)
    }

    /// Lower a connection's presence after its socket/session has ended.
    /// This lifecycle operation intentionally needs no live SessionContext:
    /// it can only move the exact currently-bound device epoch to Offline,
    /// and cannot alter membership, catalog, or policy state.
    pub fn close_connection(
        &self,
        scope: &myagents_agent_network_protocol::DeviceScope,
        key_fingerprint: &str,
        expected_epoch: &str,
    ) -> Result<bool, MetadataError> {
        if !canonical_uuid(&scope.service_id)
            || !canonical_uuid(&scope.network_id)
            || !canonical_uuid(&scope.principal_id)
            || !canonical_uuid(&scope.device_id)
            || scope.key_generation == 0
            || scope.key_generation > MAX_GENERATION as u64
            || !canonical_fingerprint(key_fingerprint)
            || !canonical_uuid(expected_epoch)
        {
            return Err(MetadataError::InvalidInput);
        }
        if scope.service_id != self.profile.service_id
            || scope.environment != self.profile.environment
        {
            return Ok(false);
        }
        let mut connection = self.connection.lock().map_err(|_| MetadataError::Storage)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| MetadataError::Storage)?;
        let changed = tx
            .execute(
                "UPDATE devices SET presence='offline'
                 WHERE network_id=?1 AND principal_id=?2 AND device_id=?3
                   AND key_generation=?4 AND key_fingerprint=?5
                   AND connection_epoch=?6 AND presence!='offline'",
                params![
                    scope.network_id,
                    scope.principal_id,
                    scope.device_id,
                    scope.key_generation as i64,
                    key_fingerprint,
                    expected_epoch
                ],
            )
            .map_err(|_| MetadataError::Storage)?;
        tx.commit().map_err(|_| MetadataError::Storage)?;
        Ok(changed == 1)
    }

    /// Ingests a complete, schema-valid snapshot. Epoch comes from the trusted
    /// relay session owner and must match the snapshot; this is not Ready.
    pub fn upload_catalog(
        &self,
        context: &SessionContext,
        key_generation: u64,
        trusted_current_epoch: &str,
        snapshot: &CatalogSnapshot,
    ) -> Result<Value, MetadataError> {
        validate_context(context)?;
        if !canonical_uuid(trusted_current_epoch) || key_generation == 0 {
            return Err(MetadataError::InvalidInput);
        }
        let value = serde_json::to_value(snapshot).map_err(|_| MetadataError::InvalidInput)?;
        validate_catalog(&value).map_err(|_| MetadataError::InvalidInput)?;
        if snapshot.connection_epoch != trusted_current_epoch
            || snapshot.items.len() > budget("catalogItems")
            || snapshot.catalog_seq == 0
            || snapshot.catalog_seq > MAX_GENERATION as u64
        {
            return Err(MetadataError::CatalogStale);
        }
        let mut seen = std::collections::HashSet::new();
        if snapshot
            .items
            .iter()
            .any(|item| item.local_agent_id.is_empty() || !seen.insert(&item.local_agent_id))
        {
            return Err(MetadataError::InvalidInput);
        }
        let payload_json =
            serde_json::to_string(&value).map_err(|_| MetadataError::InvalidInput)?;
        let payload_hash = digest(payload_json.as_bytes());
        if payload_json.len() > budget("catalogBytes") {
            return Err(MetadataError::InvalidInput);
        }
        let mut connection = self.connection.lock().map_err(|_| MetadataError::Storage)?;
        validate_context(context)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| MetadataError::Storage)?;
        validate_context(context)?;
        let device = get_device(&tx, context, &context.device_id)?;
        if device.key_generation != key_generation as i64 {
            return Err(MetadataError::IdentityConflict);
        }
        let persisted_epoch: Option<String> = tx
            .query_row(
                "SELECT connection_epoch FROM devices WHERE network_id=?1 AND principal_id=?2 AND device_id=?3",
                params![context.network_id, context.principal_id, context.device_id],
                |row| row.get(0),
            )
            .map_err(|_| MetadataError::Storage)?;
        if persisted_epoch.as_deref() != Some(trusted_current_epoch) {
            return Err(MetadataError::CatalogStale);
        }
        let current = tx
            .query_row(
                "SELECT connection_epoch,catalog_seq,payload_hash FROM catalogs
                 WHERE network_id=?1 AND principal_id=?2 AND device_id=?3",
                params![context.network_id, context.principal_id, context.device_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| MetadataError::Storage)?;
        if let Some((epoch, seq, previous_hash)) = current.as_ref() {
            if epoch == trusted_current_epoch {
                if snapshot.catalog_seq < *seq as u64 {
                    return Err(MetadataError::CatalogStale);
                }
                if snapshot.catalog_seq == *seq as u64 {
                    if payload_hash != *previous_hash {
                        return Err(MetadataError::CatalogConflict);
                    }
                    validate_context(context)?;
                    tx.commit().map_err(|_| MetadataError::Storage)?;
                    return Ok(json!({"connectionEpoch":epoch,"catalogSeq":seq}));
                }
            }
        }
        let now = now_seconds()?;
        tx.execute(
            "INSERT INTO catalogs(network_id,principal_id,device_id,connection_epoch,catalog_seq,
               payload_hash,payload_json,synced_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(network_id,principal_id,device_id) DO UPDATE SET
               connection_epoch=excluded.connection_epoch,catalog_seq=excluded.catalog_seq,
               payload_hash=excluded.payload_hash,payload_json=excluded.payload_json,synced_at=excluded.synced_at",
            params![
                context.network_id,
                context.principal_id,
                context.device_id,
                trusted_current_epoch,
                snapshot.catalog_seq as i64,
                payload_hash,
                payload_json,
                now
            ],
        )
        .map_err(|_| MetadataError::Storage)?;
        // Syncing establishes the trusted epoch before catalog upload. A new
        // epoch starts fresh presence; Ready is a separate exact-sequence event.
        tx.execute(
            "UPDATE devices SET catalog_epoch=?1,catalog_seq=?2,catalog_synced_at=?3,
               presence='syncing',updated_at=?3
             WHERE network_id=?4 AND principal_id=?5 AND device_id=?6",
            params![
                trusted_current_epoch,
                snapshot.catalog_seq as i64,
                now,
                context.network_id,
                context.principal_id,
                context.device_id
            ],
        )
        .map_err(|_| MetadataError::Storage)?;
        tx.execute(
            "UPDATE catalog_items SET item_json=json_set(item_json,'$.lifecycle','removed')
             WHERE network_id=?1 AND principal_id=?2 AND device_id=?3
               AND json_extract(item_json,'$.lifecycle')='active'",
            params![context.network_id, context.principal_id, context.device_id],
        )
        .map_err(|_| MetadataError::Storage)?;
        for item in &snapshot.items {
            let item_json = serde_json::to_string(item).map_err(|_| MetadataError::Storage)?;
            let existing_mount: Option<String> = tx
                .query_row(
                    "SELECT mount_id FROM catalog_items WHERE network_id=?1 AND principal_id=?2
                       AND device_id=?3 AND local_agent_id=?4",
                    params![
                        context.network_id,
                        context.principal_id,
                        context.device_id,
                        item.local_agent_id
                    ],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|_| MetadataError::Storage)?;
            tx.execute(
                "INSERT INTO catalog_items(network_id,principal_id,device_id,local_agent_id,
                   mount_id,item_json,enabled,enable_revision,description,description_revision)
                 VALUES(?1,?2,?3,?4,?5,?6,0,0,NULL,0)
                 ON CONFLICT(network_id,principal_id,device_id,local_agent_id)
                 DO UPDATE SET item_json=excluded.item_json",
                params![
                    context.network_id,
                    context.principal_id,
                    context.device_id,
                    item.local_agent_id,
                    existing_mount.unwrap_or_else(|| Uuid::new_v4().to_string()),
                    item_json
                ],
            )
            .map_err(|_| MetadataError::Storage)?;
        }
        validate_context(context)?;
        tx.commit().map_err(|_| MetadataError::Storage)?;
        Ok(json!({"connectionEpoch":trusted_current_epoch,"catalogSeq":snapshot.catalog_seq}))
    }

    pub fn list_devices(
        &self,
        context: &SessionContext,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<Value, MetadataError> {
        self.directory_page(context, "devices", cursor, limit, |tx| {
            Self::device_rows(tx, context)
        })
    }

    pub fn list_agents(
        &self,
        context: &SessionContext,
        target_device_id: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<Value, MetadataError> {
        if !canonical_uuid(target_device_id) {
            return Err(MetadataError::InvalidInput);
        }
        let query_key = format!("agents:{target_device_id}");
        self.directory_page(context, &query_key, cursor, limit, |tx| {
            Self::agent_rows(tx, context, target_device_id)
        })
    }

    /// Reads one same-account device's relay state from durable owner tables.
    /// The caller must already have freshly authenticated the session and
    /// checked the presented device identity; this method rechecks session
    /// expiry while waiting for and holding the owner lock.
    pub fn read_relay_state(
        &self,
        context: &SessionContext,
        target_device_id: &str,
    ) -> Result<RelayMetadataState, MetadataError> {
        validate_context(context)?;
        if !canonical_uuid(target_device_id) {
            return Err(MetadataError::InvalidInput);
        }
        let mut connection = self.connection.lock().map_err(|_| MetadataError::Storage)?;
        validate_context(context)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| MetadataError::Storage)?;
        validate_context(context)?;
        ensure_registered(&tx, context)?;
        let row = tx
            .query_row(
                "SELECT identity_binding_id,key_generation,key_fingerprint,joined,
                        membership_revision,presence,connection_epoch,catalog_epoch,catalog_seq
                 FROM devices WHERE network_id=?1 AND principal_id=?2 AND device_id=?3",
                params![context.network_id, context.principal_id, target_device_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, bool>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, i64>(8)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| MetadataError::Storage)?
            .ok_or(MetadataError::DeviceOwnerMismatch)?;
        let (
            identity_binding_id,
            key_generation,
            key_fingerprint,
            joined,
            membership_revision,
            presence,
            connection_epoch,
            catalog_epoch,
            catalog_seq,
        ) = row;
        let network_revision = get_roster_revision(&tx, context)?;
        let durable_ack_seq = durable_catalog_ack(
            &tx,
            context,
            target_device_id,
            connection_epoch.as_deref(),
            catalog_epoch.as_deref(),
            catalog_seq,
        )?;
        let state = RelayMetadataState {
            key_generation: u64::try_from(key_generation).map_err(|_| MetadataError::Storage)?,
            identity_binding_id,
            key_fingerprint,
            joined,
            membership_revision: u64::try_from(membership_revision)
                .map_err(|_| MetadataError::Storage)?,
            network_revision: u64::try_from(network_revision)
                .map_err(|_| MetadataError::Storage)?,
            connection_epoch,
            catalog_epoch,
            catalog_seq: u64::try_from(catalog_seq).map_err(|_| MetadataError::Storage)?,
            durable_ack_seq,
            presence: parse_presence(&presence)?,
        };
        validate_context(context)?;
        tx.commit().map_err(|_| MetadataError::Storage)?;
        validate_context(context)?;
        Ok(state)
    }

    /// Returns a device's own policy catalog during trusted Syncing hydration
    /// or after Ready. The epoch is supplied by the live relay registry, never
    /// by the caller's session payload; each cursor read repeats the DB/epoch
    /// gate before consuming its frozen page.
    pub fn list_self_policy(
        &self,
        context: &SessionContext,
        trusted_active_epoch: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<Page<Value>, MetadataError> {
        validate_context(context)?;
        if !canonical_uuid(trusted_active_epoch) {
            return Err(MetadataError::InvalidInput);
        }
        let query_key = format!("self-policy:{}:{trusted_active_epoch}", context.device_id);
        let page = self.directory_page_with_gate(
            context,
            &query_key,
            cursor,
            limit,
            |tx| validate_self_policy_epoch(tx, context, trusted_active_epoch),
            |tx| Self::self_policy_rows(tx, context),
        )?;
        serde_json::from_value(page).map_err(|_| MetadataError::Storage)
    }

    pub fn get_network(&self, context: &SessionContext) -> Result<Value, MetadataError> {
        validate_context(context)?;
        let connection = self.connection.lock().map_err(|_| MetadataError::Storage)?;
        validate_context(context)?;
        ensure_registered(&connection, context)?;
        let revision = get_roster_revision(&connection, context)?;
        let value = json!({
            "serviceId":self.profile.service_id,
            "environment":self.profile.environment,
            "networkId":context.network_id,
            "principalId":context.principal_id,
            "name":self.profile.network_name,
            "revision":revision,
            "protocol":1,
            "capabilities":[]
        });
        validate_context(context)?;
        validate_metadata(MetadataKind::Network, &value).map_err(|_| MetadataError::Storage)?;
        Ok(value)
    }

    pub fn mutate_membership(
        &self,
        context: &SessionContext,
        target_device_id: &str,
        joined: bool,
        expected_membership_revision: u64,
        mutation_id: &str,
    ) -> Result<Value, MetadataError> {
        self.mutate(
            context,
            mutation_id,
            "membership",
            target_device_id,
            json!({
                "joined":joined,"expectedMembershipRevision":expected_membership_revision
            }),
            |tx, now| {
                let mut row = get_target_device(tx, context, target_device_id)?;
                if row.membership_revision as u64 != expected_membership_revision {
                    return Err(MetadataError::MembershipConflict);
                }
                if row.joined != joined {
                    row.membership_revision += 1;
                    tx.execute(
                        "UPDATE devices SET joined=?1,membership_revision=?2,updated_at=?3
                     WHERE network_id=?4 AND principal_id=?5 AND device_id=?6
                       AND membership_revision=?7",
                        params![
                            joined,
                            row.membership_revision,
                            now,
                            context.network_id,
                            context.principal_id,
                            target_device_id,
                            expected_membership_revision as i64
                        ],
                    )
                    .map_err(|_| MetadataError::Storage)?;
                    bump_roster(tx, context)?;
                    row.joined = joined;
                }
                Ok(
                    json!({"networkId":context.network_id,"principalId":context.principal_id,
                "deviceId":target_device_id,"joined":row.joined,
                "membershipRevision":row.membership_revision}),
                )
            },
        )
    }

    pub fn rename_device(
        &self,
        context: &SessionContext,
        target_device_id: &str,
        name: &str,
        expected_name: &str,
        mutation_id: &str,
    ) -> Result<Value, MetadataError> {
        let body = json!({"name":name,"expectedName":expected_name,"mutationId":mutation_id});
        validate_device_name_mutation(&body).map_err(|_| MetadataError::InvalidInput)?;
        self.mutate(
            context,
            mutation_id,
            "device-name",
            target_device_id,
            json!({
                "name":name,"expectedName":expected_name
            }),
            |tx, now| {
                let row = get_target_device(tx, context, target_device_id)?;
                if row.name != expected_name {
                    return Err(MetadataError::NameConflict);
                }
                if row.name != name {
                    tx.execute(
                        "UPDATE devices SET name=?1,updated_at=?2 WHERE network_id=?3
                     AND principal_id=?4 AND device_id=?5 AND name=?6",
                        params![
                            name,
                            now,
                            context.network_id,
                            context.principal_id,
                            target_device_id,
                            expected_name
                        ],
                    )
                    .map_err(|_| MetadataError::Storage)?;
                    bump_roster(tx, context)?;
                }
                Ok(
                    json!({"networkId":context.network_id,"principalId":context.principal_id,
                "deviceId":target_device_id,"name":name}),
                )
            },
        )
    }

    /// The fixed 1.1 package has no mutation for creating/removing local Agents
    /// or binding remote model credentials. Those remain Host-local operations.
    pub fn unsupported_agent_mutation(&self) -> Result<Value, MetadataError> {
        Err(MetadataError::Unsupported)
    }

    pub fn get_receipt(
        &self,
        context: &SessionContext,
        mutation_id: &str,
    ) -> Result<Value, MetadataError> {
        validate_context(context)?;
        if !canonical_uuid(mutation_id) {
            return Err(MetadataError::InvalidInput);
        }
        let connection = self.connection.lock().map_err(|_| MetadataError::Storage)?;
        validate_context(context)?;
        let receipt: Option<(String, i64)> = connection
            .query_row(
                "SELECT response_json,expires_at FROM mutation_receipts
                 WHERE network_id=?1 AND principal_id=?2 AND mutation_id=?3",
                params![context.network_id, context.principal_id, mutation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| MetadataError::Storage)?;
        let Some((body, expires_at)) = receipt else {
            return Err(MetadataError::ReceiptNotFound);
        };
        if now_seconds()? >= expires_at {
            return Err(MetadataError::ReceiptExpired);
        }
        ensure_registered(&connection, context)?;
        validate_context(context)?;
        serde_json::from_str(&body).map_err(|_| MetadataError::Storage)
    }

    pub fn get_device_name(
        &self,
        context: &SessionContext,
        target_device_id: &str,
    ) -> Result<Value, MetadataError> {
        validate_context(context)?;
        if !canonical_uuid(target_device_id) {
            return Err(MetadataError::InvalidInput);
        }
        let connection = self.connection.lock().map_err(|_| MetadataError::Storage)?;
        validate_context(context)?;
        ensure_registered(&connection, context)?;
        let row = get_target_device(&connection, context, target_device_id)?;
        let value = json!({
            "networkId": context.network_id,
            "principalId": context.principal_id,
            "deviceId": target_device_id,
            "name": row.name
        });
        validate_context(context)?;
        validate_metadata(MetadataKind::DeviceName, &value).map_err(|_| MetadataError::Storage)?;
        Ok(value)
    }

    fn mutate<F>(
        &self,
        context: &SessionContext,
        mutation_id: &str,
        method: &str,
        target_id: &str,
        request: Value,
        apply: F,
    ) -> Result<Value, MetadataError>
    where
        F: FnOnce(&Transaction<'_>, i64) -> Result<Value, MetadataError>,
    {
        validate_context(context)?;
        if !canonical_uuid(mutation_id) || !canonical_uuid(target_id) {
            return Err(MetadataError::InvalidInput);
        }
        let request_bytes =
            serde_json::to_vec(&request).map_err(|_| MetadataError::InvalidInput)?;
        let request_hash = digest(
            &[
                method.as_bytes(),
                b"\n",
                target_id.as_bytes(),
                b"\n",
                &request_bytes,
            ]
            .concat(),
        );
        let mut connection = self.connection.lock().map_err(|_| MetadataError::Storage)?;
        validate_context(context)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| MetadataError::Storage)?;
        validate_context(context)?;
        ensure_registered(&tx, context)?;
        let now = now_seconds()?;
        let existing = tx
            .query_row(
                "SELECT payload_hash,response_json,expires_at FROM mutation_receipts
                 WHERE network_id=?1 AND principal_id=?2 AND mutation_id=?3",
                params![context.network_id, context.principal_id, mutation_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| MetadataError::Storage)?;
        if let Some((old_hash, old_response, expires_at)) = existing {
            if now >= expires_at {
                return Err(MetadataError::ReceiptExpired);
            }
            if old_hash != request_hash {
                return Err(MetadataError::ReceiptConflict);
            }
            validate_context(context)?;
            tx.commit().map_err(|_| MetadataError::Storage)?;
            return serde_json::from_str(&old_response).map_err(|_| MetadataError::Storage);
        }
        // Expired IDs remain permanent anti-replay tombstones. Clear their
        // response bodies for compactness, but never delete their identity/hash.
        tx.execute(
            "UPDATE mutation_receipts SET response_json='' WHERE expires_at<=?1 AND response_json<>''",
            params![now],
        )
        .map_err(|_| MetadataError::Storage)?;
        let (owner_count, total_count): (i64, i64) = tx
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM mutation_receipts WHERE network_id=?1 AND principal_id=?2),
                   (SELECT COUNT(*) FROM mutation_receipts)",
                params![context.network_id, context.principal_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| MetadataError::Storage)?;
        if owner_count >= MAX_RECEIPTS_PER_OWNER || total_count >= MAX_RECEIPTS_TOTAL {
            return Err(MetadataError::ReceiptCapacity);
        }
        let result = apply(&tx, now)?;
        let response_json = serde_json::to_string(&result).map_err(|_| MetadataError::Storage)?;
        tx.execute(
            "INSERT INTO mutation_receipts(network_id,principal_id,mutation_id,method,target_id,
               payload_hash,response_json,created_at,expires_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                context.network_id,
                context.principal_id,
                mutation_id,
                method,
                target_id,
                request_hash,
                response_json,
                now,
                now.saturating_add(RECEIPT_TTL)
            ],
        )
        .map_err(|_| MetadataError::Storage)?;
        validate_context(context)?;
        tx.commit().map_err(|_| MetadataError::Storage)?;
        Ok(result)
    }

    fn directory_page<F>(
        &self,
        context: &SessionContext,
        query_key: &str,
        cursor: Option<&str>,
        limit: usize,
        load: F,
    ) -> Result<Value, MetadataError>
    where
        F: FnOnce(&Transaction<'_>) -> Result<Vec<Value>, MetadataError>,
    {
        self.directory_page_with_gate(context, query_key, cursor, limit, |_| Ok(()), load)
    }

    fn directory_page_with_gate<F, G>(
        &self,
        context: &SessionContext,
        query_key: &str,
        cursor: Option<&str>,
        limit: usize,
        gate: G,
        load: F,
    ) -> Result<Value, MetadataError>
    where
        F: FnOnce(&Transaction<'_>) -> Result<Vec<Value>, MetadataError>,
        G: FnOnce(&Transaction<'_>) -> Result<(), MetadataError>,
    {
        validate_context(context)?;
        if limit == 0 || limit > budget("pageMax") {
            return Err(MetadataError::InvalidInput);
        }
        let mut connection = self.connection.lock().map_err(|_| MetadataError::Storage)?;
        validate_context(context)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| MetadataError::Storage)?;
        validate_context(context)?;
        ensure_registered(&tx, context)?;
        gate(&tx)?;
        let now = now_seconds()?;
        tx.execute(
            "DELETE FROM directory_snapshots WHERE expires_at<=?1",
            params![now],
        )
        .map_err(|_| MetadataError::Storage)?;
        let (snapshot_id, items_json, offset, expires_at) = if let Some(cursor) = cursor {
            if !canonical_uuid(cursor) {
                return Err(MetadataError::InvalidCursor);
            }
            tx.query_row(
                "SELECT s.snapshot_id,s.items_json,c.offset,s.expires_at
                 FROM directory_cursors c JOIN directory_snapshots s ON s.snapshot_id=c.snapshot_id
                 WHERE c.cursor_id=?1 AND s.network_id=?2 AND s.principal_id=?3 AND s.query_key=?4",
                params![cursor, context.network_id, context.principal_id, query_key],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| MetadataError::Storage)?
            .ok_or(MetadataError::InvalidCursor)?
        } else {
            let rows = load(&tx)?;
            if rows.len() > budget("catalogItems") {
                return Err(MetadataError::SnapshotCapacity);
            }
            if rows.len() <= limit {
                let page = json!({"items":rows,"nextCursor":null,"complete":true});
                let kind = if query_key == "devices" {
                    MetadataKind::Devices
                } else {
                    MetadataKind::Agents
                };
                validate_metadata(kind, &page).map_err(|_| MetadataError::Storage)?;
                validate_context(context)?;
                tx.commit().map_err(|_| MetadataError::Storage)?;
                return Ok(page);
            }
            let items_json = serde_json::to_string(&rows).map_err(|_| MetadataError::Storage)?;
            let byte_count =
                i64::try_from(items_json.len()).map_err(|_| MetadataError::SnapshotCapacity)?;
            if byte_count > MAX_SNAPSHOT_BYTES {
                return Err(MetadataError::SnapshotCapacity);
            }
            let (count, bytes): (i64, i64) = tx.query_row(
                "SELECT COUNT(*),COALESCE(SUM(byte_count),0) FROM directory_snapshots WHERE expires_at>?1",
                params![now], |row| Ok((row.get(0)?,row.get(1)?)),
            ).map_err(|_| MetadataError::Storage)?;
            if count >= MAX_SNAPSHOTS
                || bytes.saturating_add(byte_count) > MAX_SNAPSHOT_BYTES.saturating_mul(4)
            {
                return Err(MetadataError::SnapshotCapacity);
            }
            let id = Uuid::new_v4().to_string();
            let expires = now.saturating_add(SNAPSHOT_TTL);
            tx.execute("INSERT INTO directory_snapshots(snapshot_id,network_id,principal_id,query_key,items_json,byte_count,created_at,expires_at)
                VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![id,context.network_id,context.principal_id,query_key,items_json,byte_count,now,expires]).map_err(|_|MetadataError::Storage)?;
            (id, items_json, 0, expires)
        };
        if now >= expires_at {
            return Err(MetadataError::InvalidCursor);
        }
        let items: Vec<Value> =
            serde_json::from_str(&items_json).map_err(|_| MetadataError::Storage)?;
        let start = usize::try_from(offset).map_err(|_| MetadataError::InvalidCursor)?;
        if start > items.len() {
            return Err(MetadataError::InvalidCursor);
        }
        let end = start.saturating_add(limit).min(items.len());
        let complete = end == items.len();
        let next_cursor = if complete {
            None
        } else {
            let next_offset = i64::try_from(end).map_err(|_| MetadataError::InvalidCursor)?;
            let known: Option<String> = tx
                .query_row(
                    "SELECT cursor_id FROM directory_cursors WHERE snapshot_id=?1 AND offset=?2",
                    params![snapshot_id, next_offset],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|_| MetadataError::Storage)?;
            let cursor_id = known.unwrap_or_else(|| Uuid::new_v4().to_string());
            tx.execute(
                "INSERT OR IGNORE INTO directory_cursors(cursor_id,snapshot_id,offset) VALUES(?1,?2,?3)",
                params![cursor_id,snapshot_id,next_offset],
            )
            .map_err(|_| MetadataError::Storage)?;
            Some(cursor_id)
        };
        validate_context(context)?;
        tx.commit().map_err(|_| MetadataError::Storage)?;
        let page = json!({"items":items[start..end],"nextCursor":next_cursor,"complete":complete});
        let kind = if query_key == "devices" {
            MetadataKind::Devices
        } else {
            MetadataKind::Agents
        };
        validate_metadata(kind, &page).map_err(|_| MetadataError::Storage)?;
        validate_context(context)?;
        Ok(page)
    }

    fn device_rows(
        connection: &Connection,
        context: &SessionContext,
    ) -> Result<Vec<Value>, MetadataError> {
        ensure_registered(connection, context)?;
        let revision = get_roster_revision(connection, context)?;
        let mut statement=connection.prepare("SELECT device_id,joined,membership_revision,name,platform,os_version,app_version,account_seen_at,presence,connection_epoch,catalog_epoch,catalog_seq,catalog_synced_at,last_network_seen_at FROM devices WHERE network_id=?1 AND principal_id=?2 ORDER BY device_id").map_err(|_|MetadataError::Storage)?;
        let rows=statement.query_map(params![context.network_id,context.principal_id],|row| {
            let device_id:String=row.get(0)?;
            let joined:bool=row.get(1)?;
            let membership_revision:i64=row.get(2)?;
            let name:String=row.get(3)?;
            let platform:String=row.get(4)?;
            let os_version:String=row.get(5)?;
            let app_version:String=row.get(6)?;
            let account_seen_at:i64=row.get(7)?;
            let presence:String=row.get(8)?;
            let connection_epoch:Option<String>=row.get(9)?;
            let catalog_epoch:Option<String>=row.get(10)?;
            let catalog_seq:i64=row.get(11)?;
            let catalog_synced_at:Option<i64>=row.get(12)?;
            let last_network_seen_at:Option<i64>=row.get(13)?;
            let count:Option<i64>=if presence=="ready" && catalog_epoch.as_deref()==connection_epoch.as_deref() {
                let active:i64=connection.query_row("SELECT COUNT(*) FROM catalog_items WHERE network_id=?1 AND principal_id=?2 AND device_id=?3 AND json_extract(item_json,'$.lifecycle')='active'",params![context.network_id,context.principal_id,device_id],|r|r.get(0))?;
                if active == 0 {Some(0)} else {None}
            }else{None};
            Ok(json!({"networkId":context.network_id,"principalId":context.principal_id,"deviceId":device_id,
                "joined":joined,"membershipRevision":membership_revision,"name":name,"platform":platform,
                "osVersion":os_version,"appVersion":app_version,"lastAccountSeenAt":timestamp(account_seen_at),
                "lastNetworkSeenAt":last_network_seen_at,"rosterRevision":revision.to_string(),
                "catalogEpoch":catalog_epoch,"catalogSeq":catalog_seq,"catalogSyncedAt":catalog_synced_at,
                "connectionState":presence,"onlineAgentCount":count}))
        }).map_err(|_|MetadataError::Storage)?;
        let mut result = Vec::new();
        for item in rows {
            result.push(item.map_err(|_| MetadataError::Storage)?);
        }
        Ok(result)
    }

    fn agent_rows(
        connection: &Connection,
        context: &SessionContext,
        target_device_id: &str,
    ) -> Result<Vec<Value>, MetadataError> {
        let _ = get_target_device(connection, context, target_device_id)?;
        let current: Option<(String, Option<String>, String)> = connection
            .query_row(
                "SELECT d.presence,d.connection_epoch,c.connection_epoch FROM devices d JOIN catalogs c
                   ON c.network_id=d.network_id AND c.principal_id=d.principal_id AND c.device_id=d.device_id
                 WHERE d.network_id=?1 AND d.principal_id=?2 AND d.device_id=?3",
                params![context.network_id,context.principal_id,target_device_id],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
            )
            .optional()
            .map_err(|_| MetadataError::Storage)?;
        if current
            .as_ref()
            .is_none_or(|(presence, connected, catalog)| {
                presence != "ready" || connected.as_deref() != Some(catalog.as_str())
            })
        {
            return Err(MetadataError::CatalogStale);
        }
        let mut statement=connection.prepare("SELECT mount_id,local_agent_id,item_json,enabled,enable_revision,description,description_revision FROM catalog_items WHERE network_id=?1 AND principal_id=?2 AND device_id=?3 ORDER BY local_agent_id").map_err(|_|MetadataError::Storage)?;
        let rows=statement.query_map(params![context.network_id,context.principal_id,target_device_id],|row|{
            let mount_id:String=row.get(0)?;
            let local_agent_id:String=row.get(1)?;
            let item_json:String=row.get(2)?;
            let enabled:bool=row.get(3)?;
            let enable_revision:i64=row.get(4)?;
            let description:Option<String>=row.get(5)?;
            let description_revision:i64=row.get(6)?;
            let item:Value=serde_json::from_str(&item_json).map_err(|_|rusqlite::Error::InvalidQuery)?;
            if item["lifecycle"]!="active" {return Ok(None)}
            Ok(Some(json!({"mountId":mount_id,"networkId":context.network_id,"principalId":context.principal_id,
                "deviceId":target_device_id,"localAgentId":local_agent_id,"enabled":enabled,
                "enableRevision":enable_revision,"description":description,"descriptionRevision":description_revision,
                "localWorkspaceId":item["localWorkspaceId"],"name":item["name"],"path":item["path"],
                "lifecycle":"active","catalogRevision":item["exposureRevision"],"icon":item.get("icon")})))
        }).map_err(|_|MetadataError::Storage)?;
        let mut result = Vec::new();
        for item in rows {
            if let Some(item) = item.map_err(|_| MetadataError::Storage)? {
                result.push(item);
            }
        }
        Ok(result)
    }

    fn self_policy_rows(
        connection: &Connection,
        context: &SessionContext,
    ) -> Result<Vec<Value>, MetadataError> {
        let _ = get_target_device(connection, context, &context.device_id)?;
        let mut statement = connection
            .prepare(
                "SELECT mount_id,local_agent_id,item_json,enabled,enable_revision,description,
                        description_revision FROM catalog_items
                 WHERE network_id=?1 AND principal_id=?2 AND device_id=?3 ORDER BY local_agent_id",
            )
            .map_err(|_| MetadataError::Storage)?;
        let rows = statement
            .query_map(
                params![context.network_id, context.principal_id, context.device_id],
                |row| {
                    let mount_id: String = row.get(0)?;
                    let local_agent_id: String = row.get(1)?;
                    let item_json: String = row.get(2)?;
                    let enabled: bool = row.get(3)?;
                    let enable_revision: i64 = row.get(4)?;
                    let description: Option<String> = row.get(5)?;
                    let description_revision: i64 = row.get(6)?;
                    let item: Value = serde_json::from_str(&item_json)
                        .map_err(|_| rusqlite::Error::InvalidQuery)?;
                    if item["lifecycle"] != "active" {
                        return Ok(None);
                    }
                    Ok(Some(json!({
                        "mountId":mount_id,"networkId":context.network_id,
                        "principalId":context.principal_id,"deviceId":context.device_id,
                        "localAgentId":local_agent_id,"enabled":enabled,
                        "enableRevision":enable_revision,"description":description,
                        "descriptionRevision":description_revision,
                        "localWorkspaceId":item["localWorkspaceId"],"name":item["name"],
                        "path":item["path"],"lifecycle":"active",
                        "catalogRevision":item["exposureRevision"],"icon":item.get("icon")
                    })))
                },
            )
            .map_err(|_| MetadataError::Storage)?;
        let mut result = Vec::new();
        for item in rows {
            if let Some(item) = item.map_err(|_| MetadataError::Storage)? {
                result.push(item);
            }
        }
        Ok(result)
    }
}

fn parse_presence(value: &str) -> Result<Presence, MetadataError> {
    match value {
        "offline" => Ok(Presence::Offline),
        "syncing" => Ok(Presence::Syncing),
        "ready" => Ok(Presence::Ready),
        _ => Err(MetadataError::Storage),
    }
}

fn durable_catalog_ack(
    connection: &Connection,
    context: &SessionContext,
    device_id: &str,
    connection_epoch: Option<&str>,
    catalog_epoch: Option<&str>,
    device_catalog_seq: i64,
) -> Result<Option<u64>, MetadataError> {
    let Some(current_epoch) = connection_epoch else {
        return Ok(None);
    };
    if catalog_epoch != Some(current_epoch) || device_catalog_seq <= 0 {
        return Ok(None);
    }
    let stored = connection
        .query_row(
            "SELECT connection_epoch,catalog_seq,payload_hash,payload_json FROM catalogs
             WHERE network_id=?1 AND principal_id=?2 AND device_id=?3",
            params![context.network_id, context.principal_id, device_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|_| MetadataError::Storage)?;
    let Some((stored_epoch, stored_seq, payload_hash, payload_json)) = stored else {
        return Ok(None);
    };
    if stored_epoch != current_epoch || stored_seq <= 0 || stored_seq != device_catalog_seq {
        return Ok(None);
    }
    if digest(payload_json.as_bytes()) != payload_hash {
        return Ok(None);
    }
    let Ok(snapshot) = serde_json::from_str::<CatalogSnapshot>(&payload_json) else {
        return Ok(None);
    };
    let Ok(value) = serde_json::to_value(&snapshot) else {
        return Ok(None);
    };
    if validate_catalog(&value).is_err()
        || snapshot.connection_epoch != current_epoch
        || snapshot.catalog_seq != stored_seq as u64
        || snapshot.catalog_seq == 0
        || snapshot.items.len() > budget("catalogItems")
    {
        return Ok(None);
    }
    Ok(Some(stored_seq as u64))
}

fn validate_self_policy_epoch(
    connection: &Connection,
    context: &SessionContext,
    trusted_active_epoch: &str,
) -> Result<(), MetadataError> {
    let current = connection
        .query_row(
            "SELECT presence,connection_epoch,catalog_epoch,catalog_seq FROM devices
             WHERE network_id=?1 AND principal_id=?2 AND device_id=?3",
            params![context.network_id, context.principal_id, context.device_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|_| MetadataError::Storage)?
        .ok_or(MetadataError::DeviceNotRegistered)?;
    let (presence, connection_epoch, catalog_epoch, catalog_seq) = current;
    if !matches!(presence.as_str(), "syncing" | "ready")
        || connection_epoch.as_deref() != Some(trusted_active_epoch)
        || catalog_epoch.as_deref() != Some(trusted_active_epoch)
        || catalog_seq <= 0
        || durable_catalog_ack(
            connection,
            context,
            &context.device_id,
            connection_epoch.as_deref(),
            catalog_epoch.as_deref(),
            catalog_seq,
        )? != Some(catalog_seq as u64)
    {
        return Err(MetadataError::CatalogStale);
    }
    Ok(())
}

#[derive(Debug)]
struct DeviceRow {
    name: String,
    joined: bool,
    membership_revision: i64,
    key_generation: i64,
}

fn get_device(
    tx: &Connection,
    context: &SessionContext,
    device_id: &str,
) -> Result<DeviceRow, MetadataError> {
    tx.query_row(
        "SELECT name,joined,membership_revision,key_generation FROM devices
         WHERE network_id=?1 AND principal_id=?2 AND device_id=?3",
        params![context.network_id, context.principal_id, device_id],
        |row| {
            Ok(DeviceRow {
                name: row.get(0)?,
                joined: row.get(1)?,
                membership_revision: row.get(2)?,
                key_generation: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|_| MetadataError::Storage)?
    .ok_or(MetadataError::DeviceNotRegistered)
}

fn ensure_registered(
    connection: &Connection,
    context: &SessionContext,
) -> Result<(), MetadataError> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM devices WHERE network_id=?1 AND principal_id=?2 AND device_id=?3)",
            params![context.network_id,context.principal_id,context.device_id],
            |row| row.get(0),
        )
        .map_err(|_| MetadataError::Storage)?;
    if exists {
        Ok(())
    } else {
        Err(MetadataError::DeviceNotRegistered)
    }
}

fn get_target_device(
    tx: &Connection,
    context: &SessionContext,
    target_device_id: &str,
) -> Result<DeviceRow, MetadataError> {
    if !canonical_uuid(target_device_id) {
        return Err(MetadataError::InvalidInput);
    }
    get_device(tx, context, target_device_id).map_err(|error| match error {
        MetadataError::DeviceNotRegistered => MetadataError::DeviceOwnerMismatch,
        other => other,
    })
}

fn get_roster_revision(
    connection: &Connection,
    context: &SessionContext,
) -> Result<i64, MetadataError> {
    connection
        .query_row(
            "SELECT roster_revision FROM owner_state WHERE network_id=?1 AND principal_id=?2",
            params![context.network_id, context.principal_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| MetadataError::Storage)
        .map(|value| value.unwrap_or(0))
}

fn bump_roster(tx: &Transaction<'_>, context: &SessionContext) -> Result<(), MetadataError> {
    tx.execute(
        "INSERT INTO owner_state(network_id,principal_id,roster_revision) VALUES(?1,?2,1)
      ON CONFLICT(network_id,principal_id) DO UPDATE SET roster_revision=roster_revision+1",
        params![context.network_id, context.principal_id],
    )
    .map_err(|_| MetadataError::Storage)?;
    Ok(())
}

fn validate_profile(profile: &MetadataProfile) -> Result<(), MetadataError> {
    if !canonical_uuid(&profile.service_id)
        || !["production", "development"].contains(&profile.environment.as_str())
        || profile.network_name.is_empty()
        || profile.network_name.len() > 4096
    {
        return Err(MetadataError::InvalidInput);
    }
    Ok(())
}

/// Bind an owner database to its service/environment on first use. This lock is
/// intentionally stored in SQLite rather than inferred from mutable process
/// config, and the IMMEDIATE transaction serializes concurrent first opens.
/// `network_name` is display text and is deliberately excluded from the pin.
fn pin_database_profile(
    connection: &mut Connection,
    profile: &MetadataProfile,
) -> Result<(), MetadataError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| MetadataError::Storage)?;
    let table_exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='service_profile')",
            [],
            |row| row.get(0),
        )
        .map_err(|_| MetadataError::Storage)?;

    if table_exists {
        let pinned: Option<(String, String)> = transaction
            .query_row(
                "SELECT service_id,environment FROM service_profile WHERE singleton=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| MetadataError::Storage)?;
        let Some((service_id, environment)) = pinned else {
            return Err(MetadataError::Storage);
        };
        if service_id != profile.service_id || environment != profile.environment {
            return Err(MetadataError::ProfileMismatch);
        }
    } else {
        if has_user_table_rows(&transaction)? {
            return Err(MetadataError::UnboundDatabase);
        }
        transaction
            .execute_batch(
                "CREATE TABLE service_profile (
                   singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                   service_id TEXT NOT NULL,
                   environment TEXT NOT NULL
                 );",
            )
            .map_err(|_| MetadataError::Storage)?;
        transaction
            .execute(
                "INSERT INTO service_profile(singleton,service_id,environment) VALUES(1,?1,?2)",
                params![profile.service_id, profile.environment],
            )
            .map_err(|_| MetadataError::Storage)?;
    }
    transaction.commit().map_err(|_| MetadataError::Storage)
}

fn has_user_table_rows(connection: &Connection) -> Result<bool, MetadataError> {
    let mut statement = connection
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .map_err(|_| MetadataError::Storage)?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| MetadataError::Storage)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| MetadataError::Storage)?;
    for name in names {
        let quoted = format!("\"{}\"", name.replace('"', "\"\""));
        let has_rows: bool = connection
            .query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {quoted} LIMIT 1)"),
                [],
                |row| row.get(0),
            )
            .map_err(|_| MetadataError::Storage)?;
        if has_rows {
            return Ok(true);
        }
    }
    Ok(false)
}

fn validate_registration(
    context: &SessionContext,
    record: &DeviceRecord,
    info: &DeviceInfo,
) -> Result<(), MetadataError> {
    if !canonical_uuid(&record.identity_binding_id)
        || record.principal_id != context.principal_id
        || record.network_id != context.network_id
        || record.device_id != context.device_id
        || record.key_generation == 0
        || record.key_generation > MAX_GENERATION as u64
        || !canonical_fingerprint(&record.key_fingerprint)
        || info.name.is_empty()
        || info.name.len() > 4096
        || info.platform.len() > 256
        || info.os_version.len() > 256
        || info.app_version.len() > 128
    {
        return Err(MetadataError::InvalidInput);
    }
    Ok(())
}

fn validate_context(context: &SessionContext) -> Result<(), MetadataError> {
    let now = now_seconds()?;
    if !canonical_uuid(&context.principal_id)
        || !canonical_uuid(&context.network_id)
        || !canonical_uuid(&context.device_id)
        || !canonical_uuid(&context.session_handle)
        || context.expires_at <= now
    {
        return Err(MetadataError::InvalidSession);
    }
    Ok(())
}

fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

fn canonical_fingerprint(value: &str) -> bool {
    value.len() == 43
        && base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, value)
            .is_ok_and(|bytes| bytes.len() == 32)
}

fn digest(value: &[u8]) -> String {
    base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        Sha256::digest(value),
    )
}

fn now_seconds() -> Result<i64, MetadataError> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| MetadataError::Storage)?
        .as_secs();
    i64::try_from(seconds).map_err(|_| MetadataError::Storage)
}

fn timestamp(seconds: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp(seconds)
        .ok()
        .and_then(|datetime| datetime.format(&Rfc3339).ok())
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".into())
}

fn validate_state_dir(path: &Path) -> Result<PathBuf, MetadataError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| MetadataError::UnsafePath)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o777 != 0o700
        || metadata.uid() != nix::unistd::Uid::effective().as_raw()
    {
        return Err(MetadataError::UnsafePath);
    }
    // Resolve trusted intermediate aliases such as macOS /var -> /private/var
    // before SQLite applies NOFOLLOW to the final database path component.
    path.canonicalize().map_err(|_| MetadataError::UnsafePath)
}

fn create_private_database_file(path: &Path) -> Result<(), MetadataError> {
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(file) => {
            file.sync_all().map_err(|_| MetadataError::Storage)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(MetadataError::UnsafePath),
    }
    validate_database_file(path)
}

fn validate_database_file(path: &Path) -> Result<(), MetadataError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| MetadataError::UnsafePath)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o777 != 0o600
        || metadata.nlink() != 1
        || metadata.uid() != nix::unistd::Uid::effective().as_raw()
    {
        return Err(MetadataError::UnsafePath);
    }
    Ok(())
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod profile_pin_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{Arc, Barrier};

    fn private_temp_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        dir
    }

    fn profile() -> MetadataProfile {
        MetadataProfile {
            service_id: Uuid::new_v4().to_string(),
            environment: "development".into(),
            network_name: "display label".into(),
        }
    }

    #[test]
    fn service_profile_pin_survives_restart_and_preserves_existing_rows() {
        let dir = private_temp_dir();
        let original = profile();
        {
            let store = MetadataStore::open(dir.path(), original.clone()).unwrap();
            store
                .connection
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO owner_state(network_id,principal_id,roster_revision) VALUES(?1,?2,7)",
                    params![Uuid::new_v4().to_string(), Uuid::new_v4().to_string()],
                )
                .unwrap();
        }

        let mut renamed = original.clone();
        renamed.network_name = "updated display label".into();
        let store = MetadataStore::open(dir.path(), renamed).unwrap();
        drop(store);

        let mut other_service = original.clone();
        other_service.service_id = Uuid::new_v4().to_string();
        assert!(matches!(
            MetadataStore::open(dir.path(), other_service),
            Err(MetadataError::ProfileMismatch)
        ));
        let mut other_environment = original.clone();
        other_environment.environment = "production".into();
        assert!(matches!(
            MetadataStore::open(dir.path(), other_environment),
            Err(MetadataError::ProfileMismatch)
        ));

        let reopened = MetadataStore::open(dir.path(), original).unwrap();
        let rows: i64 = reopened
            .connection
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM owner_state", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1, "profile mismatch must not delete or rewrite data");
    }

    #[test]
    fn nonempty_database_without_a_profile_pin_fails_closed() {
        let dir = private_temp_dir();
        let configured = profile();
        {
            let store = MetadataStore::open(dir.path(), configured.clone()).unwrap();
            store
                .connection
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO owner_state(network_id,principal_id,roster_revision) VALUES(?1,?2,1)",
                    params![Uuid::new_v4().to_string(), Uuid::new_v4().to_string()],
                )
                .unwrap();
        }
        let database = dir.path().join(DB_NAME);
        let connection = Connection::open(&database).unwrap();
        connection
            .execute("DROP TABLE service_profile", [])
            .unwrap();
        drop(connection);

        assert!(matches!(
            MetadataStore::open(dir.path(), configured),
            Err(MetadataError::UnboundDatabase)
        ));
        let connection = Connection::open(&database).unwrap();
        let rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM owner_state", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1, "refusal must preserve unbound operator data");
    }

    #[test]
    fn concurrent_first_open_atomically_selects_one_service_profile() {
        let dir = private_temp_dir();
        let path = dir.path().to_path_buf();
        let first = profile();
        let mut second = first.clone();
        second.service_id = Uuid::new_v4().to_string();
        let barrier = Arc::new(Barrier::new(2));
        let workers = [first, second].map(|candidate| {
            let barrier = barrier.clone();
            let path = path.clone();
            std::thread::spawn(move || {
                barrier.wait();
                MetadataStore::open(path, candidate)
            })
        });
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(MetadataError::ProfileMismatch)))
                .count(),
            1
        );
    }
}
