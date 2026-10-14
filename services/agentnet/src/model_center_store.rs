//! Private model-center state. AdminStore remains the desired Bot configuration owner.
use super::model_center_types::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use hmac::{Hmac, Mac};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
};
use zeroize::Zeroizing;
static INIT: Mutex<()> = Mutex::new(());
pub(crate) struct ModelStartupGuard {
    _file: fs::File,
}
#[derive(Clone)]
pub struct ModelCenterStore {
    db: PathBuf,
    key: std::sync::Arc<Zeroizing<[u8; 32]>>,
}
impl ModelCenterStore {
    pub fn open(dir: &Path, network_id: &str) -> Result<Self> {
        let _guard = INIT.lock().map_err(|_| ModelCenterError::Storage)?;
        uuid(network_id)?;
        let md = fs::symlink_metadata(dir).map_err(|_| ModelCenterError::UnsafeState)?;
        if !dir.is_absolute()
            || !md.is_dir()
            || md.file_type().is_symlink()
            || md.mode() & 0o077 != 0
            || md.uid() != nix::unistd::Uid::effective().as_raw()
        {
            return Err(ModelCenterError::UnsafeState);
        }
        let dir = dir
            .canonicalize()
            .map_err(|_| ModelCenterError::UnsafeState)?;
        let db = dir.join("model-center.sqlite3");
        create_private(&db, &[])?;
        let key_path = dir.join("model-center.key");
        // Missing key in an existing nonempty database must never silently rotate secrets.
        if !key_path.exists()
            && fs::metadata(&db)
                .map_err(|_| ModelCenterError::Storage)?
                .len()
                > 0
        {
            return Err(ModelCenterError::UnsafeState);
        }
        create_private(&key_path, &rand::random::<[u8; 32]>())?;
        let mut key = Zeroizing::new([0u8; 32]);
        let mut file = private_file(&key_path)?;
        if file
            .metadata()
            .map_err(|_| ModelCenterError::Storage)?
            .len()
            != 32
        {
            return Err(ModelCenterError::UnsafeState);
        }
        file.read_exact(&mut *key)
            .map_err(|_| ModelCenterError::Storage)?;
        let store = Self {
            db,
            key: std::sync::Arc::new(key),
        };
        let mut c = store.conn()?;
        c.pragma_update(None, "journal_mode", "WAL")
            .map_err(storage)?;
        c.pragma_update(None, "synchronous", "FULL")
            .map_err(storage)?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS pin(network_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS providers(id TEXT PRIMARY KEY,public TEXT NOT NULL,secret BLOB NOT NULL); CREATE TABLE IF NOT EXISTS models(id TEXT PRIMARY KEY,public TEXT NOT NULL); CREATE TABLE IF NOT EXISTS credentials(id TEXT PRIMARY KEY,hash BLOB NOT NULL UNIQUE,scope TEXT NOT NULL,bot_id TEXT NOT NULL,binding TEXT NOT NULL,expires INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS usage(request_id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,day INTEGER NOT NULL,active INTEGER NOT NULL,record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS blocked_leases(session_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,outcome TEXT NOT NULL,blocked_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS mutations(id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,hash BLOB NOT NULL,response TEXT NOT NULL); CREATE INDEX IF NOT EXISTS usage_bot_day ON usage(bot_id,day);").map_err(storage)?;
        let pins: Vec<String> = {
            let mut s = tx.prepare("SELECT network_id FROM pin").map_err(storage)?;
            s.query_map([], |r| r.get(0))
                .map_err(storage)?
                .collect::<rusqlite::Result<_>>()
                .map_err(storage)?
        };
        match pins.as_slice() {
            [] => {
                let n:i64=tx.query_row("SELECT (SELECT COUNT(*) FROM providers)+(SELECT COUNT(*) FROM models)+(SELECT COUNT(*) FROM credentials)+(SELECT COUNT(*) FROM usage)",[],|r|r.get(0)).map_err(storage)?;
                if n != 0 {
                    return Err(ModelCenterError::UnsafeState);
                }
                tx.execute("INSERT INTO pin VALUES(?1)", [network_id])
                    .map_err(storage)?;
            }
            [id] if id == network_id => {}
            _ => return Err(ModelCenterError::UnsafeState),
        }
        tx.commit().map_err(storage)?;
        Ok(store)
    }
    fn conn(&self) -> Result<Connection> {
        private_file(&self.db)?;
        let c = Connection::open_with_flags(
            &self.db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW
                | rusqlite::OpenFlags::SQLITE_OPEN_FULL_MUTEX,
        )
        .map_err(storage)?;
        c.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(storage)?;
        Ok(c)
    }
    /// Retain this guard for the whole serving lifetime. A second process must
    /// fail before it can recover requests belonging to the active owner.
    pub(crate) fn start_exclusive(&self) -> Result<(ModelStartupGuard, usize)> {
        let path = self.db.with_file_name("model-center.lock");
        create_private(&path, &[])?;
        let file = private_file(&path)?;
        file.try_lock().map_err(|_| ModelCenterError::UnsafeState)?;
        let guard = ModelStartupGuard { _file: file };
        let recovered = self.recover_interrupted_calls()?;
        Ok((guard, recovered))
    }
    /// Call exactly once during exclusive process startup, before accepting requests.
    /// Another active service must not share this state directory.
    fn recover_interrupted_calls(&self) -> Result<usize> {
        let mut c = self.conn()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let rows = {
            let mut s = tx
                .prepare("SELECT request_id,record FROM usage WHERE active=1")
                .map_err(storage)?;
            s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(storage)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(storage)?
        };
        for (id, raw) in &rows {
            let mut record: UsageRecord = from_json(raw)?;
            record.outcome = "interrupted".into();
            block_lease(&tx, &record.session_id, id, "interrupted")?;
            record.completed_at = Some(now());
            tx.execute(
                "UPDATE usage SET active=0,record=?2 WHERE request_id=?1",
                params![id, json(&record)?],
            )
            .map_err(storage)?;
        }
        tx.commit().map_err(storage)?;
        Ok(rows.len())
    }
    pub fn providers(&self) -> Result<Vec<Provider>> {
        self.list("providers")
    }
    pub fn models(&self) -> Result<Vec<Model>> {
        self.list("models")
    }
    fn list<T: serde::de::DeserializeOwned>(&self, table: &str) -> Result<Vec<T>> {
        let c = self.conn()?;
        let mut s = c
            .prepare(&format!("SELECT public FROM {table} ORDER BY id"))
            .map_err(storage)?;
        let records = s
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(storage)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(storage)?;
        records.into_iter().map(|s| from_json(&s)).collect()
    }
    pub fn provider(&self, id: &str) -> Result<Provider> {
        fetch(&self.conn()?, "providers", id)
    }
    pub fn model(&self, id: &str) -> Result<Model> {
        fetch(&self.conn()?, "models", id)
    }
    pub fn put_provider(
        &self,
        actor: &str,
        mutation_id: &str,
        write: ProviderWrite,
        expected_revision: u64,
    ) -> Result<Provider> {
        let digest = self.request_hash(
            &serde_json::json!({"write":write,"expected_revision":expected_revision}),
        )?;
        self.put_provider_inner(
            actor,
            mutation_id,
            "put_provider",
            digest,
            write,
            expected_revision,
        )
    }
    fn put_provider_inner(
        &self,
        actor: &str,
        mutation_id: &str,
        action: &str,
        digest: Vec<u8>,
        mut write: ProviderWrite,
        expected_revision: u64,
    ) -> Result<Provider> {
        uuid(&write.id)?;
        text(&write.label, 128)?;
        super::model_center_gateway::validate_base_url(&write.base_url)?;
        if write.max_output_tokens == 0
            || write.max_output_tokens > 16_384
            || (write.api_protocol == ApiProtocol::Anthropic
                && write.max_output_tokens_param_name != "max_tokens")
            || (write.api_protocol == ApiProtocol::Openai && write.auth_type != AuthType::ApiKey)
            || (write.api_protocol == ApiProtocol::Openai
                && write.upstream_format == UpstreamFormat::ChatCompletions
                && !["max_tokens", "max_completion_tokens"]
                    .contains(&write.max_output_tokens_param_name.as_str()))
        {
            return Err(ModelCenterError::Invalid);
        }
        if write.api_protocol == ApiProtocol::Openai
            && write.upstream_format == UpstreamFormat::Responses
        {
            write.max_output_tokens_param_name = "max_output_tokens".into();
        }
        let mut c = self.conn()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        if let Some(reply) = mutation_replay(&tx, actor, mutation_id, action, &digest)? {
            return from_json(&reply);
        }
        let old = optional_fetch::<Provider>(&tx, "providers", &write.id)?;
        check_revision(old.as_ref().map(|p| p.revision), expected_revision)?;
        let secret = match write.api_key.take() {
            Some(v) if !v.is_empty() && v.len() <= 8192 && !v.chars().any(char::is_control) => {
                Zeroizing::new(v.into_bytes())
            }
            Some(_) => return Err(ModelCenterError::Invalid),
            None => {
                let p = old.as_ref().ok_or(ModelCenterError::Invalid)?;
                self.decrypt(&tx, p)?
            }
        };
        let public = Provider {
            id: write.id,
            label: write.label,
            base_url: write.base_url,
            api_protocol: write.api_protocol,
            auth_type: write.auth_type,
            upstream_format: write.upstream_format,
            max_output_tokens_param_name: write.max_output_tokens_param_name,
            max_output_tokens: write.max_output_tokens,
            enabled: write.enabled,
            has_key: true,
            revision: expected_revision
                .checked_add(1)
                .ok_or(ModelCenterError::Invalid)?,
        };
        let encrypted = self.encrypt(&public, &secret)?;
        tx.execute("INSERT INTO providers VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET public=excluded.public,secret=excluded.secret",params![public.id,json(&public)?,encrypted]).map_err(storage)?;
        save_mutation(&tx, actor, mutation_id, action, &digest, &json(&public)?)?;
        tx.commit().map_err(storage)?;
        Ok(public)
    }
    pub fn put_model(
        &self,
        actor: &str,
        mutation_id: &str,
        write: ModelWrite,
        expected_revision: u64,
    ) -> Result<Model> {
        let digest = self.request_hash(
            &serde_json::json!({"write":write,"expected_revision":expected_revision}),
        )?;
        self.put_model_inner(
            actor,
            mutation_id,
            "put_model",
            digest,
            write,
            expected_revision,
        )
    }
    fn put_model_inner(
        &self,
        actor: &str,
        mutation_id: &str,
        action: &str,
        digest: Vec<u8>,
        write: ModelWrite,
        expected_revision: u64,
    ) -> Result<Model> {
        uuid(&write.id)?;
        uuid(&write.provider_id)?;
        if write.owner_ids.is_empty() || write.owner_ids.len() > 256 {
            return Err(ModelCenterError::Invalid);
        }
        let mut owners = std::collections::HashSet::new();
        for owner in &write.owner_ids {
            uuid(owner)?;
            if !owners.insert(owner) {
                return Err(ModelCenterError::Invalid);
            }
        }
        text(&write.label, 128)?;
        text(&write.model_id, 256)?;
        if write
            .price_version
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.len() > 128)
            || write
                .input_price_microusd_per_million
                .is_some_and(|v| v > 1_000_000_000_000)
            || write
                .output_price_microusd_per_million
                .is_some_and(|v| v > 1_000_000_000_000)
        {
            return Err(ModelCenterError::Invalid);
        }
        let mut c = self.conn()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        if let Some(reply) = mutation_replay(&tx, actor, mutation_id, action, &digest)? {
            return from_json(&reply);
        }
        fetch::<Provider>(&tx, "providers", &write.provider_id)?;
        let old = optional_fetch::<Model>(&tx, "models", &write.id)?;
        check_revision(old.as_ref().map(|p| p.revision), expected_revision)?;
        let m = Model {
            config: write,
            revision: expected_revision
                .checked_add(1)
                .ok_or(ModelCenterError::Invalid)?,
        };
        tx.execute(
            "INSERT INTO models VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET public=excluded.public",
            params![m.config.id, json(&m)?],
        )
        .map_err(storage)?;
        save_mutation(&tx, actor, mutation_id, action, &digest, &json(&m)?)?;
        tx.commit().map_err(storage)?;
        Ok(m)
    }
    /// Logical deletion preserves historical snapshots and cannot reactivate old leases.
    pub fn delete_provider(
        &self,
        actor: &str,
        mutation_id: &str,
        id: &str,
        revision: u64,
    ) -> Result<Provider> {
        let digest =
            self.request_hash(&serde_json::json!({"id":id,"expected_revision":revision}))?;
        if let Some(reply) = mutation_replay(
            &self.conn()?,
            actor,
            mutation_id,
            "delete_provider",
            &digest,
        )? {
            return from_json(&reply);
        }
        let p = self.provider(id)?;
        self.put_provider_inner(
            actor,
            mutation_id,
            "delete_provider",
            digest,
            ProviderWrite {
                id: p.id,
                label: p.label,
                base_url: p.base_url,
                api_protocol: p.api_protocol,
                auth_type: p.auth_type,
                upstream_format: p.upstream_format,
                max_output_tokens_param_name: p.max_output_tokens_param_name,
                max_output_tokens: p.max_output_tokens,
                enabled: false,
                api_key: None,
            },
            revision,
        )
    }
    pub fn delete_model(
        &self,
        actor: &str,
        mutation_id: &str,
        id: &str,
        revision: u64,
    ) -> Result<Model> {
        let digest =
            self.request_hash(&serde_json::json!({"id":id,"expected_revision":revision}))?;
        if let Some(reply) =
            mutation_replay(&self.conn()?, actor, mutation_id, "delete_model", &digest)?
        {
            return from_json(&reply);
        }
        let mut m = self.model(id)?;
        m.config.enabled = false;
        self.put_model_inner(
            actor,
            mutation_id,
            "delete_model",
            digest,
            m.config,
            revision,
        )
    }
    pub fn mutation(&self, id: &str, actor: &str) -> Result<serde_json::Value> {
        uuid(id)?;
        let c = self.conn()?;
        let raw: Option<String> = c
            .query_row(
                "SELECT response FROM mutations WHERE id=?1 AND actor=?2",
                params![id, actor],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage)?;
        from_json(&raw.ok_or(ModelCenterError::NotFound)?)
    }
    fn request_hash(&self, value: &serde_json::Value) -> Result<Vec<u8>> {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&**self.key)
            .map_err(|_| ModelCenterError::Storage)?;
        mac.update(json(value)?.as_bytes());
        Ok(mac.finalize().into_bytes().to_vec())
    }
    fn encrypt(&self, p: &Provider, key: &[u8]) -> Result<Vec<u8>> {
        let cipher = XChaCha20Poly1305::new_from_slice(&**self.key)
            .map_err(|_| ModelCenterError::Storage)?;
        let nonce = rand::random::<[u8; 24]>();
        let encrypted = cipher
            .encrypt(
                &XNonce::from(nonce),
                Payload {
                    msg: key,
                    aad: format!("{}:{}", p.id, p.revision).as_bytes(),
                },
            )
            .map_err(|_| ModelCenterError::Storage)?;
        Ok([nonce.as_slice(), encrypted.as_slice()].concat())
    }
    fn decrypt(&self, c: &Connection, p: &Provider) -> Result<Zeroizing<Vec<u8>>> {
        let secret: Vec<u8> = c
            .query_row("SELECT secret FROM providers WHERE id=?1", [&p.id], |r| {
                r.get(0)
            })
            .map_err(storage)?;
        if secret.len() < 40 {
            return Err(ModelCenterError::Storage);
        }
        let cipher = XChaCha20Poly1305::new_from_slice(&**self.key)
            .map_err(|_| ModelCenterError::Storage)?;
        let plain = cipher
            .decrypt(
                &XNonce::from(
                    <[u8; 24]>::try_from(&secret[..24]).map_err(|_| ModelCenterError::Storage)?,
                ),
                Payload {
                    msg: &secret[24..],
                    aad: format!("{}:{}", p.id, p.revision).as_bytes(),
                },
            )
            .map_err(|_| ModelCenterError::Storage)?;
        Ok(Zeroizing::new(plain))
    }
    pub(crate) fn provider_secret(&self, lease: &SessionLease) -> Result<Zeroizing<Vec<u8>>> {
        let c = self.conn()?;
        check_current(&c, lease)?;
        self.decrypt(&c, &lease.provider)
    }
    /// Only the gateway may use this internal plaintext key for a bounded catalog GET.
    pub(crate) fn provider_secret_for_probe(
        &self,
        id: &str,
    ) -> Result<(Provider, Zeroizing<Vec<u8>>)> {
        uuid(id)?;
        let c = self.conn()?;
        let provider: Provider = fetch(&c, "providers", id)?;
        if !provider.enabled {
            return Err(ModelCenterError::Disabled);
        }
        let secret = self.decrypt(&c, &provider)?;
        Ok((provider, secret))
    }
    #[cfg(test)]
    pub fn issue_bot_credential(
        &self,
        bot: &ValidatedBot,
        ttl_seconds: u64,
    ) -> Result<IssuedCredential> {
        self.issue_bot_credential_for_models(bot, std::slice::from_ref(&bot.model_ref), ttl_seconds)
    }
    /// Mint a finite model grant only after the HTTP owner checks live resource authorization.
    /// No wildcard, automatic future model discovery, or desired-state change broadens this grant.
    pub fn issue_bot_credential_for_models(
        &self,
        bot: &ValidatedBot,
        allowed_model_refs: &[String],
        ttl_seconds: u64,
    ) -> Result<IssuedCredential> {
        validate_bot(bot)?;
        if !(1..=86400).contains(&ttl_seconds)
            || allowed_model_refs.is_empty()
            || allowed_model_refs.len() > 256
            || !allowed_model_refs.contains(&bot.model_ref)
        {
            return Err(ModelCenterError::Invalid);
        }
        let mut seen = std::collections::HashSet::new();
        for model_ref in allowed_model_refs {
            uuid(model_ref)?;
            if !seen.insert(model_ref) {
                return Err(ModelCenterError::Invalid);
            }
        }
        let mut c = self.conn()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let mut max_output_tokens = 0;
        for model_ref in allowed_model_refs {
            let model: Model = fetch(&tx, "models", model_ref)?;
            let provider: Provider = fetch(&tx, "providers", &model.config.provider_id)?;
            if !model.config.enabled || !provider.enabled {
                return Err(ModelCenterError::Disabled);
            }
            if !model.config.owner_ids.contains(&bot.owner_id) {
                return Err(ModelCenterError::Unauthorized);
            }
            max_output_tokens = max_output_tokens.max(provider.max_output_tokens);
        }
        let grant = BotCredentialGrant {
            scope: bot.clone(),
            allowed_model_refs: allowed_model_refs.to_vec(),
            max_output_tokens: max_output_tokens.min(bot.daily_tokens),
        };
        let expiry = now() + ttl_seconds;
        let bearer = new_bearer();
        let id = uuid::Uuid::new_v4().to_string();
        tx.execute("INSERT INTO credentials(id,hash,scope,bot_id,binding,expires) VALUES(?1,?2,'bot',?3,?4,?5)",params![id,hash(&bearer),bot.bot_id,json(&grant)?,expiry]).map_err(storage)?;
        tx.commit().map_err(storage)?;
        Ok(IssuedCredential {
            bearer,
            expires_at: expiry,
        })
    }
    pub fn authenticate_bot_grant(&self, bearer: &str) -> Result<BotCredentialGrant> {
        let c = self.conn()?;
        let (_, binding, _) = credential(&c, bearer, "bot")?;
        parse_bot_grant(&binding)
    }
    #[cfg(test)]
    pub fn authenticate_bot(&self, bearer: &str) -> Result<ValidatedBot> {
        Ok(self.authenticate_bot_grant(bearer)?.scope)
    }
    #[cfg(test)]
    pub fn issue_session(
        &self,
        bot_bearer: &str,
        bot: &ValidatedBot,
        session_id: &str,
        ttl_seconds: u64,
    ) -> Result<IssuedSession> {
        let grant = self.authenticate_bot_grant(bot_bearer)?;
        let model = self.model(&bot.model_ref)?;
        let provider = self.provider(&model.config.provider_id)?;
        self.issue_session_with_limits(
            bot_bearer,
            bot,
            session_id,
            ttl_seconds,
            provider
                .max_output_tokens
                .min(bot.daily_tokens)
                .min(grant.max_output_tokens),
            bot.daily_tokens,
        )
    }
    pub fn issue_session_with_limits(
        &self,
        bot_bearer: &str,
        bot: &ValidatedBot,
        session_id: &str,
        ttl_seconds: u64,
        max_output_tokens: u64,
        max_total_tokens: u64,
    ) -> Result<IssuedSession> {
        validate_bot(bot)?;
        uuid(session_id)?;
        ttl(ttl_seconds)?;
        let mut c = self.conn()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let (_, binding, parent_expiry) = credential(&tx, bot_bearer, "bot")?;
        let grant = parse_bot_grant(&binding)?;
        validate_session_grant(&grant, bot)?;

        let exists:i64=tx.query_row("SELECT COUNT(*) FROM credentials WHERE scope='session' AND json_extract(binding,'$.session_id')=?1",[session_id],|r|r.get(0)).map_err(storage)?;
        if exists != 0 {
            return Err(ModelCenterError::Replay);
        }
        let model: Model = fetch(&tx, "models", &bot.model_ref)?;
        let provider: Provider = fetch(&tx, "providers", &model.config.provider_id)?;
        if !model.config.enabled || !provider.enabled {
            return Err(ModelCenterError::Disabled);
        }
        if !model.config.owner_ids.contains(&bot.owner_id) {
            return Err(ModelCenterError::Unauthorized);
        }
        if max_output_tokens == 0
            || max_output_tokens > provider.max_output_tokens
            || max_output_tokens > grant.max_output_tokens
            || max_output_tokens > max_total_tokens
            || max_total_tokens == 0
            || max_total_tokens > bot.daily_tokens
        {
            return Err(ModelCenterError::Invalid);
        }
        let bearer = new_bearer();
        let lease = SessionLease {
            session_id: session_id.into(),
            credential_id: uuid::Uuid::new_v4().to_string(),
            bot: bot.clone(),
            model,
            provider,
            expires_at: (now() + ttl_seconds).min(parent_expiry),
            max_output_tokens,
            max_total_tokens,
        };
        tx.execute("INSERT INTO credentials(id,hash,scope,bot_id,binding,expires) VALUES(?1,?2,'session',?3,?4,?5)",params![lease.credential_id,hash(&bearer),bot.bot_id,json(&lease)?,lease.expires_at]).map_err(storage)?;
        tx.commit().map_err(storage)?;
        Ok(IssuedSession { bearer, lease })
    }
    pub fn authenticate_session(&self, bearer: &str) -> Result<SessionLease> {
        let c = self.conn()?;
        let (_, binding, _) = credential(&c, bearer, "session")?;
        let lease = from_json(&binding)?;
        check_current(&c, &lease)?;
        Ok(lease)
    }
    pub fn revoke_bot(&self, bot_id: &str) -> Result<()> {
        uuid(bot_id)?;
        self.conn()?
            .execute("UPDATE credentials SET revoked=1 WHERE bot_id=?1", [bot_id])
            .map_err(storage)?;
        Ok(())
    }
    #[cfg(test)]
    pub fn revoke_session(&self, session_id: &str) -> Result<()> {
        uuid(session_id)?;
        self.conn()?.execute("UPDATE credentials SET revoked=1 WHERE scope='session' AND json_extract(binding,'$.session_id')=?1",[session_id]).map_err(storage)?;
        Ok(())
    }
    /// Atomically reserves both quota and concurrency before any upstream bytes are sent.
    #[cfg(test)]
    pub fn reserve(
        &self,
        bearer: &str,
        request_id: &str,
        input_bound: u64,
        output_bound: u64,
    ) -> Result<UsageRecord> {
        self.reserve_inner(bearer, request_id, input_bound, output_bound, None)
    }
    pub fn reserve_with_limits(
        &self,
        bearer: &str,
        request_id: &str,
        input_bound: u64,
        output_bound: u64,
        live_bot: &ValidatedBot,
    ) -> Result<UsageRecord> {
        self.reserve_inner(
            bearer,
            request_id,
            input_bound,
            output_bound,
            Some(live_bot),
        )
    }
    fn reserve_inner(
        &self,
        bearer: &str,
        request_id: &str,
        input_bound: u64,
        output_bound: u64,
        live_bot: Option<&ValidatedBot>,
    ) -> Result<UsageRecord> {
        uuid(request_id)?;
        let mut c = self.conn()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let (_, binding, _) = credential(&tx, bearer, "session")?;
        let mut lease: SessionLease = from_json(&binding)?;
        check_current(&tx, &lease)?;
        if let Some(live) = live_bot {
            validate_bot(live)?;
            if live.bot_id != lease.bot.bot_id
                || live.owner_id != lease.bot.owner_id
                || live.host_id != lease.bot.host_id
                || live.host_key_generation != lease.bot.host_key_generation
                || live.identity_binding_id != lease.bot.identity_binding_id
            {
                return Err(ModelCenterError::Unauthorized);
            }
            lease.bot.daily_tokens = lease.bot.daily_tokens.min(live.daily_tokens);
            lease.bot.concurrency_limit = lease.bot.concurrency_limit.min(live.concurrency_limit);
            lease.bot.daily_cost_microusd =
                match (lease.bot.daily_cost_microusd, live.daily_cost_microusd) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (a, b) => a.or(b),
                };
        }

        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM usage WHERE request_id=?1)",
                [request_id],
                |r| r.get(0),
            )
            .map_err(storage)?;
        if exists {
            return Err(ModelCenterError::Replay);
        }
        if output_bound == 0 || output_bound > lease.max_output_tokens || input_bound > 1_100_000 {
            return Err(ModelCenterError::Invalid);
        }
        let tokens = input_bound
            .checked_add(output_bound)
            .ok_or(ModelCenterError::Invalid)?;
        let cost = cost(&lease.model, input_bound, output_bound)?;
        if lease.bot.daily_cost_microusd.is_some() && cost.is_none() {
            return Err(ModelCenterError::PriceUnknown);
        }
        let started = now();
        let day = started / 86400;
        let (used,spent):(u64,u64)=tx.query_row("SELECT COALESCE(SUM(CAST(json_extract(record,'$.charged_tokens') AS INTEGER)),0),COALESCE(SUM(CAST(json_extract(record,'$.charged_cost_microusd') AS INTEGER)),0) FROM usage WHERE bot_id=?1 AND day=?2",params![lease.bot.bot_id,day],|r|Ok((r.get(0)?,r.get(1)?))).map_err(storage)?;
        let unpriced:u64=tx.query_row("SELECT COUNT(*) FROM usage WHERE bot_id=?1 AND day=?2 AND json_extract(record,'$.charged_cost_microusd') IS NULL",params![lease.bot.bot_id,day],|r|r.get(0)).map_err(storage)?;
        if lease.bot.daily_cost_microusd.is_some() && unpriced > 0 {
            return Err(ModelCenterError::PriceUnknown);
        }
        let all_active: u32 = tx
            .query_row(
                "SELECT COUNT(*) FROM usage WHERE bot_id=?1 AND active=1",
                [&lease.bot.bot_id],
                |r| r.get(0),
            )
            .map_err(storage)?;
        let session_used:u64=tx.query_row("SELECT COALESCE(SUM(CAST(json_extract(record,'$.charged_tokens') AS INTEGER)),0) FROM usage WHERE json_extract(record,'$.session_id')=?1",[&lease.session_id],|r|r.get(0)).map_err(storage)?;
        if session_used
            .checked_add(tokens)
            .is_none_or(|n| n > lease.max_total_tokens)
            || used
                .checked_add(tokens)
                .is_none_or(|n| n > lease.bot.daily_tokens)
            || all_active >= lease.bot.concurrency_limit
            || lease.bot.daily_cost_microusd.is_some_and(|limit| {
                spent
                    .checked_add(cost.unwrap_or(0))
                    .is_none_or(|n| n > limit)
            })
        {
            return Err(ModelCenterError::Quota);
        }
        let record = UsageRecord {
            request_id: request_id.into(),
            bot_id: lease.bot.bot_id.clone(),
            owner_id: lease.bot.owner_id.clone(),
            session_id: lease.session_id.clone(),
            model_ref: lease.model.config.id.clone(),
            model_revision: lease.model.revision,
            provider_revision: lease.provider.revision,
            started_at: started,
            started_at_millis: now_millis(),
            duration_ms: None,
            completed_at: None,
            outcome: "reserved".into(),
            input_tokens: None,
            output_tokens: None,
            reserved_tokens: tokens,
            charged_tokens: tokens,
            reserved_cost_microusd: cost,
            charged_cost_microusd: cost,
            cost_microusd: None,
            price_version: lease.model.config.price_version.clone(),
            usage_known: false,
        };
        tx.execute(
            "INSERT INTO usage VALUES(?1,?2,?3,1,?4)",
            params![request_id, lease.bot.bot_id, day, json(&record)?],
        )
        .map_err(storage)?;
        tx.commit().map_err(storage)?;
        Ok(record)
    }
    /// Unknown/failed/interrupted usage retains the full reservation; retries never re-invoke.
    pub fn settle(
        &self,
        lease: &SessionLease,
        request_id: &str,
        usage: Option<TokenUsage>,
        outcome: &str,
    ) -> Result<()> {
        if ![
            "success",
            "upstream_error",
            "upstream_rejected",
            "timeout",
            "disconnected",
            "revoked",
            "output_limit",
            "interrupted",
        ]
        .contains(&outcome)
        {
            return Err(ModelCenterError::Invalid);
        }
        let mut c = self.conn()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let row: Option<(String, bool)> = tx
            .query_row(
                "SELECT record,active FROM usage WHERE request_id=?1",
                [request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(storage)?;
        let (raw, active) = row.ok_or(ModelCenterError::NotFound)?;
        let mut r: UsageRecord = from_json(&raw)?;
        if r.session_id != lease.session_id {
            return Err(ModelCenterError::Unauthorized);
        }
        if !active {
            return Ok(());
        }
        if outcome != "success" && outcome != "upstream_rejected" {
            block_lease(&tx, &lease.session_id, request_id, outcome)?;
        }
        r.completed_at = Some(now());
        r.duration_ms = Some(now_millis().saturating_sub(r.started_at_millis));
        r.outcome = outcome.into();
        // Only terminal success with verified usage releases quota. Partial stream usage is not final.
        if outcome == "success"
            && let Some(u) = usage
        {
            r.input_tokens = Some(u.input);
            r.output_tokens = Some(u.output);
            r.charged_tokens = u
                .input
                .checked_add(u.output)
                .ok_or(ModelCenterError::Invalid)?;
            r.cost_microusd = cost(&lease.model, u.input, u.output)?;
            r.charged_cost_microusd = r.cost_microusd;
            r.usage_known = true;
        }
        tx.execute(
            "UPDATE usage SET record=?2,active=0 WHERE request_id=?1",
            params![request_id, json(&r)?],
        )
        .map_err(storage)?;
        tx.commit().map_err(storage)?;
        Ok(())
    }
    pub fn usage(&self, limit: usize) -> Result<Vec<UsageRecord>> {
        let c = self.conn()?;
        let mut s = c
            .prepare("SELECT record FROM usage ORDER BY rowid DESC LIMIT ?1")
            .map_err(storage)?;
        let raws = s
            .query_map([limit.clamp(1, 500)], |r| r.get::<_, String>(0))
            .map_err(storage)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(storage)?;
        raws.into_iter().map(|s| from_json(&s)).collect()
    }
    #[cfg(test)]
    pub fn status(&self) -> Result<serde_json::Value> {
        let c = self.conn()?;
        let active: u64 = c
            .query_row("SELECT COUNT(*) FROM usage WHERE active=1", [], |r| {
                r.get(0)
            })
            .map_err(storage)?;
        Ok(
            serde_json::json!({"providers":self.providers()?.len(),"models":self.models()?.len(),"active_calls":active,"provider_keys":"encrypted_at_rest","gateway_bearers":"hash_only","usage_content":"metadata_only"}),
        )
    }
}
fn block_lease(c: &Connection, session_id: &str, request_id: &str, outcome: &str) -> Result<()> {
    c.execute(
        "INSERT INTO blocked_leases VALUES(?1,?2,?3,?4) ON CONFLICT(session_id) DO NOTHING",
        params![session_id, request_id, outcome, now()],
    )
    .map_err(storage)?;
    Ok(())
}
fn check_current(c: &Connection, l: &SessionLease) -> Result<()> {
    let blocked: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM blocked_leases WHERE session_id=?1)",
            [&l.session_id],
            |r| r.get(0),
        )
        .map_err(storage)?;
    if blocked {
        return Err(ModelCenterError::Unauthorized);
    }

    let m: Model = fetch(c, "models", &l.model.config.id)?;
    let p: Provider = fetch(c, "providers", &l.provider.id)?;
    if !m.config.enabled || !p.enabled {
        return Err(ModelCenterError::Disabled);
    }
    if !m.config.owner_ids.contains(&l.bot.owner_id) {
        return Err(ModelCenterError::Unauthorized);
    }
    if p.revision != l.provider.revision {
        return Err(ModelCenterError::Unauthorized);
    }
    Ok(())
}
fn credential(c: &Connection, bearer: &str, scope: &str) -> Result<(String, String, u64)> {
    if bearer.len() != 43 {
        return Err(ModelCenterError::Unauthorized);
    }
    c.query_row("SELECT id,binding,expires FROM credentials WHERE hash=?1 AND scope=?2 AND revoked=0 AND expires>?3",params![hash(bearer),scope,now()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(storage)?.ok_or(ModelCenterError::Unauthorized)
}
fn parse_bot_grant(raw: &str) -> Result<BotCredentialGrant> {
    let value: serde_json::Value = from_json(raw)?;
    if value.get("scope").is_some() {
        return from_json(raw);
    }
    // Existing single-model credentials remain single-model; migration never widens authority.
    let scope: ValidatedBot = from_json(raw)?;
    Ok(BotCredentialGrant {
        allowed_model_refs: vec![scope.model_ref.clone()],
        max_output_tokens: scope.daily_tokens,
        scope,
    })
}
fn same_resource(a: &ValidatedBot, b: &ValidatedBot) -> bool {
    a.bot_id == b.bot_id
        && a.owner_id == b.owner_id
        && a.host_id == b.host_id
        && a.host_key_generation == b.host_key_generation
        && a.identity_binding_id == b.identity_binding_id
}
fn validate_session_grant(grant: &BotCredentialGrant, bot: &ValidatedBot) -> Result<()> {
    if !same_resource(&grant.scope, bot)
        || !grant.allowed_model_refs.contains(&bot.model_ref)
        || bot.daily_tokens > grant.scope.daily_tokens
        || bot.concurrency_limit > grant.scope.concurrency_limit
    {
        return Err(ModelCenterError::Unauthorized);
    }
    if let Some(ceiling) = grant.scope.daily_cost_microusd
        && bot.daily_cost_microusd.is_none_or(|limit| limit > ceiling)
    {
        return Err(ModelCenterError::Unauthorized);
    }
    Ok(())
}
fn validate_bot(b: &ValidatedBot) -> Result<()> {
    for id in [
        &b.bot_id,
        &b.owner_id,
        &b.host_id,
        &b.model_ref,
        &b.identity_binding_id,
    ] {
        uuid(id)?;
    }
    if b.host_key_generation == 0
        || b.binding_revision == 0
        || b.daily_tokens == 0
        || b.daily_tokens > 1_000_000_000
        || b.concurrency_limit == 0
        || b.concurrency_limit > 64
        || b.daily_cost_microusd.is_some_and(|v| v > 1_000_000_000_000)
    {
        return Err(ModelCenterError::Invalid);
    }
    Ok(())
}
fn ttl(v: u64) -> Result<()> {
    if !(1..=900).contains(&v) {
        return Err(ModelCenterError::Invalid);
    }
    Ok(())
}
fn check_revision(old: Option<u64>, expected: u64) -> Result<()> {
    if old.unwrap_or(0) != expected || (old.is_none() && expected != 0) {
        return Err(ModelCenterError::RevisionConflict);
    }
    Ok(())
}
fn optional_fetch<T: serde::de::DeserializeOwned>(
    c: &Connection,
    table: &str,
    id: &str,
) -> Result<Option<T>> {
    match fetch(c, table, id) {
        Ok(value) => Ok(Some(value)),
        Err(ModelCenterError::NotFound) => Ok(None),
        Err(error) => Err(error),
    }
}
fn fetch<T: serde::de::DeserializeOwned>(c: &Connection, table: &str, id: &str) -> Result<T> {
    let s: Option<String> = c
        .query_row(
            &format!("SELECT public FROM {table} WHERE id=?1"),
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(storage)?;
    from_json(&s.ok_or(ModelCenterError::NotFound)?)
}
fn json<T: serde::Serialize>(v: &T) -> Result<String> {
    serde_json::to_string(v).map_err(|_| ModelCenterError::Storage)
}
fn from_json<T: serde::de::DeserializeOwned>(v: &str) -> Result<T> {
    serde_json::from_str(v).map_err(|_| ModelCenterError::Storage)
}
fn uuid(v: &str) -> Result<()> {
    uuid::Uuid::parse_str(v)
        .map(|_| ())
        .map_err(|_| ModelCenterError::Invalid)
}
fn text(v: &str, max: usize) -> Result<()> {
    if v.trim().is_empty() || v.len() > max || v.chars().any(char::is_control) {
        return Err(ModelCenterError::Invalid);
    }
    Ok(())
}
fn storage(_: rusqlite::Error) -> ModelCenterError {
    ModelCenterError::Storage
}
fn hash(v: &str) -> Vec<u8> {
    Sha256::digest(v.as_bytes()).to_vec()
}
fn new_bearer() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}
pub(crate) fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
fn cost(m: &Model, input: u64, output: u64) -> Result<Option<u64>> {
    match (
        m.config.input_price_microusd_per_million,
        m.config.output_price_microusd_per_million,
    ) {
        (Some(a), Some(b)) => {
            let value =
                (input as u128 * a as u128 + output as u128 * b as u128).div_ceil(1_000_000);
            Ok(Some(
                u64::try_from(value).map_err(|_| ModelCenterError::Invalid)?,
            ))
        }
        _ => Ok(None),
    }
}
fn create_private(path: &Path, bytes: &[u8]) -> Result<()> {
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(mut f) => {
            f.write_all(bytes)
                .and_then(|_| f.sync_all())
                .map_err(|_| ModelCenterError::Storage)?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(ModelCenterError::UnsafeState),
    }
    private_file(path)?;
    Ok(())
}
fn private_file(path: &Path) -> Result<fs::File> {
    let md = fs::symlink_metadata(path).map_err(|_| ModelCenterError::UnsafeState)?;
    if !md.is_file()
        || md.file_type().is_symlink()
        || md.nlink() != 1
        || md.mode() & 0o077 != 0
        || md.uid() != nix::unistd::Uid::effective().as_raw()
    {
        return Err(ModelCenterError::UnsafeState);
    }
    let f = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| ModelCenterError::UnsafeState)?;
    let opened = f.metadata().map_err(|_| ModelCenterError::UnsafeState)?;
    if md.ino() != opened.ino() || md.dev() != opened.dev() {
        return Err(ModelCenterError::UnsafeState);
    }
    Ok(f)
}

fn mutation_replay(
    c: &Connection,
    actor: &str,
    id: &str,
    action: &str,
    digest: &[u8],
) -> Result<Option<String>> {
    uuid(actor)?;
    uuid(id)?;
    let row: Option<(String, String, Vec<u8>, String)> = c
        .query_row(
            "SELECT actor,action,hash,response FROM mutations WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(storage)?;
    match row {
        Some((a, b, h, response)) if a == actor && b == action && h == digest => Ok(Some(response)),
        Some(_) => Err(ModelCenterError::Replay),
        None => Ok(None),
    }
}
fn save_mutation(
    c: &Connection,
    actor: &str,
    id: &str,
    action: &str,
    digest: &[u8],
    response: &str,
) -> Result<()> {
    c.execute(
        "INSERT INTO mutations VALUES(?1,?2,?3,?4,?5)",
        params![id, actor, action, digest, response],
    )
    .map_err(storage)?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    pub(crate) struct Fixture {
        pub store: ArcStore,
        pub dir: tempfile::TempDir,
        pub bot: ValidatedBot,
        pub bearer: String,
        pub lease: SessionLease,
    }
    pub(crate) type ArcStore = std::sync::Arc<ModelCenterStore>;
    pub(crate) fn id() -> String {
        uuid::Uuid::new_v4().to_string()
    }
    pub(crate) fn fixture(
        protocol: ApiProtocol,
        auth: AuthType,
        format: UpstreamFormat,
        daily_tokens: u64,
        concurrency_limit: u32,
    ) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let store = std::sync::Arc::new(ModelCenterStore::open(dir.path(), &id()).unwrap());
        let actor = id();
        let provider_id = id();
        let model_id = id();
        store
            .put_provider(
                &actor,
                &id(),
                ProviderWrite {
                    id: provider_id.clone(),
                    label: "fixture".into(),
                    base_url: if protocol == ApiProtocol::Anthropic {
                        "https://fixture.example"
                    } else {
                        "https://fixture.example/v1"
                    }
                    .into(),
                    api_protocol: protocol,
                    auth_type: auth,
                    upstream_format: format,
                    max_output_tokens_param_name: if format == UpstreamFormat::Responses {
                        "max_output_tokens"
                    } else {
                        "max_tokens"
                    }
                    .into(),
                    max_output_tokens: 1024,
                    enabled: true,
                    api_key: Some("fixture-secret-do-not-persist".into()),
                },
                0,
            )
            .unwrap();
        store
            .put_model(
                &actor,
                &id(),
                ModelWrite {
                    id: model_id.clone(),
                    provider_id,
                    model_id: "fixture-model".into(),
                    label: "Fixture model".into(),
                    owner_ids: vec![actor.clone()],
                    enabled: true,
                    input_price_microusd_per_million: Some(2_000_000),
                    output_price_microusd_per_million: Some(6_000_000),
                    price_version: Some("fixture-only".into()),
                },
                0,
            )
            .unwrap();
        let bot = ValidatedBot {
            bot_id: id(),
            owner_id: actor,
            host_id: id(),
            host_key_generation: 1,
            identity_binding_id: id(),
            model_ref: model_id,
            binding_revision: 1,
            daily_tokens,
            daily_cost_microusd: None,
            concurrency_limit,
        };
        let credential = store.issue_bot_credential(&bot, 900).unwrap();
        let issued = store
            .issue_session(&credential.bearer, &bot, &id(), 900)
            .unwrap();
        Fixture {
            store,
            dir,
            bot,
            bearer: issued.bearer,
            lease: issued.lease,
        }
    }
    #[test]
    fn secrets_write_only_encrypted_and_bearers_hashed() {
        let f = fixture(
            ApiProtocol::Anthropic,
            AuthType::ApiKey,
            UpstreamFormat::ChatCompletions,
            10000,
            5,
        );
        let public = serde_json::to_string(&f.store.providers().unwrap()).unwrap();
        assert!(!public.contains("fixture-secret"));
        assert!(!public.contains("api_key\":"));
        for filename in ["model-center.sqlite3", "model-center.sqlite3-wal"] {
            if let Ok(raw) = fs::read(f.dir.path().join(filename)) {
                assert!(
                    !raw.windows(28)
                        .any(|b| b == b"fixture-secret-do-not-persist")
                );
                assert!(
                    !raw.windows(f.bearer.len())
                        .any(|b| b == f.bearer.as_bytes())
                );
            }
        }
        let key = fs::metadata(f.dir.path().join("model-center.key")).unwrap();
        assert_eq!(key.mode() & 0o777, 0o600);
        assert_eq!(
            f.store.provider_secret(&f.lease).unwrap().as_slice(),
            b"fixture-secret-do-not-persist"
        );
    }
    #[test]
    fn atomic_quota_race_and_replay() {
        let f = fixture(
            ApiProtocol::Anthropic,
            AuthType::ApiKey,
            UpstreamFormat::ChatCompletions,
            1000,
            64,
        );
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(16));
        let workers = (0..16)
            .map(|_| {
                let s = f.store.clone();
                let b = f.bearer.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    s.reserve(&b, &id(), 100, 100)
                })
            })
            .collect::<Vec<_>>();
        let results = workers
            .into_iter()
            .map(|w| w.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 5);
        let request = results.iter().find_map(|r| r.as_ref().ok()).unwrap();
        assert!(matches!(
            f.store.reserve(&f.bearer, &request.request_id, 100, 100),
            Err(ModelCenterError::Replay)
        ));
        assert_eq!(f.store.usage(500).unwrap().len(), 5);
    }
    #[test]
    fn concurrency_unknown_reservation_and_terminal_usage() {
        let f = fixture(
            ApiProtocol::Anthropic,
            AuthType::ApiKey,
            UpstreamFormat::ChatCompletions,
            1000,
            1,
        );
        let r = id();
        f.store.reserve(&f.bearer, &r, 100, 100).unwrap();
        assert!(matches!(
            f.store.reserve(&f.bearer, &id(), 100, 100),
            Err(ModelCenterError::Quota)
        ));
        f.store
            .settle(&f.lease, &r, None, "upstream_rejected")
            .unwrap();
        let saved = f.store.usage(5).unwrap().pop().unwrap();
        assert_eq!(saved.charged_tokens, 200);
        assert!(!saved.usage_known);
        assert_eq!(saved.cost_microusd, None);
        assert_eq!(saved.charged_cost_microusd, Some(800));
        let r2 = id();
        f.store.reserve(&f.bearer, &r2, 100, 100).unwrap();
        f.store
            .settle(
                &f.lease,
                &r2,
                Some(TokenUsage {
                    input: 3,
                    output: 7,
                }),
                "success",
            )
            .unwrap();
        let saved = f.store.usage(5).unwrap().remove(0);
        assert_eq!(saved.charged_tokens, 10);
        assert_eq!(saved.cost_microusd, Some(48));
        assert!(saved.usage_known);
    }
    #[test]
    fn model_price_snapshot_immutable_but_authority_revocation_is_live() {
        let f = fixture(
            ApiProtocol::Anthropic,
            AuthType::ApiKey,
            UpstreamFormat::ChatCompletions,
            1000,
            2,
        );
        let mut m = f.lease.model.config.clone();
        m.input_price_microusd_per_million = Some(999);
        f.store
            .put_model(&f.bot.owner_id, &id(), m.clone(), 1)
            .unwrap();
        assert_eq!(
            f.store
                .authenticate_session(&f.bearer)
                .unwrap()
                .model
                .config
                .input_price_microusd_per_million,
            Some(2_000_000)
        );
        m.owner_ids = vec![id()];
        f.store.put_model(&f.bot.owner_id, &id(), m, 2).unwrap();
        assert!(f.store.authenticate_session(&f.bearer).is_err());
    }
    #[test]
    fn credential_revocation_and_provider_disable_block_new_calls() {
        let f = fixture(
            ApiProtocol::Anthropic,
            AuthType::ApiKey,
            UpstreamFormat::ChatCompletions,
            1000,
            2,
        );
        f.store.revoke_bot(&f.bot.bot_id).unwrap();
        assert!(f.store.authenticate_session(&f.bearer).is_err());
        let g = fixture(
            ApiProtocol::Anthropic,
            AuthType::ApiKey,
            UpstreamFormat::ChatCompletions,
            1000,
            2,
        );
        g.store
            .delete_provider(&g.bot.owner_id, &id(), &g.lease.provider.id, 1)
            .unwrap();
        assert!(matches!(
            g.store.authenticate_session(&g.bearer),
            Err(ModelCenterError::Disabled)
        ));
    }
    #[test]
    fn mutation_replay_cas_and_no_secret_receipt() {
        let f = fixture(
            ApiProtocol::Anthropic,
            AuthType::ApiKey,
            UpstreamFormat::ChatCompletions,
            1000,
            2,
        );
        let mut m = f.lease.model.config.clone();
        m.label = "updated".into();
        let op = id();
        let first = f
            .store
            .put_model(&f.bot.owner_id, &op, m.clone(), 1)
            .unwrap();
        assert_eq!(
            f.store
                .put_model(&f.bot.owner_id, &op, m.clone(), 1)
                .unwrap()
                .revision,
            first.revision
        );
        assert!(matches!(
            f.store.put_model(&f.bot.owner_id, &id(), m.clone(), 1),
            Err(ModelCenterError::RevisionConflict)
        ));
        m.label = "other".into();
        assert!(matches!(
            f.store.put_model(&f.bot.owner_id, &op, m, 1),
            Err(ModelCenterError::Replay)
        ));
        let op = id();
        let p = f
            .store
            .delete_provider(&f.bot.owner_id, &op, &f.lease.provider.id, 1)
            .unwrap();
        assert_eq!(
            p.revision,
            f.store
                .delete_provider(&f.bot.owner_id, &op, &f.lease.provider.id, 1)
                .unwrap()
                .revision
        );
        assert!(
            !f.store
                .mutation(&op, &f.bot.owner_id)
                .unwrap()
                .to_string()
                .contains("fixture-secret")
        );
    }
    #[test]
    fn unsafe_key_paths_and_missing_keys_fail_closed() {
        let f = fixture(
            ApiProtocol::Anthropic,
            AuthType::ApiKey,
            UpstreamFormat::ChatCompletions,
            1000,
            2,
        );
        let key = f.dir.path().join("model-center.key");
        fs::remove_file(&key).unwrap();
        assert!(matches!(
            ModelCenterStore::open(f.dir.path(), &id()),
            Err(ModelCenterError::UnsafeState)
        ));
        std::os::unix::fs::symlink("/etc/passwd", &key).unwrap();
        assert!(matches!(
            ModelCenterStore::open(f.dir.path(), &id()),
            Err(ModelCenterError::UnsafeState)
        ));
    }
}

