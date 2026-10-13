//! Closed finite-Bot execution wire contract. Authentication, actual device
//! ownership, durable grants/receipts and application are external owners.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, jwk::JwkSet};
use serde::{Deserialize, Deserializer, Serialize, de};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const NAMESPACE: &str = "moxbot.bot.execution/v1";
pub const AUDIENCE: &str = "moxbot-host-bots/v1";
pub const GRANT_TYP: &str = "moxbot-execution-grant+jwt";
pub const INTENT_TYP: &str = "moxbot-execution-intent+jwt";
pub const LEASE_TYP: &str = "moxbot-execution-lease+jwt";
pub const REVOCATION_TYP: &str = "moxbot-execution-revocation+jwt";
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const MAX_OBJECT_BYTES: usize = 64 * 1024;
pub const MAX_JWT_BYTES: usize = 128 * 1024;
pub const MAX_COLLECTION_ITEMS: usize = 64;
pub const MAX_PROOF_SECONDS: u64 = 300;
pub const MAX_LEASE_SECONDS: u64 = 15;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecutionError(pub &'static str);
impl std::fmt::Display for ExecutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for ExecutionError {}
type Result<T> = std::result::Result<T, ExecutionError>;
fn invalid() -> ExecutionError {
    ExecutionError("EXECUTION_INVALID")
}
fn require(ok: bool) -> Result<()> {
    if ok { Ok(()) } else { Err(invalid()) }
}
fn safe<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<u64, D::Error> {
    let n = u64::deserialize(d)?;
    if n > MAX_SAFE_INTEGER {
        Err(de::Error::custom("unsafe integer"))
    } else {
        Ok(n)
    }
}
fn nullable_string<'de, D: Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)
}
fn counter(n: u64, positive: bool) -> bool {
    n <= MAX_SAFE_INTEGER && (!positive || n > 0)
}
fn uuid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok_and(|id| id.to_string() == s)
}
fn text(s: &str, max: usize) -> bool {
    s.len() <= max && !s.contains('\0')
}
fn identifier(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn relative(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 1024
        && s.split('/')
            .all(|p| identifier(p, 128) && p != "." && p != "..")
}
fn unique<T: Ord>(values: &[T]) -> bool {
    !values.is_empty()
        && values.len() <= MAX_COLLECTION_ITEMS
        && values.iter().collect::<BTreeSet<_>>().len() == values.len()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionScope {
    pub issuer: String,
    pub service_id: String,
    pub environment: String,
    pub network_id: String,
    pub host_owner_id: String,
    pub host_device_id: String,
    #[serde(deserialize_with = "safe")]
    pub host_key_generation: u64,
    pub identity_binding_id: String,
}
impl ExecutionScope {
    pub fn validate(&self) -> Result<()> {
        let url = url::Url::parse(&self.issuer).map_err(|_| invalid())?;
        require(
            self.issuer.len() <= 2048
                && url.scheme() == "https"
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none()
                && url.origin().ascii_serialization() == self.issuer
                && ["production", "development"].contains(&self.environment.as_str())
                && [
                    &self.service_id,
                    &self.network_id,
                    &self.host_owner_id,
                    &self.host_device_id,
                    &self.identity_binding_id,
                ]
                .iter()
                .all(|s| uuid(s))
                && counter(self.host_key_generation, true),
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Method {
    Create,
    Configure,
    Enable,
    Disable,
    Delete,
    Restore,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Grant {
    pub id: String,
    #[serde(deserialize_with = "safe")]
    pub generation: u64,
    pub scope: ExecutionScope,
    pub bot_id: String,
    pub root_id: String,
    pub relative_path: String,
    pub operations: Vec<Method>,
    pub allowed_runtimes: Vec<String>,
    pub allowed_model_refs: Vec<String>,
    #[serde(deserialize_with = "safe")]
    pub max_daily_tokens: u64,
    #[serde(deserialize_with = "safe")]
    pub expires_at: u64,
}
impl Grant {
    pub fn validate(&self) -> Result<()> {
        self.scope.validate()?;
        require(
            uuid(&self.id)
                && uuid(&self.bot_id)
                && counter(self.generation, true)
                && identifier(&self.root_id, 64)
                && relative(&self.relative_path)
                && unique(&self.operations)
                && unique(&self.allowed_runtimes)
                && self.allowed_runtimes.iter().all(|s| identifier(s, 64))
                && self.allowed_model_refs.len() <= MAX_COLLECTION_ITEMS
                && self.allowed_model_refs.iter().all(|s| uuid(s))
                && self
                    .allowed_model_refs
                    .iter()
                    .collect::<BTreeSet<_>>()
                    .len()
                    == self.allowed_model_refs.len()
                && counter(self.max_daily_tokens, true)
                && counter(self.expires_at, true),
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BotConfig {
    pub name: String,
    pub description: String,
    pub runtime: String,
    #[serde(deserialize_with = "nullable_string")]
    pub model_ref: Option<String>,
    pub system_prompt: String,
    #[serde(deserialize_with = "safe")]
    pub daily_tokens: u64,
}
impl BotConfig {
    pub fn validate(&self) -> Result<()> {
        require(
            !self.name.trim().is_empty()
                && self.name.chars().count() <= 60
                && text(&self.name, 240)
                && text(&self.description, 4096)
                && identifier(&self.runtime, 64)
                && self.model_ref.as_ref().is_none_or(|id| uuid(id))
                && text(&self.system_prompt, 16384)
                && counter(self.daily_tokens, true),
        )
    }
    pub fn authorized_by(&self, grant: &Grant) -> Result<()> {
        self.validate()?;
        require(
            grant.allowed_runtimes.contains(&self.runtime)
                && self
                    .model_ref
                    .as_ref()
                    .is_none_or(|id| grant.allowed_model_refs.contains(id))
                && self.daily_tokens <= grant.max_daily_tokens,
        )
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateParams {
    pub name: String,
    pub description: String,
    pub runtime: String,
    #[serde(deserialize_with = "nullable_string")]
    pub model_ref: Option<String>,
    pub system_prompt: String,
    #[serde(deserialize_with = "safe")]
    pub daily_tokens: u64,
    #[serde(deserialize_with = "safe")]
    pub resource_expected_revision: u64,
}
impl CreateParams {
    pub fn config(&self) -> BotConfig {
        BotConfig {
            name: self.name.clone(),
            description: self.description.clone(),
            runtime: self.runtime.clone(),
            model_ref: self.model_ref.clone(),
            system_prompt: self.system_prompt.clone(),
            daily_tokens: self.daily_tokens,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyParams {}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisablePolicy {
    Cancel,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DisableParams {
    pub policy: DisablePolicy,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteParams {
    pub confirmation: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "method",
    content = "params",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Operation {
    Create(CreateParams),
    Configure(BotConfig),
    Enable(EmptyParams),
    Disable(DisableParams),
    Delete(DeleteParams),
    Restore(EmptyParams),
}
impl Operation {
    pub fn method(&self) -> Method {
        match self {
            Self::Create(_) => Method::Create,
            Self::Configure(_) => Method::Configure,
            Self::Enable(_) => Method::Enable,
            Self::Disable(_) => Method::Disable,
            Self::Delete(_) => Method::Delete,
            Self::Restore(_) => Method::Restore,
        }
    }
    fn validate(&self) -> Result<()> {
        match self {
            Self::Create(p) => {
                p.config().validate()?;
                require(counter(p.resource_expected_revision, false))
            }
            Self::Configure(p) => p.validate(),
            Self::Delete(p) => require(
                !p.confirmation.trim().is_empty()
                    && p.confirmation.chars().count() <= 60
                    && text(&p.confirmation, 240),
            ),
            _ => Ok(()),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub mutation_id: String,
    pub request_hash: String,
    pub actor_principal_id: String,
    pub actor_session_handle: String,
    pub grant_id: String,
    #[serde(deserialize_with = "safe")]
    pub grant_generation: u64,
    pub bot_id: String,
    #[serde(deserialize_with = "safe")]
    pub binding_generation: u64,
    #[serde(deserialize_with = "safe")]
    pub expected_host_revision: u64,
    pub operation: Operation,
}
impl Command {
    pub fn validate(&self) -> Result<()> {
        self.operation.validate()?;
        require(
            [
                &self.mutation_id,
                &self.actor_principal_id,
                &self.actor_session_handle,
                &self.grant_id,
                &self.bot_id,
            ]
            .iter()
            .all(|s| uuid(s))
                && counter(self.grant_generation, true)
                && counter(self.binding_generation, false)
                && counter(self.expected_host_revision, false)
                && digest(&self.request_hash)
                && self.request_hash == command_hash(self)?,
        )
    }
    pub fn authorized_by(&self, grant: &Grant) -> Result<()> {
        self.validate()?;
        grant.validate()?;
        require(
            self.grant_id == grant.id
                && self.grant_generation == grant.generation
                && self.bot_id == grant.bot_id
                && grant.operations.contains(&self.operation.method()),
        )?;
        match &self.operation {
            Operation::Create(p) => p.config().authorized_by(grant),
            Operation::Configure(p) => p.authorized_by(grant),
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Admission {
    Closed,
    Open,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Activity {
    Idle,
    Running,
    Stopping,
    Stopped,
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActiveRun {
    pub session_id: String,
    pub run_generation: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BotSnapshot {
    pub bot_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(deserialize_with = "safe")]
    pub binding_generation: u64,
    #[serde(deserialize_with = "safe")]
    pub revision: u64,
    pub deleted: bool,
    pub admission: Admission,
    pub activity: Activity,
    pub configured: bool,
    pub runnable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsupported_reason: Option<String>,
    pub config: BotConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_run: Option<ActiveRun>,
}
impl BotSnapshot {
    pub fn validate(&self) -> Result<()> {
        self.config.validate()?;
        require(
            uuid(&self.bot_id)
                && counter(self.binding_generation, false)
                && counter(self.revision, false)
                && self
                    .agent_id
                    .as_ref()
                    .is_none_or(|s| !s.is_empty() && text(s, 256))
                && self
                    .unsupported_reason
                    .as_ref()
                    .is_none_or(|s| identifier(s, 128))
                && self
                    .active_run
                    .as_ref()
                    .is_none_or(|r| uuid(&r.session_id) && uuid(&r.run_generation))
                && (!self.runnable
                    || (self.configured
                        && self.agent_id.is_some()
                        && self.binding_generation > 0
                        && !self.deleted
                        && self.unsupported_reason.is_none()))
                && (self.admission != Admission::Open || self.runnable)
                && (self.activity != Activity::Running
                    || (self.runnable && self.active_run.is_some()))
                && (self.activity != Activity::Stopped
                    || (self.admission == Admission::Closed && self.active_run.is_none()))
                && (!self.deleted
                    || (self.admission == Admission::Closed
                        && self.active_run.is_none()
                        && self.activity == Activity::Stopped)),
        )
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptStatus {
    Persisted,
    Conflict,
    Failed,
    Unconfirmed,
}
/// Authenticated report for display only, never execution authority or a receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostObservation {
    #[serde(deserialize_with = "safe")]
    pub host_revision: u64,
    #[serde(deserialize_with = "safe")]
    pub resource_revision: u64,
    pub root_ids: Vec<String>,
    pub supported_runtimes: Vec<String>,
    pub allowed_bot_ids: Vec<String>,
    pub allowed_model_refs: Vec<String>,
    #[serde(deserialize_with = "safe")]
    pub max_daily_tokens: u64,
    #[serde(deserialize_with = "safe")]
    pub policy_expires_at: u64,
    pub snapshots: Vec<BotSnapshot>,
}
impl HostObservation {
    pub fn validate(&self) -> Result<()> {
        let bounded_unique = |v: &[String]| {
            v.len() <= MAX_COLLECTION_ITEMS && v.iter().collect::<BTreeSet<_>>().len() == v.len()
        };
        require(
            counter(self.host_revision, false)
                && counter(self.resource_revision, false)
                && counter(self.max_daily_tokens, false)
                && counter(self.policy_expires_at, true)
                && bounded_unique(&self.root_ids)
                && self.root_ids.iter().all(|s| identifier(s, 64))
                && bounded_unique(&self.supported_runtimes)
                && self.supported_runtimes.iter().all(|s| identifier(s, 64))
                && bounded_unique(&self.allowed_bot_ids)
                && self.allowed_bot_ids.iter().all(|s| uuid(s))
                && bounded_unique(&self.allowed_model_refs)
                && self.allowed_model_refs.iter().all(|s| uuid(s))
                && self.snapshots.len() <= MAX_COLLECTION_ITEMS
                && self
                    .snapshots
                    .iter()
                    .map(|s| &s.bot_id)
                    .collect::<BTreeSet<_>>()
                    .len()
                    == self.snapshots.len(),
        )?;
        for s in &self.snapshots {
            s.validate()?;
            require(self.allowed_bot_ids.contains(&s.bot_id))?;
        }
        canonical_bytes(&serde_json::to_value(self).map_err(|_| invalid())?)?;
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub mutation_id: String,
    pub request_hash: String,
    pub grant_id: String,
    #[serde(deserialize_with = "safe")]
    pub grant_generation: u64,
    pub bot_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(deserialize_with = "safe")]
    pub binding_generation: u64,
    #[serde(deserialize_with = "safe")]
    pub revision: u64,
    pub status: ReceiptStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<BotSnapshot>,
}
impl Receipt {
    pub fn validate(&self) -> Result<()> {
        require(
            uuid(&self.mutation_id)
                && digest(&self.request_hash)
                && uuid(&self.grant_id)
                && uuid(&self.bot_id)
                && counter(self.grant_generation, true)
                && counter(self.binding_generation, false)
                && counter(self.revision, false)
                && self
                    .agent_id
                    .as_ref()
                    .is_none_or(|s| !s.is_empty() && text(s, 256))
                && self.code.as_ref().is_none_or(|s| identifier(s, 128)),
        )?;
        if let Some(s) = &self.snapshot {
            s.validate()?;
            require(
                s.bot_id == self.bot_id
                    && s.agent_id == self.agent_id
                    && s.binding_generation == self.binding_generation
                    && s.revision == self.revision,
            )?;
        }
        require(self.status != ReceiptStatus::Unconfirmed || self.snapshot.is_none())
    }
    pub fn matches_command(&self, command: &Command) -> Result<()> {
        self.validate()?;
        command.validate()?;
        require(
            self.mutation_id == command.mutation_id
                && self.request_hash == command.request_hash
                && self.grant_id == command.grant_id
                && self.grant_generation == command.grant_generation
                && self.bot_id == command.bot_id,
        )
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostContext {
    pub challenge_nonce: String,
    #[serde(deserialize_with = "safe")]
    pub local_auth_generation: u64,
    pub boot_epoch: String,
    pub connection_epoch: String,
    #[serde(deserialize_with = "safe")]
    pub membership_revision: u64,
}
impl HostContext {
    pub fn validate(&self) -> Result<()> {
        require(
            [
                &self.challenge_nonce,
                &self.boot_epoch,
                &self.connection_epoch,
            ]
            .iter()
            .all(|s| uuid(s))
                && counter(self.local_auth_generation, true)
                && counter(self.membership_revision, true),
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GrantClaims {
    pub iss: String,
    pub aud: String,
    pub namespace: String,
    #[serde(deserialize_with = "safe")]
    pub iat: u64,
    #[serde(deserialize_with = "safe")]
    pub nbf: u64,
    #[serde(deserialize_with = "safe")]
    pub exp: u64,
    pub jti: String,
    pub grant: Grant,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntentClaims {
    pub iss: String,
    pub aud: String,
    pub namespace: String,
    #[serde(deserialize_with = "safe")]
    pub iat: u64,
    #[serde(deserialize_with = "safe")]
    pub nbf: u64,
    #[serde(deserialize_with = "safe")]
    pub exp: u64,
    pub jti: String,
    pub scope: ExecutionScope,
    pub grant: Grant,
    pub command: Command,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LeaseClaims {
    pub iss: String,
    pub aud: String,
    pub namespace: String,
    #[serde(deserialize_with = "safe")]
    pub iat: u64,
    #[serde(deserialize_with = "safe")]
    pub nbf: u64,
    #[serde(deserialize_with = "safe")]
    pub exp: u64,
    pub jti: String,
    pub scope: ExecutionScope,
    pub grant_id: String,
    #[serde(deserialize_with = "safe")]
    pub grant_generation: u64,
    pub bot_id: String,
    #[serde(deserialize_with = "safe")]
    pub binding_generation: u64,
    pub mutation_id: String,
    pub request_hash: String,
    pub intent_hash: String,
    pub host_context: HostContext,
    pub lease_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RevocationClaims {
    pub iss: String,
    pub aud: String,
    pub namespace: String,
    #[serde(deserialize_with = "safe")]
    pub iat: u64,
    #[serde(deserialize_with = "safe")]
    pub nbf: u64,
    #[serde(deserialize_with = "safe")]
    pub exp: u64,
    pub jti: String,
    pub scope: ExecutionScope,
    pub grant_id: String,
    #[serde(deserialize_with = "safe")]
    pub revoked_generation: u64,
    pub bot_id: String,
    pub host_context: HostContext,
}
#[allow(clippy::too_many_arguments)]
fn time(
    iss: &str,
    aud: &str,
    ns: &str,
    t: (u64, u64, u64),
    jti: &str,
    scope: &ExecutionScope,
    now: u64,
    ttl: u64,
) -> Result<()> {
    scope.validate()?;
    let (iat, nbf, exp) = t;
    require(
        iss == scope.issuer
            && aud == AUDIENCE
            && ns == NAMESPACE
            && uuid(jti)
            && [iat, nbf, exp, now].iter().all(|&n| counter(n, false))
            && nbf == iat
            && iat <= now
            && now < exp
            && exp > iat
            && exp - iat <= ttl,
    )
}
impl GrantClaims {
    pub fn validate_at(&self, scope: &ExecutionScope, now: u64) -> Result<()> {
        self.grant.validate()?;
        time(
            &self.iss,
            &self.aud,
            &self.namespace,
            (self.iat, self.nbf, self.exp),
            &self.jti,
            scope,
            now,
            MAX_PROOF_SECONDS,
        )?;
        require(&self.grant.scope == scope && self.exp <= self.grant.expires_at)
    }
}
impl IntentClaims {
    pub fn validate_at(&self, scope: &ExecutionScope, now: u64) -> Result<()> {
        self.command.authorized_by(&self.grant)?;
        time(
            &self.iss,
            &self.aud,
            &self.namespace,
            (self.iat, self.nbf, self.exp),
            &self.jti,
            scope,
            now,
            MAX_PROOF_SECONDS,
        )?;
        require(
            &self.scope == scope && &self.grant.scope == scope && self.exp <= self.grant.expires_at,
        )
    }
}
impl LeaseClaims {
    pub fn validate_at(&self, scope: &ExecutionScope, now: u64) -> Result<()> {
        self.host_context.validate()?;
        time(
            &self.iss,
            &self.aud,
            &self.namespace,
            (self.iat, self.nbf, self.exp),
            &self.jti,
            scope,
            now,
            MAX_LEASE_SECONDS,
        )?;
        require(
            &self.scope == scope
                && [
                    &self.grant_id,
                    &self.bot_id,
                    &self.mutation_id,
                    &self.lease_id,
                ]
                .iter()
                .all(|s| uuid(s))
                && counter(self.grant_generation, true)
                && counter(self.binding_generation, false)
                && digest(&self.request_hash)
                && digest(&self.intent_hash),
        )
    }
    pub fn matches_intent(
        &self,
        intent: &IntentClaims,
        context: &HostContext,
        now: u64,
    ) -> Result<()> {
        self.validate_at(&intent.scope, now)?;
        intent.validate_at(&intent.scope, now)?;
        context.validate()?;
        let c = &intent.command;
        require(
            self.intent_hash == intent_hash(intent)?
                && self.exp <= intent.exp
                && self.exp <= intent.grant.expires_at
                && self.grant_id == c.grant_id
                && self.grant_generation == c.grant_generation
                && self.bot_id == c.bot_id
                && self.binding_generation == c.binding_generation
                && self.mutation_id == c.mutation_id
                && self.request_hash == c.request_hash
                && &self.host_context == context,
        )
    }
}
impl RevocationClaims {
    pub fn validate_at(&self, scope: &ExecutionScope, now: u64) -> Result<()> {
        self.host_context.validate()?;
        time(
            &self.iss,
            &self.aud,
            &self.namespace,
            (self.iat, self.nbf, self.exp),
            &self.jti,
            scope,
            now,
            MAX_LEASE_SECONDS,
        )?;
        require(
            &self.scope == scope
                && uuid(&self.grant_id)
                && uuid(&self.bot_id)
                && counter(self.revoked_generation, true),
        )
    }
    pub fn matches_target(
        &self,
        scope: &ExecutionScope,
        context: &HostContext,
        grant_id: &str,
        bot_id: &str,
        generation: u64,
        now: u64,
    ) -> Result<()> {
        self.validate_at(scope, now)?;
        context.validate()?;
        require(
            &self.host_context == context
                && self.grant_id == grant_id
                && self.bot_id == bot_id
                && self.revoked_generation == generation,
        )
    }
}

/// UTF-8 JSON; recursively sorted keys, bounded integers, no floating point.
/// Contract keys are ASCII, so Rust string ordering and Node ordering agree.
pub fn canonical_bytes(value: &Value) -> Result<Vec<u8>> {
    fn write(v: &Value, out: &mut Vec<u8>, depth: usize) -> Result<()> {
        require(depth <= 32)?;
        match v {
            Value::Object(map) => {
                out.push(b'{');
                let mut keys: Vec<_> = map.keys().collect();
                keys.sort();
                for (i, k) in keys.iter().enumerate() {
                    require(k.is_ascii())?;
                    if i > 0 {
                        out.push(b',');
                    }
                    serde_json::to_writer(&mut *out, k).map_err(|_| invalid())?;
                    out.push(b':');
                    write(&map[*k], out, depth + 1)?;
                }
                out.push(b'}');
            }
            Value::Array(a) => {
                out.push(b'[');
                for (i, x) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(b',');
                    }
                    write(x, out, depth + 1)?;
                }
                out.push(b']');
            }
            Value::Number(n) => {
                require(n.as_u64().is_some_and(|n| n <= MAX_SAFE_INTEGER))?;
                serde_json::to_writer(&mut *out, n).map_err(|_| invalid())?;
            }
            _ => serde_json::to_writer(&mut *out, v).map_err(|_| invalid())?,
        }
        require(out.len() <= MAX_OBJECT_BYTES)
    }
    let mut out = Vec::new();
    write(value, &mut out, 0)?;
    Ok(out)
}
pub fn command_hash(command: &Command) -> Result<String> {
    let mut value = serde_json::to_value(command).map_err(|_| invalid())?;
    value
        .as_object_mut()
        .ok_or_else(invalid)?
        .remove("request_hash");
    Ok(format!("{:x}", Sha256::digest(canonical_bytes(&value)?)))
}
pub fn intent_hash(intent: &IntentClaims) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(canonical_bytes(
            &serde_json::to_value(intent).map_err(|_| invalid())?
        )?)
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClosedHeader {
    alg: String,
    typ: String,
    kid: String,
}
fn decode<T: for<'de> Deserialize<'de>>(token: &str, jwks: &Value, typ: &str) -> Result<T> {
    require(token.len() <= MAX_JWT_BYTES)?;
    let parts: Vec<_> = token.split('.').collect();
    require(parts.len() == 3)?;
    let bytes = URL_SAFE_NO_PAD.decode(parts[0]).map_err(|_| invalid())?;
    let h: ClosedHeader = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    require(h.alg == "ES256" && h.typ == typ && identifier(&h.kid, 128))?;
    let raw = jwks
        .get("keys")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let matched: Vec<_> = raw
        .iter()
        .filter(|k| k.get("kid").and_then(Value::as_str) == Some(h.kid.as_str()))
        .collect();
    require(matched.len() == 1)?;
    let pinned = matched[0];
    require(
        pinned["kty"] == "EC"
            && pinned["crv"] == "P-256"
            && pinned.get("d").is_none()
            && pinned.get("alg").is_none_or(|a| a == "ES256")
            && pinned.get("use").is_none_or(|u| u == "sig"),
    )?;
    let set: JwkSet = serde_json::from_value(jwks.clone()).map_err(|_| invalid())?;
    require(
        set.keys.len() <= MAX_COLLECTION_ITEMS
            && set
                .keys
                .iter()
                .filter(|k| k.common.key_id.as_deref() == Some(&h.kid))
                .count()
                == 1,
    )?;
    let key =
        DecodingKey::from_jwk(set.find(&h.kid).ok_or_else(invalid)?).map_err(|_| invalid())?;
    let mut validation = Validation::new(Algorithm::ES256);
    validation.validate_exp = false;
    validation.validate_aud = false;
    validation.required_spec_claims.clear();
    jsonwebtoken::decode(token, &key, &validation)
        .map(|x| x.claims)
        .map_err(|_| ExecutionError("EXECUTION_PROOF_REJECTED"))
}
pub fn verify_grant(
    token: &str,
    jwks: &Value,
    scope: &ExecutionScope,
    now: u64,
) -> Result<GrantClaims> {
    let claims: GrantClaims = decode(token, jwks, GRANT_TYP)?;
    claims.validate_at(scope, now)?;
    Ok(claims)
}
pub fn verify_intent(
    token: &str,
    jwks: &Value,
    scope: &ExecutionScope,
    now: u64,
) -> Result<IntentClaims> {
    let claims: IntentClaims = decode(token, jwks, INTENT_TYP)?;
    claims.validate_at(scope, now)?;
    Ok(claims)
}
pub fn verify_lease(
    token: &str,
    jwks: &Value,
    scope: &ExecutionScope,
    now: u64,
    intent: &IntentClaims,
    context: &HostContext,
) -> Result<LeaseClaims> {
    let claims: LeaseClaims = decode(token, jwks, LEASE_TYP)?;
    claims.validate_at(scope, now)?;
    claims.matches_intent(intent, context, now)?;
    Ok(claims)
}
#[allow(clippy::too_many_arguments)]
pub fn verify_revocation(
    token: &str,
    jwks: &Value,
    scope: &ExecutionScope,
    now: u64,
    context: &HostContext,
    grant_id: &str,
    bot_id: &str,
    generation: u64,
) -> Result<RevocationClaims> {
    let claims: RevocationClaims = decode(token, jwks, REVOCATION_TYP)?;
    claims.matches_target(scope, context, grant_id, bot_id, generation, now)?;
    Ok(claims)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        serde_json::from_str(include_str!("../fixtures/wire-v1.json")).unwrap()
    }
    #[test]
    fn observations_are_closed_bounded_metadata_with_exact_bot_subset() {
        let f = fixture();
        let mut o: HostObservation = serde_json::from_value(f["observation"].clone()).unwrap();
        o.validate().unwrap(); // No supported runtime or paid invocation is claimed.
        let mut value = f["observation"].clone();
        value["provider_secret"] = Value::Bool(true);
        assert!(serde_json::from_value::<HostObservation>(value).is_err());
        o.allowed_bot_ids.clear();
        assert!(o.validate().is_err());
        let mut o: HostObservation = serde_json::from_value(f["observation"].clone()).unwrap();
        o.snapshots.push(o.snapshots[0].clone());
        assert!(o.validate().is_err());
        let mut o: HostObservation = serde_json::from_value(f["observation"].clone()).unwrap();
        let mut snapshot = o.snapshots[0].clone();
        snapshot.config.system_prompt = "x".repeat(16_384);
        o.snapshots.clear();
        o.allowed_bot_ids.clear();
        for n in 1..=4 {
            let mut s = snapshot.clone();
            s.bot_id = uuid::Uuid::from_u128(n).to_string();
            o.allowed_bot_ids.push(s.bot_id.clone());
            o.snapshots.push(s);
        }
        assert!(o.validate().is_err());
        o.snapshots.pop();
        o.validate().unwrap();
        o.host_revision = MAX_SAFE_INTEGER + 1;
        assert!(o.validate().is_err());
    }
    #[test]
    fn canonical_fixture_and_hash_match() {
        let f = fixture();
        let c: Command = serde_json::from_value(f["command"].clone()).unwrap();
        assert_eq!(
            command_hash(&c).unwrap(),
            f["command_hash"].as_str().unwrap()
        );
        c.validate().unwrap();
        let i: IntentClaims = serde_json::from_value(f["intent"].clone()).unwrap();
        assert_eq!(intent_hash(&i).unwrap(), f["intent_hash"].as_str().unwrap());
        i.validate_at(&i.scope, f["now"].as_u64().unwrap()).unwrap();
        let l: LeaseClaims = serde_json::from_value(f["lease"].clone()).unwrap();
        l.matches_intent(&i, &l.host_context, f["now"].as_u64().unwrap())
            .unwrap();
        assert_eq!(
            String::from_utf8(canonical_bytes(&f["canonical_input"]).unwrap()).unwrap(),
            f["canonical_output"].as_str().unwrap()
        );
    }
    #[test]
    fn rejects_unknown_keys_floats_and_unsafe_integers() {
        let f = fixture();
        let mut c = f["command"].clone();
        c["unexpected"] = Value::Bool(true);
        assert!(serde_json::from_value::<Command>(c).is_err());
        for n in [
            serde_json::json!(MAX_SAFE_INTEGER + 1),
            serde_json::json!(1.0),
            serde_json::json!(-1),
        ] {
            let mut c = f["command"].clone();
            c["expected_host_revision"] = n.clone();
            assert!(serde_json::from_value::<Command>(c).is_err());
            assert!(canonical_bytes(&n).is_err());
        }
        let mut c = f["command"].clone();
        c["operation"]["params"]["provider_secret"] = Value::String("no".into());
        assert!(serde_json::from_value::<Command>(c).is_err());
    }
    #[test]
    fn fences_scope_hash_nonce_time_and_grant() {
        let f = fixture();
        let i: IntentClaims = serde_json::from_value(f["intent"].clone()).unwrap();
        let now = f["now"].as_u64().unwrap();
        let mut bad = i.clone();
        bad.command.expected_host_revision += 1;
        assert!(bad.validate_at(&i.scope, now).is_err());
        let mut bad = i.clone();
        bad.scope.host_key_generation += 1;
        assert!(bad.validate_at(&i.scope, now).is_err());
        let mut bad = i.clone();
        bad.grant.operations = vec![Method::Enable];
        assert!(bad.validate_at(&i.scope, now).is_err());
        assert!(i.validate_at(&i.scope, i.exp).is_err());
        let l: LeaseClaims = serde_json::from_value(f["lease"].clone()).unwrap();
        let mut ctx = l.host_context.clone();
        ctx.local_auth_generation += 1;
        assert!(l.matches_intent(&i, &ctx, now).is_err());
        let mut bad = l.clone();
        bad.exp = bad.iat + 16;
        assert!(bad.validate_at(&i.scope, now).is_err());
        let mut bad = l.clone();
        bad.host_context.connection_epoch = bad.host_context.boot_epoch.clone();
        assert!(bad.matches_intent(&i, &l.host_context, now).is_err());
    }
    #[test]
    fn verifies_real_node_es256_fixture_and_closed_revocation_target() {
        let f = fixture();
        let signed: Value =
            serde_json::from_str(include_str!("../fixtures/signed-v1.json")).unwrap();
        let scope: ExecutionScope = serde_json::from_value(f["scope"].clone()).unwrap();
        let now = f["now"].as_u64().unwrap();
        verify_grant(
            signed["tokens"]["grant"].as_str().unwrap(),
            &signed["jwks"],
            &scope,
            now,
        )
        .unwrap();
        let i = verify_intent(
            signed["tokens"]["intent"].as_str().unwrap(),
            &signed["jwks"],
            &scope,
            now,
        )
        .unwrap();
        let l: LeaseClaims = serde_json::from_value(f["lease"].clone()).unwrap();
        verify_lease(
            signed["tokens"]["lease"].as_str().unwrap(),
            &signed["jwks"],
            &scope,
            now,
            &i,
            &l.host_context,
        )
        .unwrap();
        verify_revocation(
            signed["tokens"]["revocation"].as_str().unwrap(),
            &signed["jwks"],
            &scope,
            now,
            &l.host_context,
            &i.grant.id,
            &i.grant.bot_id,
            1,
        )
        .unwrap();
        assert!(
            verify_grant(
                signed["tokens"]["intent"].as_str().unwrap(),
                &signed["jwks"],
                &scope,
                now
            )
            .is_err()
        );
        assert!(
            verify_revocation(
                signed["tokens"]["revocation"].as_str().unwrap(),
                &signed["jwks"],
                &scope,
                now,
                &l.host_context,
                &i.grant.id,
                &i.grant.bot_id,
                2
            )
            .is_err()
        );
        let mut bad = signed["jwks"].clone();
        bad["keys"][0]["use"] = serde_json::json!("enc");
        assert!(
            verify_intent(
                signed["tokens"]["intent"].as_str().unwrap(),
                &bad,
                &scope,
                now
            )
            .is_err()
        );
        let mut bad_scope = scope.clone();
        bad_scope.host_key_generation += 1;
        assert!(
            verify_intent(
                signed["tokens"]["intent"].as_str().unwrap(),
                &signed["jwks"],
                &bad_scope,
                now
            )
            .is_err()
        );
    }
}
