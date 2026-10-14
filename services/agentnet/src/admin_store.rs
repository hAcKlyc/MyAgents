use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdminConfig {
    pub admin_principal_ids: Vec<String>,
    pub hosts: Vec<Resource>,
    pub model_refs: Vec<Resource>,
    pub max_daily_tokens: u64,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Resource {
    pub id: String,
    #[serde(alias = "label")]
    pub name: String,
    #[serde(default)]
    pub owner_ids: Vec<String>,
    pub runtimes: Vec<String>,
}
impl AdminConfig {
    /// Managed IDs shadow static references even when disabled. This projection
    /// changes model resources only; administrator, Host and quota owners stay intact.
    pub(crate) fn with_managed_models(
        &self,
        store: &crate::model_center_store::ModelCenterStore,
    ) -> Result<Self, crate::model_center_types::ModelCenterError> {
        let models = store.models()?;
        let providers = store.providers()?;
        let managed_ids = models
            .iter()
            .map(|model| model.config.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let mut config = self.clone();
        config
            .model_refs
            .retain(|resource| !managed_ids.contains(resource.id.as_str()));
        for model in models {
            if model.config.enabled
                && !model.config.owner_ids.is_empty()
                && providers.iter().any(|provider| {
                    provider.id == model.config.provider_id && provider.enabled && provider.has_key
                })
            {
                config.model_refs.push(Resource {
                    id: model.config.id,
                    name: model.config.label,
                    owner_ids: model.config.owner_ids,
                    runtimes: vec!["builtin".into()],
                });
            }
        }
        Ok(config)
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.admin_principal_ids.is_empty()
            || self.admin_principal_ids.len() > 128
            || self.max_daily_tokens == 0
            || i64::try_from(self.max_daily_tokens).is_err()
        {
            return Err("invalid administration config");
        }
        let mut admins = std::collections::HashSet::new();
        if self
            .admin_principal_ids
            .iter()
            .any(|id| Uuid::parse_str(id).is_err() || !admins.insert(id))
        {
            return Err("invalid administration config");
        }
        for list in [&self.hosts, &self.model_refs] {
            if list.len() > 256 {
                return Err("invalid administration resource");
            }
            let mut ids = std::collections::HashSet::new();
            for r in list {
                if Uuid::parse_str(&r.id).is_err()
                    || r.owner_ids.iter().any(|x| Uuid::parse_str(x).is_err())
                    || r.name.trim().is_empty()
                    || r.name.len() > 128
                    || !ids.insert(r.id.clone())
                    || r.runtimes.is_empty()
                    || r.runtimes.iter().any(|v| v != "builtin" && v != "codex")
                {
                    return Err("invalid administration resource");
                }
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bot {
    pub id: String,
    pub name: String,
    pub description: String,
    pub owner_id: String,
    pub host_id: String,
    pub runtime: String,
    pub model_ref: Option<String>,
    pub system_prompt: String,
    pub daily_tokens: u64,
    pub revision: u64,
    pub deleted: bool,
    pub state: String,
    pub configured: bool,
}
pub struct AdminStore {
    db: PathBuf,
}
static ADMIN_STORE_INIT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
impl AdminStore {
    pub fn open(dir: &Path, network_id: &str) -> Result<Self, &'static str> {
        let _init_guard = ADMIN_STORE_INIT_LOCK
            .lock()
            .map_err(|_| "admin storage unavailable")?;
        if !dir.is_absolute() {
            return Err("unsafe state path");
        }
        let md = fs::symlink_metadata(dir).map_err(|_| "unsafe state path")?;
        if !md.is_dir()
            || md.file_type().is_symlink()
            || md.mode() & 0o077 != 0
            || md.uid() != nix::unistd::Uid::effective().as_raw()
        {
            return Err("unsafe state path");
        }
        let dir = dir.canonicalize().map_err(|_| "unsafe state path")?;
        let db = dir.join("admin.sqlite3");
        if !db.exists() {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&db)
            {
                Ok(file) => drop(file),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err("admin storage unavailable"),
            }
        }
        verify(&db)?;
        let mut c = Connection::open_with_flags(
            &db,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NOFOLLOW
                | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
        )
        .map_err(|_| "admin storage unavailable")?;
        c.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "admin storage unavailable")?;
        c.pragma_update(None, "journal_mode", "WAL")
            .map_err(|_| "admin storage unavailable")?;
        c.pragma_update(None, "synchronous", "FULL")
            .map_err(|_| "admin storage unavailable")?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "admin storage unavailable")?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS bots(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,owner_id TEXT NOT NULL,host_id TEXT NOT NULL,runtime TEXT NOT NULL,model_ref TEXT,system_prompt TEXT NOT NULL,daily_tokens INTEGER NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL,state TEXT NOT NULL,configured INTEGER NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS active_bot_name ON bots(name COLLATE NOCASE) WHERE deleted=0; CREATE TABLE IF NOT EXISTS mutations(id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,body_hash BLOB NOT NULL,response TEXT NOT NULL); CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,bot_id TEXT,metadata TEXT NOT NULL,created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS service_pin(network_id TEXT NOT NULL);")
            .map_err(|_| "admin storage unavailable")?;
        let (pin_count, pin): (i64, Option<String>) = tx
            .query_row(
                "SELECT COUNT(*),MIN(network_id) FROM service_pin",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| "admin storage unavailable")?;
        if pin_count > 1 {
            return Err("admin state has multiple network bindings");
        }
        if let Some(saved) = pin {
            if saved != network_id {
                return Err("admin state belongs to another network");
            }
        } else {
            let records: i64 = tx
                .query_row(
                    "SELECT (SELECT COUNT(*) FROM bots) + (SELECT COUNT(*) FROM mutations) + (SELECT COUNT(*) FROM audit)",
                    [],
                    |r| r.get(0),
                )
                .map_err(|_| "admin storage unavailable")?;
            if records > 0 {
                return Err("unbound admin state contains records");
            }
            tx.execute(
                "INSERT INTO service_pin(network_id) VALUES(?1)",
                [network_id],
            )
            .map_err(|_| "admin storage unavailable")?;
        }
        tx.commit().map_err(|_| "admin storage unavailable")?;
        verify(&db)?;
        Ok(Self { db })
    }
    fn conn(&self) -> Result<Connection, &'static str> {
        verify(&self.db)?;
        let c = Connection::open_with_flags(
            &self.db,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NOFOLLOW
                | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
        )
        .map_err(|_| "admin storage unavailable")?;
        c.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "admin storage unavailable")?;
        c.pragma_update(None, "synchronous", "FULL")
            .map_err(|_| "admin storage unavailable")?;
        verify(&self.db)?;
        Ok(c)
    }
    pub fn bots(&self) -> Result<Vec<Bot>, &'static str> {
        let c = self.conn()?;
        let mut s=c.prepare("SELECT id,name,description,owner_id,host_id,runtime,model_ref,system_prompt,daily_tokens,revision,deleted,state,configured FROM bots ORDER BY name").map_err(|_|"admin storage unavailable")?;
        s.query_map([], row_bot)
            .map_err(|_| "admin storage unavailable")?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "admin storage unavailable")
    }
    pub fn audit(&self) -> Result<Vec<Value>, &'static str> {
        let c = self.conn()?;
        let mut s=c.prepare("SELECT actor,action,bot_id,metadata,created_at FROM audit ORDER BY id DESC LIMIT 200").map_err(|_|"admin storage unavailable")?;
        s.query_map([],|r|Ok(serde_json::json!({"actor":r.get::<_,String>(0)?,"action":r.get::<_,String>(1)?,"bot_id":r.get::<_,Option<String>>(2)?,"metadata":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap_or(Value::Null),"created_at":r.get::<_,i64>(4)?}))).map_err(|_|"admin storage unavailable")?.collect::<Result<Vec<_>,_>>().map_err(|_|"admin storage unavailable")
    }
    #[allow(clippy::too_many_arguments)]
    pub fn mutate(
        &self,
        actor: &str,
        action: &str,
        op: Uuid,
        body: &Value,
        expected: Option<u64>,
        config: &AdminConfig,
        registered: &[String],
    ) -> Result<Value, (&'static str, bool)> {
        let hash =
            Sha256::digest(serde_json::to_vec(body).map_err(|_| ("invalid request", false))?)
                .to_vec();
        let mut c = self.conn().map_err(|e| (e, false))?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| ("admin storage unavailable", false))?;
        if let Some((a, k, h, v)) = tx
            .query_row(
                "SELECT actor,action,body_hash,response FROM mutations WHERE id=?1",
                [op.to_string()],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Vec<u8>>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| ("admin storage unavailable", false))?
        {
            if a == actor && k == action && h == hash {
                return serde_json::from_str(&v).map_err(|_| ("admin storage unavailable", false));
            }
            return Err(("MUTATION_ID_CONFLICT", false));
        }
        let raw_id = body.get("id").and_then(Value::as_str).unwrap_or("");
        let allowed: &[&str] = match action {
            "create" => &[
                "id",
                "name",
                "description",
                "owner_id",
                "host_id",
                "runtime",
                "model_ref",
                "system_prompt",
                "daily_tokens",
                "revision",
                "deleted",
                "state",
                "configured",
                "expected_revision",
                "mutation_id",
            ],
            "configure" => &[
                "id",
                "name",
                "description",
                "runtime",
                "model_ref",
                "system_prompt",
                "daily_tokens",
                "expected_revision",
                "mutation_id",
                "configured",
            ],
            "assign" => &[
                "id",
                "owner_id",
                "host_id",
                "confirm_impact",
                "expected_revision",
                "mutation_id",
            ],
            "start" | "stop" => &["id", "expected_revision", "mutation_id"],
            "delete" => &["id", "confirm_name", "expected_revision", "mutation_id"],
            "restore" => &["id", "expected_revision", "mutation_id"],
            _ => return Err(("invalid request", false)),
        };
        if body
            .as_object()
            .is_none_or(|object| object.keys().any(|key| !allowed.contains(&key.as_str())))
        {
            return Err(("invalid request", false));
        }
        let valid_resource =
            |owner: &str, host: &str, runtime: &str, model: Option<&str>| -> bool {
                if !registered.iter().any(|id| id == owner)
                    || !["builtin", "codex"].contains(&runtime)
                {
                    return false;
                }
                if !config.hosts.iter().any(|item| {
                    item.id == host
                        && item.owner_ids.iter().any(|x| x == owner)
                        && item.runtimes.iter().any(|x| x == runtime)
                }) {
                    return false;
                }
                model.is_none_or(|id| {
                    config.model_refs.iter().any(|item| {
                        item.id == id
                            && item.owner_ids.iter().any(|x| x == owner)
                            && item.runtimes.iter().any(|x| x == runtime)
                    })
                })
            };
        let valid_fields =
            |description: &str, prompt: &str, daily: u64, model: Option<&str>| -> bool {
                description.len() <= 1024
                    && prompt.len() <= 4096
                    && daily > 0
                    && daily <= config.max_daily_tokens
                    && i64::try_from(daily).is_ok()
                    && model.is_none_or(|m| Uuid::parse_str(m).is_ok())
            };
        let result = match action {
            "create" => {
                let mut b: Bot =
                    serde_json::from_value(body.clone()).map_err(|_| ("invalid request", false))?;
                normalize_bot_name(&mut b.name);
                if !valid_bot_name(&b.name) {
                    return Err(("INVALID_BOT_NAME", false));
                }
                if !valid_fields(
                    &b.description,
                    &b.system_prompt,
                    b.daily_tokens,
                    b.model_ref.as_deref(),
                ) || !valid_resource(&b.owner_id, &b.host_id, &b.runtime, b.model_ref.as_deref())
                {
                    return Err(("RESOURCE_ASSIGNMENT_FORBIDDEN", false));
                }
                b.configured = b.model_ref.is_some() && !b.system_prompt.trim().is_empty();
                tx.execute(
                    "INSERT INTO bots VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,1,0,'stopped',?10)",
                    params![
                        b.id.to_string(),
                        b.name,
                        b.description,
                        b.owner_id.to_string(),
                        b.host_id.to_string(),
                        b.runtime,
                        b.model_ref.as_deref(),
                        b.system_prompt,
                        b.daily_tokens,
                        b.configured as i64
                    ],
                )
                .map_err(map_write_error)?;
                serde_json::to_value(b).unwrap()
            }
            "configure" => {
                let mut b = fetch(&tx, raw_id)?;
                if b.deleted {
                    return Err(("BOT_DELETED", false));
                }
                revision(expected, &b)?;
                for (k, v) in body.as_object().ok_or(("invalid request", false))? {
                    match k.as_str() {
                        "name" => b.name = v.as_str().ok_or(("invalid request", false))?.into(),
                        "description" => {
                            b.description = v.as_str().ok_or(("invalid request", false))?.into()
                        }
                        "runtime" => {
                            b.runtime = v.as_str().ok_or(("invalid request", false))?.into()
                        }
                        "system_prompt" => {
                            b.system_prompt = v.as_str().ok_or(("invalid request", false))?.into()
                        }
                        "daily_tokens" => {
                            b.daily_tokens = v.as_u64().ok_or(("invalid request", false))?
                        }
                        "model_ref" => {
                            b.model_ref = if v.is_null() {
                                None
                            } else {
                                Some(
                                    Uuid::parse_str(v.as_str().ok_or(("invalid request", false))?)
                                        .map_err(|_| ("invalid request", false))?
                                        .to_string(),
                                )
                            }
                        }
                        "id" | "mutation_id" | "expected_revision" | "configured" => {}
                        _ => return Err(("invalid request", false)),
                    }
                }
                normalize_bot_name(&mut b.name);
                if !valid_bot_name(&b.name) {
                    return Err(("INVALID_BOT_NAME", false));
                }
                if !valid_fields(
                    &b.description,
                    &b.system_prompt,
                    b.daily_tokens,
                    b.model_ref.as_deref(),
                ) || !valid_resource(&b.owner_id, &b.host_id, &b.runtime, b.model_ref.as_deref())
                {
                    return Err(("RESOURCE_ASSIGNMENT_FORBIDDEN", false));
                }
                b.configured = b.model_ref.is_some() && !b.system_prompt.trim().is_empty();
                b.revision += 1;
                save(&tx, &b)?;
                serde_json::to_value(b).unwrap()
            }
            "assign" => {
                let mut b = fetch(&tx, raw_id)?;
                if b.deleted {
                    return Err(("BOT_DELETED", false));
                }
                revision(expected, &b)?;
                if body["confirm_impact"] != true {
                    return Err(("IMPACT_CONFIRMATION_REQUIRED", false));
                }
                let owner = Uuid::parse_str(
                    body["owner_id"]
                        .as_str()
                        .ok_or(("invalid request", false))?,
                )
                .map_err(|_| ("invalid request", false))?
                .to_string();
                let host =
                    Uuid::parse_str(body["host_id"].as_str().ok_or(("invalid request", false))?)
                        .map_err(|_| ("invalid request", false))?
                        .to_string();
                if !valid_resource(&owner, &host, &b.runtime, None) {
                    return Err(("RESOURCE_ASSIGNMENT_FORBIDDEN", false));
                }
                if owner != b.owner_id || host != b.host_id {
                    b.owner_id = owner;
                    b.host_id = host;
                    b.model_ref = None;
                    b.system_prompt.clear();
                    b.configured = false;
                    b.state = "stopped".into();
                    b.revision += 1;
                    save(&tx, &b)?
                }
                serde_json::to_value(b).unwrap()
            }
            "start" | "stop" => {
                let mut b = fetch(&tx, raw_id)?;
                if b.deleted {
                    return Err(("BOT_DELETED", false));
                }
                revision(expected, &b)?;
                if action == "start" {
                    return Err(("HOST_EXECUTION_NOT_CONNECTED", false));
                }
                if b.state != "stopped" {
                    b.state = "stopped".into();
                    b.revision += 1;
                    save(&tx, &b)?
                }
                serde_json::to_value(b).unwrap()
            }
            "delete" | "restore" => {
                let mut b = fetch(&tx, raw_id)?;
                revision(expected, &b)?;
                if (action == "delete" && b.deleted) || (action == "restore" && !b.deleted) {
                    return Err(("BOT_STATE_CONFLICT", false));
                }
                if action == "delete" && body["confirm_name"].as_str() != Some(&b.name) {
                    return Err(("NAME_CONFIRMATION_REQUIRED", false));
                }
                if action == "restore"
                    && (!valid_resource(
                        &b.owner_id,
                        &b.host_id,
                        &b.runtime,
                        b.model_ref.as_deref(),
                    ) || !valid_bot_name(&b.name)
                        || !valid_fields(
                            &b.description,
                            &b.system_prompt,
                            b.daily_tokens,
                            b.model_ref.as_deref(),
                        ))
                {
                    return Err(("RESOURCE_ASSIGNMENT_FORBIDDEN", false));
                }
                b.deleted = action == "delete";
                b.state = "stopped".into();
                b.revision += 1;
                save(&tx, &b)?;
                serde_json::to_value(b).unwrap()
            }
            _ => return Err(("invalid action", false)),
        };
        let bid = result.get("id").and_then(Value::as_str);
        let meta = serde_json::json!({"mutation_id":op.to_string(),"revision":result.get("revision"),"state":result.get("state"),"deleted":result.get("deleted")});
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        tx.execute(
            "INSERT INTO audit(actor,action,bot_id,metadata,created_at) VALUES(?1,?2,?3,?4,?5)",
            params![actor, action, bid, meta.to_string(), now],
        )
        .map_err(|_| ("admin storage unavailable", false))?;
        tx.execute(
            "INSERT INTO mutations VALUES(?1,?2,?3,?4,?5)",
            params![op.to_string(), actor, action, hash, result.to_string()],
        )
        .map_err(|_| ("admin storage unavailable", false))?;
        tx.commit()
            .map_err(|_| ("admin storage unavailable", false))?;
        Ok(result)
    }
    pub fn mutation(&self, id: Uuid, actor: &str) -> Result<Value, &'static str> {
        let c = self.conn()?;
        let s = c
            .query_row(
                "SELECT response FROM mutations WHERE id=?1 AND actor=?2",
                params![id.to_string(), actor],
                |r| r.get::<_, String>(0),
            )
            .map_err(|_| "mutation not found")?;
        serde_json::from_str(&s).map_err(|_| "admin storage unavailable")
    }
}
fn revision(expected: Option<u64>, b: &Bot) -> Result<(), (&'static str, bool)> {
    if expected == Some(b.revision) {
        Ok(())
    } else {
        Err(("REVISION_CONFLICT", false))
    }
}
fn normalize_bot_name(name: &mut String) {
    *name = name.trim().to_owned();
}
fn valid_bot_name(name: &str) -> bool {
    name.trim() == name && (1..=60).contains(&name.chars().count())
}
fn fetch(tx: &rusqlite::Transaction<'_>, id: &str) -> Result<Bot, (&'static str, bool)> {
    let id = Uuid::parse_str(id).map_err(|_| ("invalid request", false))?;
    tx.query_row("SELECT id,name,description,owner_id,host_id,runtime,model_ref,system_prompt,daily_tokens,revision,deleted,state,configured FROM bots WHERE id=?1",[id.to_string()],row_bot).optional().map_err(|_|("admin storage unavailable",false))?.ok_or(("BOT_NOT_FOUND",false))
}
fn save(tx: &rusqlite::Transaction<'_>, b: &Bot) -> Result<(), (&'static str, bool)> {
    tx.execute("UPDATE bots SET name=?2,description=?3,owner_id=?4,host_id=?5,runtime=?6,model_ref=?7,system_prompt=?8,daily_tokens=?9,revision=?10,deleted=?11,state=?12,configured=?13 WHERE id=?1",params![b.id.to_string(),b.name,b.description,b.owner_id.to_string(),b.host_id.to_string(),b.runtime,b.model_ref.as_deref(),b.system_prompt,b.daily_tokens,b.revision,b.deleted as i64,b.state,b.configured as i64]).map_err(map_write_error)?;
    Ok(())
}
fn map_write_error(error: rusqlite::Error) -> (&'static str, bool) {
    if matches!(
        error,
        rusqlite::Error::SqliteFailure(ref e, _)
            if e.code == rusqlite::ErrorCode::ConstraintViolation
    ) {
        ("BOT_NAME_CONFLICT", false)
    } else {
        ("admin storage unavailable", false)
    }
}
fn row_bot(r: &rusqlite::Row<'_>) -> rusqlite::Result<Bot> {
    Ok(Bot {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        owner_id: r.get(3)?,
        host_id: r.get(4)?,
        runtime: r.get(5)?,
        model_ref: r.get(6)?,
        system_prompt: r.get(7)?,
        daily_tokens: r.get::<_, i64>(8)? as u64,
        revision: r.get::<_, i64>(9)? as u64,
        deleted: r.get::<_, i64>(10)? != 0,
        state: r.get(11)?,
        configured: r.get::<_, i64>(12)? != 0,
    })
}
fn verify(p: &Path) -> Result<(), &'static str> {
    let m = fs::symlink_metadata(p).map_err(|_| "unsafe admin database")?;
    if !m.file_type().is_file()
        || m.nlink() != 1
        || m.mode() & 0o077 != 0
        || m.uid() != nix::unistd::Uid::effective().as_raw()
    {
        return Err("unsafe admin database");
    }
    let f = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(p)
        .map_err(|_| "unsafe admin database")?;
    let o = f.metadata().map_err(|_| "unsafe admin database")?;
    if o.dev() != m.dev() || o.ino() != m.ino() || o.nlink() != 1 || o.mode() & 0o077 != 0 {
        return Err("unsafe admin database");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{Arc, Barrier};
    use tempfile::TempDir;
    fn store() -> (AdminStore, TempDir) {
        let d = tempfile::tempdir().unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(d.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let s = AdminStore::open(d.path(), "11111111-1111-4111-8111-111111111111").unwrap();
        (s, d)
    }
    fn policy() -> AdminConfig {
        AdminConfig {
            admin_principal_ids: vec![],
            hosts: vec![Resource {
                id: "22222222-2222-4222-8222-222222222222".into(),
                name: "host".into(),
                owner_ids: vec!["11111111-1111-4111-8111-111111111111".into()],
                runtimes: vec!["builtin".into()],
            }],
            model_refs: vec![],
            max_daily_tokens: 1000,
        }
    }
    fn users() -> Vec<String> {
        vec!["11111111-1111-4111-8111-111111111111".into()]
    }
    fn create(op: Uuid) -> Value {
        serde_json::json!({"id":op.to_string(),"name":"draft","description":"","owner_id":"11111111-1111-4111-8111-111111111111","host_id":"22222222-2222-4222-8222-222222222222","runtime":"builtin","model_ref":null,"system_prompt":"","daily_tokens":100,"revision":1,"deleted":false,"state":"stopped","configured":false,"expected_revision":0,"mutation_id":op.to_string()})
    }
    fn create_named(op: Uuid, name: &str) -> Value {
        let mut body = create(op);
        body["name"] = Value::String(name.to_owned());
        body
    }
    #[test]
    fn create_replay_compare_and_restart_persist() {
        let (s, d) = store();
        let op = Uuid::new_v4();
        let b = create(op);
        let policy = policy();
        let users = users();
        let first = s
            .mutate("actor", "create", op, &b, None, &policy, &users)
            .unwrap();
        assert_eq!(first["state"], "stopped");
        assert_eq!(
            s.mutate("actor", "create", op, &b, None, &policy, &users)
                .unwrap(),
            first
        );
        assert_eq!(
            s.mutate("other", "create", op, &b, None, &policy, &users)
                .unwrap_err()
                .0,
            "MUTATION_ID_CONFLICT"
        );
        let id = first["id"].as_str().unwrap();
        let op2 = Uuid::new_v4();
        let conf = serde_json::json!({"id":id.to_string(),"mutation_id":op2.to_string(),"expected_revision":1,"system_prompt":"private instructions","configured":true});
        let changed = s
            .mutate("actor", "configure", op2, &conf, Some(1), &policy, &users)
            .unwrap();
        assert_eq!(changed["revision"], 2);
        assert_eq!(changed["system_prompt"], "private instructions");
        assert_eq!(
            s.mutate(
                "actor",
                "configure",
                Uuid::new_v4(),
                &conf,
                Some(1),
                &policy,
                &users
            )
            .unwrap_err()
            .0,
            "REVISION_CONFLICT"
        );
        drop(s);
        let again = AdminStore::open(d.path(), "11111111-1111-4111-8111-111111111111").unwrap();
        assert_eq!(again.bots().unwrap()[0].revision, 2)
    }
    #[test]
    fn start_is_never_claimed_and_delete_restore_name_conflict() {
        let (s, _d) = store();
        let op = Uuid::new_v4();
        let b = create(op);
        let policy = policy();
        let users = users();
        let created = s
            .mutate("actor", "create", op, &b, None, &policy, &users)
            .unwrap();
        let id = created["id"].as_str().unwrap();
        let start = serde_json::json!({"id":id.to_string(),"mutation_id":Uuid::new_v4().to_string(),"expected_revision":1});
        assert_eq!(
            s.mutate(
                "actor",
                "start",
                Uuid::new_v4(),
                &start,
                Some(1),
                &policy,
                &users
            )
            .unwrap_err()
            .0,
            "HOST_EXECUTION_NOT_CONNECTED"
        );
        let del = serde_json::json!({"id":id.to_string(),"mutation_id":Uuid::new_v4().to_string(),"expected_revision":1,"confirm_name":"draft"});
        let removed = s
            .mutate(
                "actor",
                "delete",
                Uuid::parse_str(del["mutation_id"].as_str().unwrap()).unwrap(),
                &del,
                Some(1),
                &policy,
                &users,
            )
            .unwrap();
        assert_eq!(removed["deleted"], true);
        let restore = serde_json::json!({"id":id.to_string(),"mutation_id":Uuid::new_v4().to_string(),"expected_revision":2});
        assert_eq!(
            s.mutate(
                "actor",
                "restore",
                Uuid::parse_str(restore["mutation_id"].as_str().unwrap()).unwrap(),
                &restore,
                Some(2),
                &policy,
                &users
            )
            .unwrap()["state"],
            "stopped"
        )
    }

    #[test]
    fn network_pin_rejects_wrong_or_missing_binding_for_nonempty_state() {
        let (store, dir) = store();
        let op = Uuid::new_v4();
        let body = create(op);
        store
            .mutate("actor", "create", op, &body, None, &policy(), &users())
            .unwrap();
        drop(store);
        assert!(AdminStore::open(dir.path(), "33333333-3333-4333-8333-333333333333").is_err());
        let connection = Connection::open(dir.path().join("admin.sqlite3")).unwrap();
        connection.execute("DELETE FROM bots", []).unwrap();
        connection.execute("DELETE FROM service_pin", []).unwrap();
        drop(connection);
        assert!(AdminStore::open(dir.path(), "11111111-1111-4111-8111-111111111111").is_err());
        let connection = Connection::open(dir.path().join("admin.sqlite3")).unwrap();
        connection.execute("DELETE FROM mutations", []).unwrap();
        connection.execute("DELETE FROM audit", []).unwrap();
        connection
            .execute(
                "INSERT INTO service_pin(network_id) VALUES('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222')",
                [],
            )
            .unwrap();
        drop(connection);
        assert!(AdminStore::open(dir.path(), "11111111-1111-4111-8111-111111111111").is_err());
    }

    #[test]
    fn bot_names_trim_and_enforce_sixty_unicode_scalars_on_create_and_configure() {
        let (store, _dir) = store();
        let policy = policy();
        let users = users();

        let op = Uuid::new_v4();
        let body = create_named(op, "  Alpha  ");
        let created = store
            .mutate("actor", "create", op, &body, None, &policy, &users)
            .unwrap();
        assert_eq!(created["name"], "Alpha");
        assert_eq!(
            store
                .mutate("actor", "create", op, &body, None, &policy, &users)
                .unwrap(),
            created,
            "idempotent replay hashes the original untrimmed request body"
        );
        let normalized_replay = create_named(op, "Alpha");
        assert_eq!(
            store
                .mutate(
                    "actor",
                    "create",
                    op,
                    &normalized_replay,
                    None,
                    &policy,
                    &users
                )
                .unwrap_err()
                .0,
            "MUTATION_ID_CONFLICT"
        );

        let op_60 = Uuid::new_v4();
        let sixty_cjk = "界".repeat(60);
        let created_60 = store
            .mutate(
                "actor",
                "create",
                op_60,
                &create_named(op_60, &sixty_cjk),
                None,
                &policy,
                &users,
            )
            .unwrap();
        assert_eq!(created_60["name"].as_str().unwrap().chars().count(), 60);

        let op_61 = Uuid::new_v4();
        assert_eq!(
            store
                .mutate(
                    "actor",
                    "create",
                    op_61,
                    &create_named(op_61, &"P".repeat(61)),
                    None,
                    &policy,
                    &users,
                )
                .unwrap_err()
                .0,
            "INVALID_BOT_NAME"
        );
        let whitespace_op = Uuid::new_v4();
        assert_eq!(
            store
                .mutate(
                    "actor",
                    "create",
                    whitespace_op,
                    &create_named(whitespace_op, " \t\n "),
                    None,
                    &policy,
                    &users
                )
                .unwrap_err()
                .0,
            "INVALID_BOT_NAME"
        );

        let configure_id = created["id"].as_str().unwrap();
        let config_op = Uuid::new_v4();
        let too_long = serde_json::json!({"id":configure_id,"mutation_id":config_op.to_string(),"expected_revision":1,"name":"Q".repeat(61)});
        assert_eq!(
            store
                .mutate(
                    "actor",
                    "configure",
                    config_op,
                    &too_long,
                    Some(1),
                    &policy,
                    &users
                )
                .unwrap_err()
                .0,
            "INVALID_BOT_NAME"
        );
        let trim_op = Uuid::new_v4();
        let normalized = store
            .mutate(
                "actor",
                "configure",
                trim_op,
                &serde_json::json!({"id":configure_id,"mutation_id":trim_op.to_string(),"expected_revision":1,"name":"  Beta  "}),
                Some(1),
                &policy,
                &users,
            )
            .unwrap();
        assert_eq!(normalized["name"], "Beta");
        let cjk_op = Uuid::new_v4();
        let sixty_other_cjk = format!("{}号", "界".repeat(59));
        let cjk_configured = store
            .mutate(
                "actor",
                "configure",
                cjk_op,
                &serde_json::json!({"id":configure_id,"mutation_id":cjk_op.to_string(),"expected_revision":2,"name":sixty_other_cjk}),
                Some(2),
                &policy,
                &users,
            )
            .unwrap();
        assert_eq!(cjk_configured["name"].as_str().unwrap().chars().count(), 60);

        let duplicate_op = Uuid::new_v4();
        store
            .mutate(
                "actor",
                "create",
                duplicate_op,
                &create_named(duplicate_op, "  duplicate  "),
                None,
                &policy,
                &users,
            )
            .unwrap();
        let duplicate_after_trim = Uuid::new_v4();
        assert_eq!(
            store
                .mutate(
                    "actor",
                    "create",
                    duplicate_after_trim,
                    &create_named(duplicate_after_trim, "duplicate"),
                    None,
                    &policy,
                    &users,
                )
                .unwrap_err()
                .0,
            "BOT_NAME_CONFLICT"
        );
    }

    #[test]
    fn policy_rejects_duplicate_admins_and_unknown_runtime() {
        let mut config = policy();
        config.admin_principal_ids = vec![
            "11111111-1111-4111-8111-111111111111".into(),
            "11111111-1111-4111-8111-111111111111".into(),
        ];
        assert!(config.validate().is_err());
        config.admin_principal_ids.pop();
        config.hosts[0].runtimes = vec!["anything".into()];
        assert!(config.validate().is_err());
    }

    #[test]
    fn concurrent_first_open_serializes_schema_and_creates_one_network_pin() {
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let path = dir.path().to_path_buf();
        let barrier = Arc::new(Barrier::new(8));
        let workers = (0..8)
            .map(|_| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    AdminStore::open(&path, "11111111-1111-4111-8111-111111111111")
                })
            })
            .collect::<Vec<_>>();
        for worker in workers {
            worker.join().unwrap().unwrap();
        }
        let connection = Connection::open(path.join("admin.sqlite3")).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM service_pin", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