#[cfg(test)]
mod additional_tests {
    use super::tests::{fixture, id};
    use super::*;
    #[test]
    fn session_limits_are_atomic_cumulative_and_scoped() {
        let f = fixture(
            ApiProtocol::Openai,
            AuthType::ApiKey,
            UpstreamFormat::Responses,
            10000,
            8,
        );
        let credential = f.store.issue_bot_credential(&f.bot, 900).unwrap();
        assert!(credential.expires_at > now());
        assert_eq!(f.store.authenticate_bot(&credential.bearer).unwrap(), f.bot);
        let session = f
            .store
            .issue_session_with_limits(&credential.bearer, &f.bot, &id(), 600, 50, 150)
            .unwrap();
        assert_eq!(session.lease.max_output_tokens, 50);
        assert_eq!(session.lease.max_total_tokens, 150);
        assert!(matches!(
            f.store.reserve(&session.bearer, &id(), 1, 51),
            Err(ModelCenterError::Invalid)
        ));
        let request = id();
        f.store.reserve(&session.bearer, &request, 50, 50).unwrap();
        f.store
            .settle(&session.lease, &request, None, "success")
            .unwrap();
        assert!(matches!(
            f.store.reserve(&session.bearer, &id(), 1, 50),
            Err(ModelCenterError::Quota)
        ));
        f.store.revoke_session(&session.lease.session_id).unwrap();
        assert!(f.store.authenticate_session(&session.bearer).is_err());
        assert!(f.store.authenticate_session(&f.bearer).is_ok());
    }
    #[test]
    fn money_reservation_and_unknown_prices_never_become_zero() {
        let mut f = fixture(
            ApiProtocol::Anthropic,
            AuthType::ApiKey,
            UpstreamFormat::ChatCompletions,
            10000,
            5,
        );
        f.bot.daily_cost_microusd = Some(800);
        let credential = f.store.issue_bot_credential(&f.bot, 900).unwrap();
        let session = f
            .store
            .issue_session(&credential.bearer, &f.bot, &id(), 900)
            .unwrap();
        let request = id();
        f.store
            .reserve(&session.bearer, &request, 100, 100)
            .unwrap();
        f.store
            .settle(&session.lease, &request, None, "success")
            .unwrap();
        assert!(matches!(
            f.store.reserve(&session.bearer, &id(), 1, 1),
            Err(ModelCenterError::Quota)
        ));
        let mut model = f.lease.model.config.clone();
        model.input_price_microusd_per_million = None;
        model.output_price_microusd_per_million = None;
        f.store.put_model(&f.bot.owner_id, &id(), model, 1).unwrap();
        let session = f
            .store
            .issue_session(&credential.bearer, &f.bot, &id(), 900)
            .unwrap();
        assert!(matches!(
            f.store.reserve(&session.bearer, &id(), 1, 1),
            Err(ModelCenterError::PriceUnknown)
        ));
        let r = f.store.usage(1).unwrap().remove(0);
        assert_eq!(r.cost_microusd, None);
        assert_eq!(r.charged_cost_microusd, Some(800));
    }
    #[test]
    fn provider_rotation_write_replay_and_state_reopen_do_not_release_live_calls() {
        let f = fixture(
            ApiProtocol::Anthropic,
            AuthType::ApiKey,
            UpstreamFormat::ChatCompletions,
            10000,
            1,
        );
        let request = id();
        f.store.reserve(&f.bearer, &request, 100, 100).unwrap();
        let c = f.store.conn().unwrap();
        let network: String = c
            .query_row("SELECT network_id FROM pin", [], |r| r.get(0))
            .unwrap();
        drop(c);
        let reopened = ModelCenterStore::open(f.dir.path(), &network).unwrap();
        assert_eq!(reopened.status().unwrap()["active_calls"], 1);
        assert!(matches!(
            reopened.reserve(&f.bearer, &id(), 1, 1),
            Err(ModelCenterError::Quota)
        ));
        assert_eq!(reopened.recover_interrupted_calls().unwrap(), 1);
        assert!(matches!(
            reopened.reserve(&f.bearer, &request, 100, 100),
            Err(ModelCenterError::Unauthorized)
        ));
        let p = f.lease.provider.clone();
        let write = ProviderWrite {
            id: p.id,
            label: p.label,
            base_url: p.base_url,
            api_protocol: p.api_protocol,
            auth_type: p.auth_type,
            upstream_format: p.upstream_format,
            max_output_tokens_param_name: p.max_output_tokens_param_name,
            max_output_tokens: p.max_output_tokens,
            enabled: true,
            api_key: Some("new-fixture-secret".into()),
        };
        let op = id();
        let first = f
            .store
            .put_provider(&f.bot.owner_id, &op, write.clone(), 1)
            .unwrap();
        assert_eq!(
            f.store
                .put_provider(&f.bot.owner_id, &op, write, 1)
                .unwrap()
                .revision,
            first.revision
        );
        assert!(f.store.authenticate_session(&f.bearer).is_err());
        assert!(
            !f.store
                .mutation(&op, &f.bot.owner_id)
                .unwrap()
                .to_string()
                .contains("secret")
        );
    }
}

