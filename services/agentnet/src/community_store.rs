//! Owned community persistence. AuthStore owns identity; this store owns posts,
//! replies, moderation history, and permanent bounded mutation receipts.
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;
const STORAGE: &str = "COMMUNITY_UNAVAILABLE";
const ACTOR_MUTATION_LIMIT: i64 = 10_000;
const TOTAL_MUTATION_LIMIT: i64 = 100_000;
static INIT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Topic {
    pub id: String,
    pub category: String,
    pub title: String,
    pub content: String,
    pub author_name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub revision: u64,
    pub reply_count: u64,
    pub is_owner: bool,
    pub pinned: bool,
    pub locked: bool,
    pub visibility: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Reply {
    pub id: String,
    pub content: String,
    pub author_name: String,
    pub created_at: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Detail {
    pub topic: Topic,
    pub replies: Vec<Reply>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateRequest {
    mutation_id: String,
    category: String,
    title: String,
    content: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReplyRequest {
    mutation_id: String,
    content: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateRequest {
    mutation_id: String,
    expected_revision: u64,
    visibility: Option<String>,
    pinned: Option<bool>,
    locked: Option<bool>,
}
pub struct CommunityStore {
    db: PathBuf,
    network_id: String,
}
impl CommunityStore {
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
            .join("community.sqlite3");
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
        tx.execute_batch("CREATE TABLE IF NOT EXISTS community_topics (
            id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, category TEXT NOT NULL CHECK(category IN ('discussion','question','showcase','announcement')),
            title TEXT NOT NULL, content TEXT NOT NULL, author_name TEXT NOT NULL,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
            reply_count INTEGER NOT NULL DEFAULT 0 CHECK(reply_count>=0), pinned INTEGER NOT NULL DEFAULT 0,
            locked INTEGER NOT NULL DEFAULT 0, visibility TEXT NOT NULL DEFAULT 'published' CHECK(visibility IN ('published','hidden')));
            CREATE INDEX IF NOT EXISTS community_topic_order ON community_topics(pinned DESC,created_at DESC,id DESC);
            CREATE TABLE IF NOT EXISTS community_replies (sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
            topic_id TEXT NOT NULL REFERENCES community_topics(id), principal_id TEXT NOT NULL, content TEXT NOT NULL,
            author_name TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS community_reply_order ON community_replies(topic_id,sequence);
            CREATE TABLE IF NOT EXISTS community_audit (sequence INTEGER PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES community_topics(id),
            actor_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TRIGGER IF NOT EXISTS community_audit_no_update BEFORE UPDATE ON community_audit BEGIN SELECT RAISE(ABORT,'immutable community audit'); END;
            CREATE TRIGGER IF NOT EXISTS community_audit_no_delete BEFORE DELETE ON community_audit BEGIN SELECT RAISE(ABORT,'immutable community audit'); END;
            CREATE TABLE IF NOT EXISTS community_mutations (actor_id TEXT NOT NULL, mutation_id TEXT NOT NULL, body_hash BLOB NOT NULL,
            response TEXT NOT NULL, PRIMARY KEY(actor_id,mutation_id));
            CREATE TABLE IF NOT EXISTS community_service_pin(network_id TEXT NOT NULL);") .map_err(|_| STORAGE)?;
        let (count, pin): (i64, Option<String>) = tx
            .query_row(
                "SELECT COUNT(*),MIN(network_id) FROM community_service_pin",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| STORAGE)?;
        if count > 1 || pin.as_ref().is_some_and(|v| v != network_id) {
            return Err(STORAGE);
        }
        if pin.is_none() {
            let rows:i64=tx.query_row("SELECT (SELECT COUNT(*) FROM community_topics)+(SELECT COUNT(*) FROM community_replies)+(SELECT COUNT(*) FROM community_mutations)+(SELECT COUNT(*) FROM community_audit)",[],|r|r.get(0)).map_err(|_| STORAGE)?;
            if rows != 0 {
                return Err(STORAGE);
            }
            tx.execute(
                "INSERT INTO community_service_pin(network_id) VALUES(?1)",
                [network_id],
            )
            .map_err(|_| STORAGE)?;
        }
        tx.commit().map_err(|_| STORAGE)?;
        verify(&db)?;
        Ok(Self {
            db,
            network_id: network_id.into(),
        })
    }
    fn conn(&self) -> Result<Connection, &'static str> {
        let c = connection(&self.db)?;
        let (count, pin): (i64, Option<String>) = c
            .query_row(
                "SELECT COUNT(*),MIN(network_id) FROM community_service_pin",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| STORAGE)?;
        if count != 1 || pin.as_deref() != Some(&self.network_id) {
            return Err(STORAGE);
        }
        Ok(c)
    }
    fn alias(&self, actor: &str) -> String {
        let h = Sha256::digest(format!("{}:{actor}", self.network_id).as_bytes());
        format!(
            "成员-{}",
            h[..6]
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        )
    }
    pub fn list(&self, actor: &str, admin: bool) -> Result<Vec<Topic>, &'static str> {
        let mut c = self.conn()?;
        let tx = c.transaction().map_err(|_| STORAGE)?;
        let mut s=tx.prepare("SELECT id FROM community_topics WHERE ?1 OR visibility='published' ORDER BY pinned DESC,created_at DESC,id DESC LIMIT 100").map_err(|_| STORAGE)?;
        let ids = s
            .query_map([admin], |r| r.get::<_, String>(0))
            .map_err(|_| STORAGE)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| STORAGE)?;
        ids.into_iter().map(|id| load(&tx, &id, actor)).collect()
    }
    pub fn get(&self, id: &str, actor: &str, admin: bool) -> Result<Detail, &'static str> {
        let mut c = self.conn()?;
        let tx = c.transaction().map_err(|_| STORAGE)?;
        let topic = visible(&tx, id, actor, admin)?;
        let mut s=tx.prepare("SELECT id,content,author_name,created_at FROM (SELECT sequence,id,content,author_name,created_at FROM community_replies WHERE topic_id=?1 ORDER BY sequence DESC LIMIT 200) ORDER BY sequence").map_err(|_| STORAGE)?;
        let replies = s
            .query_map([id], |r| {
                Ok(Reply {
                    id: r.get(0)?,
                    content: r.get(1)?,
                    author_name: r.get(2)?,
                    created_at: r.get(3)?,
                })
            })
            .map_err(|_| STORAGE)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| STORAGE)?;
        Ok(Detail { topic, replies })
    }
    pub fn create(&self, actor: &str, admin: bool, body: &Value) -> Result<Value, &'static str> {
        let r: CreateRequest =
            serde_json::from_value(body.clone()).map_err(|_| "REQUEST_INVALID")?;
        let op = uuid(&r.mutation_id)?;
        text(&r.title, 120)?;
        text(&r.content, 8000)?;
        if !matches!(
            r.category.as_str(),
            "discussion" | "question" | "showcase" | "announcement"
        ) {
            return Err("REQUEST_INVALID");
        }
        if r.category == "announcement" && !admin {
            return Err("ADMIN_REQUIRED");
        }
        let hash = body_hash("create", None, body)?;
        let mut c = self.conn()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| STORAGE)?;
        if let Some(v) = replay(&tx, actor, &op, &hash)? {
            return Ok(v);
        }
        capacity(&tx, actor)?;
        let id = Uuid::new_v4().to_string();
        let now = now()?;
        tx.execute("INSERT INTO community_topics(id,principal_id,category,title,content,author_name,created_at,updated_at,revision) VALUES(?1,?2,?3,?4,?5,?6,?7,?7,1)",params![id,actor,r.category,r.title.trim(),r.content.trim(),self.alias(actor),now]).map_err(|_| STORAGE)?;
        audit(&tx, &id, actor, "created", body, now)?;
        let result = json!(load(&tx, &id, actor)?);
        receipt(&tx, actor, &op, &hash, &result)?;
        tx.commit().map_err(|_| STORAGE)?;
        Ok(result)
    }
    pub fn reply(
        &self,
        id: &str,
        actor: &str,
        admin: bool,
        body: &Value,
    ) -> Result<Value, &'static str> {
        uuid(id)?;
        let r: ReplyRequest =
            serde_json::from_value(body.clone()).map_err(|_| "REQUEST_INVALID")?;
        let op = uuid(&r.mutation_id)?;
        text(&r.content, 4000)?;
        let hash = body_hash("reply", Some(id), body)?;
        let mut c = self.conn()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| STORAGE)?;
        // Re-check visibility before replay: hidden content never leaks after moderation.
        let topic = visible(&tx, id, actor, admin)?;
        if let Some(v) = replay(&tx, actor, &op, &hash)? {
            return Ok(v);
        }
        if topic.locked && !admin {
            return Err("COMMUNITY_LOCKED");
        }
        capacity(&tx, actor)?;
        let now = now()?;
        let rid = Uuid::new_v4().to_string();
        let alias = self.alias(actor);
        tx.execute("INSERT INTO community_replies(id,topic_id,principal_id,content,author_name,created_at) VALUES(?1,?2,?3,?4,?5,?6)",params![rid,id,actor,r.content.trim(),alias,now]).map_err(|_| STORAGE)?;
        tx.execute("UPDATE community_topics SET reply_count=reply_count+1,revision=revision+1,updated_at=?1 WHERE id=?2",params![now,id]).map_err(|_| STORAGE)?;
        audit(&tx, id, actor, "reply", &json!({"reply_id":rid}), now)?;
        let result = json!(Reply {
            id: rid,
            content: r.content.trim().into(),
            author_name: alias,
            created_at: now
        });
        receipt(&tx, actor, &op, &hash, &result)?;
        tx.commit().map_err(|_| STORAGE)?;
        Ok(result)
    }
    pub fn update(&self, id: &str, actor: &str, body: &Value) -> Result<Value, &'static str> {
        uuid(id)?;
        let r: UpdateRequest =
            serde_json::from_value(body.clone()).map_err(|_| "REQUEST_INVALID")?;
        let op = uuid(&r.mutation_id)?;
        if r.expected_revision == 0
            || r.expected_revision >= i64::MAX as u64
            || (r.visibility.is_none() && r.pinned.is_none() && r.locked.is_none())
            || r.visibility
                .as_ref()
                .is_some_and(|v| !matches!(v.as_str(), "published" | "hidden"))
        {
            return Err("REQUEST_INVALID");
        }
        let hash = body_hash("moderate", Some(id), body)?;
        let mut c = self.conn()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| STORAGE)?;
        if let Some(v) = replay(&tx, actor, &op, &hash)? {
            return Ok(v);
        }
        capacity(&tx, actor)?;
        let original = load(&tx, id, actor)?;
        if original.revision != r.expected_revision {
            return Err("REVISION_CONFLICT");
        }
        let now = now()?;
        let changed=tx.execute("UPDATE community_topics SET visibility=?1,pinned=?2,locked=?3,revision=revision+1,updated_at=?4 WHERE id=?5 AND revision=?6",params![r.visibility.unwrap_or(original.visibility),r.pinned.unwrap_or(original.pinned),r.locked.unwrap_or(original.locked),now,id,r.expected_revision]).map_err(|_| STORAGE)?;
        if changed != 1 {
            return Err("REVISION_CONFLICT");
        }
        audit(&tx, id, actor, "moderated", body, now)?;
        let result = json!(load(&tx, id, actor)?);
        receipt(&tx, actor, &op, &hash, &result)?;
        tx.commit().map_err(|_| STORAGE)?;
        Ok(result)
    }
}
fn load(c: &Connection, id: &str, actor: &str) -> Result<Topic, &'static str> {
    c.query_row("SELECT id,category,title,content,author_name,created_at,updated_at,revision,reply_count,principal_id,pinned,locked,visibility FROM community_topics WHERE id=?1",[id],|r|Ok(Topic{id:r.get(0)?,category:r.get(1)?,title:r.get(2)?,content:r.get(3)?,author_name:r.get(4)?,created_at:r.get(5)?,updated_at:r.get(6)?,revision:r.get(7)?,reply_count:r.get(8)?,is_owner:r.get::<_,String>(9)?==actor,pinned:r.get(10)?,locked:r.get(11)?,visibility:r.get(12)?})).optional().map_err(|_| STORAGE)?.ok_or("COMMUNITY_NOT_FOUND")
}
fn visible(c: &Connection, id: &str, actor: &str, admin: bool) -> Result<Topic, &'static str> {
    let row = load(c, id, actor)?;
    if row.visibility == "hidden" && !admin {
        return Err("COMMUNITY_NOT_FOUND");
    }
    Ok(row)
}
fn uuid(s: &str) -> Result<String, &'static str> {
    Uuid::parse_str(s)
        .map(|v| v.to_string())
        .map_err(|_| "REQUEST_INVALID")
}
fn text(s: &str, max: usize) -> Result<(), &'static str> {
    if s.trim().is_empty() || s.chars().count() > max || s.contains('\0') {
        Err("REQUEST_INVALID")
    } else {
        Ok(())
    }
}
fn now() -> Result<i64, &'static str> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .ok_or(STORAGE)
}
fn body_hash(kind: &str, id: Option<&str>, body: &Value) -> Result<Vec<u8>, &'static str> {
    Ok(
        Sha256::digest(serde_json::to_vec(&(kind, id, body)).map_err(|_| "REQUEST_INVALID")?)
            .to_vec(),
    )
}
fn replay(
    c: &Connection,
    actor: &str,
    op: &str,
    hash: &[u8],
) -> Result<Option<Value>, &'static str> {
    let row:Option<(Vec<u8>,String)>=c.query_row("SELECT body_hash,response FROM community_mutations WHERE actor_id=?1 AND mutation_id=?2",params![actor,op],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_| STORAGE)?;
    match row {
        Some((saved, response)) if saved == hash => serde_json::from_str(&response)
            .map(Some)
            .map_err(|_| STORAGE),
        Some(_) => Err("MUTATION_CONFLICT"),
        None => Ok(None),
    }
}
fn capacity(c: &Connection, actor: &str) -> Result<(), &'static str> {
    let (total, own): (i64, i64) = c
        .query_row(
            "SELECT COUNT(*),COALESCE(SUM(actor_id=?1),0) FROM community_mutations",
            [actor],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| STORAGE)?;
    if own >= ACTOR_MUTATION_LIMIT || total >= TOTAL_MUTATION_LIMIT {
        Err(STORAGE)
    } else {
        Ok(())
    }
}
fn receipt(
    c: &Connection,
    actor: &str,
    op: &str,
    hash: &[u8],
    response: &Value,
) -> Result<(), &'static str> {
    c.execute("INSERT INTO community_mutations(actor_id,mutation_id,body_hash,response) VALUES(?1,?2,?3,?4)",params![actor,op,hash,response.to_string()]).map(|_|()).map_err(|_| STORAGE)
}
fn audit(
    c: &Connection,
    id: &str,
    actor: &str,
    kind: &str,
    detail: &Value,
    now: i64,
) -> Result<(), &'static str> {
    c.execute("INSERT INTO community_audit(topic_id,actor_id,kind,detail,created_at) VALUES(?1,?2,?3,?4,?5)",params![id,actor,kind,detail.to_string(),now]).map(|_|()).map_err(|_| STORAGE)
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
    use std::{
        os::unix::fs::PermissionsExt,
        sync::{Arc, Barrier},
    };
    const NETWORK: &str = "11111111-1111-4111-8111-111111111111";
    fn setup() -> (CommunityStore, tempfile::TempDir) {
        let d = tempfile::tempdir().unwrap();
        fs::set_permissions(d.path(), fs::Permissions::from_mode(0o700)).unwrap();
        (CommunityStore::open(d.path(), NETWORK).unwrap(), d)
    }
    fn body() -> Value {
        json!({"mutation_id":Uuid::new_v4().to_string(),"category":"discussion","title":"社区讨论","content":"支持中文和 emoji 😀"})
    }
    fn reply_body() -> Value {
        json!({"mutation_id":Uuid::new_v4().to_string(),"content":"回复内容"})
    }
    #[test]
    fn community_store_durable_exact_replay_visibility_and_audit() {
        let (s, d) = setup();
        let b = body();
        let row = s.create("principal-private", false, &b).unwrap();
        let id = row["id"].as_str().unwrap();
        assert_eq!(s.create("principal-private", false, &b).unwrap(), row);
        let mut changed = b.clone();
        changed["content"] = json!("different");
        assert_eq!(
            s.create("principal-private", false, &changed).unwrap_err(),
            "MUTATION_CONFLICT"
        );
        assert!(!row.to_string().contains("principal-private"));
        assert_eq!(row["is_owner"], true);
        assert!(!s.list("other", false).unwrap()[0].is_owner);
        assert!(row["created_at"].as_i64().unwrap() > 1_000_000_000_000);
        let rb = reply_body();
        let reply = s.reply(id, "other", false, &rb).unwrap();
        assert_eq!(s.reply(id, "other", false, &rb).unwrap(), reply);
        let mut reused = rb.clone();
        reused["category"] = json!("discussion");
        reused["title"] = json!("reuse");
        assert_eq!(
            s.create("other", false, &reused).unwrap_err(),
            "MUTATION_CONFLICT"
        );
        let current = s.get(id, "principal-private", false).unwrap();
        assert_eq!(current.topic.reply_count, 1);
        assert_eq!(current.topic.revision, 2);
        assert_eq!(current.replies.len(), 1);
        let update = json!({"mutation_id":Uuid::new_v4().to_string(),"expected_revision":2,"visibility":"hidden","locked":true,"pinned":true});
        let moderated = s.update(id, "admin", &update).unwrap();
        assert_eq!(s.update(id, "admin", &update).unwrap(), moderated);
        assert!(s.list("principal-private", false).unwrap().is_empty());
        assert_eq!(
            s.get(id, "principal-private", false).unwrap_err(),
            "COMMUNITY_NOT_FOUND"
        );
        assert_eq!(
            s.reply(id, "other", false, &rb).unwrap_err(),
            "COMMUNITY_NOT_FOUND"
        );
        assert_eq!(s.get(id, "admin", true).unwrap().topic.visibility, "hidden");
        let reopened = CommunityStore::open(d.path(), NETWORK).unwrap();
        assert_eq!(reopened.get(id, "admin", true).unwrap().topic.revision, 3);
        assert_eq!(
            reopened.create("principal-private", false, &b).unwrap(),
            row
        );
        assert!(CommunityStore::open(d.path(), "22222222-2222-4222-8222-222222222222").is_err());
        let c = s.conn().unwrap();
        let audits: i64 = c
            .query_row("SELECT COUNT(*) FROM community_audit", [], |r| r.get(0))
            .unwrap();
        assert_eq!(audits, 3);
        assert!(c.execute("DELETE FROM community_audit", []).is_err());
        c.execute(
            "UPDATE community_service_pin SET network_id='22222222-2222-4222-8222-222222222222'",
            [],
        )
        .unwrap();
        assert!(s.list("admin", true).is_err());
    }
    #[test]
    fn community_store_locked_announcements_and_validation() {
        let (s, _d) = setup();
        let mut b = body();
        b["category"] = json!("announcement");
        assert_eq!(s.create("member", false, &b).unwrap_err(), "ADMIN_REQUIRED");
        let row = s.create("admin", true, &b).unwrap();
        let id = row["id"].as_str().unwrap();
        s.update(
            id,
            "admin",
            &json!({"mutation_id":Uuid::new_v4().to_string(),"expected_revision":1,"locked":true}),
        )
        .unwrap();
        assert_eq!(
            s.reply(id, "member", false, &reply_body()).unwrap_err(),
            "COMMUNITY_LOCKED"
        );
        assert!(s.reply(id, "admin", true, &reply_body()).is_ok());
        for (key, value) in [
            ("title", json!(" ")),
            ("title", json!("中".repeat(121))),
            ("content", json!("😀".repeat(8001))),
            ("category", json!("invalid")),
            ("mutation_id", json!("invalid")),
            ("unexpected", json!(true)),
        ] {
            let mut bad = body();
            bad[key] = value;
            assert_eq!(
                s.create("member", false, &bad).unwrap_err(),
                "REQUEST_INVALID"
            );
        }
        let mut unicode = body();
        unicode["content"] = json!("😀".repeat(8000));
        assert!(s.create("member", false, &unicode).is_ok());
        assert_eq!(s.update(id,"admin",&json!({"mutation_id":Uuid::new_v4().to_string(),"expected_revision":1,"pinned":true})).unwrap_err(),"REVISION_CONFLICT");
    }
    #[test]
    fn community_store_parallel_replies_and_cas_are_atomic() {
        let (s, _d) = setup();
        let s = Arc::new(s);
        let row = s.create("owner", false, &body()).unwrap();
        let id = row["id"].as_str().unwrap().to_string();
        let rb = reply_body();
        let gate = Arc::new(Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let (s, id, rb, g) = (s.clone(), id.clone(), rb.clone(), gate.clone());
                std::thread::spawn(move || {
                    g.wait();
                    s.reply(&id, "member", false, &rb).unwrap()
                })
            })
            .collect();
        let replies: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert!(replies.iter().all(|r| r == &replies[0]));
        assert_eq!(s.get(&id, "owner", false).unwrap().topic.reply_count, 1);
        let gate = Arc::new(Barrier::new(2));
        let threads:Vec<_>=(0..2).map(|_|{let(s,id,g)=(s.clone(),id.clone(),gate.clone());std::thread::spawn(move||{g.wait();s.update(&id,"admin",&json!({"mutation_id":Uuid::new_v4().to_string(),"expected_revision":2,"pinned":true}))})}).collect();
        let out: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(out.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            out.iter()
                .filter(|r| matches!(r, Err("REVISION_CONFLICT")))
                .count(),
            1
        );
    }
    #[test]
    fn community_store_bounds_lists_replies_and_preserves_receipts_at_capacity() {
        let (s, _d) = setup();
        let initial_body = body();
        let first = s.create("owner", false, &initial_body).unwrap();
        let id = first["id"].as_str().unwrap();
        let pin=s.update(id,"admin",&json!({"mutation_id":Uuid::new_v4().to_string(),"expected_revision":1,"pinned":true})).unwrap();
        for _ in 0..101 {
            s.create("other", false, &body()).unwrap();
        }
        let list = s.list("owner", false).unwrap();
        assert_eq!(list.len(), 100);
        assert_eq!(list[0].id, id);
        let mut reply_ids = Vec::new();
        for index in 0..201 {
            let mut body = reply_body();
            body["content"] = json!(format!("回复 {index}"));
            let row = s.reply(id, "other", false, &body).unwrap();
            reply_ids.push(row["id"].as_str().unwrap().to_owned());
        }
        let detail = s.get(id, "owner", false).unwrap();
        assert_eq!(detail.replies.len(), 200);
        assert_eq!(detail.topic.reply_count, 201);
        assert_eq!(
            detail
                .replies
                .iter()
                .map(|r| r.id.clone())
                .collect::<Vec<_>>(),
            reply_ids[1..]
        );
        assert_eq!(detail.replies.last().unwrap().content, "回复 200");
        let c = s.conn().unwrap();
        c.execute("INSERT INTO community_mutations(actor_id,mutation_id,body_hash,response) SELECT 'limited',CAST(value AS TEXT),x'00','null' FROM json_each(?1)",[serde_json::to_string(&(0..ACTOR_MUTATION_LIMIT).collect::<Vec<_>>()).unwrap()]).unwrap();
        assert_eq!(s.create("limited", false, &body()).unwrap_err(), STORAGE);
        c.execute("INSERT INTO community_mutations(actor_id,mutation_id,body_hash,response) SELECT 'owner',CAST(value AS TEXT),x'00','null' FROM json_each(?1)",[serde_json::to_string(&(0..ACTOR_MUTATION_LIMIT).collect::<Vec<_>>()).unwrap()]).unwrap();
        assert_eq!(s.create("owner", false, &initial_body).unwrap(), first);
        assert_eq!(s.create("owner", false, &body()).unwrap_err(), STORAGE);
        // Capacity is checked only after existing receipt lookup; receipts are permanent.
        assert_eq!(
            s.update(
                id,
                "admin",
                &json!({"mutation_id":"not-uuid","expected_revision":1,"pinned":true})
            )
            .unwrap_err(),
            "REQUEST_INVALID"
        );
        assert_eq!(pin["pinned"], true);
    }
}
