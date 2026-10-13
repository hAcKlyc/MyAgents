//! Closed, bounded codec foundation for host-management messages.
//!
//! This crate only frames and validates messages. It does not negotiate a
//! channel, authorize a peer, dispatch owner operations, or claim that a
//! request succeeded. The TLS/channel owner must perform those steps.

use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use std::fmt;
use uuid::Uuid;

pub const PROTOCOL: &str = "host-management/v1";
pub const NAMESPACE: &str = "host.management";
pub const VERSION: u16 = 1;
/// No larger than the existing AgentNet control-object budget.
pub const MAX_OBJECT_BYTES: usize = 64 * 1024;
/// Deliberately much smaller than the existing AgentNet receive budget.
pub const MAX_RECEIVE_BYTES: usize = 256 * 1024;
pub const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;
const PREFIX_BYTES: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodecError {
    FrameTooLarge,
    ReceiveTooLarge,
    InvalidLength,
    InvalidJson,
    InvalidFrame,
    Poisoned,
    AllocationFailed,
}
impl fmt::Display for CodecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::FrameTooLarge => "FRAME_TOO_LARGE",
            Self::ReceiveTooLarge => "RECEIVE_TOO_LARGE",
            Self::InvalidLength => "INVALID_LENGTH",
            Self::InvalidJson => "INVALID_JSON",
            Self::InvalidFrame => "INVALID_FRAME",
            Self::Poisoned => "DECODER_POISONED",
            Self::AllocationFailed => "ALLOCATION_FAILED",
        })
    }
}
impl std::error::Error for CodecError {}

/// Canonical lowercase UUID. The original spelling is checked while decoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CanonicalUuid(Uuid);
impl CanonicalUuid {
    pub fn new(value: Uuid) -> Self {
        Self(value)
    }
    pub fn parse(value: &str) -> Result<Self, CodecError> {
        let parsed = Uuid::parse_str(value).map_err(|_| CodecError::InvalidFrame)?;
        if parsed.to_string() != value {
            return Err(CodecError::InvalidFrame);
        }
        Ok(Self(parsed))
    }
    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}