#[cfg(test)]
mod finite_grant_tests {
    use super::tests::{Fixture, fixture, id};
    use super::*;
    fn add_model(f: &Fixture, label: &str) -> String {
        let mut model = f.lease.model.config.clone();
        model.id = id();
        model.model_id = label.into();
        model.label = label.into();
        let model_id = model.id.clone();
        f.store.put_model(&f.bot.owner_id, &id(), model, 0).unwrap();
        model_id
    }
    #[test]
    fn approved_desired_switch_issues_new_snapshot_without_changing_old_lease() {
        let f = fixture(
            ApiProtocol::Anthropic,
            AuthType::ApiKey,
            UpstreamFormat::ChatCompletions,
            10000,
            8,
        );
        let second = add_model(&f, "approved-second-model");
        let unapproved = add_model(&f, "unapproved-third-model");
        let credential = f
            .store
            .issue_bot_credential_for_models(
                &f.bot,
                &[f.bot.model_ref.clone(), second.clone()],
                86400,
            )
            .unwrap();
        let grant = f.store.authenticate_bot_grant(&credential.bearer).unwrap();
        assert_eq!(grant.allowed_model_refs.len(), 2);
        assert_eq!(grant.scope.bot_id, f.bot.bot_id);
        assert!(credential.expires_at > now() + 80000);
        let before = f
            .store
            .issue_session_with_limits(&credential.bearer, &f.bot, &id(), 900, 32, 1000)
            .unwrap();
        let mut desired = f.bot.clone();
        desired.model_ref = second;
        desired.binding_revision += 1;
        let after = f
            .store
            .issue_session_with_limits(&credential.bearer, &desired, &id(), 900, 32, 1000)
            .unwrap();
        assert_eq!(after.lease.model.config.model_id, "approved-second-model");
        assert_eq!(after.lease.bot.binding_revision, 2);
        let old = f.store.authenticate_session(&before.bearer).unwrap();
        assert_eq!(old.model.config.model_id, "fixture-model");
        assert_eq!(old.bot.binding_revision, 1);
        assert_eq!(
            f.store
                .authenticate_session(&f.bearer)
                .unwrap()
                .model
                .config
                .model_id,
            "fixture-model"
        );
        desired.model_ref = unapproved;
        assert!(matches!(
            f.store
                .issue_session(&credential.bearer, &desired, &id(), 900),
            Err(ModelCenterError::Unauthorized)
        ));
        let singleton = f.store.issue_bot_credential(&f.bot, 900).unwrap();
        desired.model_ref = after.lease.model.config.id;
        assert!(matches!(
            f.store
                .issue_session(&singleton.bearer, &desired, &id(), 900),
            Err(ModelCenterError::Unauthorized)
        ));
    }
    #[test]
    fn grant_rejects_resource_identity_changes_and_expanded_budget_ceilings() {
        let mut f = fixture(
            ApiProtocol::Anthropic,
            AuthType::ApiKey,
            UpstreamFormat::ChatCompletions,
            10000,
            8,
        );
        f.bot.daily_cost_microusd = Some(200);
        let credential = f.store.issue_bot_credential(&f.bot, 86400).unwrap();
        let mut variants = Vec::new();
        let mut changed = f.bot.clone();
        changed.owner_id = id();
        variants.push(changed);
        let mut changed = f.bot.clone();
        changed.host_id = id();
        variants.push(changed);
        let mut changed = f.bot.clone();
        changed.host_key_generation += 1;
        variants.push(changed);
        let mut changed = f.bot.clone();
        changed.identity_binding_id = id();
        variants.push(changed);
        let mut changed = f.bot.clone();
        changed.bot_id = id();
        variants.push(changed);
        let mut changed = f.bot.clone();
        changed.daily_tokens += 1;
        variants.push(changed);
        let mut changed = f.bot.clone();
        changed.concurrency_limit += 1;
        variants.push(changed);
        let mut changed = f.bot.clone();
        changed.daily_cost_microusd = None;
        variants.push(changed);
        let mut changed = f.bot.clone();
        changed.daily_cost_microusd = Some(201);
        variants.push(changed);
        for variant in variants {
            assert!(matches!(
                f.store.issue_session_with_limits(
                    &credential.bearer,
                    &variant,
                    &id(),
                    900,
                    32,
                    1000
                ),
                Err(ModelCenterError::Unauthorized)
            ));
        }
        let mut reduced = f.bot.clone();
        reduced.binding_revision += 7;
        reduced.daily_tokens = 1000;
        reduced.concurrency_limit = 1;
        reduced.daily_cost_microusd = Some(100);
        assert!(
            f.store
                .issue_session_with_limits(&credential.bearer, &reduced, &id(), 900, 32, 1000)
                .is_ok()
        );
        let p = f.lease.provider.clone();
        f.store
            .put_provider(
                &f.bot.owner_id,
                &id(),
                ProviderWrite {
                    id: p.id,
                    label: p.label,
                    base_url: p.base_url,
                    api_protocol: p.api_protocol,
                    auth_type: p.auth_type,
                    upstream_format: p.upstream_format,
                    max_output_tokens_param_name: p.max_output_tokens_param_name,
                    max_output_tokens: 2048,
                    enabled: true,
                    api_key: None,
                },
                1,
            )
            .unwrap();
        assert!(matches!(
            f.store
                .issue_session_with_limits(&credential.bearer, &f.bot, &id(), 900, 1536, 10000),
            Err(ModelCenterError::Invalid)
        ));
        assert_eq!(
            f.store
                .issue_session(&credential.bearer, &f.bot, &id(), 900)
                .unwrap()
                .lease
                .max_output_tokens,
            1024
        );
    }
    #[test]
    fn grant_lists_have_no_wildcard_duplicates_or_future_authorization() {
        let f = fixture(
            ApiProtocol::Anthropic,
            AuthType::ApiKey,
            UpstreamFormat::ChatCompletions,
            10000,
            8,
        );
        for refs in [
            vec![],
            vec!["*".into()],
            vec![f.bot.model_ref.clone(), f.bot.model_ref.clone()],
            vec![id()],
        ] {
            assert!(
                f.store
                    .issue_bot_credential_for_models(&f.bot, &refs, 900)
                    .is_err()
            );
        }
    }
}

#[cfg(test)]
mod startup_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn second_owner_cannot_recover_live_calls_and_guard_release_allows_restart() {
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let network = uuid::Uuid::new_v4().to_string();
        let store = ModelCenterStore::open(dir.path(), &network).unwrap();
        let (guard, recovered) = store.start_exclusive().unwrap();
        assert_eq!(recovered, 0);
        let second = ModelCenterStore::open(dir.path(), &network).unwrap();
        assert!(second.start_exclusive().is_err());
        drop(guard);
        assert!(second.start_exclusive().is_ok());
    }
}
