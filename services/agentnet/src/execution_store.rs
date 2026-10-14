//! Durable finite-grant/command ledger. Callers hold live authority gates; this
//! store never interprets an HTTP bearer or self-reported device identity.
use myagents_agentnet_execution_core::{
    Activity, Admission, BotSnapshot, Command, ExecutionScope, Grant, HostContext, HostObservation,
    IntentClaims, LeaseClaims, Operation, Receipt, ReceiptStatus, intent_hash,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    fs,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
};

const LIMIT: i64 = 128;
static INIT: Mutex<()> = Mutex::new(());
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct InstancePin {
    pub issuer: String,
    pub service_id: String,
    pub environment: String,
    pub network_id: String,
}
impl InstancePin {
    pub fn from_scope(s: &ExecutionScope) -> Self {
        Self {
            issuer: s.issuer.clone(),
            service_id: s.service_id.clone(),
            environment: s.environment.clone(),
            network_id: s.network_id.clone(),
        }
    }
    fn matches(&self, s: &ExecutionScope) -> bool {
        *self == Self::from_scope(s)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum GrantState {
    Active,
    Revoking,
    Revoked,
}
impl GrantState {
    fn text(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Revoking => "revoking",
            Self::Revoked => "revoked",
        }
    }
    fn parse(s: &str) -> Result<Self> {
        match s {
            "active" => Ok(Self::Active),
            "revoking" => Ok(Self::Revoking),
            "revoked" => Ok(Self::Revoked),
            _ => Err(storage()),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GrantRow {
    pub grant: Grant,
    pub state: GrantState,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CommandRow {
    pub command: Command,
    pub scope: ExecutionScope,
    pub status: String,
    pub receipt: Option<Receipt>,
    pub lease_count: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ObservationRow {
    pub host_id: String,
    pub scope: ExecutionScope,
    pub seen_at: u64,
    pub host_context: HostContext,
    pub observation: HostObservation,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LedgerError(pub &'static str);
impl std::fmt::Display for LedgerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for LedgerError {}
type Result<T> = std::result::Result<T, LedgerError>;
fn storage() -> LedgerError {
    LedgerError("EXECUTION_STORAGE_UNAVAILABLE")
}
fn json<T: Serialize>(v: &T) -> Result<String> {
    serde_json::to_string(v).map_err(|_| storage())
}
fn decode<T: DeserializeOwned>(s: &str) -> Result<T> {
    serde_json::from_str(s).map_err(|_| storage())
}
fn i(n: u64) -> Result<i64> {
    i64::try_from(n).map_err(|_| LedgerError("EXECUTION_INVALID"))
}
fn uuid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok_and(|v| v.to_string() == s)
}
fn verify(p: &Path) -> Result<(u64, u64)> {
    let m = fs::symlink_metadata(p).map_err(|_| storage())?;
    if !m.is_file()
        || m.file_type().is_symlink()
        || m.nlink() != 1
        || m.mode() & 0o077 != 0
        || m.uid() != nix::unistd::Uid::effective().as_raw()
    {
        return Err(storage());
    }
    Ok((m.dev(), m.ino()))
}
pub(crate) struct ExecutionStore {
    path: PathBuf,
    inode: (u64, u64),
    pin: InstancePin,
}
impl ExecutionStore {
    pub fn open(dir: &Path, pin: InstancePin) -> Result<Self> {
        let _guard = INIT.lock().map_err(|_| storage())?;
        let md = fs::symlink_metadata(dir).map_err(|_| storage())?;
        if !dir.is_absolute()
            || !md.is_dir()
            || md.file_type().is_symlink()
            || md.mode() & 0o077 != 0
            || md.uid() != nix::unistd::Uid::effective().as_raw()
        {
            return Err(storage());
        }
        let path = dir
            .canonicalize()
            .map_err(|_| storage())?
            .join("execution.sqlite3");
        if !path.exists() {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&path)
            {
                Ok(f) => drop(f),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err(storage()),
            }
        }
        let inode = verify(&path)?;
        let store = Self { path, inode, pin };
        let mut c = store.connection()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage())?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS execution_pin(singleton INTEGER PRIMARY KEY CHECK(singleton=1),payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,generation INTEGER NOT NULL,owner TEXT NOT NULL,device TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,owner_session_handle TEXT NOT NULL,UNIQUE(bot_id,generation)); CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,actor TEXT NOT NULL,actor_session_handle TEXT NOT NULL,grant_id TEXT NOT NULL,bot_id TEXT NOT NULL,device TEXT NOT NULL,body_hash TEXT NOT NULL,payload TEXT NOT NULL,scope TEXT NOT NULL,status TEXT NOT NULL,receipt TEXT,lease_count INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS issued_intents(hash TEXT PRIMARY KEY,command_id TEXT NOT NULL,device TEXT NOT NULL,payload TEXT NOT NULL,expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS leases(id TEXT PRIMARY KEY,intent_hash TEXT NOT NULL,command_id TEXT NOT NULL,device TEXT NOT NULL,nonce TEXT NOT NULL,payload TEXT NOT NULL,expires_at INTEGER NOT NULL,UNIQUE(device,nonce)); CREATE TABLE IF NOT EXISTS owner_mutations(id TEXT PRIMARY KEY,actor TEXT NOT NULL,payload TEXT NOT NULL,response TEXT NOT NULL);") .map_err(|_|storage())?;
        let saved: Option<String> = tx
            .query_row(
                "SELECT payload FROM execution_pin WHERE singleton=1",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| storage())?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS host_observations(device TEXT PRIMARY KEY, payload TEXT NOT NULL)").map_err(|_|storage())?;
        if let Some(saved) = saved {
            if decode::<InstancePin>(&saved)? != store.pin {
                return Err(LedgerError("EXECUTION_INSTANCE_MISMATCH"));
            }
        } else {
            let n:i64=tx.query_row("SELECT (SELECT COUNT(*)FROM grants)+(SELECT COUNT(*)FROM commands)+(SELECT COUNT(*)FROM issued_intents)+(SELECT COUNT(*)FROM leases)+(SELECT COUNT(*)FROM owner_mutations)+(SELECT COUNT(*)FROM host_observations)",[],|r|r.get(0)).map_err(|_|storage())?;
            if n != 0 {
                return Err(LedgerError("EXECUTION_UNBOUND_STATE"));
            }
            tx.execute(
                "INSERT INTO execution_pin VALUES(1,?1)",
                [json(&store.pin)?],
            )
            .map_err(|_| storage())?;
        }
        tx.commit().map_err(|_| storage())?;
        Ok(store)
    }
    fn connection(&self) -> Result<Connection> {
        if verify(&self.path)? != self.inode {
            return Err(storage());
        }
        let c = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NOFOLLOW
                | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
        )
        .map_err(|_| storage())?;
        c.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| storage())?;
        c.pragma_update(None, "journal_mode", "WAL")
            .map_err(|_| storage())?;
        c.pragma_update(None, "synchronous", "FULL")
            .map_err(|_| storage())?;
        if verify(&self.path)? != self.inode {
            return Err(storage());
        }
        Ok(c)
    }
    pub fn accept_grant(
        &self,
        grant: &Grant,
        expected_generation: u64,
        owner_session: &str,
        now: u64,
    ) -> Result<GrantRow> {
        grant
            .validate()
            .map_err(|_| LedgerError("EXECUTION_INVALID"))?;
        if !self.pin.matches(&grant.scope)
            || !uuid(owner_session)
            || grant.expires_at <= now
            || grant.generation
                != expected_generation
                    .checked_add(1)
                    .ok_or(LedgerError("GRANT_GENERATION_EXHAUSTED"))?
        {
            return Err(LedgerError("GRANT_SCOPE_REJECTED"));
        }
        let mut c = self.connection()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage())?;
        let payload = json(grant)?;
        if let Some((old, state)) = tx
            .query_row(
                "SELECT payload,state FROM grants WHERE id=?1",
                [&grant.id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|_| storage())?
        {
            if old != payload {
                return Err(LedgerError("GRANT_ID_MISMATCH"));
            }
            return Ok(GrantRow {
                grant: decode(&old)?,
                state: GrantState::parse(&state)?,
            });
        }
        let previous: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(generation),0) FROM grants WHERE bot_id=?1",
                [&grant.bot_id],
                |r| r.get(0),
            )
            .map_err(|_| storage())?;
        if previous != i(expected_generation)? {
            return Err(LedgerError("GRANT_GENERATION_CONFLICT"));
        }
        let live: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM grants WHERE bot_id=?1 AND state!='revoked'",
                [&grant.bot_id],
                |r| r.get(0),
            )
            .map_err(|_| storage())?;
        if live != 0 {
            return Err(LedgerError("GRANT_CHANGE_REQUIRES_EFFECTIVE_REVOCATION"));
        }
        let n: i64 = tx
            .query_row(
                "SELECT COUNT(*)FROM grants WHERE state!='revoked'",
                [],
                |r| r.get(0),
            )
            .map_err(|_| storage())?;
        if n >= LIMIT {
            return Err(LedgerError("EXECUTION_CAPACITY"));
        }
        tx.execute(
            "INSERT INTO grants VALUES(?1,?2,?3,?4,?5,?6,'active',?7)",
            params![
                grant.id,
                grant.bot_id,
                i(grant.generation)?,
                grant.scope.host_owner_id,
                grant.scope.host_device_id,
                payload,
                owner_session
            ],
        )
        .map_err(|_| storage())?;
        tx.commit().map_err(|_| storage())?;
        Ok(GrantRow {
            grant: grant.clone(),
            state: GrantState::Active,
        })
    }
    pub fn grants(&self) -> Result<Vec<GrantRow>> {
        let c = self.connection()?;
        let mut q=c.prepare("SELECT payload,state FROM grants ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'revoking' THEN 1 ELSE 2 END,rowid DESC LIMIT 128").map_err(|_|storage())?;
        q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|_| storage())?
            .map(|r| {
                let (p, s) = r.map_err(|_| storage())?;
                Ok(GrantRow {
                    grant: decode(&p)?,
                    state: GrantState::parse(&s)?,
                })
            })
            .collect()
    }
    /// Display metadata only. This table is never consulted by grant, lease,
    /// binding, receipt or effective-revocation transactions.
    pub fn observe(
        &self,
        scope: &ExecutionScope,
        context: &HostContext,
        observation: &HostObservation,
        seen_at: u64,
    ) -> Result<ObservationRow> {
        scope
            .validate()
            .map_err(|_| LedgerError("HOST_OBSERVATION_INVALID"))?;
        context
            .validate()
            .map_err(|_| LedgerError("HOST_OBSERVATION_INVALID"))?;
        observation
            .validate()
            .map_err(|_| LedgerError("HOST_OBSERVATION_INVALID"))?;
        if !self.pin.matches(scope)
            || seen_at == 0
            || seen_at > myagents_agentnet_execution_core::MAX_SAFE_INTEGER
        {
            return Err(LedgerError("HOST_OBSERVATION_INVALID"));
        }
        let row = ObservationRow {
            host_id: scope.host_device_id.clone(),
            scope: scope.clone(),
            seen_at,
            host_context: context.clone(),
            observation: observation.clone(),
        };
        let mut c = self.connection()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage())?;
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM host_observations WHERE device=?1)",
                [&row.host_id],
                |r| r.get(0),
            )
            .map_err(|_| storage())?;
        if !exists {
            let n: i64 = tx
                .query_row("SELECT COUNT(*) FROM host_observations", [], |r| r.get(0))
                .map_err(|_| storage())?;
            if n >= LIMIT {
                return Err(LedgerError("EXECUTION_CAPACITY"));
            }
        }
        tx.execute("INSERT INTO host_observations(device,payload) VALUES(?1,?2) ON CONFLICT(device) DO UPDATE SET payload=excluded.payload",params![row.host_id,json(&row)?]).map_err(|_|storage())?;
        tx.commit().map_err(|_| storage())?;
        Ok(row)
    }
    pub fn public_observations(&self) -> Result<Vec<ObservationRow>> {
        let c = self.connection()?;
        let mut q = c
            .prepare("SELECT payload FROM host_observations ORDER BY device LIMIT 128")
            .map_err(|_| storage())?;
        let rows = q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|_| storage())?;
        rows.map(|r| {
            let row: ObservationRow = decode(&r.map_err(|_| storage())?)?;
            row.scope.validate().map_err(|_| storage())?;
            row.host_context.validate().map_err(|_| storage())?;
            row.observation.validate().map_err(|_| storage())?;
            if !self.pin.matches(&row.scope)
                || row.host_id != row.scope.host_device_id
                || row.seen_at == 0
                || row.seen_at > myagents_agentnet_execution_core::MAX_SAFE_INTEGER
            {
                return Err(storage());
            }
            Ok(row)
        })
        .collect()
    }
    pub fn grant(&self, id: &str) -> Result<GrantRow> {
        let c = self.connection()?;
        let p: Option<(String, String)> = c
            .query_row("SELECT payload,state FROM grants WHERE id=?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()
            .map_err(|_| storage())?;
        let (p, state) = p.ok_or(LedgerError("GRANT_NOT_FOUND"))?;
        Ok(GrantRow {
            grant: decode(&p)?,
            state: GrantState::parse(&state)?,
        })
    }
    pub fn revoke(
        &self,
        id: &str,
        expected_generation: u64,
        actor: &str,
        mutation_id: &str,
    ) -> Result<GrantRow> {
        if !uuid(id) || !uuid(actor) || !uuid(mutation_id) {
            return Err(LedgerError("EXECUTION_INVALID"));
        }
        let mut c = self.connection()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage())?;
        let body = json(&(id, expected_generation, actor))?;
        if let Some((owner, old, response)) = tx
            .query_row(
                "SELECT actor,payload,response FROM owner_mutations WHERE id=?1",
                [mutation_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| storage())?
        {
            if owner != actor || old != body {
                return Err(LedgerError("EXECUTION_MUTATION_MISMATCH"));
            }
            return decode(&response);
        }
        let (p, s): (String, String) = tx
            .query_row("SELECT payload,state FROM grants WHERE id=?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()
            .map_err(|_| storage())?
            .ok_or(LedgerError("GRANT_NOT_FOUND"))?;
        let grant: Grant = decode(&p)?;
        if grant.scope.host_owner_id != actor {
            return Err(LedgerError("GRANT_OWNER_REQUIRED"));
        }
        if grant.generation != expected_generation {
            return Err(LedgerError("GRANT_GENERATION_CONFLICT"));
        }
        let state = GrantState::parse(&s)?;
        let next = if state == GrantState::Revoked {
            state
        } else {
            GrantState::Revoking
        };
        let row = GrantRow { grant, state: next };
        tx.execute(
            "UPDATE grants SET state=?1 WHERE id=?2",
            params![next.text(), id],
        )
        .map_err(|_| storage())?;
        tx.execute(
            "INSERT INTO owner_mutations VALUES(?1,?2,?3,?4)",
            params![mutation_id, actor, body, json(&row)?],
        )
        .map_err(|_| storage())?;
        // Queued/issued commands had no authorization lease. Once leased the
        // effect is uncertain until the Host reports it; never infer rollback.
        tx.execute(
            "UPDATE commands SET status='cancel_pending' WHERE grant_id=?1 AND receipt IS NULL",
            [id],
        )
        .map_err(|_| storage())?;
        tx.commit().map_err(|_| storage())?;
        Ok(row)
    }
    pub fn known_bot_snapshot(
        &self,
        scope: &ExecutionScope,
        bot_id: &str,
    ) -> Result<Option<BotSnapshot>> {
        known_snapshot(&self.connection()?, scope, bot_id)
    }
    pub fn confirm_revoked(
        &self,
        id: &str,
        generation: u64,
        scope: &ExecutionScope,
        snapshot: &BotSnapshot,
    ) -> Result<GrantRow> {
        let mut c = self.connection()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage())?;
        let (p, s): (String, String) = tx
            .query_row("SELECT payload,state FROM grants WHERE id=?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()
            .map_err(|_| storage())?
            .ok_or(LedgerError("GRANT_NOT_FOUND"))?;
        let grant: Grant = decode(&p)?;
        let state = GrantState::parse(&s)?;
        if grant.generation != generation || &grant.scope != scope || state == GrantState::Active {
            return Err(LedgerError("GRANT_REVOCATION_MISMATCH"));
        }
        snapshot
            .validate()
            .map_err(|_| LedgerError("HOST_CLOSE_UNCONFIRMED"))?;
        if snapshot.bot_id != grant.bot_id
            || snapshot.admission != Admission::Closed
            || !matches!(snapshot.activity, Activity::Idle | Activity::Stopped)
            || snapshot.active_run.is_some()
        {
            return Err(LedgerError("HOST_CLOSE_UNCONFIRMED"));
        }
        // No leased outcome is inferred away, even after its short lease expired.
        let uncertain:i64=tx.query_row("SELECT COUNT(*) FROM commands WHERE bot_id=?1 AND device=?2 AND scope=?3 AND lease_count>0 AND receipt IS NULL",params![grant.bot_id,scope.host_device_id,json(scope)?],|r|r.get(0)).map_err(|_|storage())?;
        if uncertain != 0 {
            return Err(LedgerError("HOST_COMMAND_OUTCOME_UNCONFIRMED"));
        }
        if let Some(known) = known_snapshot(&tx, scope, &grant.bot_id)? {
            if snapshot.agent_id != known.agent_id
                || snapshot.binding_generation != known.binding_generation
                || snapshot.revision < known.revision
            {
                return Err(LedgerError("HOST_BINDING_MISMATCH"));
            }
        } else if snapshot.agent_id.is_some() || snapshot.binding_generation != 0 {
            return Err(LedgerError("HOST_BINDING_UNKNOWN"));
        }
        tx.execute("UPDATE grants SET state='revoked' WHERE id=?1", [id])
            .map_err(|_| storage())?;
        tx.commit().map_err(|_| storage())?;
        Ok(GrantRow {
            grant,
            state: GrantState::Revoked,
        })
    }
    pub fn enqueue(&self, cmd: &Command, grant: &Grant, now: u64) -> Result<CommandRow> {
        cmd.authorized_by(grant)
            .map_err(|_| LedgerError("COMMAND_SCOPE_REJECTED"))?;
        if !self.pin.matches(&grant.scope) || grant.expires_at <= now {
            return Err(LedgerError("GRANT_EXPIRED"));
        }
        let mut c = self.connection()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage())?;
        let payload = json(cmd)?;
        if let Some(row) = read_command(&tx, &cmd.mutation_id)? {
            if row.command != *cmd || row.scope != grant.scope {
                return Err(LedgerError("EXECUTION_MUTATION_MISMATCH"));
            }
            return Ok(row);
        }
        active_grant(&tx, grant, now)?;
        let n: i64 = tx
            .query_row(
                "SELECT COUNT(*)FROM commands WHERE receipt IS NULL",
                [],
                |r| r.get(0),
            )
            .map_err(|_| storage())?;
        if n >= LIMIT {
            return Err(LedgerError("EXECUTION_CAPACITY"));
        }
        tx.execute("INSERT INTO commands(id,actor,actor_session_handle,grant_id,bot_id,device,body_hash,payload,scope,status) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'queued')",params![cmd.mutation_id,cmd.actor_principal_id,cmd.actor_session_handle,grant.id,cmd.bot_id,grant.scope.host_device_id,cmd.request_hash,payload,json(&grant.scope)?]).map_err(|_|storage())?;
        let row = read_command(&tx, &cmd.mutation_id)?.ok_or_else(storage)?;
        tx.commit().map_err(|_| storage())?;
        Ok(row)
    }
    pub fn command(&self, id: &str) -> Result<CommandRow> {
        read_command(&self.connection()?, id)?.ok_or(LedgerError("EXECUTION_MUTATION_NOT_FOUND"))
    }
    pub fn queued_for(&self, scope: &ExecutionScope) -> Result<Vec<CommandRow>> {
        let c = self.connection()?;
        // Reserve bounded candidate slots for reductions beyond the oldest
        // blocked normal window, but preserve row order for executable work.
        let mut query=c.prepare("WITH reductions AS (SELECT rowid AS position,id FROM commands WHERE device=?1 AND scope=?2 AND status IN ('queued','issued','leased','unconfirmed') AND receipt IS NULL AND json_extract(payload,'$.operation.method') IN ('disable','delete') ORDER BY rowid LIMIT 8),normal AS (SELECT rowid AS position,id FROM commands WHERE device=?1 AND scope=?2 AND status IN ('queued','issued','leased','unconfirmed') AND receipt IS NULL AND COALESCE(json_extract(payload,'$.operation.method'),'') NOT IN ('disable','delete') ORDER BY rowid LIMIT 8) SELECT id FROM (SELECT position,id FROM reductions UNION ALL SELECT position,id FROM normal) ORDER BY position").map_err(|_|storage())?;
        let ids = query
            .query_map(params![scope.host_device_id, json(scope)?], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|_| storage())?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| storage())?;
        ids.iter()
            .map(|id| read_command(&c, id)?.ok_or_else(storage))
            .collect()
    }
    pub(crate) fn has_prior_noncleanup(
        &self,
        scope: &ExecutionScope,
        command: &Command,
        now: u64,
        evaluated_ids: &[String],
    ) -> Result<bool> {
        if evaluated_ids.len() > 16 {
            return Err(LedgerError("EXECUTION_INVALID"));
        }
        self.connection()?.query_row("SELECT EXISTS(SELECT 1 FROM commands AS command JOIN grants AS grant ON grant.id=command.grant_id WHERE command.device=?1 AND command.scope=?2 AND command.bot_id=?3 AND command.receipt IS NULL AND command.status IN ('queued','issued','leased','unconfirmed') AND grant.state='active' AND CAST(json_extract(grant.payload,'$.expires_at') AS INTEGER)>?5 AND COALESCE(json_extract(command.payload,'$.operation.method'),'') NOT IN ('disable','delete') AND command.rowid<(SELECT rowid FROM commands WHERE id=?4) AND command.id NOT IN (SELECT value FROM json_each(?6)))",params![scope.host_device_id,json(scope)?,command.bot_id,command.mutation_id,i(now)?,json(&evaluated_ids)?],|row|row.get(0)).map_err(|_|storage())
    }
    pub fn issue_intent(&self, intent: &IntentClaims, now: u64) -> Result<String> {
        intent
            .validate_at(&intent.scope, now)
            .map_err(|_| LedgerError("INTENT_REJECTED"))?;
        if !self.pin.matches(&intent.scope) {
            return Err(LedgerError("INTENT_REJECTED"));
        }
        let hash = intent_hash(intent).map_err(|_| LedgerError("INTENT_REJECTED"))?;
        let mut c = self.connection()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage())?;
        let cmd = read_command(&tx, &intent.command.mutation_id)?
            .ok_or(LedgerError("EXECUTION_MUTATION_NOT_FOUND"))?;
        if cmd.command != intent.command
            || cmd.scope != intent.scope
            || cmd.receipt.is_some()
            || !["queued", "issued", "leased", "unconfirmed"].contains(&cmd.status.as_str())
        {
            return Err(LedgerError("COMMAND_NOT_PENDING"));
        }
        check_delete_dependencies(&tx, &intent.scope, &cmd.command)?;
        active_grant(&tx, &intent.grant, now)?;
        tx.execute("DELETE FROM issued_intents WHERE expires_at<=?1", [i(now)?])
            .map_err(|_| storage())?;
        let previous: Option<String> = tx
            .query_row(
                "SELECT payload FROM issued_intents WHERE hash=?1",
                [&hash],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| storage())?;
        if let Some(previous) = previous {
            if previous != json(intent)? {
                return Err(storage());
            }
            tx.commit().map_err(|_| storage())?;
            return Ok(hash);
        }
        let n: i64 = tx
            .query_row("SELECT COUNT(*)FROM issued_intents", [], |r| r.get(0))
            .map_err(|_| storage())?;
        if n >= LIMIT {
            return Err(LedgerError("EXECUTION_CAPACITY"));
        }
        tx.execute(
            "INSERT OR IGNORE INTO issued_intents VALUES(?1,?2,?3,?4,?5)",
            params![
                hash,
                cmd.command.mutation_id,
                intent.scope.host_device_id,
                json(intent)?,
                i(intent.exp)?
            ],
        )
        .map_err(|_| storage())?;
        tx.execute(
            "UPDATE commands SET status='issued' WHERE id=?1 AND status='queued'",
            [&cmd.command.mutation_id],
        )
        .map_err(|_| storage())?;
        tx.commit().map_err(|_| storage())?;
        Ok(hash)
    }
    pub fn current_intent(
        &self,
        scope: &ExecutionScope,
        mutation_id: &str,
        now: u64,
    ) -> Result<Option<IntentClaims>> {
        let c = self.connection()?;
        let saved:Option<String>=c.query_row("SELECT payload FROM issued_intents WHERE command_id=?1 AND device=?2 AND expires_at>?3 ORDER BY expires_at DESC LIMIT 1",params![mutation_id,scope.host_device_id,i(now)?],|r|r.get(0)).optional().map_err(|_|storage())?;
        saved
            .map(|raw| {
                let v: IntentClaims = decode(&raw)?;
                v.validate_at(scope, now).map_err(|_| storage())?;
                Ok(v)
            })
            .transpose()
    }
    pub fn bot_has_live_grant(&self, bot_id: &str) -> Result<bool> {
        let n: i64 = self
            .connection()?
            .query_row(
                "SELECT COUNT(*) FROM grants WHERE bot_id=?1 AND state!='revoked'",
                [bot_id],
                |r| r.get(0),
            )
            .map_err(|_| storage())?;
        Ok(n > 0)
    }
    pub fn intent(&self, hash: &str) -> Result<IntentClaims> {
        let c = self.connection()?;
        let payload: Option<String> = c
            .query_row(
                "SELECT payload FROM issued_intents WHERE hash=?1",
                [hash],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| storage())?;
        let intent: IntentClaims = decode(&payload.ok_or(LedgerError("INTENT_NOT_FOUND"))?)?;
        if intent_hash(&intent).map_err(|_| storage())? != hash {
            return Err(storage());
        }
        Ok(intent)
    }
    pub fn issue_lease(
        &self,
        lease: &LeaseClaims,
        intent: &IntentClaims,
        context: &HostContext,
        now: u64,
    ) -> Result<LeaseClaims> {
        lease
            .matches_intent(intent, context, now)
            .map_err(|_| LedgerError("LEASE_REJECTED"))?;
        let mut c = self.connection()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage())?;
        active_grant(&tx, &intent.grant, now)?;
        let cmd = read_command(&tx, &lease.mutation_id)?
            .ok_or(LedgerError("EXECUTION_MUTATION_NOT_FOUND"))?;
        if cmd.command != intent.command
            || cmd.scope != intent.scope
            || cmd.receipt.is_some()
            || cmd.status == "cancel_pending"
        {
            return Err(LedgerError("COMMAND_NOT_PENDING"));
        }
        check_delete_dependencies(&tx, &intent.scope, &cmd.command)?;
        let saved: Option<String> = tx
            .query_row(
                "SELECT payload FROM leases WHERE device=?1 AND nonce=?2",
                params![lease.scope.host_device_id, context.challenge_nonce],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| storage())?;
        if let Some(saved) = saved {
            let old: LeaseClaims = decode(&saved)?;
            if old.intent_hash != lease.intent_hash
                || old.host_context != lease.host_context
                || old.exp <= now
            {
                return Err(LedgerError("LEASE_NONCE_REJECTED"));
            }
            return Ok(old);
        }
        let n: i64 = tx
            .query_row(
                "SELECT COUNT(*)FROM leases WHERE expires_at>?1",
                [i(now)?],
                |r| r.get(0),
            )
            .map_err(|_| storage())?;
        if n >= LIMIT {
            return Err(LedgerError("EXECUTION_CAPACITY"));
        }
        // Immutable issued intent must already be in the trusted local ledger.
        let issued: Option<String> = tx
            .query_row(
                "SELECT payload FROM issued_intents WHERE hash=?1",
                [&lease.intent_hash],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| storage())?;
        if issued.as_deref() != Some(json(intent)?.as_str()) {
            return Err(LedgerError("INTENT_NOT_FOUND"));
        }
        tx.execute(
            "INSERT INTO leases VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                lease.lease_id,
                lease.intent_hash,
                lease.mutation_id,
                lease.scope.host_device_id,
                context.challenge_nonce,
                json(lease)?,
                i(lease.exp)?
            ],
        )
        .map_err(|_| storage())?;
        tx.execute(
            "UPDATE commands SET status='leased',lease_count=lease_count+1 WHERE id=?1",
            [&lease.mutation_id],
        )
        .map_err(|_| storage())?;
        tx.commit().map_err(|_| storage())?;
        Ok(lease.clone())
    }
    pub fn record_receipt(
        &self,
        lease_id: &str,
        scope: &ExecutionScope,
        receipt: &Receipt,
    ) -> Result<CommandRow> {
        receipt
            .validate()
            .map_err(|_| LedgerError("HOST_RECEIPT_REJECTED"))?;
        let mut c = self.connection()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage())?;
        let payload: Option<String> = tx
            .query_row("SELECT payload FROM leases WHERE id=?1", [lease_id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|_| storage())?;
        let lease: LeaseClaims = decode(&payload.ok_or(LedgerError("LEASE_NOT_FOUND"))?)?;
        let cmd = read_command(&tx, &receipt.mutation_id)?
            .ok_or(LedgerError("EXECUTION_MUTATION_NOT_FOUND"))?;
        if &cmd.scope != scope
            || &lease.scope != scope
            || lease.mutation_id != receipt.mutation_id
            || lease.request_hash != receipt.request_hash
        {
            return Err(LedgerError("HOST_RECEIPT_REJECTED"));
        }
        receipt
            .matches_command(&cmd.command)
            .map_err(|_| LedgerError("HOST_RECEIPT_REJECTED"))?;
        if receipt.status == ReceiptStatus::Persisted && receipt.snapshot.is_none() {
            return Err(LedgerError("HOST_RECEIPT_REJECTED"));
        }
        if let Some(old) = &cmd.receipt {
            if old != receipt {
                return Err(LedgerError("HOST_RECEIPT_MISMATCH"));
            }
            return Ok(cmd);
        }
        let terminal = receipt.status != ReceiptStatus::Unconfirmed;
        tx.execute(
            "UPDATE commands SET status=?1,receipt=?2 WHERE id=?3",
            params![
                if terminal {
                    "host_confirmed"
                } else {
                    "unconfirmed"
                },
                if terminal { Some(json(receipt)?) } else { None },
                receipt.mutation_id
            ],
        )
        .map_err(|_| storage())?;
        let updated = read_command(&tx, &receipt.mutation_id)?.ok_or_else(storage)?;
        tx.commit().map_err(|_| storage())?;
        Ok(updated)
    }
}
fn known_snapshot(
    c: &Connection,
    scope: &ExecutionScope,
    bot_id: &str,
) -> Result<Option<BotSnapshot>> {
    let mut q=c.prepare("SELECT receipt FROM commands WHERE bot_id=?1 AND device=?2 AND scope=?3 AND receipt IS NOT NULL AND json_extract(receipt,'$.status')='persisted'").map_err(|_|storage())?;
    let rows = q
        .query_map(params![bot_id, scope.host_device_id, json(scope)?], |r| {
            r.get::<_, String>(0)
        })
        .map_err(|_| storage())?;
    let mut latest: Option<BotSnapshot> = None;
    for row in rows {
        let r: Receipt = decode(&row.map_err(|_| storage())?)?;
        r.validate().map_err(|_| storage())?;
        let v = r.snapshot.ok_or_else(storage)?;
        if latest.as_ref().is_none_or(|old| v.revision > old.revision) {
            latest = Some(v)
        }
    }
    Ok(latest)
}
fn active_grant(c: &Connection, grant: &Grant, now: u64) -> Result<()> {
    let row: Option<(String, String)> = c
        .query_row(
            "SELECT payload,state FROM grants WHERE id=?1",
            [&grant.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| storage())?;
    let (p, s) = row.ok_or(LedgerError("GRANT_NOT_FOUND"))?;
    if p != json(grant)? || s != "active" || grant.expires_at <= now {
        return Err(LedgerError("GRANT_NOT_ACTIVE"));
    }
    Ok(())
}
fn check_delete_dependencies(
    c: &Connection,
    scope: &ExecutionScope,
    command: &Command,
) -> Result<()> {
    if !matches!(command.operation, Operation::Delete(_)) {
        return Ok(());
    }
    // Expiry or actor logout never establishes the outcome of an earlier lease.
    // The original command/receipt owner remains authoritative; exclude this
    // mutation so a Delete lease can replay its own nonce normally.
    let unknown:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM commands WHERE device=?1 AND scope=?2 AND bot_id=?3 AND id!=?4 AND rowid<(SELECT rowid FROM commands WHERE id=?4) AND lease_count>0 AND receipt IS NULL)",params![scope.host_device_id,json(scope)?,command.bot_id,command.mutation_id],|row|row.get(0)).map_err(|_|storage())?;
    if unknown {
        return Err(LedgerError("HOST_COMMAND_OUTCOME_UNCONFIRMED"));
    }
    Ok(())
}
fn read_command(c: &Connection, id: &str) -> Result<Option<CommandRow>> {
    let row: Option<(String, String, String, Option<String>, u64)> = c
        .query_row(
            "SELECT payload,scope,status,receipt,lease_count FROM commands WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(|_| storage())?;
    row.map(|(p, s, status, receipt, lease_count)| {
        let command: Command = decode(&p)?;
        command.validate().map_err(|_| storage())?;
        let scope: ExecutionScope = decode(&s)?;
        scope.validate().map_err(|_| storage())?;
        Ok(CommandRow {
            command,
            scope,
            status,
            receipt: receipt.map(|r| decode(&r)).transpose()?,
            lease_count,
        })
    })
    .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use myagents_agentnet_execution_core::{BotSnapshot, command_hash};
    use std::os::unix::fs::{PermissionsExt, symlink};
    fn wire() -> serde_json::Value {
        serde_json::from_str(include_str!("../execution-core/fixtures/wire-v1.json")).unwrap()
    }
    fn fixture() -> (
        tempfile::TempDir,
        ExecutionStore,
        Grant,
        Command,
        IntentClaims,
        LeaseClaims,
    ) {
        let w = wire();
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let grant: Grant = serde_json::from_value(w["grant"].clone()).unwrap();
        let command: Command = serde_json::from_value(w["command"].clone()).unwrap();
        let intent: IntentClaims = serde_json::from_value(w["intent"].clone())
            .unwrap_or_else(|_| serde_json::from_value(w["intent_claims"].clone()).unwrap());
        let lease: LeaseClaims = serde_json::from_value(w["lease"].clone())
            .unwrap_or_else(|_| serde_json::from_value(w["lease_claims"].clone()).unwrap());
        let s = ExecutionStore::open(dir.path(), InstancePin::from_scope(&grant.scope)).unwrap();
        (dir, s, grant, command, intent, lease)
    }
    #[test]
    fn observations_persist_latest_scope_context_but_cannot_confirm_outcomes_or_bindings() {
        let (dir, s, g, c, intent, lease) = fixture();
        let now = 1_800_000_001;
        let o: HostObservation = serde_json::from_value(wire()["observation"].clone()).unwrap();
        s.observe(&g.scope, &lease.host_context, &o, now).unwrap();
        assert!(s.known_bot_snapshot(&g.scope, &g.bot_id).unwrap().is_none());
        let reopened = ExecutionStore::open(dir.path(), InstancePin::from_scope(&g.scope)).unwrap();
        let mut context = lease.host_context.clone();
        context.challenge_nonce = uuid::Uuid::new_v4().to_string();
        reopened.observe(&g.scope, &context, &o, now + 31).unwrap();
        let reports = reopened.public_observations().unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].seen_at, now + 31);
        assert_eq!(reports[0].host_context, context);
        s.accept_grant(&g, 0, &c.actor_session_handle, now).unwrap();
        s.enqueue(&c, &g, now).unwrap();
        s.issue_intent(&intent, now).unwrap();
        s.issue_lease(&lease, &intent, &lease.host_context, now)
            .unwrap();
        s.revoke(
            &g.id,
            g.generation,
            &g.scope.host_owner_id,
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
        assert_eq!(
            s.confirm_revoked(&g.id, g.generation, &g.scope, &o.snapshots[0])
                .unwrap_err()
                .0,
            "HOST_COMMAND_OUTCOME_UNCONFIRMED"
        );
        assert!(s.command(&c.mutation_id).unwrap().receipt.is_none());
        let mut foreign = g.scope.clone();
        foreign.issuer = "https://different.invalid".into();
        assert!(s.observe(&foreign, &context, &o, now).is_err());
    }
    #[test]
    fn pin_private_file_and_original_command_survive_reopen() {
        let (dir, s, g, c, _, _) = fixture();
        s.accept_grant(&g, 0, &c.actor_session_handle, 1_800_000_001)
            .unwrap();
        s.enqueue(&c, &g, 1_800_000_001).unwrap();
        let again = ExecutionStore::open(dir.path(), InstancePin::from_scope(&g.scope)).unwrap();
        assert_eq!(again.command(&c.mutation_id).unwrap().command, c);
        let mut changed = c.clone();
        changed.expected_host_revision += 1;
        changed.request_hash = command_hash(&changed).unwrap();
        assert_eq!(
            again.enqueue(&changed, &g, 1_800_000_001).unwrap_err().0,
            "EXECUTION_MUTATION_MISMATCH"
        );
        let mut pin = InstancePin::from_scope(&g.scope);
        pin.issuer = "https://another.invalid".into();
        assert!(ExecutionStore::open(dir.path(), pin).is_err());
        fs::set_permissions(
            dir.path().join("execution.sqlite3"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(again.grant(&g.id).is_err());
    }
    #[test]
    fn no_lease_before_issued_intent_and_nonce_cannot_retarget() {
        let (_dir, s, g, c, intent, lease) = fixture();
        let now = 1_800_000_001;
        s.accept_grant(&g, 0, &c.actor_session_handle, now).unwrap();
        s.enqueue(&c, &g, now).unwrap();
        assert_eq!(
            s.issue_lease(&lease, &intent, &lease.host_context, now)
                .unwrap_err()
                .0,
            "INTENT_NOT_FOUND"
        );
        assert_eq!(
            s.issue_intent(&intent, now).unwrap(),
            intent_hash(&intent).unwrap()
        );
        let l = s
            .issue_lease(&lease, &intent, &lease.host_context, now)
            .unwrap();
        assert_eq!(
            s.issue_lease(&lease, &intent, &lease.host_context, now)
                .unwrap(),
            l
        );
        let mut wrong = lease.clone();
        wrong.host_context.boot_epoch = uuid::Uuid::new_v4().to_string();
        assert!(
            s.issue_lease(&wrong, &intent, &wrong.host_context, now)
                .is_err()
        );
        assert_eq!(s.command(&c.mutation_id).unwrap().lease_count, 1);
    }
    #[test]
    fn revocation_blocks_leases_and_reassignment_until_host_confirmation() {
        let (_dir, s, g, c, intent, lease) = fixture();
        let now = 1_800_000_001;
        s.accept_grant(&g, 0, &c.actor_session_handle, now).unwrap();
        s.enqueue(&c, &g, now).unwrap();
        s.issue_intent(&intent, now).unwrap();
        assert!(
            s.revoke(
                &g.id,
                g.generation,
                &uuid::Uuid::new_v4().to_string(),
                &uuid::Uuid::new_v4().to_string()
            )
            .is_err()
        );
        let id = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            s.revoke(&g.id, g.generation, &g.scope.host_owner_id, &id)
                .unwrap()
                .state,
            GrantState::Revoking
        );
        assert!(
            s.issue_lease(&lease, &intent, &lease.host_context, now)
                .is_err()
        );
        let mut next = g.clone();
        next.id = uuid::Uuid::new_v4().to_string();
        next.generation += 1;
        assert_eq!(
            s.accept_grant(&next, g.generation, &c.actor_session_handle, now)
                .unwrap_err()
                .0,
            "GRANT_CHANGE_REQUIRES_EFFECTIVE_REVOCATION"
        );
        let mut empty: BotSnapshot = serde_json::from_value(wire()["snapshot"].clone()).unwrap();
        empty.agent_id = None;
        empty.binding_generation = 0;
        empty.active_run = None;
        empty.admission = Admission::Closed;
        empty.activity = Activity::Idle;
        let mut other = g.scope.clone();
        other.host_device_id = uuid::Uuid::new_v4().to_string();
        assert!(
            s.confirm_revoked(&g.id, g.generation, &other, &empty)
                .is_err()
        );
        s.confirm_revoked(&g.id, g.generation, &g.scope, &empty)
            .unwrap();
        assert_eq!(
            s.accept_grant(&next, g.generation, &c.actor_session_handle, now)
                .unwrap()
                .state,
            GrantState::Active
        );
        assert_eq!(
            s.revoke(&g.id, g.generation, &g.scope.host_owner_id, &id)
                .unwrap()
                .state,
            GrantState::Revoking
        ); // Original acceptance receipt does not fake effective state.
    }
    #[test]
    fn receipt_requires_real_issued_lease_and_exact_target() {
        let (_dir, s, g, c, intent, lease) = fixture();
        let now = 1_800_000_001;
        s.accept_grant(&g, 0, &c.actor_session_handle, now).unwrap();
        s.enqueue(&c, &g, now).unwrap();
        s.issue_intent(&intent, now).unwrap();
        let snapshot: BotSnapshot = serde_json::from_value(wire()["snapshot"].clone()).unwrap();
        let mut receipt = Receipt {
            mutation_id: c.mutation_id.clone(),
            request_hash: c.request_hash.clone(),
            grant_id: g.id.clone(),
            grant_generation: g.generation,
            bot_id: g.bot_id.clone(),
            agent_id: snapshot.agent_id.clone(),
            binding_generation: snapshot.binding_generation,
            revision: snapshot.revision,
            status: ReceiptStatus::Persisted,
            code: None,
            snapshot: Some(snapshot),
        };
        assert_eq!(
            s.record_receipt(&lease.lease_id, &g.scope, &receipt)
                .unwrap_err()
                .0,
            "LEASE_NOT_FOUND"
        );
        s.issue_lease(&lease, &intent, &lease.host_context, now)
            .unwrap();
        let saved = s
            .record_receipt(&lease.lease_id, &g.scope, &receipt)
            .unwrap();
        assert_eq!(saved.status, "host_confirmed");
        assert_eq!(
            s.record_receipt(&lease.lease_id, &g.scope, &receipt)
                .unwrap()
                .receipt,
            Some(receipt.clone())
        );
        receipt.status = ReceiptStatus::Failed;
        assert_eq!(
            s.record_receipt(&lease.lease_id, &g.scope, &receipt)
                .unwrap_err()
                .0,
            "HOST_RECEIPT_MISMATCH"
        );
    }
    #[test]
    fn symlink_and_unbound_state_are_refused() {
        let (dir, _, g, _, _, _) = fixture();
        let other = tempfile::tempdir().unwrap();
        fs::set_permissions(other.path(), fs::Permissions::from_mode(0o700)).unwrap();
        symlink(
            dir.path().join("execution.sqlite3"),
            other.path().join("execution.sqlite3"),
        )
        .unwrap();
        assert!(ExecutionStore::open(other.path(), InstancePin::from_scope(&g.scope)).is_err());
        let path = dir.path().join("execution.sqlite3");
        let c = Connection::open(&path).unwrap();
        c.execute("DELETE FROM execution_pin", []).unwrap();
        c.execute(
            "INSERT INTO owner_mutations VALUES('test','actor','{}','{}')",
            [],
        )
        .unwrap();
        drop(c);
        assert!(ExecutionStore::open(dir.path(), InstancePin::from_scope(&g.scope)).is_err());
    }
}