impl Serialize for CanonicalUuid {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0.to_string())
    }
}
impl<'de> Deserialize<'de> for CanonicalUuid {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PeerRole {
    Controller,
    Host,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Owner {
    #[serde(rename = "config")]
    Config,
    #[serde(rename = "resources")]
    Resources,
    #[serde(rename = "credentials")]
    Credentials,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ManagementMethod {
    #[serde(rename = "host.snapshot")]
    HostSnapshot,
    #[serde(rename = "config.set")]
    ConfigSet,
    #[serde(rename = "credential.set")]
    CredentialSet,
    #[serde(rename = "resources.create")]
    ResourcesCreate,
    #[serde(rename = "receipt.get")]
    ReceiptGet,
    #[serde(rename = "host.capabilities")]
    HostCapabilities,
    #[serde(rename = "host.inspect")]
    HostInspect,
    #[serde(rename = "config.provider.set")]
    ConfigProviderSet,
    #[serde(rename = "credential.provider.set")]
    CredentialProviderSet,
    #[serde(rename = "receipt.provider.get")]
    ReceiptProviderGet,
    #[serde(rename = "resources.directory.list")]
    ResourcesDirectoryList,
    #[serde(rename = "resources.register")]
    ResourcesRegister,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    pub namespace: String,
    pub version: u16,
    #[serde(rename = "senderSequence")]
    pub sender_sequence: u64,
    #[serde(rename = "channelId")]
    pub channel_id: CanonicalUuid,
    pub message: ManagementMessage,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ManagementMessage {
    Hello {
        protocol: String,
        role: PeerRole,
        nonce: CanonicalUuid,
    },
    HelloAck {
        protocol: String,
        role: PeerRole,
        nonce: CanonicalUuid,
    },
    Request {
        #[serde(rename = "requestId")]
        request_id: CanonicalUuid,
        method: ManagementMethod,
        params: RequestParams,
    },
    Response {
        #[serde(rename = "requestId")]
        request_id: CanonicalUuid,
        result: ResponseResult,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestParams {
    Snapshot(SnapshotParams),
    ConfigSet(ConfigSetParams),
    CredentialSet(CredentialSetParams),
    ResourcesCreate(ResourcesCreateParams),
    ReceiptGet(ReceiptGetParams),
    ConfigProviderSet(Box<ConfigProviderSetParams>),
    // Same shape as credential.set; method distinguishes provider validation.
    ReceiptProviderGet(ReceiptProviderGetParams),
    ResourcesDirectoryList(DirectoryListParams),
    ResourcesRegister(ResourcesRegisterParams),
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotParams {}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigSetParams {
    pub expected_revision: u64,
    pub provider_id: String,
    pub model: String,
    #[serde(
        default,
        deserialize_with = "deserialize_workspace",
        skip_serializing_if = "Option::is_none"
    )]
    pub workspace: Option<String>,
    pub execution_authorized: bool,
    pub mutation_id: CanonicalUuid,
}
/// The secret is transmitted only inside the authenticated encrypted channel.
/// Debug output must remain safe through Frame/RequestParams nesting too.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialSetParams {
    pub expected_revision: u64,
    pub provider_id: String,
    pub credential: String,
    pub mutation_id: CanonicalUuid,
}
impl fmt::Debug for CredentialSetParams {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CredentialSetParams")
            .field("expected_revision", &self.expected_revision)
            .field("provider_id", &self.provider_id)
            .field("credential", &"[REDACTED]")
            .field("mutation_id", &self.mutation_id)
            .finish()
    }
}
fn deserialize_workspace<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourcesCreateParams {
    pub root_id: String,
    pub relative_path: String,
    pub expected_revision: u64,
    pub mutation_id: CanonicalUuid,
    pub operation: ResourceOperation,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceOperation {
    Register,
    Create,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiptGetParams {
    pub mutation_id: CanonicalUuid,
    pub owner: Owner,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApiProtocol {
    Anthropic,
    Openai,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthType {
    AuthToken,
    ApiKey,
    Both,
    AuthTokenClearApiKey,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpstreamFormat {
    ChatCompletions,
    Responses,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MaxOutputTokensParamName {
    MaxTokens,
    MaxCompletionTokens,
    MaxOutputTokens,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelAliases {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sonnet: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opus: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub haiku: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderProfile {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_provider_id: Option<String>,
    pub name: String,
    pub api_protocol: ApiProtocol,
    pub base_url: String,
    pub auth_type: AuthType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_format: Option<UpstreamFormat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens_param_name: Option<MaxOutputTokensParamName>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_aliases: Option<ModelAliases>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSelection {
    pub root_id: String,
    pub relative_path: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigProviderSetParams {
    pub provider: ProviderProfile,
    pub model: String,
    pub workspace: WorkspaceSelection,
    pub execution_authorized: bool,
    pub expected_revision: u64,
    pub mutation_id: CanonicalUuid,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiptProviderGetParams {
    pub owner: Owner,
    pub provider_id: String,
    pub mutation_id: CanonicalUuid,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectoryListParams {
    pub root_id: String,
    pub relative_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourcesRegisterParams {
    pub root_id: String,
    pub relative_path: String,
    pub expected_revision: u64,
    pub mutation_id: CanonicalUuid,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityLimits {
    pub directory_entries: u16,
    pub path_bytes: u16,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capabilities {
    pub version: u8,
    pub methods: Vec<ManagementMethod>,
    pub provider_kinds: Vec<ApiProtocol>,
    pub limits: CapabilityLimits,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectoryEntry {
    pub name: String,
    pub relative_path: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectoryList {
    pub root_id: String,
    pub relative_path: String,
    pub entries: Vec<DirectoryEntry>,
    pub next_cursor: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenericHostSettings {
    pub revision: u64,
    pub provider_id: String,
    pub model: String,
    pub workspace: WorkspaceSelection,
    pub execution_authorized: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ProviderConfigReceipt {
    Persisted {
        #[serde(rename = "mutationId")]
        mutation_id: CanonicalUuid,
        revision: u64,
        effect: ConfigEffect,
        settings: GenericHostSettings,
    },
    Conflict {
        #[serde(rename = "mutationId")]
        mutation_id: CanonicalUuid,
        revision: u64,
        effect: ConfigEffect,
    },
    NotFound {
        #[serde(rename = "mutationId")]
        mutation_id: CanonicalUuid,
    },
}
/// Same fields as v1 snapshot, with independently validated generic settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtendedSnapshot {
    pub version: u8,
    pub host_id: CanonicalUuid,
    pub configured: bool,
    #[serde(deserialize_with = "deserialize_required_provider")]
    pub provider: Option<ProviderProfile>,
    pub settings: Option<GenericHostSettings>,
    pub active_session: Option<ActiveSession>,
    pub stopping: bool,
    pub capabilities: Vec<HostCapability>,
    pub agent_net: AgentNetStatus,
    pub runtime: RuntimeStatus,
    pub credentials: CredentialsStatus,
    pub resources: ResourcesSnapshot,
}

fn deserialize_required_provider<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<ProviderProfile>, D::Error> {
    Option::<ProviderProfile>::deserialize(deserializer)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ResponseResult {
    Snapshot(Box<HostSnapshot>),
    Capabilities(Capabilities),
    ExtendedSnapshot(Box<ExtendedSnapshot>),
    ProviderConfigReceipt(ProviderConfigReceipt),
    ProviderCredentialReceipt(CredentialReceipt),
    DirectoryList(DirectoryList),
    ConfigReceipt(ConfigReceipt),
    CredentialReceipt(CredentialReceipt),
    ResourceReceipt(ResourceReceipt),
    ReceiptNotFound {
        #[serde(rename = "mutationId")]
        mutation_id: CanonicalUuid,
        owner: Owner,
    },
    Error {
        code: String,
    },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostSnapshot {
    pub version: u8,
    pub host_id: CanonicalUuid,
    pub configured: bool,
    pub settings: Option<HostSettings>,
    pub active_session: Option<ActiveSession>,
    pub stopping: bool,
    pub capabilities: Vec<HostCapability>,
    pub agent_net: AgentNetStatus,
    pub runtime: RuntimeStatus,
    pub credentials: CredentialsStatus,
    pub resources: ResourcesSnapshot,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialsStatus {
    pub provider_id: String,
    pub configured: bool,
    pub revision: u64,
    pub write_available: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourcesSnapshot {
    pub version: u8,
    pub revision: u64,
    pub roots: Vec<ResourceRoot>,
    pub agents: Vec<ResourceAgent>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceRoot {
    pub root_id: String,
    pub workspace_path: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceAgent {
    pub agent_id: String,
    pub project_id: String,
    pub name: String,
    pub workspace_path: String,
    pub enabled: bool,
    pub archived: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostSettings {
    pub revision: u64,
    pub provider_id: String,
    pub model: String,
    pub workspace: String,
    pub execution_authorized: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActiveSession {
    pub session_id: CanonicalUuid,
    pub generation: CanonicalUuid,
    pub closing: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostCapability {
    LocalSession,
    Permission,
    Stop,
    PersistentHistory,
    LocalConfigReceipt,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentNetStatus {
    pub available: bool,
    pub reason: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStatus {
    pub node: String,
    pub sdk_binary_present: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ConfigReceipt {
    Persisted {
        #[serde(rename = "mutationId")]
        mutation_id: CanonicalUuid,
        revision: u64,
        effect: ConfigEffect,
        settings: HostSettings,
    },
    Conflict {
        #[serde(rename = "mutationId")]
        mutation_id: CanonicalUuid,
        revision: u64,
        effect: ConfigEffect,
    },
    NotFound {
        #[serde(rename = "mutationId")]
        mutation_id: CanonicalUuid,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case", deny_unknown_fields)]
pub enum CredentialReceipt {
    Persisted {
        #[serde(rename = "mutationId")]
        mutation_id: CanonicalUuid,
        revision: u64,
        effect: ConfigEffect,
    },
    Conflict {
        #[serde(rename = "mutationId")]
        mutation_id: CanonicalUuid,
        revision: u64,
        effect: ConfigEffect,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConfigEffect {
    NewSession,
    None,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ResourceReceipt {
    Pending {
        #[serde(rename = "mutationId")]
        mutation_id: CanonicalUuid,
        revision: u64,
        effect: ResourceEffect,
    },
    Persisted {
        #[serde(rename = "mutationId")]
        mutation_id: CanonicalUuid,
        revision: u64,
        effect: ResourceEffect,
        resource: ResourceSummary,
    },
    Conflict {
        #[serde(rename = "mutationId")]
        mutation_id: CanonicalUuid,
        revision: u64,
        effect: ResourceEffect,
    },
    NotFound {
        #[serde(rename = "mutationId")]
        mutation_id: CanonicalUuid,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResourceEffect {
    None,
    RegisteredDisabledAgent,
    ExistingAgent,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceSummary {
    pub created: bool,
    pub agent_id: String,
    pub project_id: String,
    pub name: String,
    pub workspace_path: String,
    pub enabled: bool,
    pub archived: bool,
}

impl Frame {
    pub fn validate(&self) -> Result<(), CodecError> {
        if self.namespace != NAMESPACE
            || self.version != VERSION
            || self.sender_sequence == 0
            || self.sender_sequence > MAX_SAFE_SEQUENCE
        {
            return Err(CodecError::InvalidFrame);
        }
        match &self.message {
            ManagementMessage::Hello {
                protocol, nonce, ..
            }
            | ManagementMessage::HelloAck {
                protocol, nonce, ..
            } => {
                let _ = nonce;
                if protocol != PROTOCOL {
                    return Err(CodecError::InvalidFrame);
                }
            }
            ManagementMessage::Request { method, params, .. } => {
                let valid = matches!(
                    (method, params),
                    (
                        ManagementMethod::HostSnapshot
                            | ManagementMethod::HostCapabilities
                            | ManagementMethod::HostInspect,
                        RequestParams::Snapshot(_)
                    ) | (ManagementMethod::ConfigSet, RequestParams::ConfigSet(_))
                        | (
                            ManagementMethod::CredentialSet,
                            RequestParams::CredentialSet(_)
                        )
                        | (
                            ManagementMethod::ResourcesCreate,
                            RequestParams::ResourcesCreate(_)
                        )
                        | (ManagementMethod::ReceiptGet, RequestParams::ReceiptGet(_))
                        | (
                            ManagementMethod::ConfigProviderSet,
                            RequestParams::ConfigProviderSet(_)
                        )
                        | (
                            ManagementMethod::CredentialProviderSet,
                            RequestParams::CredentialSet(_)
                        )
                        | (
                            ManagementMethod::ReceiptProviderGet,
                            RequestParams::ReceiptProviderGet(_)
                        )
                        | (
                            ManagementMethod::ResourcesDirectoryList,
                            RequestParams::ResourcesDirectoryList(_)
                        )
                        | (
                            ManagementMethod::ResourcesRegister,
                            RequestParams::ResourcesRegister(_)
                        )
                );
                if !valid {
                    return Err(CodecError::InvalidFrame);
                }
                if *method == ManagementMethod::CredentialProviderSet {
                    if let RequestParams::CredentialSet(p) = params
                        && (!valid_provider_id(&p.provider_id) || !valid_credential(p))
                    {
                        return Err(CodecError::InvalidFrame);
                    }
                } else {
                    validate_params(params)?;
                }
            }
            ManagementMessage::Response { result, .. } => validate_result(result)?,
        }
        Ok(())
    }
}

fn validate_params(params: &RequestParams) -> Result<(), CodecError> {
    match params {
        RequestParams::Snapshot(_) | RequestParams::ReceiptGet(_) => Ok(()),
        RequestParams::ConfigSet(p) => {
            if !safe_revision(p.expected_revision)
                || p.provider_id != "moonshot-coding"
                || !valid_model(&p.model)
                || p.workspace
                    .as_ref()
                    .is_some_and(|path| !valid_absolute_path(path))
            {
                return Err(CodecError::InvalidFrame);
            }
            Ok(())
        }
        RequestParams::CredentialSet(p) => {
            if !safe_revision(p.expected_revision)
                || p.provider_id != "moonshot-coding"
                || p.credential.trim().is_empty()
                || p.credential.len() > 16 * 1024
                || p.credential.bytes().any(|b| matches!(b, 0 | b'\r' | b'\n'))
            {
                return Err(CodecError::InvalidFrame);
            }
            Ok(())
        }
        RequestParams::ConfigProviderSet(p) => {
            if !safe_revision(p.expected_revision)
                || !valid_provider(&p.provider)
                || !valid_generic_model(&p.model)
                || !valid_root_id(&p.workspace.root_id)
                || !valid_directory_path(&p.workspace.relative_path, true)
            {
                return Err(CodecError::InvalidFrame);
            }
            Ok(())
        }
        RequestParams::ReceiptProviderGet(p) => {
            if !valid_provider_id(&p.provider_id) || p.owner == Owner::Resources {
                return Err(CodecError::InvalidFrame);
            }
            Ok(())
        }
        RequestParams::ResourcesDirectoryList(p) => {
            if !valid_root_id(&p.root_id)
                || !valid_directory_path(&p.relative_path, true)
                || p.cursor.as_ref().is_some_and(|s| !valid_cursor(s))
            {
                return Err(CodecError::InvalidFrame);
            }
            Ok(())
        }
        RequestParams::ResourcesRegister(p) => {
            if !safe_revision(p.expected_revision)
                || !valid_root_id(&p.root_id)
                || !valid_directory_path(&p.relative_path, false)
            {
                return Err(CodecError::InvalidFrame);
            }
            Ok(())
        }
        RequestParams::ResourcesCreate(p) => {
            if !safe_revision(p.expected_revision)
                || !valid_root_id(&p.root_id)
                || !valid_relative_path(&p.relative_path)
            {
                return Err(CodecError::InvalidFrame);
            }
            Ok(())
        }
    }
}
fn validate_result(result: &ResponseResult) -> Result<(), CodecError> {
    match result {
        ResponseResult::Error { code } if !valid_error_code(code) => Err(CodecError::InvalidFrame),
        ResponseResult::Snapshot(snapshot) => validate_snapshot(snapshot),
        ResponseResult::Capabilities(c) => {
            let mut methods = std::collections::HashSet::new();
            let mut kinds = std::collections::HashSet::new();
            if c.version != 1
                || c.methods.len() > 12
                || c.provider_kinds.len() > 2
                || c.methods
                    .iter()
                    .any(|m| !methods.insert(serde_json::to_string(m).unwrap_or_default()))
                || c.provider_kinds
                    .iter()
                    .any(|m| !kinds.insert(serde_json::to_string(m).unwrap_or_default()))
                || c.limits.directory_entries != 128
                || c.limits.path_bytes != 4096
            {
                return Err(CodecError::InvalidFrame);
            }
            Ok(())
        }
        ResponseResult::ExtendedSnapshot(s) => validate_extended_snapshot(s),
        ResponseResult::ProviderConfigReceipt(r) => validate_provider_config_receipt(r),
        ResponseResult::ProviderCredentialReceipt(r) => validate_credential_receipt(r),
        ResponseResult::DirectoryList(d) => validate_directory_list(d),
        ResponseResult::ConfigReceipt(receipt) => validate_config_receipt(receipt),
        ResponseResult::CredentialReceipt(receipt) => validate_credential_receipt(receipt),
        ResponseResult::ResourceReceipt(receipt) => validate_resource_receipt(receipt),
        _ => Ok(()),
    }
}
fn valid_provider_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}
fn valid_generic_model(s: &str) -> bool {
    !s.is_empty() && s.chars().count() <= 160 && !s.chars().any(char::is_control)
}
fn valid_credential(p: &CredentialSetParams) -> bool {
    safe_revision(p.expected_revision)
        && !p.credential.trim().is_empty()
        && p.credential.len() <= 16 * 1024
        && !p.credential.bytes().any(|b| matches!(b, 0 | b'\r' | b'\n'))
}
fn valid_cursor(s: &str) -> bool {
    !s.is_empty() && s.len() <= 4096 && !s.chars().any(char::is_control)
}
fn valid_directory_path(s: &str, root: bool) -> bool {
    (root && s.is_empty())
        || (!s.is_empty()
            && s.len() <= 4096
            && !s.starts_with('/')
            && !s.chars().any(char::is_control)
            && !s.contains('\\')
            && s.split('/')
                .all(|c| !c.is_empty() && c != "." && c != ".." && c.len() <= 255))
}
fn valid_provider(p: &ProviderProfile) -> bool {
    valid_provider_id(&p.id)
        && p.source_provider_id
            .as_ref()
            .is_none_or(|id| valid_provider_id(id))
        && !p.name.is_empty()
        && p.name.chars().count() <= 256
        && !p.name.chars().any(char::is_control)
        && valid_endpoint(&p.base_url)
        && p.max_output_tokens
            .is_none_or(|n| n > 0 && safe_revision(n))
        && p.model_aliases.as_ref().is_none_or(|a| {
            [&a.fable, &a.sonnet, &a.opus, &a.haiku]
                .into_iter()
                .all(|v| v.as_ref().is_none_or(|s| valid_generic_model(s)))
        })
}
fn valid_endpoint(s: &str) -> bool {
    // Parse only the bounded HTTPS subset; no implicit URL normalization.
    if s.len() > 4096
        || s.chars().any(|c| c.is_control() || c.is_whitespace())
        || s.contains(['?', '#', '@', '\\'])
    {
        return false;
    }
    let Some(rest) = s.strip_prefix("https://") else {
        return false;
    };
    let authority = rest.split('/').next().unwrap_or_default();
    let (host, port) = if let Some(tail) = authority.strip_prefix('[') {
        let Some((host, suffix)) = tail.split_once(']') else {
            return false;
        };
        if host.parse::<std::net::Ipv6Addr>().is_err() {
            return false;
        }
        (
            host,
            suffix
                .strip_prefix(':')
                .or_else(|| suffix.is_empty().then_some("")),
        )
    } else {
        let mut parts = authority.split(':');
        let host = parts.next().unwrap_or_default();
        let port = parts.next().unwrap_or("");
        if parts.next().is_some()
            || host.is_empty()
            || !host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
        {
            return false;
        }
        (host, Some(port))
    };
    let Some(port) = port else {
        return false;
    };
    if !port.is_empty() && !port.parse::<u16>().is_ok_and(|n| n > 0) {
        return false;
    }
    // WHATWG URL consumers treat shortened/numeric IPv4 forms as loopback too.
    // Only accept canonical dotted IPv4; DNS final labels cannot be numeric.
    if !host.contains(':') && host.parse::<std::net::Ipv4Addr>().is_err() {
        let dns = host.trim_end_matches('.');
        if dns.split('.').any(|label| {
            label.is_empty() || label.len() > 63 || label.starts_with('-') || label.ends_with('-')
        }) {
            return false;
        }
        let final_label = dns.rsplit('.').next().unwrap_or_default();
        if final_label.bytes().all(|b| b.is_ascii_digit())
            || final_label.to_ascii_lowercase().starts_with("0x")
        {
            return false;
        }
    }
    let lower = host.trim_end_matches('.').to_ascii_lowercase();
    if lower == "localhost" || lower.ends_with(".localhost") {
        return false;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>()
        && (ip.is_loopback()
            || ip.is_unspecified()
            || matches!(ip, std::net::IpAddr::V6(v) if v.to_ipv4_mapped().is_some_and(|x| x.is_loopback() || x.is_unspecified())))
    {
        return false;
    }
    true
}
fn validate_generic_settings(s: &GenericHostSettings) -> Result<(), CodecError> {
    if s.revision == 0
        || !safe_revision(s.revision)
        || !valid_provider_id(&s.provider_id)
        || !valid_generic_model(&s.model)
        || !valid_root_id(&s.workspace.root_id)
        || !valid_directory_path(&s.workspace.relative_path, true)
    {
        return Err(CodecError::InvalidFrame);
    }
    Ok(())
}
fn validate_extended_snapshot(s: &ExtendedSnapshot) -> Result<(), CodecError> {
    if s.version != 1
        || s.configured != s.provider.is_some()
        || s.provider.as_ref().is_some_and(|p| !valid_provider(p))
        || s.settings.as_ref().is_some_and(|settings| {
            s.provider
                .as_ref()
                .is_none_or(|p| p.id != settings.provider_id)
        })
        || !valid_provider_id(&s.credentials.provider_id)
        || !safe_revision(s.credentials.revision)
        || (s.credentials.configured && s.credentials.revision == 0)
        || validate_resources_snapshot(&s.resources).is_err()
        || s.capabilities.len() > 16
        || s.settings
            .as_ref()
            .is_some_and(|v| validate_generic_settings(v).is_err())
        || s.configured != s.settings.is_some()
        || !valid_semver(&s.runtime.node)
        || s.agent_net.reason.as_ref().is_some_and(|v| v.len() > 64)
        || s.settings
            .as_ref()
            .is_some_and(|v| v.provider_id != s.credentials.provider_id)
    {
        return Err(CodecError::InvalidFrame);
    }
    Ok(())
}
fn validate_provider_config_receipt(r: &ProviderConfigReceipt) -> Result<(), CodecError> {
    match r {
        ProviderConfigReceipt::Persisted {
            revision,
            effect,
            settings,
            ..
        } => {
            if *revision != settings.revision || *effect != ConfigEffect::NewSession {
                return Err(CodecError::InvalidFrame);
            }
            validate_generic_settings(settings)
        }
        ProviderConfigReceipt::Conflict {
            revision, effect, ..
        } if safe_revision(*revision) && *effect == ConfigEffect::None => Ok(()),
        ProviderConfigReceipt::NotFound { .. } => Ok(()),
        _ => Err(CodecError::InvalidFrame),
    }
}
fn validate_directory_list(d: &DirectoryList) -> Result<(), CodecError> {
    let mut names = std::collections::HashSet::new();
    if !valid_root_id(&d.root_id)
        || !valid_directory_path(&d.relative_path, true)
        || d.entries.len() > 128
        || d.next_cursor.as_ref().is_some_and(|s| !valid_cursor(s))
        || d.entries.iter().any(|e| {
            let expected = if d.relative_path.is_empty() {
                e.name.clone()
            } else {
                format!("{}/{}", d.relative_path, e.name)
            };
            e.name.contains('/')
                || !valid_directory_path(&e.name, false)
                || !valid_directory_path(&e.relative_path, false)
                || e.relative_path != expected
                || !names.insert(e.name.as_str())
        })
    {
        return Err(CodecError::InvalidFrame);
    }
    Ok(())
}

fn validate_snapshot(s: &HostSnapshot) -> Result<(), CodecError> {
    if s.version != 1
        || s.credentials.provider_id != "moonshot-coding"
        || !safe_revision(s.credentials.revision)
        || (s.credentials.configured && s.credentials.revision == 0)
        || validate_resources_snapshot(&s.resources).is_err()
        || s.capabilities.len() > 16
        || s.settings
            .as_ref()
            .is_some_and(|v| validate_settings(v).is_err())
        || s.configured != s.settings.is_some()
        || s.runtime.node.len() > 32
        || !valid_semver(&s.runtime.node)
        || s.agent_net.reason.as_ref().is_some_and(|v| v.len() > 64)
    {
        return Err(CodecError::InvalidFrame);
    }
    Ok(())
}
fn validate_resources_snapshot(s: &ResourcesSnapshot) -> Result<(), CodecError> {
    if s.version != 1 || !safe_revision(s.revision) || s.roots.len() > 16 || s.agents.len() > 128 {
        return Err(CodecError::InvalidFrame);
    }
    let mut root_ids = std::collections::HashSet::new();
    for root in &s.roots {
        if !valid_root_id(&root.root_id)
            || !valid_absolute_path(&root.workspace_path)
            || !root_ids.insert(root.root_id.as_str())
        {
            return Err(CodecError::InvalidFrame);
        }
    }
    let mut agent_ids = std::collections::HashSet::new();
    for agent in &s.agents {
        if agent.agent_id.is_empty()
            || agent.agent_id.len() > 256
            || agent.project_id.is_empty()
            || agent.project_id.len() > 256
            || agent.name.len() > 512
            || !valid_absolute_path(&agent.workspace_path)
            || !agent_ids.insert(agent.agent_id.as_str())
        {
            return Err(CodecError::InvalidFrame);
        }
    }
    Ok(())
}
fn validate_credential_receipt(r: &CredentialReceipt) -> Result<(), CodecError> {
    let valid = match r {
        CredentialReceipt::Persisted {
            revision, effect, ..
        } => *revision > 0 && safe_revision(*revision) && *effect == ConfigEffect::NewSession,
        CredentialReceipt::Conflict {
            revision, effect, ..
        } => safe_revision(*revision) && *effect == ConfigEffect::None,
    };
    if valid {
        Ok(())
    } else {
        Err(CodecError::InvalidFrame)
    }
}
fn validate_config_receipt(r: &ConfigReceipt) -> Result<(), CodecError> {
    match r {
        ConfigReceipt::Persisted {
            revision,
            effect,
            settings,
            ..
        } => {
            if *revision == 0
                || *effect != ConfigEffect::NewSession
                || settings.revision != *revision
            {
                return Err(CodecError::InvalidFrame);
            }
            validate_settings(settings)
        }
        ConfigReceipt::Conflict {
            revision, effect, ..
        } => {
            if !safe_revision(*revision) || *effect != ConfigEffect::None {
                Err(CodecError::InvalidFrame)
            } else {
                Ok(())
            }
        }
        ConfigReceipt::NotFound { .. } => Ok(()),
    }
}
fn validate_resource_receipt(r: &ResourceReceipt) -> Result<(), CodecError> {
    match r {
        ResourceReceipt::Pending {
            revision, effect, ..
        }
        | ResourceReceipt::Conflict {
            revision, effect, ..
        } => {
            if !safe_revision(*revision) || *effect != ResourceEffect::None {
                Err(CodecError::InvalidFrame)
            } else {
                Ok(())
            }
        }
        ResourceReceipt::Persisted {
            revision,
            effect,
            resource,
            ..
        } => {
            if *revision == 0
                || resource.agent_id.is_empty()
                || resource.agent_id.len() > 256
                || resource.project_id.is_empty()
                || resource.project_id.len() > 256
                || resource.name.len() > 512
                || !valid_absolute_path(&resource.workspace_path)
                || resource.archived
                || (resource.created && resource.enabled)
                || *effect
                    != if resource.created {
                        ResourceEffect::RegisteredDisabledAgent
                    } else {
                        ResourceEffect::ExistingAgent
                    }
            {
                return Err(CodecError::InvalidFrame);
            }
            Ok(())
        }
        ResourceReceipt::NotFound { .. } => Ok(()),
    }
}
fn validate_settings(s: &HostSettings) -> Result<(), CodecError> {
    if s.revision == 0
        || !safe_revision(s.revision)
        || s.provider_id != "moonshot-coding"
        || !valid_model(&s.model)
        || !valid_absolute_path(&s.workspace)
    {
        Err(CodecError::InvalidFrame)
    } else {
        Ok(())
    }
}
fn safe_revision(v: u64) -> bool {
    v <= MAX_SAFE_SEQUENCE
}
fn valid_model(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 128
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}
fn valid_root_id(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 64
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
fn valid_relative_path(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 1024
        && v.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && part.len() <= 128
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
        })
}
fn valid_absolute_path(v: &str) -> bool {
    v.starts_with('/') && v.len() <= 4096 && !v.bytes().any(|b| b < 0x20 || b == 0x7f)
}
fn valid_error_code(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 64
        && v.as_bytes()[0].is_ascii_uppercase()
        && v.bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}
fn valid_semver(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 32
        && v.bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'-' | b'+'))
}

pub fn encode_frame(frame: &Frame) -> Result<Vec<u8>, CodecError> {
    frame.validate()?;
    let body = serde_json::to_vec(frame).map_err(|_| CodecError::InvalidFrame)?;
    if body.is_empty() {
        return Err(CodecError::InvalidLength);
    }
    if body.len() > MAX_OBJECT_BYTES {
        return Err(CodecError::FrameTooLarge);
    }
    let len = u32::try_from(body.len()).map_err(|_| CodecError::FrameTooLarge)?;
    let mut framed = Vec::with_capacity(PREFIX_BYTES + body.len());
    framed.extend_from_slice(&len.to_be_bytes());
    framed.extend_from_slice(&body);
    Ok(framed)
}

#[derive(Default)]
pub struct FrameDecoder {
    bytes: Vec<u8>,
    failed: bool,
}
impl FrameDecoder {
    pub fn buffered_len(&self) -> usize {
        self.bytes.len()
    }
    pub fn is_poisoned(&self) -> bool {
        self.failed
    }
    /// Call at transport EOF. A partial prefix or payload is never a valid frame.
    pub fn finish(&mut self) -> Result<(), CodecError> {
        if self.failed {
            return Err(CodecError::Poisoned);
        }
        if self.bytes.is_empty() {
            return Ok(());
        }
        self.failed = true;
        self.bytes.clear();
        Err(CodecError::InvalidLength)
    }
    pub fn push(&mut self, input: &[u8]) -> Result<Vec<Frame>, CodecError> {
        if self.failed {
            return Err(CodecError::Poisoned);
        }
        if input.len() > MAX_RECEIVE_BYTES.saturating_sub(self.bytes.len()) {
            return self.poison(CodecError::ReceiveTooLarge);
        }
        if self.bytes.try_reserve_exact(input.len()).is_err() {
            return self.poison(CodecError::AllocationFailed);
        }
        self.bytes.extend_from_slice(input);
        let result = self.decode_available();
        if result.is_err() {
            self.failed = true;
            self.bytes.clear();
        }
        result
    }
    fn poison<T>(&mut self, error: CodecError) -> Result<T, CodecError> {
        self.failed = true;
        self.bytes.clear();
        Err(error)
    }
    fn decode_available(&mut self) -> Result<Vec<Frame>, CodecError> {
        let mut frames = Vec::new();
        let mut consumed = 0usize;
        while self.bytes.len().saturating_sub(consumed) >= PREFIX_BYTES {
            let size = u32::from_be_bytes(
                self.bytes[consumed..consumed + 4]
                    .try_into()
                    .map_err(|_| CodecError::InvalidLength)?,
            ) as usize;
            if size == 0 {
                return Err(CodecError::InvalidLength);
            }
            if size > MAX_OBJECT_BYTES {
                return Err(CodecError::FrameTooLarge);
            }
            let Some(end) = consumed
                .checked_add(PREFIX_BYTES)
                .and_then(|v| v.checked_add(size))
            else {
                return Err(CodecError::FrameTooLarge);
            };
            if self.bytes.len() < end {
                break;
            }
            let frame: Frame = serde_json::from_slice(&self.bytes[consumed + PREFIX_BYTES..end])
                .map_err(|_| CodecError::InvalidJson)?;
            frame.validate()?;
            frames.push(frame);
            consumed = end;
        }
        if consumed > 0 {
            self.bytes = self.bytes[consumed..].to_vec();
        }
        Ok(frames)
    }
}

#[cfg(test)]
mod credential_and_snapshot_tests {
    use super::*;
    use serde_json::json;
    fn id() -> CanonicalUuid {
        CanonicalUuid::new(Uuid::new_v4())
    }
    fn frame(message: ManagementMessage) -> Frame {
        Frame {
            namespace: NAMESPACE.into(),
            version: VERSION,
            sender_sequence: 1,
            channel_id: id(),
            message,
        }
    }
    fn credential(value: &str) -> Frame {
        frame(ManagementMessage::Request {
            request_id: id(),
            method: ManagementMethod::CredentialSet,
            params: RequestParams::CredentialSet(CredentialSetParams {
                expected_revision: 0,
                provider_id: "moonshot-coding".into(),
                credential: value.into(),
                mutation_id: id(),
            }),
        })
    }
    fn snapshot() -> HostSnapshot {
        HostSnapshot {
            version: 1,
            host_id: id(),
            configured: false,
            settings: None,
            active_session: None,
            stopping: false,
            capabilities: vec![],
            agent_net: AgentNetStatus {
                available: true,
                reason: None,
            },
            runtime: RuntimeStatus {
                node: "24.0.0".into(),
                sdk_binary_present: false,
            },
            credentials: CredentialsStatus {
                provider_id: "moonshot-coding".into(),
                configured: false,
                revision: 0,
                write_available: false,
            },
            resources: ResourcesSnapshot {
                version: 1,
                revision: 0,
                roots: vec![ResourceRoot {
                    root_id: "workspace".into(),
                    workspace_path: "/var/lib/isolated/workspaces".into(),
                }],
                agents: vec![ResourceAgent {
                    agent_id: "agent-1".into(),
                    project_id: "project-1".into(),
                    name: "isolated".into(),
                    workspace_path: "/var/lib/isolated/workspaces/one".into(),
                    enabled: false,
                    archived: false,
                }],
            },
        }
    }
    fn snapshot_frame(s: HostSnapshot) -> Frame {
        frame(ManagementMessage::Response {
            request_id: id(),
            result: ResponseResult::Snapshot(Box::new(s)),
        })
    }
    fn decode_json(value: serde_json::Value) -> Result<Vec<Frame>, CodecError> {
        let body = serde_json::to_vec(&value).unwrap();
        let mut bytes = (body.len() as u32).to_be_bytes().to_vec();
        bytes.extend(body);
        FrameDecoder::default().push(&bytes)
    }
    #[test]
    fn credential_round_trip_is_bounded_utf8_and_redacted_through_frame_debug() {
        let value = "isolated-secret-fixture";
        let valid = credential(value);
        assert_eq!(
            FrameDecoder::default()
                .push(&encode_frame(&valid).unwrap())
                .unwrap(),
            vec![valid.clone()]
        );
        let debug = format!("{valid:?}");
        assert!(debug.contains("[REDACTED]"));
        assert!(!debug.contains(value));
        assert!(credential(&"é".repeat(8192)).validate().is_ok());
        for invalid in [
            String::new(),
            "x\ny".into(),
            "x\ry".into(),
            "x\0y".into(),
            "é".repeat(8193),
        ] {
            assert_eq!(
                credential(&invalid).validate(),
                Err(CodecError::InvalidFrame)
            );
        }
        let mut wrong = credential(value);
        if let ManagementMessage::Request {
            params: RequestParams::CredentialSet(p),
            ..
        } = &mut wrong.message
        {
            p.provider_id = "other-provider".into();
        }
        assert!(wrong.validate().is_err());
        if let ManagementMessage::Request {
            params: RequestParams::CredentialSet(p),
            ..
        } = &mut wrong.message
        {
            p.provider_id = "moonshot-coding".into();
            p.expected_revision = MAX_SAFE_SEQUENCE + 1;
        }
        assert!(wrong.validate().is_err());
    }
    #[test]
    fn credential_and_receipt_closed_keys_reject_secret_projection() {
        let mut value = serde_json::to_value(credential("fixture-only")).unwrap();
        value["message"]["params"]["extra"] = json!(true);
        assert_eq!(decode_json(value), Err(CodecError::InvalidJson));
        let receipt = CredentialReceipt::Persisted {
            mutation_id: id(),
            revision: 1,
            effect: ConfigEffect::NewSession,
        };
        let valid = frame(ManagementMessage::Response {
            request_id: id(),
            result: ResponseResult::CredentialReceipt(receipt),
        });
        assert!(encode_frame(&valid).is_ok());
        let mut value = serde_json::to_value(valid).unwrap();
        value["message"]["result"]["credential"] = json!("fixture-only");
        assert_eq!(decode_json(value), Err(CodecError::InvalidJson));
        let value = json!({"kind":"credential-receipt","status":"not-found","mutationId":id()});
        assert!(serde_json::from_value::<ResponseResult>(value).is_err());
        let not_found = frame(ManagementMessage::Response {
            request_id: id(),
            result: ResponseResult::ReceiptNotFound {
                mutation_id: id(),
                owner: Owner::Credentials,
            },
        });
        assert!(encode_frame(&not_found).is_ok());
        let raw = serde_json::to_string(&credential("fixture-only"))
            .unwrap()
            .replace(
                "\"credential\":\"fixture-only\"",
                "\"credential\":\"fixture-only\",\"credential\":\"different\"",
            );
        assert!(serde_json::from_str::<Frame>(&raw).is_err());
    }
    #[test]
    fn credential_receipts_have_safe_revision_and_actual_effect() {
        for receipt in [
            CredentialReceipt::Persisted {
                mutation_id: id(),
                revision: 0,
                effect: ConfigEffect::NewSession,
            },
            CredentialReceipt::Persisted {
                mutation_id: id(),
                revision: 1,
                effect: ConfigEffect::None,
            },
            CredentialReceipt::Conflict {
                mutation_id: id(),
                revision: 0,
                effect: ConfigEffect::NewSession,
            },
            CredentialReceipt::Conflict {
                mutation_id: id(),
                revision: MAX_SAFE_SEQUENCE + 1,
                effect: ConfigEffect::None,
            },
        ] {
            assert!(validate_credential_receipt(&receipt).is_err());
        }
        assert!(
            validate_credential_receipt(&CredentialReceipt::Conflict {
                mutation_id: id(),
                revision: 0,
                effect: ConfigEffect::None
            })
            .is_ok()
        );
    }
    #[test]
    fn snapshot_requires_both_closed_nonsecret_owner_projections() {
        let valid = snapshot_frame(snapshot());
        assert!(encode_frame(&valid).is_ok());
        for key in ["credentials", "resources"] {
            let mut value = serde_json::to_value(&valid).unwrap();
            value["message"]["result"]
                .as_object_mut()
                .unwrap()
                .remove(key);
            assert_eq!(decode_json(value), Err(CodecError::InvalidJson));
        }
        for key in ["credential", "hash", "permissionGuess"] {
            let mut value = serde_json::to_value(&valid).unwrap();
            value["message"]["result"]["credentials"][key] = json!("fixture-only");
            assert_eq!(decode_json(value), Err(CodecError::InvalidJson));
        }
        let mut value = serde_json::to_value(&valid).unwrap();
        value["message"]["result"]["resources"]["roots"][0]["credential"] = json!("fixture-only");
        assert_eq!(decode_json(value), Err(CodecError::InvalidJson));
        let mut value = serde_json::to_value(valid).unwrap();
        value["message"]["result"]["resources"]["agents"][0]["extra"] = json!(true);
        assert_eq!(decode_json(value), Err(CodecError::InvalidJson));
        let mut s = snapshot();
        s.credentials.configured = true;
        assert!(snapshot_frame(s.clone()).validate().is_err());
        s.credentials.revision = 1;
        assert!(snapshot_frame(s).validate().is_ok());
    }
    #[test]
    fn snapshot_rejects_duplicates_limits_and_invalid_paths() {
        let mut s = snapshot();
        s.resources.roots.push(s.resources.roots[0].clone());
        assert!(snapshot_frame(s).validate().is_err());
        let mut s = snapshot();
        s.resources.agents.push(s.resources.agents[0].clone());
        assert!(snapshot_frame(s).validate().is_err());
        let mut s = snapshot();
        s.resources.roots = (0..17)
            .map(|i| ResourceRoot {
                root_id: format!("root-{i}"),
                workspace_path: "/isolated".into(),
            })
            .collect();
        assert!(snapshot_frame(s).validate().is_err());
        let mut s = snapshot();
        s.resources.agents = (0..129)
            .map(|i| ResourceAgent {
                agent_id: format!("agent-{i}"),
                ..s.resources.agents[0].clone()
            })
            .collect();
        assert!(snapshot_frame(s).validate().is_err());
        let mut s = snapshot();
        s.resources.roots[0].workspace_path = "relative".into();
        assert!(snapshot_frame(s).validate().is_err());
        let mut s = snapshot();
        s.resources.agents[0].workspace_path = format!("/{}", "x".repeat(4096));
        assert!(snapshot_frame(s).validate().is_err());
        let mut s = snapshot();
        s.resources.agents = (0..128)
            .map(|i| ResourceAgent {
                agent_id: format!("agent-{i}"),
                workspace_path: format!("/{}", "x".repeat(2000)),
                ..s.resources.agents[0].clone()
            })
            .collect();
        assert!(snapshot_frame(s.clone()).validate().is_ok());
        assert_eq!(
            encode_frame(&snapshot_frame(s)),
            Err(CodecError::FrameTooLarge)
        );
    }
}
