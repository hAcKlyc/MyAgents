//! Model-center wire records. Provider credentials are deliberately write-only.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiProtocol {
    Anthropic,
    Openai,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthType {
    AuthToken,
    ApiKey,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpstreamFormat {
    ChatCompletions,
    Responses,
}
fn default_cap() -> u64 {
    4096
}
fn default_enabled() -> bool {
    true
}
fn default_param() -> String {
    "max_tokens".into()
}
fn default_format() -> UpstreamFormat {
    UpstreamFormat::ChatCompletions
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderWrite {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub api_protocol: ApiProtocol,
    pub auth_type: AuthType,
    #[serde(default = "default_format")]
    pub upstream_format: UpstreamFormat,
    #[serde(default = "default_param")]
    pub max_output_tokens_param_name: String,
    #[serde(default = "default_cap")]
    pub max_output_tokens: u64,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub api_key: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provider {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub api_protocol: ApiProtocol,
    pub auth_type: AuthType,
    pub upstream_format: UpstreamFormat,
    pub max_output_tokens_param_name: String,
    pub max_output_tokens: u64,
    pub enabled: bool,
    pub has_key: bool,
    pub revision: u64,
}
/// Integer USD micro-units per million tokens; None means unknown, never zero.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelWrite {
    pub id: String,
    pub provider_id: String,
    pub model_id: String,
    pub label: String,
    pub owner_ids: Vec<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub input_price_microusd_per_million: Option<u64>,
    #[serde(default)]
    pub output_price_microusd_per_million: Option<u64>,
    #[serde(default)]
    pub price_version: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Model {
    #[serde(flatten)]
    pub config: ModelWrite,
    pub revision: u64,
}
/// Construct only after checking current account, Bot, deployment and Host authority.
/// This value does not confer authority by itself; the gateway requires a live check.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ValidatedBot {
    pub bot_id: String,
    pub owner_id: String,
    pub host_id: String,
    pub host_key_generation: u64,
    pub identity_binding_id: String,
    pub model_ref: String,
    pub binding_revision: u64,
    pub daily_tokens: u64,
    pub daily_cost_microusd: Option<u64>,
    pub concurrency_limit: u32,
}
/// Explicit finite resource authorization. `scope.model_ref`/revision record issuance,
/// while only `allowed_model_refs` authorizes model selection for new Sessions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BotCredentialGrant {
    pub scope: ValidatedBot,
    pub allowed_model_refs: Vec<String>,
    pub max_output_tokens: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionLease {
    pub session_id: String,
    pub credential_id: String,
    pub bot: ValidatedBot,
    pub model: Model,
    pub provider: Provider,
    pub expires_at: u64,
    pub max_output_tokens: u64,
    pub max_total_tokens: u64,
}
pub struct IssuedCredential {
    pub bearer: String,
    pub expires_at: u64,
}
pub struct IssuedSession {
    pub bearer: String,
    pub lease: SessionLease,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageRecord {
    pub request_id: String,
    pub bot_id: String,
    pub owner_id: String,
    pub session_id: String,
    pub model_ref: String,
    pub model_revision: u64,
    pub provider_revision: u64,
    // Captured call metadata; old rows retain unknown names instead of using the current catalog.
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub model_label: Option<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
    pub started_at: u64,
    pub started_at_millis: u64,
    pub duration_ms: Option<u64>,
    pub completed_at: Option<u64>,
    pub outcome: String,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reserved_tokens: u64,
    pub charged_tokens: u64,
    pub reserved_cost_microusd: Option<u64>,
    pub charged_cost_microusd: Option<u64>,
    pub cost_microusd: Option<u64>,
    pub price_version: Option<String>,
    pub usage_known: bool,
}
#[derive(Debug, Clone, Copy)]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
}
#[derive(Debug, thiserror::Error)]
pub enum ModelCenterError {
    #[error("MODEL_CENTER_STORAGE_UNAVAILABLE")]
    Storage,
    #[error("UNSAFE_MODEL_CENTER_STATE")]
    UnsafeState,
    #[error("INVALID_MODEL_CENTER_REQUEST")]
    Invalid,
    #[error("MODEL_CENTER_REVISION_CONFLICT")]
    RevisionConflict,
    #[error("MODEL_CENTER_NOT_FOUND")]
    NotFound,
    #[error("MODEL_CENTER_CREDENTIAL_REJECTED")]
    Unauthorized,
    #[error("MODEL_CENTER_DISABLED")]
    Disabled,
    #[error("MODEL_CENTER_QUOTA_EXCEEDED")]
    Quota,
    #[error("MODEL_CENTER_PRICE_UNKNOWN")]
    PriceUnknown,
    #[error("MODEL_CENTER_REQUEST_REPLAY")]
    Replay,
    #[error("MODEL_CENTER_UPSTREAM_REJECTED")]
    Upstream,
    #[error("MODEL_CENTER_UPSTREAM_TIMEOUT")]
    Timeout,
    #[error("MODEL_CENTER_OUTPUT_LIMIT")]
    OutputLimit,
    #[error("MODEL_CENTER_UNSAFE_UPSTREAM")]
    UnsafeUpstream,
}
pub type Result<T> = std::result::Result<T, ModelCenterError>;
