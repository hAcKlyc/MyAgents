//! The cloud service owns feedback, its immutable history and mutation receipts.
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const STORAGE: &str = "FEEDBACK_STORAGE_UNAVAILABLE";
static INIT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Feedback {
    pub id: String,
    pub principal_id: String,
    pub title: String,
    pub description: String,
    pub category: String,
    pub app_version: Option<String>,
    pub status: String,
    pub revision: u64,
    pub created_at: i64,
    pub updated_at: i64,
    pub events: Vec<FeedbackEvent>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FeedbackEvent {
    pub id: String,
    pub actor_id: String,
    pub kind: String,
    pub status: Option<String>,
    pub reply: Option<String>,
    pub created_at: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateRequest {
    mutation_id: String,
    title: String,
    description: String,
    category: String,
    #[serde(default)]
    app_version: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateRequest {
    mutation_id: String,
    expected_revision: u64,
    status: String,
    #[serde(default)]
    reply: Option<String>,
}
pub struct FeedbackStore {
    db: PathBuf,
    network_id: String,
}
impl FeedbackStore {
    pub fn open(dir: &Path, network_id: &str) -> Result<Self, &'static str> {
        let _init = INIT_LOCK.lock().map_err(|_| STORAGE)?;
        if !dir.is_absolute() || Uuid::parse_str(network_id).is_err() {
            return Err(STORAGE);
        }
        let md = fs::symlink_metadata(dir).map_err(|_| STORAGE)?;
        if !md.is_dir()
            || md.file_type().is_symlink()
            || md.mode() & 0o077 != 0
            || md.uid() != nix::unistd::Uid::effective().as_raw()
        {
            return Err(STORAGE);
        }
        let db = dir
            .canonicalize()
            .map_err(|_| STORAGE)?
            .join("feedback.sqlite3");
        if !db.exists() {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&db)
            {
                Ok(file) => drop(file),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err(STORAGE),
            }
        }
        let mut c = connection(&db)?;
        // DELETE journals keep this store's backup unit a single durable database.
        c.pragma_update(None, "journal_mode", "DELETE")
            .map_err(|_| STORAGE)?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| STORAGE)?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS feedback (
            id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, title TEXT NOT NULL,
            description TEXT NOT NULL, category TEXT NOT NULL CHECK(category IN ('bug','suggestion','help')),
            app_version TEXT, status TEXT NOT NULL CHECK(status IN ('new','in_progress','resolved')),
            revision INTEGER NOT NULL CHECK(revision > 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS feedback_owner_created ON feedback(principal_id,created_at DESC,id DESC);
            CREATE TABLE IF NOT EXISTS feedback_events (
                sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, feedback_id TEXT NOT NULL REFERENCES feedback(id),
                actor_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('created','status','reply')),
                status TEXT, reply TEXT, created_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS feedback_event_order ON feedback_events(feedback_id,sequence);
            CREATE TRIGGER IF NOT EXISTS feedback_events_no_update BEFORE UPDATE ON feedback_events BEGIN SELECT RAISE(ABORT,'immutable feedback history'); END;
            CREATE TRIGGER IF NOT EXISTS feedback_events_no_delete BEFORE DELETE ON feedback_events BEGIN SELECT RAISE(ABORT,'immutable feedback history'); END;
            CREATE TABLE IF NOT EXISTS feedback_mutations (
                actor_id TEXT NOT NULL, mutation_id TEXT NOT NULL, body_hash BLOB NOT NULL, response TEXT NOT NULL,
                PRIMARY KEY(actor_id,mutation_id));
            CREATE TABLE IF NOT EXISTS feedback_service_pin(network_id TEXT NOT NULL);")
            .map_err(|_| STORAGE)?;
        let (count, pin): (i64, Option<String>) = tx
            .query_row(
                "SELECT COUNT(*),MIN(network_id) FROM feedback_service_pin",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| STORAGE)?;
        if count > 1 || pin.as_ref().is_some_and(|saved| saved != network_id) {
            return Err(STORAGE);
        }
        if pin.is_none() {
            let rows: i64 = tx.query_row("SELECT (SELECT COUNT(*) FROM feedback)+(SELECT COUNT(*) FROM feedback_events)+(SELECT COUNT(*) FROM feedback_mutations)", [], |r| r.get(0)).map_err(|_| STORAGE)?;
            if rows != 0 {
                return Err(STORAGE);
            }
            tx.execute(
                "INSERT INTO feedback_service_pin(network_id) VALUES(?1)",
                [network_id],
            )
            .map_err(|_| STORAGE)?;
        }
        tx.commit().map_err(|_| STORAGE)?;
        verify(&db)?;
        Ok(Self {
            db,
            network_id: network_id.to_owned(),
        })
    }
    fn conn(&self) -> Result<Connection, &'static str> {
        let c = connection(&self.db)?;
        let (count, pin): (i64, Option<String>) = c
            .query_row(
                "SELECT COUNT(*),MIN(network_id) FROM feedback_service_pin",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| STORAGE)?;
        if count != 1 || pin.as_deref() != Some(&self.network_id) {
            return Err(STORAGE);
        }
        Ok(c)
    }
    pub fn list(&self, actor: &str, admin: bool) -> Result<Vec<Feedback>, &'static str> {
        let mut c = self.conn()?;
        let tx = c.transaction().map_err(|_| STORAGE)?;
        let mut s = tx.prepare("SELECT id FROM feedback WHERE ?1 OR principal_id=?2 ORDER BY created_at DESC,id DESC LIMIT 100").map_err(|_| STORAGE)?;
        let ids = s
            .query_map(params![admin, actor], |r| r.get::<_, String>(0))
            .map_err(|_| STORAGE)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| STORAGE)?;
        ids.into_iter().map(|id| load(&tx, &id)).collect()
    }
    pub fn get(&self, id: &str, actor: &str, admin: bool) -> Result<Feedback, &'static str> {
        let mut c = self.conn()?;
        let tx = c.transaction().map_err(|_| STORAGE)?;
        permitted(&tx, id, actor, admin)?;
        load(&tx, id)
    }
    pub fn create(&self, actor: &str, body: &Value) -> Result<Feedback, &'static str> {
        let req: CreateRequest =
            serde_json::from_value(body.clone()).map_err(|_| "REQUEST_INVALID")?;
        let op = uuid(&req.mutation_id)?;
        text(&req.title, 1, 120)?;
        text(&req.description, 1, 8000)?;
        if !matches!(req.category.as_str(), "bug" | "suggestion" | "help") {
            return Err("REQUEST_INVALID");
        }
        if let Some(version) = &req.app_version {
            text(version, 0, 64)?;
        }
        let hash = body_hash("create", None, body)?;
        let mut c = self.conn()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| STORAGE)?;
        if let Some(result) = replay(&tx, actor, &op, &hash)? {
            return Ok(result);
        }
        let id = Uuid::new_v4().to_string();
        let now = now()?;
        tx.execute("INSERT INTO feedback(id,principal_id,title,description,category,app_version,status,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'new',1,?7,?7)", params![id,actor,req.title.trim(),req.description.trim(),req.category,req.app_version,now]).map_err(|_| STORAGE)?;
        event(&tx, &id, actor, "created", Some("new"), None, now)?;
        let result = load(&tx, &id)?;
        receipt(&tx, actor, &op, &hash, &result)?;
        tx.commit().map_err(|_| STORAGE)?;
        Ok(result)
    }
    pub fn update(&self, id: &str, actor: &str, body: &Value) -> Result<Feedback, &'static str> {
        uuid(id)?;
        let req: UpdateRequest =
            serde_json::from_value(body.clone()).map_err(|_| "REQUEST_INVALID")?;
        let op = uuid(&req.mutation_id)?;
        if req.expected_revision == 0
            || req.expected_revision >= i64::MAX as u64
            || !matches!(req.status.as_str(), "new" | "in_progress" | "resolved")
        {
            return Err("REQUEST_INVALID");
        }
        if let Some(reply) = &req.reply {
            text(reply, 0, 4000)?;
        }
        let hash = body_hash("update", Some(id), body)?;
        let mut c = self.conn()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| STORAGE)?;
        if let Some(result) = replay(&tx, actor, &op, &hash)? {
            return Ok(result);
        }
        let original = load(&tx, id)?;
        if original.revision != req.expected_revision {
            return Err("REVISION_CONFLICT");
        }
        let reply = req
            .reply
            .as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty());
        if original.status == req.status && reply.is_none() {
            return Err("REQUEST_INVALID");
        }
        let now = now()?;
        let changed = tx.execute("UPDATE feedback SET status=?1,revision=revision+1,updated_at=?2 WHERE id=?3 AND revision=?4",params![req.status,now,id,req.expected_revision]).map_err(|_| STORAGE)?;
        if changed != 1 {
            return Err("REVISION_CONFLICT");
        }
        if original.status != req.status {
            event(&tx, id, actor, "status", Some(&req.status), None, now)?;
        }
        if let Some(reply) = reply {
            event(&tx, id, actor, "reply", Some(&req.status), Some(reply), now)?;
        }
        let result = load(&tx, id)?;
        receipt(&tx, actor, &op, &hash, &result)?;
        tx.commit().map_err(|_| STORAGE)?;
        Ok(result)
    }
}
fn uuid(s: &str) -> Result<String, &'static str> {
    Uuid::parse_str(s)
        .map(|v| v.to_string())
        .map_err(|_| "REQUEST_INVALID")
}
fn text(s: &str, min: usize, max: usize) -> Result<(), &'static str> {
    let n = s.chars().count();
    if n < min || n > max || (min > 0 && s.trim().is_empty()) || s.contains('\0') {
        Err("REQUEST_INVALID")
    } else {
        Ok(())
    }
}
fn now() -> Result<i64, &'static str> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .map_err(|_| STORAGE)
}
fn body_hash(action: &str, target: Option<&str>, body: &Value) -> Result<Vec<u8>, &'static str> {
    let bytes = serde_json::to_vec(&(action, target, body)).map_err(|_| "REQUEST_INVALID")?;
    Ok(Sha256::digest(bytes).to_vec())
}
fn replay(
    c: &Connection,
    actor: &str,
    op: &str,
    hash: &[u8],
) -> Result<Option<Feedback>, &'static str> {
    let row: Option<(Vec<u8>,String)> = c.query_row("SELECT body_hash,response FROM feedback_mutations WHERE actor_id=?1 AND mutation_id=?2",params![actor,op], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_| STORAGE)?;
    match row {
        Some((saved, response)) if saved == hash => serde_json::from_str(&response)
            .map(Some)
            .map_err(|_| STORAGE),
        Some(_) => Err("MUTATION_CONFLICT"),
        None => Ok(None),
    }
}
fn receipt(
    c: &Connection,
    actor: &str,
    op: &str,
    hash: &[u8],
    result: &Feedback,
) -> Result<(), &'static str> {
    let response = serde_json::to_string(result).map_err(|_| STORAGE)?;
    c.execute("INSERT INTO feedback_mutations(actor_id,mutation_id,body_hash,response) VALUES(?1,?2,?3,?4)",params![actor,op,hash,response]).map(|_| ()).map_err(|_| STORAGE)
}
fn event(
    c: &Connection,
    id: &str,
    actor: &str,
    kind: &str,
    status: Option<&str>,
    reply: Option<&str>,
    now: i64,
) -> Result<(), &'static str> {
    c.execute("INSERT INTO feedback_events(id,feedback_id,actor_id,kind,status,reply,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![Uuid::new_v4().to_string(),id,actor,kind,status,reply,now]).map(|_|()).map_err(|_| STORAGE)
}
fn permitted(c: &Connection, id: &str, actor: &str, admin: bool) -> Result<(), &'static str> {
    let allowed = c
        .query_row(
            "SELECT 1 FROM feedback WHERE id=?1 AND (?2 OR principal_id=?3)",
            params![id, admin, actor],
            |_| Ok(()),
        )
        .optional()
        .map_err(|_| STORAGE)?;
    allowed.ok_or("FEEDBACK_NOT_FOUND")
}
fn load(c: &Connection, id: &str) -> Result<Feedback, &'static str> {
    let mut row = c.query_row("SELECT id,principal_id,title,description,category,app_version,status,revision,created_at,updated_at FROM feedback WHERE id=?1",[id], |r| Ok(Feedback {id:r.get(0)?,principal_id:r.get(1)?,title:r.get(2)?,description:r.get(3)?,category:r.get(4)?,app_version:r.get(5)?,status:r.get(6)?,revision:r.get(7)?,created_at:r.get(8)?,updated_at:r.get(9)?,events:vec![]})).optional().map_err(|_| STORAGE)?.ok_or("FEEDBACK_NOT_FOUND")?;
    let mut s = c.prepare("SELECT id,actor_id,kind,status,reply,created_at FROM feedback_events WHERE feedback_id=?1 ORDER BY sequence").map_err(|_| STORAGE)?;
    row.events = s
        .query_map([id], |r| {
            Ok(FeedbackEvent {
                id: r.get(0)?,
                actor_id: r.get(1)?,
                kind: r.get(2)?,
                status: r.get(3)?,
                reply: r.get(4)?,
                created_at: r.get(5)?,
            })
        })
        .map_err(|_| STORAGE)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| STORAGE)?;
    Ok(row)
}
fn connection(db: &Path) -> Result<Connection, &'static str> {
    verify(db)?;
    let c = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NOFOLLOW
            | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
    )
    .map_err(|_| STORAGE)?;
    c.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| STORAGE)?;
    c.pragma_update(None, "synchronous", "FULL")
        .map_err(|_| STORAGE)?;
    c.pragma_update(None, "foreign_keys", true)
        .map_err(|_| STORAGE)?;
    verify(db)?;
    Ok(c)
}
fn verify(path: &Path) -> Result<(), &'static str> {
    let before = fs::symlink_metadata(path).map_err(|_| STORAGE)?;
    if !before.is_file()
        || before.file_type().is_symlink()
        || before.nlink() != 1
        || before.mode() & 0o777 != 0o600
        || before.uid() != nix::unistd::Uid::effective().as_raw()
    {
        return Err(STORAGE);
    }
    let f = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| STORAGE)?;
    let after = f.metadata().map_err(|_| STORAGE)?;
    if after.dev() != before.dev()
        || after.ino() != before.ino()
        || after.nlink() != 1
        || after.mode() & 0o777 != 0o600
    {
        return Err(STORAGE);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        os::unix::fs::PermissionsExt,
        sync::{Arc, Barrier},
    };
    const NETWORK: &str = "11111111-1111-4111-8111-111111111111";
    fn setup() -> (FeedbackStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        (FeedbackStore::open(dir.path(), NETWORK).unwrap(), dir)
    }
    fn create_body() -> Value {
        json!({"mutation_id":Uuid::new_v4().to_string(),"title":"费用包编辑反馈","description":"保存费用包后未显示新金额，请检查。","category":"bug","app_version":"0.1.0"})
    }
    #[test]
    fn feedback_persists_history_and_replays_original_results_per_actor() {
        let (s, dir) = setup();
        let body = create_body();
        let row = s.create("user-a", &body).unwrap();
        assert_eq!(s.create("user-a", &body).unwrap(), row);
        let second = s.create("user-b", &body).unwrap();
        assert_ne!(row.id, second.id);
        let update = json!({"mutation_id":Uuid::new_v4().to_string(),"expected_revision":1,"status":"in_progress","reply":"已收到，正在处理。"});
        let updated = s.update(&row.id, "admin", &update).unwrap();
        assert_eq!(updated.revision, 2);
        assert_eq!(updated.events.len(), 3);
        let reopened = FeedbackStore::open(dir.path(), NETWORK).unwrap();
        assert_eq!(reopened.get(&row.id, "user-a", false).unwrap(), updated);
        assert_eq!(reopened.create("user-a", &body).unwrap(), row);
        assert_eq!(reopened.update(&row.id, "admin", &update).unwrap(), updated);
        let mut changed = update.clone();
        changed["reply"] = json!("不同回复");
        assert_eq!(
            reopened.update(&row.id, "admin", &changed).unwrap_err(),
            "MUTATION_CONFLICT"
        );
        let mut altered_create = body.clone();
        altered_create["description"] = json!("改变原始内容");
        assert_eq!(
            reopened.create("user-a", &altered_create).unwrap_err(),
            "MUTATION_CONFLICT"
        );
        assert_eq!(
            reopened.get(&row.id, "user-b", false).unwrap_err(),
            "FEEDBACK_NOT_FOUND"
        );
        assert_eq!(
            reopened
                .get(&Uuid::new_v4().to_string(), "user-b", false)
                .unwrap_err(),
            "FEEDBACK_NOT_FOUND"
        );
        assert_eq!(reopened.list("user-a", false).unwrap().len(), 1);
        assert_eq!(reopened.list("admin", true).unwrap().len(), 2);
        let c = reopened.conn().unwrap();
        assert!(
            c.execute("UPDATE feedback_events SET reply='overwrite'", [])
                .is_err()
        );
        assert!(c.execute("DELETE FROM feedback_events", []).is_err());
    }
    #[test]
    fn feedback_concurrent_cas_has_one_winner_and_no_partial_history() {
        let (s, _dir) = setup();
        let row = s.create("user", &create_body()).unwrap();
        let s = Arc::new(s);
        let barrier = Arc::new(Barrier::new(3));
        let workers = ["first","second"].map(|reply| {
            let s=s.clone(); let barrier=barrier.clone(); let id=row.id.clone();
            std::thread::spawn(move || { barrier.wait(); s.update(&id,"admin",&json!({"mutation_id":Uuid::new_v4().to_string(),"expected_revision":1,"status":"resolved","reply":reply})) })
        });
        barrier.wait();
        let results = workers.map(|h| h.join().unwrap());
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|r| r.as_ref().is_err_and(|e| *e == "REVISION_CONFLICT"))
                .count(),
            1
        );
        let final_row = s.get(&row.id, "user", false).unwrap();
        assert_eq!(final_row.revision, 2);
        assert_eq!(final_row.events.len(), 3);
    }
    #[test]
    fn feedback_rejects_unsafe_storage_and_cross_network_reuse() {
        let (_s, dir) = setup();
        assert!(FeedbackStore::open(dir.path(), "22222222-2222-4222-8222-222222222222").is_err());
        let db = dir.path().join("feedback.sqlite3");
        fs::set_permissions(&db, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(FeedbackStore::open(dir.path(), NETWORK).is_err());
        fs::set_permissions(&db, fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.path().join("linked.sqlite3");
        fs::hard_link(&db, &link).unwrap();
        assert!(FeedbackStore::open(dir.path(), NETWORK).is_err());
        fs::remove_file(link).unwrap();
        fs::rename(&db, dir.path().join("original.sqlite3")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("original.sqlite3"), &db).unwrap();
        assert!(FeedbackStore::open(dir.path(), NETWORK).is_err());
    }
    #[test]
    fn feedback_validates_character_limits_and_bounds_lists() {
        let (s, _dir) = setup();
        for (field, value) in [
            ("title", json!(" ")),
            ("title", json!("中".repeat(121))),
            ("description", json!("中".repeat(8001))),
            ("category", json!("unknown")),
            ("app_version", json!("x".repeat(65))),
            ("unexpected", json!(true)),
        ] {
            let mut body = create_body();
            body[field] = value;
            assert_eq!(s.create("user", &body).unwrap_err(), "REQUEST_INVALID");
        }
        let mut maximum = create_body();
        maximum["title"] = json!("中".repeat(120));
        maximum["description"] = json!("中".repeat(8000));
        s.create("user", &maximum).unwrap();
        for _ in 0..101 {
            s.create("user", &create_body()).unwrap();
        }
        assert_eq!(s.list("user", false).unwrap().len(), 100);
        assert!(s.list("other", false).unwrap().is_empty());
    }
}
