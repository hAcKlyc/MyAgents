use std::fs;
use std::io::{Cursor, Read};
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use image::ImageEncoder;
use reqwest::header::{ACCEPT_LANGUAGE, AUTHORIZATION, USER_AGENT};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

use crate::device_identity::{current_device_identity, DeviceIdentity};
use crate::network_diagnostics::{error_category, response_request_id, RequestDiagnostic};
use crate::workspace_files::path_safety::open_regular_file_no_follow;
use crate::{ulog_info, ulog_warn};

pub(crate) mod agent_network;
pub(crate) mod attachments;
pub(crate) mod cli;
pub(crate) mod delivery;
pub(crate) mod notifications;
pub(crate) mod registered_agents;
pub(crate) mod skills;
pub(crate) mod tools;

pub use attachments::{
    SpaceAttachmentDraftMetadata, SpaceCommentIssueWithAttachmentsInput,
    SpaceCreateIssueWithAttachmentsInput, SpaceDownloadAttachmentInput,
    SpaceDownloadAttachmentResult, SpaceInspectAttachmentDraftsInput,
    SpaceUploadIssueAttachmentsInput,
};
pub(crate) use attachments::{MAX_ATTACHMENT_UPLOAD_BYTES, MAX_ATTACHMENT_UPLOAD_COUNT};
pub use cli::{
    SpaceCliAttachmentAddInput, SpaceCliAttachmentDownloadInput, SpaceCliClaimLocalTaskInput,
    SpaceCliContextInput, SpaceCliGoalListInput, SpaceCliIssueActionInput, SpaceCliIssueClaimInput,
    SpaceCliIssueCommentGetInput, SpaceCliIssueCommentInput, SpaceCliIssueCommentsInput,
    SpaceCliIssueCreateInput, SpaceCliIssueGetInput, SpaceCliIssueGoalUpdate,
    SpaceCliIssueListInput, SpaceCliIssueStatusInput, SpaceCliIssueUpdateInput,
    SpaceCliRegisteredAgentOrigin,
};
pub use delivery::{
    SpaceMarkDeliveryDeliveredInput, SpaceMarkDispatchDeliveredInput, SpacePollDeliveriesInput,
    SpacePollDispatchesInput, SpaceProcessDeliveryResult,
};
pub use registered_agents::registered_agents_path;
pub use registered_agents::{
    LocalRegisteredAgent, LocalRegisteredAgentPublic, SpaceGoalSubscriptionSummary,
    SpaceIssueSubscriptionRunMode, SpaceRegisterAgentInput, SpaceRegisteredAgentIdInput,
    SpaceUpdateRegisteredAgentAvatarInput, SpaceUpdateRegisteredAgentInput, SpaceUserDeviceSummary,
};
pub(crate) use skills::MAX_SKILL_ZIP_BYTES;
pub use skills::{
    SpaceCleanupSkillExportPackagesInput, SpaceExportSkillFromUrlInput,
    SpaceInspectSkillSourceInput, SpaceInstallSkillInput, SpaceInstallSkillResult,
    SpaceListLocalSkillsInput, SpaceLocalSkillProjectInput, SpaceLocalSkillSummary,
    SpaceSkillInstallTarget, SpaceSkillSourceInspection, SpaceSkillSourceMetaInput,
    SpaceUploadSkillInput,
};
pub use tools::{SpacePublishToolInput, SpaceUpdateToolInput};

const SPACE_ENABLED_ENV: Option<&str> = option_env!("MYAGENTS_SPACE_ENABLED");
const SPACE_BASE_URL_ENV: Option<&str> = option_env!("MYAGENTS_SPACE_BASE_URL");
const SPACE_DEV_BASE_URL_ENV: Option<&str> = option_env!("MYAGENTS_SPACE_DEV_BASE_URL");
const SPACE_PUBLIC_CLIENT_ID_ENV: Option<&str> = option_env!("MYAGENTS_SPACE_PUBLIC_CLIENT_ID");
const SPACE_LEGACY_CLIENT_ID_ENV: Option<&str> = option_env!("MYAGENTS_SPACE_CLIENT_ID");
const SPACE_PUBLIC_CLIENT_ID_HEADER: &str = "X-MyAgents-Space-Client-Id";
const SPACE_CLIENT_VERSION_HEADER: &str = "X-MyAgents-Client-Version";
const SPACE_DEVICE_ID_HEADER: &str = "X-MyAgents-Device-Id";
const SPACE_PLATFORM_HEADER: &str = "X-MyAgents-Platform";
const SPACE_OS_VERSION_HEADER: &str = "X-MyAgents-OS-Version";
const SPACE_CONTEXT_HEADER: &str = "X-MyAgents-Space-Context";
const SESSION_FILE: &str = "session.json";
const MAX_PROFILE_AVATAR_BYTES: u64 = 5 * 1024 * 1024;
const MAX_SPACE_AVATAR_BYTES: u64 = MAX_PROFILE_AVATAR_BYTES;
const NORMALIZED_AVATAR_MAX_EDGE: u32 = 256;
const NORMALIZED_AVATAR_MAX_BYTES: usize = 512 * 1024;
const MAX_CLOUD_ISSUE_INSTRUCTION_CHARS: usize = 20_000;
#[derive(Debug)]
struct SpaceClientDeviceContext {
    client_version: String,
    device_id: Option<String>,
    platform: String,
    os_version: Option<String>,
}

static SPACE_CLIENT_DEVICE_CONTEXT: LazyLock<SpaceClientDeviceContext> = LazyLock::new(|| {
    let fallback_platform = crate::device_identity::platform_identifier();
    match current_device_identity() {
        Ok(identity) => SpaceClientDeviceContext {
            client_version: normalize_space_header_fact(
                &identity.app_version,
                env!("CARGO_PKG_VERSION"),
            ),
            device_id: normalize_optional_space_header_fact(&identity.device_id),
            platform: normalize_space_header_fact(&identity.platform, &fallback_platform),
            os_version: identity
                .os_version
                .as_deref()
                .and_then(normalize_optional_space_header_fact),
        },
        Err(_) => SpaceClientDeviceContext {
            client_version: env!("CARGO_PKG_VERSION").to_string(),
            device_id: None,
            platform: normalize_space_header_fact(&fallback_platform, "unknown"),
            os_version: None,
        },
    }
});

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceSession {
    pub base_url: String,
    user_credential: SpaceUserCredential,
    pub user: Value,
    #[serde(default)]
    pub account_plan: Value,
    pub space: Value,
    pub membership: Value,
    #[serde(default)]
    pub spaces: Vec<Value>,
    #[serde(default)]
    pub last_active_space_id: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum SpaceUserCredential {
    Authenticated {
        session_token: String,
        expires_at: Option<String>,
    },
    ReauthRequired {
        invalidated_session_binding_id: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpaceSessionWire {
    base_url: String,
    #[serde(default)]
    user_credential: Option<SpaceUserCredential>,
    #[serde(default)]
    session_token: Option<String>,
    #[serde(default)]
    expires_at: Option<String>,
    user: Value,
    #[serde(default)]
    account_plan: Value,
    space: Value,
    membership: Value,
    #[serde(default)]
    spaces: Vec<Value>,
    #[serde(default)]
    last_active_space_id: Option<String>,
    updated_at: String,
}

impl<'de> Deserialize<'de> for SpaceSession {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = SpaceSessionWire::deserialize(deserializer)?;
        let user_credential = match (wire.user_credential, wire.session_token) {
            (Some(credential), None) => credential,
            (None, Some(session_token)) if !session_token.trim().is_empty() => {
                SpaceUserCredential::Authenticated {
                    session_token,
                    expires_at: wire.expires_at,
                }
            }
            (Some(_), Some(_)) => {
                return Err(serde::de::Error::custom(
                    "Space session contains both canonical and legacy credentials",
                ));
            }
            _ => {
                return Err(serde::de::Error::custom(
                    "Space session is missing its user credential",
                ));
            }
        };
        Ok(Self {
            base_url: wire.base_url,
            user_credential,
            user: wire.user,
            account_plan: wire.account_plan,
            space: wire.space,
            membership: wire.membership,
            spaces: wire.spaces,
            last_active_space_id: wire.last_active_space_id,
            updated_at: wire.updated_at,
        })
    }
}

impl SpaceSession {
    pub(crate) fn authenticated(
        account: SpaceAccountPublic,
        session_token: String,
        expires_at: Option<String>,
    ) -> Self {
        Self {
            base_url: account.base_url,
            user_credential: SpaceUserCredential::Authenticated {
                session_token,
                expires_at,
            },
            user: account.user,
            account_plan: account.account_plan,
            space: account.space,
            membership: account.membership,
            spaces: account.spaces,
            last_active_space_id: account.last_active_space_id,
            updated_at: account.updated_at,
        }
    }

    fn expires_at(&self) -> Option<&str> {
        match &self.user_credential {
            SpaceUserCredential::Authenticated { expires_at, .. } => expires_at.as_deref(),
            SpaceUserCredential::ReauthRequired { .. } => None,
        }
    }

    fn session_binding_id(&self) -> String {
        match &self.user_credential {
            SpaceUserCredential::Authenticated { session_token, .. } => {
                space_session_binding_id_for_token(&self.base_url, session_token)
            }
            SpaceUserCredential::ReauthRequired {
                invalidated_session_binding_id,
            } => invalidated_session_binding_id.clone(),
        }
    }

    fn authenticated_token(&self) -> Option<&str> {
        match &self.user_credential {
            SpaceUserCredential::Authenticated { session_token, .. } => Some(session_token),
            SpaceUserCredential::ReauthRequired { .. } => None,
        }
    }

    fn invalidated_session_binding_id(&self) -> Option<&str> {
        match &self.user_credential {
            SpaceUserCredential::Authenticated { .. } => None,
            SpaceUserCredential::ReauthRequired {
                invalidated_session_binding_id,
            } => Some(invalidated_session_binding_id),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceSessionPublic {
    pub session_binding_id: String,
    pub base_url: String,
    pub expires_at: Option<String>,
    pub user: Value,
    pub account_plan: Value,
    pub space: Value,
    pub membership: Value,
    pub spaces: Vec<Value>,
    pub last_active_space_id: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SpaceSessionView {
    Authenticated {
        session: SpaceSessionPublic,
    },
    ReauthRequired {
        account: SpaceAccountPublic,
        invalidated_session_binding_id: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceAccountPublic {
    pub base_url: String,
    pub user: Value,
    pub account_plan: Value,
    pub space: Value,
    pub membership: Value,
    pub spaces: Vec<Value>,
    pub last_active_space_id: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceBuildCapability {
    pub available: bool,
    pub base_url: Option<String>,
    pub public_client_id: Option<String>,
    pub reason: Option<String>,
    pub environments: Vec<SpaceEnvironment>,
    pub active_environment: SpaceEnvironment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SpaceEnvironment {
    Production,
    Dev,
}

#[derive(Debug, Clone)]
struct SpaceRuntimeScope {
    base_url: String,
    data_dir: PathBuf,
}

#[derive(Debug, Clone)]
struct AuthenticatedSpaceSession {
    account: SpaceSession,
    session_token: String,
    session_binding_id: String,
    session_path: PathBuf,
}

impl AuthenticatedSpaceSession {
    fn from_account(account: SpaceSession, session_path: PathBuf) -> Result<Self, String> {
        let session_token = account
            .authenticated_token()
            .ok_or_else(|| "SPACE_REAUTH_REQUIRED: MyAgents Space login is required.".to_string())?
            .to_string();
        let session_binding_id = account.session_binding_id();
        Ok(Self {
            account,
            session_token,
            session_binding_id,
            session_path,
        })
    }

    fn session_token(&self) -> &str {
        &self.session_token
    }

    fn session_binding_id(&self) -> &str {
        &self.session_binding_id
    }

    fn session_path(&self) -> &Path {
        &self.session_path
    }
}

impl Deref for AuthenticatedSpaceSession {
    type Target = SpaceSession;

    fn deref(&self) -> &Self::Target {
        &self.account
    }
}

impl SpaceEnvironment {
    fn config_value(self) -> &'static str {
        match self {
            Self::Production => "production",
            Self::Dev => "dev",
        }
    }
}

impl From<SpaceSession> for SpaceSessionPublic {
    fn from(session: SpaceSession) -> Self {
        let session_binding_id = session.session_binding_id();
        let expires_at = session.expires_at().map(ToString::to_string);
        Self {
            session_binding_id,
            base_url: session.base_url.clone(),
            expires_at,
            user: session.user,
            account_plan: session.account_plan,
            space: session.space,
            membership: session.membership,
            spaces: session.spaces,
            last_active_space_id: session.last_active_space_id,
            updated_at: session.updated_at,
        }
    }
}

impl From<SpaceSession> for SpaceSessionView {
    fn from(session: SpaceSession) -> Self {
        if let Some(invalidated_session_binding_id) = session
            .invalidated_session_binding_id()
            .map(ToString::to_string)
        {
            return Self::ReauthRequired {
                account: SpaceAccountPublic {
                    base_url: session.base_url,
                    user: session.user,
                    account_plan: session.account_plan,
                    space: session.space,
                    membership: session.membership,
                    spaces: session.spaces,
                    last_active_space_id: session.last_active_space_id,
                    updated_at: session.updated_at,
                },
                invalidated_session_binding_id,
            };
        }
        Self::Authenticated {
            session: session.into(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceAuthPollInput {
    pub login_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceApiRequestInput {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub body: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceSetActiveSpaceInput {
    pub space_id: String,
    pub expected_session_binding_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceUpdateProfileInput {
    pub name: String,
    #[serde(default)]
    pub avatar_file_path: Option<String>,
    #[serde(default)]
    pub avatar_preset_id: Option<String>,
    #[serde(default)]
    pub name_changed: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceUpdateSpaceInput {
    pub space_id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub avatar_file_path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CloudEnvelope<T> {
    success: bool,
    data: Option<T>,
    error: Option<String>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default, rename = "requestId")]
    request_id: Option<String>,
    #[serde(default, rename = "recoveryHint")]
    recovery_hint: Option<Value>,
    #[serde(default)]
    quota: Option<String>,
    #[serde(default)]
    usage: Option<Value>,
    #[serde(default)]
    limit: Option<Value>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum SpaceCredentialKind {
    UserSession,
    RegisteredAgent,
}

fn should_require_space_reauth(
    status: reqwest::StatusCode,
    credential_kind: SpaceCredentialKind,
) -> bool {
    status == reqwest::StatusCode::UNAUTHORIZED
        && credential_kind == SpaceCredentialKind::UserSession
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCommandError {
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cloud_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential_kind: Option<SpaceCredentialKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_binding_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery_hint: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    quota: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<Value>,
}

type SpaceCommandResult<T> = Result<T, SpaceCommandError>;

impl SpaceCommandError {
    fn local(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            cloud_code: None,
            http_status: None,
            request_id: None,
            retryable: false,
            credential_kind: None,
            session_binding_id: None,
            recovery_hint: None,
            quota: None,
            usage: None,
            limit: None,
        }
    }

    fn transport(message: impl Into<String>) -> Self {
        Self {
            retryable: true,
            ..Self::local("SPACE_NETWORK_ERROR", message)
        }
    }
}

impl std::fmt::Display for SpaceCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)?;
        if let Some(request_id) = self.request_id.as_deref() {
            write!(formatter, " [requestId={request_id}]")?;
        }
        if let Some(session_binding_id) = self.session_binding_id.as_deref() {
            write!(formatter, " [sessionBindingId={session_binding_id}]")?;
        }
        Ok(())
    }
}

impl std::error::Error for SpaceCommandError {}

impl From<String> for SpaceCommandError {
    fn from(message: String) -> Self {
        let code = message
            .split_once(':')
            .map(|(candidate, _)| candidate.trim())
            .filter(|candidate| {
                !candidate.is_empty()
                    && candidate
                        .chars()
                        .all(|character| character.is_ascii_uppercase() || character == '_')
            })
            .unwrap_or("SPACE_LOCAL_ERROR")
            .to_string();
        Self::local(code, message)
    }
}

impl From<&str> for SpaceCommandError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

impl From<SpaceCommandError> for String {
    fn from(error: SpaceCommandError) -> Self {
        error.to_string()
    }
}

#[tauri::command]
pub async fn cmd_space_get_capability() -> Result<SpaceBuildCapability, String> {
    Ok(space_build_capability())
}

#[tauri::command]
pub async fn cmd_space_get_session() -> Result<Option<SpaceSessionView>, String> {
    if crate::space_cloud_mock::is_enabled() {
        return Ok(Some(crate::space_cloud_mock::session().into()));
    }
    ensure_space_available()?;
    let Some(session) = read_current_session()? else {
        return Ok(None);
    };
    if session.invalidated_session_binding_id().is_some() {
        return Ok(Some(session.into()));
    }
    let authenticated = AuthenticatedSpaceSession::from_account(session, session_path()?)?;
    let identity = current_device_identity()?;
    spawn_space_user_device_upsert(authenticated.clone(), identity);
    match refresh_session_from_cloud(&authenticated).await {
        Ok(refreshed) => {
            let committed = commit_refreshed_session(refreshed).await?;
            Ok(Some(SpaceSessionView::from(committed)))
        }
        Err(error) => {
            if error.code == "SPACE_SESSION_STATE_WRITE_FAILED" {
                return Err(error.into());
            }
            ulog_warn!(
                "[space] failed to refresh /api/me session snapshot: {}",
                error
            );
            let current = read_session_from_path(authenticated.session_path())?
                .ok_or_else(|| "Space session changed while refresh was in flight".to_string())?;
            Ok(Some(current.into()))
        }
    }
}

#[tauri::command]
pub async fn cmd_space_set_active_space(
    input: SpaceSetActiveSpaceInput,
) -> Result<Option<SpaceSessionPublic>, String> {
    if crate::space_cloud_mock::is_enabled() {
        let mut session = crate::space_cloud_mock::session();
        let trimmed = input.space_id.trim();
        session.last_active_space_id = (!trimmed.is_empty()).then(|| trimmed.to_string());
        return Ok(Some(session.into()));
    }
    ensure_space_available()?;
    let configured_base_url = space_base_url()?;
    let path = session_path()?;
    let active_space_id = input.space_id.trim().to_string();
    let expected_session_binding_id = input.expected_session_binding_id;
    let session = tauri::async_runtime::spawn_blocking(move || {
        set_active_space_in_session_file(
            &path,
            &configured_base_url,
            &expected_session_binding_id,
            &active_space_id,
        )
    })
    .await
    .map_err(|error| format!("set active Space task failed: {error:?}"))??;
    Ok(session.map(Into::into))
}

#[tauri::command]
pub async fn cmd_space_auth_start() -> Result<Value, String> {
    let capability = ensure_space_available()?;
    let base_url = capability_base_url(&capability)?;
    let client = http_client()?;
    let response = with_space_client_context_headers(
        client.post(api_url(&base_url, "/api/auth/desktop/start")?),
        &capability,
    )
    .send()
    .await
    .map_err(|e| format!("Space auth start failed: {}", e))?;
    let data = parse_cloud_data::<Value>(response).await?;
    if let Some(url) = data.get("authorizationUrl").and_then(Value::as_str) {
        crate::browser::spawn_external_open(url);
    }
    Ok(data)
}

#[tauri::command]
pub async fn cmd_space_auth_poll(
    app: tauri::AppHandle,
    input: SpaceAuthPollInput,
) -> Result<Value, String> {
    let capability = ensure_space_available()?;
    let base_url = capability_base_url(&capability)?;
    let client = http_client()?;
    let session_path = session_path()?;
    let expected_session_binding_id = read_session_from_path(&session_path)?
        .as_ref()
        .map(SpaceSession::session_binding_id);
    let path = format!(
        "/api/auth/desktop/poll?token={}",
        url_component(&input.login_token)
    );
    let response =
        with_space_client_context_headers(client.get(api_url(&base_url, &path)?), &capability)
            .send()
            .await
            .map_err(|_| "Space auth poll request failed".to_string())?;
    let mut data = parse_cloud_data::<Value>(response).await?;
    if data.get("status").and_then(Value::as_str) == Some("done") {
        let token = data
            .get("sessionToken")
            .and_then(Value::as_str)
            .ok_or_else(|| "Space auth completed without session token".to_string())?
            .to_string();
        let session = SpaceSession::authenticated(
            SpaceAccountPublic {
                base_url,
                user: data.get("user").cloned().unwrap_or(Value::Null),
                account_plan: data.get("accountPlan").cloned().unwrap_or(Value::Null),
                space: data.get("space").cloned().unwrap_or(Value::Null),
                membership: data.get("membership").cloned().unwrap_or(Value::Null),
                spaces: data
                    .get("spaces")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
                last_active_space_id: None,
                updated_at: chrono::Utc::now().to_rfc3339(),
            },
            token,
            data.get("expiresAt")
                .and_then(Value::as_str)
                .map(ToString::to_string),
        );
        if commit_authenticated_session_if_unchanged_at_path(
            &session_path,
            expected_session_binding_id.as_deref(),
            &session,
        )? {
            let identity = current_device_identity()?;
            spawn_space_user_device_upsert(
                AuthenticatedSpaceSession::from_account(session, session_path)?,
                identity,
            );
            account_auth_boundary_changed(&app);
        }
        if let Some(map) = data.as_object_mut() {
            map.remove("sessionToken");
        }
    }
    Ok(data)
}

#[tauri::command]
pub async fn cmd_space_auth_ack(input: SpaceAuthPollInput) -> Result<(), String> {
    let capability = ensure_space_available()?;
    let base_url = capability_base_url(&capability)?;
    let response = with_space_client_context_headers(
        http_client()?
            .post(api_url(&base_url, "/api/auth/desktop/ack")?)
            .json(&serde_json::json!({ "token": input.login_token })),
        &capability,
    )
    .send()
    .await
    .map_err(|_| "Space auth acknowledgement failed".to_string())?;
    let _ = parse_cloud_data::<Value>(response).await?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_space_logout(app: tauri::AppHandle) -> Result<(), String> {
    if crate::space_cloud_mock::is_enabled() {
        crate::space_cloud_mock::reset();
        account_auth_boundary_changed(&app);
        return Ok(());
    }
    let capability = space_build_capability();
    let path = session_path()?;
    let session_at_start =
        tauri::async_runtime::spawn_blocking(move || take_session_for_logout(&path))
            .await
            .map_err(|error| format!("remove Space session task failed: {error:?}"))??;
    account_auth_boundary_changed(&app);
    let session_to_revoke = capability
        .available
        .then(|| capability_base_url(&capability).ok())
        .flatten()
        .and_then(|configured_base_url| {
            session_at_start
                .clone()
                .filter(|session| space_base_urls_equal(&session.base_url, &configured_base_url))
        });

    if let Some(session) = session_to_revoke {
        let Some(session_token) = session.authenticated_token() else {
            return Ok(());
        };
        match (http_client(), api_url(&session.base_url, "/api/logout")) {
            (Ok(client), Ok(url)) => {
                let _ = with_space_client_context_headers(
                    client
                        .post(url)
                        .header(AUTHORIZATION, format!("Bearer {}", session_token)),
                    &capability,
                )
                .send()
                .await;
            }
            (client, url) => {
                ulog_warn!(
                    "[space] local logout completed but remote revoke could not start: client={:?} url={:?}",
                    client.err(),
                    url.err()
                );
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn cmd_space_update_profile(
    input: SpaceUpdateProfileInput,
) -> SpaceCommandResult<SpaceSessionPublic> {
    if crate::space_cloud_mock::is_enabled() {
        let session =
            crate::space_cloud_mock::update_profile(input).map_err(SpaceCommandError::from)?;
        account_profile_changed();
        return Ok(session);
    }
    ensure_space_available()?;
    let session = require_session()?;
    let form = profile_form(input)?;
    let data = authorized_multipart_data_request(&session, "/api/me/profile", form).await?;
    let refreshed = session_from_me_data(&session, &data);
    let session = commit_refreshed_session(refreshed).await?;
    account_profile_changed();
    Ok(session.into())
}

#[tauri::command]
pub async fn cmd_space_get_avatar_presets() -> SpaceCommandResult<Value> {
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::avatar_presets().map_err(Into::into);
    }
    ensure_space_available()?;
    let session = require_session()?;
    authorized_json_data_request(&session, "/api/avatar-presets", reqwest::Method::GET, None).await
}

#[tauri::command]
pub async fn cmd_space_update_space(
    input: SpaceUpdateSpaceInput,
) -> SpaceCommandResult<SpaceSessionPublic> {
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::update_space(input).map_err(Into::into);
    }
    ensure_space_available()?;
    let session = require_session()?;
    let space_id = input.space_id.trim().to_string();
    if space_id.is_empty() {
        return Err("Space id is required".into());
    }
    let form = space_form(input)?;
    let path = format!("/api/spaces/{}", url_component(&space_id));
    authorized_multipart_method_data_request(reqwest::Method::PATCH, &session, &path, form).await?;
    let refreshed = refresh_session_from_cloud(&session).await?;
    Ok(commit_refreshed_session(refreshed).await?.into())
}

#[tauri::command]
pub async fn cmd_space_api_request(
    input: SpaceApiRequestInput,
) -> Result<Value, SpaceCommandError> {
    let method = reqwest::Method::from_bytes(input.method.to_uppercase().as_bytes())
        .map_err(|_| SpaceCommandError::local("SPACE_METHOD_INVALID", "Invalid HTTP method"))?;
    if !matches!(
        method,
        reqwest::Method::GET
            | reqwest::Method::POST
            | reqwest::Method::PUT
            | reqwest::Method::PATCH
            | reqwest::Method::DELETE
    ) {
        return Err(SpaceCommandError::local(
            "SPACE_METHOD_UNSUPPORTED",
            "Unsupported Space API method",
        ));
    }
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::api_request(input).map_err(Into::into);
    }
    ensure_space_available().map_err(SpaceCommandError::from)?;
    let session = require_session().map_err(SpaceCommandError::from)?;
    let diagnostic = RequestDiagnostic::new("space", &method, &input.path);
    let client = http_client().map_err(SpaceCommandError::from)?;
    let mut req = with_space_client_context_headers(
        client
            .request(
                method,
                api_url(&session.base_url, &input.path).map_err(SpaceCommandError::from)?,
            )
            .header(AUTHORIZATION, format!("Bearer {}", session.session_token())),
        &space_build_capability(),
    );
    if let Some(body) = input.body {
        req = req.json(&body);
    }
    let response = diagnostic.send(req).await.map_err(|e| {
        SpaceCommandError::transport(format!("Space API request failed ({})", error_category(&e)))
    })?;
    let data = parse_authorized_cloud_data(response, Some(&session), &diagnostic).await?;
    Ok(serde_json::json!({ "success": true, "data": data }))
}

#[tauri::command]
pub async fn cmd_space_register_agent(
    input: SpaceRegisterAgentInput,
) -> SpaceCommandResult<LocalRegisteredAgentPublic> {
    let (agent, should_wake) = registered_agents::register_agent(input).await?;
    if should_wake {
        delivery::wake_space_connector_for_agent(&agent.id);
    }
    Ok(agent)
}

#[tauri::command]
pub async fn cmd_space_update_registered_agent(
    input: SpaceUpdateRegisteredAgentInput,
) -> SpaceCommandResult<LocalRegisteredAgentPublic> {
    let (agent, should_wake) = registered_agents::update_registered_agent(input).await?;
    if should_wake {
        delivery::wake_space_connector_for_agent(&agent.id);
    }
    Ok(agent)
}

#[tauri::command]
pub async fn cmd_space_update_registered_agent_avatar(
    input: SpaceUpdateRegisteredAgentAvatarInput,
) -> SpaceCommandResult<LocalRegisteredAgentPublic> {
    let (agent, should_wake) = registered_agents::update_registered_agent_avatar(input).await?;
    if should_wake {
        delivery::wake_space_connector_for_agent(&agent.id);
    }
    Ok(agent)
}

#[tauri::command]
pub async fn cmd_space_download_attachment(
    input: SpaceDownloadAttachmentInput,
) -> SpaceCommandResult<SpaceDownloadAttachmentResult> {
    if crate::space_cloud_mock::is_enabled() {
        return Ok(crate::space_cloud_mock::download_attachment(
            &input.workspace_path,
            &input.attachment_id,
            input.issue_id.as_deref(),
            input.file_name.as_deref(),
            input.output.as_deref(),
        )?);
    }
    if let Some(agent_id) = input.registered_agent_id.as_deref() {
        let agent = registered_agents::require_local_agent(agent_id)?;
        let base_url = space_base_url()?;
        return attachments::download_attachment_with_token(
            &base_url,
            &agent.token,
            &input,
            None,
            None,
        )
        .await;
    }
    let session = require_session()?;
    attachments::download_attachment_with_token(
        &session.base_url,
        session.session_token(),
        &input,
        None,
        Some(&session),
    )
    .await
}

fn http_client() -> Result<reqwest::Client, String> {
    // Space talks to configured external HTTPS origins. `local_http` is
    // localhost-only; this client must honor the app's proxy settings.
    #[allow(clippy::disallowed_methods)]
    let builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5));
    crate::proxy_config::build_client_with_proxy(builder)
        .map_err(|e| format!("Failed to build Space HTTP client: {}", e))
}

fn space_enabled_flag() -> bool {
    SPACE_ENABLED_ENV
        .map(str::trim)
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn configured_public_client_id() -> Option<String> {
    [SPACE_PUBLIC_CLIENT_ID_ENV, SPACE_LEGACY_CLIENT_ID_ENV]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn validate_configured_space_base_url(key: &str, raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(format!("{key} is empty"));
    }
    let url = reqwest::Url::parse(trimmed).map_err(|e| format!("Invalid {key}: {}", e))?;
    if url.scheme() != "https" {
        return Err(format!("{key} must use https"));
    }
    if url.host_str().is_none() {
        return Err(format!("{key} must include a host"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!("{key} must not include credentials"));
    }
    let mut normalized = url;
    if normalized.path() != "/" {
        return Err(format!("{key} must not include a path"));
    }
    normalized.set_query(None);
    normalized.set_fragment(None);
    Ok(normalized.to_string().trim_end_matches('/').to_string())
}

fn configured_dev_base_url() -> Result<Option<String>, String> {
    SPACE_DEV_BASE_URL_ENV
        .filter(|value| !value.trim().is_empty())
        .map(|value| validate_configured_space_base_url("MYAGENTS_SPACE_DEV_BASE_URL", value))
        .transpose()
}

fn resolve_configured_space_environment(
    configured_value: Option<&str>,
    dev_available: bool,
) -> SpaceEnvironment {
    if !dev_available {
        return SpaceEnvironment::Production;
    }
    match configured_value {
        Some("dev" | "staging") => SpaceEnvironment::Dev,
        _ => SpaceEnvironment::Production,
    }
}

fn configured_space_environment(dev_available: bool) -> SpaceEnvironment {
    let Some(dir) = crate::app_dirs::myagents_data_dir() else {
        return SpaceEnvironment::Production;
    };
    let Ok(content) = fs::read_to_string(dir.join("config.json")) else {
        return SpaceEnvironment::Production;
    };
    let Ok(config) = serde_json::from_str::<Value>(crate::utils::bom::strip_bom(&content)) else {
        return SpaceEnvironment::Production;
    };
    resolve_configured_space_environment(
        config.get("spaceEnvironment").and_then(Value::as_str),
        dev_available,
    )
}

pub fn space_build_capability() -> SpaceBuildCapability {
    if crate::app_dirs::IS_ISOLATED_QA {
        return SpaceBuildCapability {
            available: false, base_url: None, public_client_id: None,
            reason: Some("UPDATER_QA_CREDENTIALS_DISABLED".to_string()),
            environments: Vec::new(), active_environment: SpaceEnvironment::Production,
        };
    }
    if crate::space_cloud_mock::is_enabled() {
        return SpaceBuildCapability {
            available: true,
            base_url: Some(crate::space_cloud_mock::MOCK_BASE_URL.to_string()),
            public_client_id: Some("mock-public-client".to_string()),
            reason: None,
            environments: vec![SpaceEnvironment::Production],
            active_environment: SpaceEnvironment::Production,
        };
    }
    if !space_enabled_flag() {
        return SpaceBuildCapability {
            available: false,
            base_url: None,
            public_client_id: configured_public_client_id(),
            reason: Some("Team Space is not enabled in this build".to_string()),
            environments: vec![SpaceEnvironment::Production],
            active_environment: SpaceEnvironment::Production,
        };
    }
    let base_url = match SPACE_BASE_URL_ENV {
        Some(value) => match validate_configured_space_base_url("MYAGENTS_SPACE_BASE_URL", value) {
            Ok(url) => url,
            Err(error) => {
                return SpaceBuildCapability {
                    available: false,
                    base_url: None,
                    public_client_id: configured_public_client_id(),
                    reason: Some(error),
                    environments: vec![SpaceEnvironment::Production],
                    active_environment: SpaceEnvironment::Production,
                };
            }
        },
        None => {
            return SpaceBuildCapability {
                available: false,
                base_url: None,
                public_client_id: configured_public_client_id(),
                reason: Some(
                    "MYAGENTS_SPACE_BASE_URL is required when MYAGENTS_SPACE_ENABLED=true"
                        .to_string(),
                ),
                environments: vec![SpaceEnvironment::Production],
                active_environment: SpaceEnvironment::Production,
            };
        }
    };
    let dev_base_url = match configured_dev_base_url() {
        Ok(value) => value,
        Err(error) => {
            return SpaceBuildCapability {
                available: false,
                base_url: None,
                public_client_id: configured_public_client_id(),
                reason: Some(error),
                environments: vec![SpaceEnvironment::Production],
                active_environment: SpaceEnvironment::Production,
            };
        }
    };
    let mut environments = vec![SpaceEnvironment::Production];
    if dev_base_url.is_some() {
        environments.push(SpaceEnvironment::Dev);
    }
    let active_environment = configured_space_environment(dev_base_url.is_some());
    let active_base_url = match active_environment {
        SpaceEnvironment::Production => base_url,
        SpaceEnvironment::Dev => dev_base_url.unwrap_or(base_url),
    };
    SpaceBuildCapability {
        available: true,
        base_url: Some(active_base_url),
        public_client_id: configured_public_client_id(),
        reason: None,
        environments,
        active_environment,
    }
}

fn ensure_space_available() -> Result<SpaceBuildCapability, String> {
    let capability = space_build_capability();
    if capability.available {
        Ok(capability)
    } else {
        Err(capability
            .reason
            .unwrap_or_else(|| "Team Space is not available in this build".to_string()))
    }
}

fn capability_base_url(capability: &SpaceBuildCapability) -> Result<String, String> {
    capability
        .base_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "Team Space build capability is missing baseUrl".to_string())
}

fn normalize_space_header_fact(value: &str, fallback: &str) -> String {
    let normalized = value
        .chars()
        .filter(|character| character.is_ascii_graphic() || *character == ' ')
        .take(256)
        .collect::<String>();
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalize_optional_space_header_fact(value: &str) -> Option<String> {
    let normalized = normalize_space_header_fact(value, "");
    (!normalized.is_empty()).then_some(normalized)
}

fn with_space_client_context_headers(
    request: reqwest::RequestBuilder,
    capability: &SpaceBuildCapability,
) -> reqwest::RequestBuilder {
    let request = match capability.public_client_id.as_deref() {
        Some(client_id) if !client_id.trim().is_empty() => {
            request.header(SPACE_PUBLIC_CLIENT_ID_HEADER, client_id.trim())
        }
        _ => request,
    };

    let client_version = SPACE_CLIENT_DEVICE_CONTEXT.client_version.as_str();
    let platform = SPACE_CLIENT_DEVICE_CONTEXT.platform.as_str();

    let mut request = request
        .header(SPACE_CLIENT_VERSION_HEADER, client_version)
        .header(SPACE_PLATFORM_HEADER, platform)
        .header(ACCEPT_LANGUAGE, crate::i18n::current_locale().as_str())
        .header(
            USER_AGENT,
            format!("MyAgents/{client_version} ({platform})"),
        );
    if let Some(device_id) = SPACE_CLIENT_DEVICE_CONTEXT.device_id.as_deref() {
        request = request.header(SPACE_DEVICE_ID_HEADER, device_id);
    }
    if let Some(os_version) = SPACE_CLIENT_DEVICE_CONTEXT.os_version.as_deref() {
        request = request.header(SPACE_OS_VERSION_HEADER, os_version);
    }
    request
}

fn api_url(base_url: &str, path: &str) -> Result<String, String> {
    if !path.starts_with("/api/") && path != "/health" && path != "/" {
        return Err("Space API path must start with /api/".to_string());
    }
    let base =
        reqwest::Url::parse(base_url).map_err(|e| format!("Invalid Space base URL: {}", e))?;
    if base.scheme() != "https" {
        return Err("Space base URL must use https".to_string());
    }
    base.join(path.trim_start_matches('/'))
        .map(|u| u.to_string())
        .map_err(|e| format!("Invalid Space API path: {}", e))
}

fn session_space_segment(session: &SpaceSession) -> String {
    session
        .last_active_space_id
        .as_deref()
        .or_else(|| {
            session
                .space
                .get("slug")
                .and_then(Value::as_str)
                .or_else(|| session.space.get("id").and_then(Value::as_str))
        })
        .filter(|value| !value.trim().is_empty())
        .map(url_component)
        .unwrap_or_else(|| "official".to_string())
}

fn session_from_me_data(session: &SpaceSession, data: &Value) -> SpaceSession {
    SpaceSession {
        base_url: session.base_url.clone(),
        user_credential: session.user_credential.clone(),
        user: data
            .get("user")
            .cloned()
            .unwrap_or_else(|| session.user.clone()),
        account_plan: data.get("accountPlan").cloned().unwrap_or(Value::Null),
        space: data
            .get("space")
            .cloned()
            .unwrap_or_else(|| session.space.clone()),
        membership: data
            .get("membership")
            .cloned()
            .unwrap_or_else(|| session.membership.clone()),
        spaces: data
            .get("spaces")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| session.spaces.clone()),
        last_active_space_id: session.last_active_space_id.clone(),
        updated_at: chrono::Utc::now().to_rfc3339(),
    }
}

async fn refresh_session_from_cloud(
    session: &AuthenticatedSpaceSession,
) -> SpaceCommandResult<SpaceSession> {
    let data = authorized_json_data_request(session, "/api/me", reqwest::Method::GET, None).await?;
    Ok(session_from_me_data(session, &data))
}

fn profile_avatar_mime_and_filename(file_path: &Path) -> Result<(&'static str, String), String> {
    let ext = file_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| "Avatar image must be png, jpg, jpeg, or webp".to_string())?;
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => return Err("Avatar image must be png, jpg, jpeg, or webp".to_string()),
    };
    let filename = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .map(safe_local_filename)
        .unwrap_or_else(|| format!("avatar.{}", ext));
    Ok((mime, filename))
}

fn profile_form(input: SpaceUpdateProfileInput) -> Result<reqwest::multipart::Form, String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("Profile name is required".to_string());
    }
    if name.chars().count() > 40 {
        return Err("Profile name must be at most 40 characters".to_string());
    }
    let mut form = reqwest::multipart::Form::new()
        .text("name", name.to_string())
        .text(
            "nameChanged",
            input.name_changed.unwrap_or(true).to_string(),
        );
    let avatar_preset_id = input
        .avatar_preset_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(preset_id) = avatar_preset_id {
        form = form.text("avatarPresetId", preset_id.to_string());
    }
    let Some(path) = input
        .avatar_file_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(form);
    };
    if avatar_preset_id.is_some() {
        return Err("Choose either an avatar file or an avatar preset".to_string());
    }
    let file_path = PathBuf::from(path);
    form = form.part(
        "avatar",
        normalized_avatar_upload_part(&file_path, MAX_PROFILE_AVATAR_BYTES)?,
    );
    Ok(form)
}

fn space_form(input: SpaceUpdateSpaceInput) -> Result<reqwest::multipart::Form, String> {
    let mut form = reqwest::multipart::Form::new();
    if let Some(name) = input.name.as_deref() {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Space name is required".to_string());
        }
        if trimmed.chars().count() > 80 {
            return Err("Space name must be at most 80 characters".to_string());
        }
        form = form.text("name", trimmed.to_string());
    }
    let Some(path) = input
        .avatar_file_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(form);
    };
    let file_path = PathBuf::from(path);
    if !file_path.is_absolute() {
        return Err("Avatar image path must be absolute".to_string());
    }
    let metadata = fs::symlink_metadata(&file_path)
        .map_err(|e| format!("Failed to inspect avatar image: {}", e))?;
    if metadata.file_type().is_symlink() {
        return Err("Avatar image path must not be a symlink".to_string());
    }
    if !metadata.is_file() {
        return Err("Avatar image path must be a file".to_string());
    }
    if metadata.len() > MAX_SPACE_AVATAR_BYTES {
        return Err(format!(
            "Avatar image exceeds {} bytes",
            MAX_SPACE_AVATAR_BYTES
        ));
    }
    let (mime, filename) = profile_avatar_mime_and_filename(&file_path)?;
    let bytes = read_avatar_file_bytes(&file_path, &metadata, MAX_SPACE_AVATAR_BYTES)?;
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str(mime)
        .map_err(|e| format!("Failed to build avatar upload part: {}", e))?;
    Ok(form.part("avatar", part))
}

pub(super) fn normalized_avatar_upload_part(
    file_path: &Path,
    max_bytes: u64,
) -> Result<reqwest::multipart::Part, String> {
    if !file_path.is_absolute() {
        return Err("Avatar image path must be absolute".to_string());
    }
    let metadata = fs::symlink_metadata(file_path)
        .map_err(|e| format!("Failed to inspect avatar image: {}", e))?;
    if metadata.file_type().is_symlink() {
        return Err("Avatar image path must not be a symlink".to_string());
    }
    if !metadata.is_file() {
        return Err("Avatar image path must be a file".to_string());
    }
    if metadata.len() > max_bytes {
        return Err(format!("Avatar image exceeds {} bytes", max_bytes));
    }
    validate_avatar_file_extension(file_path)?;
    let bytes = read_avatar_file_bytes(file_path, &metadata, max_bytes)?;
    let normalized = normalize_avatar_bytes_to_webp(&bytes)?;
    if normalized.len() > NORMALIZED_AVATAR_MAX_BYTES {
        return Err(format!(
            "Normalized avatar image exceeds {} bytes",
            NORMALIZED_AVATAR_MAX_BYTES
        ));
    }
    reqwest::multipart::Part::bytes(normalized)
        .file_name("avatar.webp")
        .mime_str("image/webp")
        .map_err(|e| format!("Failed to build avatar upload part: {}", e))
}

fn validate_avatar_file_extension(file_path: &Path) -> Result<(), String> {
    let ext = file_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| "Avatar image must be png, jpg, jpeg, or webp".to_string())?;
    if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        Ok(())
    } else {
        Err("Avatar image must be png, jpg, jpeg, or webp".to_string())
    }
}

fn normalize_avatar_bytes_to_webp(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let image = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("Failed to inspect avatar image: {}", e))?
        .decode()
        .map_err(|e| format!("Failed to decode avatar image: {}", e))?;
    let resized = if image.width() > NORMALIZED_AVATAR_MAX_EDGE
        || image.height() > NORMALIZED_AVATAR_MAX_EDGE
    {
        image.resize(
            NORMALIZED_AVATAR_MAX_EDGE,
            NORMALIZED_AVATAR_MAX_EDGE,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        image
    };
    let rgba = resized.to_rgba8();
    let (width, height) = rgba.dimensions();
    let mut output = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut output)
        .write_image(rgba.as_raw(), width, height, image::ColorType::Rgba8.into())
        .map_err(|e| format!("Failed to encode avatar image: {}", e))?;
    Ok(output)
}

fn read_avatar_file_bytes(
    file_path: &Path,
    _validated_metadata: &fs::Metadata,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    let file = open_regular_file_no_follow(file_path, "avatar image")?;
    let opened_metadata = file
        .metadata()
        .map_err(|e| format!("Failed to inspect opened avatar image: {}", e))?;
    if !opened_metadata.is_file() {
        return Err("Avatar image path must be a file".to_string());
    }
    if opened_metadata.len() > max_bytes {
        return Err(format!("Avatar image exceeds {} bytes", max_bytes));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if _validated_metadata.dev() != opened_metadata.dev()
            || _validated_metadata.ino() != opened_metadata.ino()
        {
            return Err("Avatar image changed while reading".to_string());
        }
    }
    let after_metadata = fs::symlink_metadata(file_path)
        .map_err(|e| format!("Failed to re-inspect avatar image: {}", e))?;
    if after_metadata.file_type().is_symlink() {
        return Err("Avatar image path must not be a symlink".to_string());
    }
    if !after_metadata.is_file() {
        return Err("Avatar image path must be a file".to_string());
    }
    let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read avatar image: {}", e))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("Avatar image exceeds {} bytes", max_bytes));
    }
    Ok(bytes)
}

async fn parse_cloud_data<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
) -> Result<T, String> {
    let status = response.status();
    let envelope = response
        .json::<CloudEnvelope<T>>()
        .await
        .map_err(|e| format!("Invalid Space API response ({})", error_category(&e)))?;
    if !status.is_success() || !envelope.success {
        let mut message = envelope
            .error
            .unwrap_or_else(|| format!("Space API request failed with {}", status));
        if let Some(code) = envelope
            .code
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            message = format!("{} ({})", message, code);
        }
        if let Some(request_id) = envelope
            .request_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            message = format!("{} [{}]", message, request_id);
        }
        if let Some(hint) = envelope.recovery_hint {
            if let Some(text) = hint.get("message").and_then(Value::as_str) {
                message = format!("{} · {}", message, text);
            }
        }
        if let Some(quota) = envelope
            .quota
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            let usage = envelope
                .usage
                .as_ref()
                .map(Value::to_string)
                .unwrap_or_else(|| "?".to_string());
            let limit = envelope
                .limit
                .as_ref()
                .map(Value::to_string)
                .unwrap_or_else(|| "?".to_string());
            message = format!(
                "{} · quota={} usage={} limit={}",
                message, quota, usage, limit
            );
        }
        return Err(message);
    }
    envelope
        .data
        .ok_or_else(|| "Space API response missing data".to_string())
}

async fn parse_authorized_cloud_data(
    response: reqwest::Response,
    user_session: Option<&AuthenticatedSpaceSession>,
    diagnostic: &RequestDiagnostic,
) -> Result<Value, SpaceCommandError> {
    let status = response.status();
    let request_id = response_request_id(&response);
    let credential_kind = if user_session.is_some() {
        SpaceCredentialKind::UserSession
    } else {
        SpaceCredentialKind::RegisteredAgent
    };
    let reauth_required = should_require_space_reauth(status, credential_kind);
    if let Some(session) = user_session.filter(|_| reauth_required) {
        match mark_user_session_reauth_required(session).await {
            Ok(true) => {
                ulog_info!(
                    "[space] user session moved to reauth_required: sessionBindingId={}",
                    session.session_binding_id()
                );
                account_user_session_invalidated();
            }
            Ok(false) => {
                ulog_info!(
                    "[space] ignored stale user-session 401: sessionBindingId={}",
                    session.session_binding_id()
                );
            }
            Err(error) => {
                ulog_warn!(
                    "[space] failed to persist reauth_required: sessionBindingId={} error={}",
                    session.session_binding_id(),
                    error
                );
                return Err(SpaceCommandError {
                    http_status: Some(status.as_u16()),
                    credential_kind: Some(credential_kind),
                    session_binding_id: Some(session.session_binding_id().to_string()),
                    ..SpaceCommandError::local(
                        "SPACE_SESSION_STATE_WRITE_FAILED",
                        "MyAgents could not persist the Space login state.",
                    )
                });
            }
        }
    }
    let envelope = match response.json::<CloudEnvelope<Value>>().await {
        Ok(envelope) => envelope,
        Err(error) if reauth_required => {
            diagnostic.failure(
                "decode",
                error_category(&error),
                Some(status.as_u16()),
                request_id.as_deref(),
            );
            return Err(SpaceCommandError {
                code: "SPACE_REAUTH_REQUIRED".to_string(),
                message: "MyAgents Space login is required.".to_string(),
                cloud_code: None,
                http_status: Some(status.as_u16()),
                request_id: None,
                retryable: false,
                credential_kind: Some(credential_kind),
                session_binding_id: user_session
                    .map(AuthenticatedSpaceSession::session_binding_id)
                    .map(ToString::to_string),
                recovery_hint: None,
                quota: None,
                usage: None,
                limit: None,
            });
        }
        Err(error) => {
            diagnostic.failure(
                "decode",
                error_category(&error),
                Some(status.as_u16()),
                request_id.as_deref(),
            );
            return Err(SpaceCommandError {
                http_status: Some(status.as_u16()),
                credential_kind: Some(credential_kind),
                retryable: status == reqwest::StatusCode::TOO_MANY_REQUESTS
                    || status.is_server_error(),
                ..SpaceCommandError::local(
                    if status.is_success() {
                        "SPACE_RESPONSE_INVALID"
                    } else {
                        "SPACE_REQUEST_FAILED"
                    },
                    if status.is_success() {
                        "Invalid Space response.".to_string()
                    } else {
                        format!("Space request failed with HTTP {}.", status.as_u16())
                    },
                )
            });
        }
    };
    if !status.is_success() || !envelope.success {
        diagnostic.failure(
            "response",
            "http",
            Some(status.as_u16()),
            envelope.request_id.as_deref().or(request_id.as_deref()),
        );
        let cloud_code = envelope
            .code
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
        let message = envelope
            .error
            .unwrap_or_else(|| format!("Space request failed with HTTP {}.", status.as_u16()));
        let code = if reauth_required {
            "SPACE_REAUTH_REQUIRED".to_string()
        } else {
            cloud_code
                .clone()
                .unwrap_or_else(|| "SPACE_REQUEST_FAILED".to_string())
        };
        return Err(SpaceCommandError {
            code,
            message: if reauth_required {
                "MyAgents Space login is required.".to_string()
            } else {
                message
            },
            cloud_code,
            http_status: Some(status.as_u16()),
            request_id: envelope.request_id,
            retryable: status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error(),
            credential_kind: Some(credential_kind),
            session_binding_id: user_session
                .filter(|_| reauth_required)
                .map(AuthenticatedSpaceSession::session_binding_id)
                .map(ToString::to_string),
            recovery_hint: envelope.recovery_hint,
            quota: envelope.quota,
            usage: envelope.usage,
            limit: envelope.limit,
        });
    }
    envelope.data.ok_or_else(|| {
        diagnostic.failure(
            "schema",
            "decode",
            Some(status.as_u16()),
            envelope.request_id.as_deref().or(request_id.as_deref()),
        );
        SpaceCommandError::local(
            "SPACE_RESPONSE_INVALID",
            "Space response did not include data.",
        )
    })
}

async fn authorized_json_request(
    base_url: &str,
    path: &str,
    token: &str,
    method: reqwest::Method,
    body: Option<Value>,
) -> Result<Value, String> {
    if crate::space_cloud_mock::is_enabled() {
        let data = crate::space_cloud_mock::api_data_request_with_token(
            method.as_str(),
            path,
            Some(token),
            body,
        )?;
        return Ok(serde_json::json!({ "success": true, "data": data }));
    }
    let capability = ensure_space_available()?;
    let client = http_client()?;
    let diagnostic = RequestDiagnostic::new("space", &method, path);
    let mut req = with_space_client_context_headers(
        client
            .request(method, api_url(base_url, path)?)
            .header(AUTHORIZATION, format!("Bearer {}", token)),
        &capability,
    );
    if let Some(body) = body {
        req = req.json(&body);
    }
    let response = diagnostic
        .send(req)
        .await
        .map_err(|e| format!("Space API request failed ({})", error_category(&e)))?;
    let status = response.status();
    if !status.is_success() {
        diagnostic.failure("response", "http", Some(status.as_u16()), None);
    }
    response.json::<Value>().await.map_err(|e| {
        diagnostic.failure("decode", error_category(&e), Some(status.as_u16()), None);
        format!("Invalid Space API response ({})", error_category(&e))
    })
}

async fn upsert_space_user_device(
    session: &AuthenticatedSpaceSession,
    identity: &DeviceIdentity,
) -> SpaceCommandResult<()> {
    let body = serde_json::json!({
        "deviceId": identity.device_id,
        "deviceName": identity.device_name,
        "platform": identity.platform,
        "osVersion": identity.os_version,
        "appVersion": identity.app_version,
    });
    authorized_json_data_request(
        session,
        "/api/devices/upsert",
        reqwest::Method::POST,
        Some(body),
    )
    .await
    .map(|_| ())
}

async fn try_upsert_space_user_device(
    session: &AuthenticatedSpaceSession,
    identity: &DeviceIdentity,
) {
    if let Err(error) = upsert_space_user_device(session, identity).await {
        ulog_warn!(
            "[space] failed to upsert user device {}: {}",
            identity.device_id,
            error
        );
    }
}

fn spawn_space_user_device_upsert(session: AuthenticatedSpaceSession, identity: DeviceIdentity) {
    tauri::async_runtime::spawn(async move {
        try_upsert_space_user_device(&session, &identity).await;
    });
}

async fn authorized_json_data_request(
    session: &AuthenticatedSpaceSession,
    path: &str,
    method: reqwest::Method,
    body: Option<Value>,
) -> Result<Value, SpaceCommandError> {
    authorized_json_data_request_with_credential(
        &session.base_url,
        path,
        session.session_token(),
        method,
        body,
        None,
        Some(session),
    )
    .await
}

async fn authorized_json_data_request_scoped(
    base_url: &str,
    path: &str,
    token: &str,
    method: reqwest::Method,
    body: Option<Value>,
    space_id: Option<&str>,
    user_session: Option<&AuthenticatedSpaceSession>,
) -> Result<Value, String> {
    authorized_json_data_request_with_credential(
        base_url,
        path,
        token,
        method,
        body,
        space_id,
        user_session,
    )
    .await
    .map_err(String::from)
}

async fn authorized_json_data_request_with_credential(
    base_url: &str,
    path: &str,
    token: &str,
    method: reqwest::Method,
    body: Option<Value>,
    space_id: Option<&str>,
    user_session: Option<&AuthenticatedSpaceSession>,
) -> Result<Value, SpaceCommandError> {
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::api_data_request_scoped_with_token(
            method.as_str(),
            path,
            Some(token),
            body,
            space_id,
        )
        .map_err(Into::into);
    }
    let capability = ensure_space_available().map_err(SpaceCommandError::from)?;
    let diagnostic = RequestDiagnostic::new("space", &method, path);
    let client = http_client().map_err(SpaceCommandError::from)?;
    let mut req = with_space_client_context_headers(
        client
            .request(
                method,
                api_url(base_url, path).map_err(SpaceCommandError::from)?,
            )
            .header(AUTHORIZATION, format!("Bearer {}", token)),
        &capability,
    );
    if let Some(space_id) = space_id {
        req = req.header(SPACE_CONTEXT_HEADER, space_id);
    }
    if let Some(body) = body {
        req = req.json(&body);
    }
    let response = diagnostic.send(req).await.map_err(|e| {
        SpaceCommandError::transport(format!("Space API request failed ({})", error_category(&e)))
    })?;
    parse_authorized_cloud_data(response, user_session, &diagnostic).await
}

async fn authorized_multipart_data_request(
    session: &AuthenticatedSpaceSession,
    path: &str,
    form: reqwest::multipart::Form,
) -> Result<Value, SpaceCommandError> {
    authorized_multipart_method_data_request(reqwest::Method::POST, session, path, form).await
}

async fn authorized_multipart_method_data_request(
    method: reqwest::Method,
    session: &AuthenticatedSpaceSession,
    path: &str,
    form: reqwest::multipart::Form,
) -> Result<Value, SpaceCommandError> {
    authorized_multipart_method_data_request_with_credential(
        method,
        &session.base_url,
        path,
        session.session_token(),
        form,
        None,
        Some(session),
    )
    .await
}

async fn authorized_multipart_method_data_request_scoped(
    method: reqwest::Method,
    base_url: &str,
    path: &str,
    token: &str,
    form: reqwest::multipart::Form,
    space_id: Option<&str>,
    user_session: Option<&AuthenticatedSpaceSession>,
) -> Result<Value, String> {
    authorized_multipart_method_data_request_with_credential(
        method,
        base_url,
        path,
        token,
        form,
        space_id,
        user_session,
    )
    .await
    .map_err(String::from)
}

async fn authorized_multipart_method_data_request_with_credential(
    method: reqwest::Method,
    base_url: &str,
    path: &str,
    token: &str,
    form: reqwest::multipart::Form,
    space_id: Option<&str>,
    user_session: Option<&AuthenticatedSpaceSession>,
) -> Result<Value, SpaceCommandError> {
    if crate::space_cloud_mock::is_enabled() {
        return Err(SpaceCommandError::local(
            "SPACE_MOCK_MULTIPART_UNAVAILABLE",
            "Mock Space does not accept raw multipart requests; use typed mock upload commands",
        ));
    }
    let capability = ensure_space_available().map_err(SpaceCommandError::from)?;
    let diagnostic = RequestDiagnostic::new("space", &method, path);
    let mut request = with_space_client_context_headers(
        http_client()
            .map_err(SpaceCommandError::from)?
            .request(
                method,
                api_url(base_url, path).map_err(SpaceCommandError::from)?,
            )
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .multipart(form),
        &capability,
    );
    if let Some(space_id) = space_id {
        request = request.header(SPACE_CONTEXT_HEADER, space_id);
    }
    let response = diagnostic.send(request).await.map_err(|e| {
        SpaceCommandError::transport(format!("Space upload failed ({})", error_category(&e)))
    })?;
    parse_authorized_cloud_data(response, user_session, &diagnostic).await
}

async fn authorized_raw_request(
    session: &AuthenticatedSpaceSession,
    path: &str,
) -> Result<reqwest::Response, SpaceCommandError> {
    authorized_raw_request_with_credential(
        &session.base_url,
        path,
        session.session_token(),
        None,
        Some(session),
    )
    .await
}

async fn authorized_raw_request_with_credential(
    base_url: &str,
    path: &str,
    token: &str,
    space_id: Option<&str>,
    user_session: Option<&AuthenticatedSpaceSession>,
) -> Result<reqwest::Response, SpaceCommandError> {
    if crate::space_cloud_mock::is_enabled() {
        return Err(SpaceCommandError::local(
            "SPACE_MOCK_RAW_UNAVAILABLE",
            "Mock Space raw HTTP response is not available through this path",
        ));
    }
    let capability = ensure_space_available().map_err(SpaceCommandError::from)?;
    let diagnostic = RequestDiagnostic::new("space", &reqwest::Method::GET, path);
    let mut request = with_space_client_context_headers(
        http_client()
            .map_err(SpaceCommandError::from)?
            .get(api_url(base_url, path).map_err(SpaceCommandError::from)?)
            .header(AUTHORIZATION, format!("Bearer {}", token)),
        &capability,
    );
    if let Some(space_id) = space_id {
        request = request.header(SPACE_CONTEXT_HEADER, space_id);
    }
    let response = diagnostic.send(request).await.map_err(|e| {
        SpaceCommandError::transport(format!("Space API request failed ({})", error_category(&e)))
    })?;
    if !response.status().is_success() {
        return match parse_authorized_cloud_data(response, user_session, &diagnostic).await {
            Err(error) => Err(error),
            Ok(_) => Err(SpaceCommandError::local(
                "SPACE_DOWNLOAD_FAILED",
                "Space download failed.",
            )),
        };
    }
    Ok(response)
}

async fn authorized_bytes_request(
    session: &AuthenticatedSpaceSession,
    path: &str,
) -> Result<Vec<u8>, SpaceCommandError> {
    if crate::space_cloud_mock::is_enabled() {
        if let Some(skill_id) = path
            .strip_prefix("/api/skills/")
            .and_then(|rest| rest.strip_suffix("/package.zip"))
        {
            return crate::space_cloud_mock::skill_package_bytes(skill_id).map_err(Into::into);
        }
        return Err(SpaceCommandError::local(
            "SPACE_MOCK_BYTES_UNAVAILABLE",
            format!("Mock Space bytes route not implemented: {path}"),
        ));
    }
    let response = authorized_raw_request(session, path).await?;
    response
        .bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| SpaceCommandError::transport(format!("Space download failed: {e}")))
}

fn space_runtime_scope() -> Result<SpaceRuntimeScope, String> {
    let capability = ensure_space_available()?;
    let base_url = capability_base_url(&capability)?;
    let data_dir = space_data_dir_for_environment(capability.active_environment)?;
    Ok(SpaceRuntimeScope { base_url, data_dir })
}

fn space_data_dir_for_environment(environment: SpaceEnvironment) -> Result<PathBuf, String> {
    let root = crate::app_dirs::myagents_data_dir()
        .ok_or_else(|| "Home dir not found".to_string())?
        .join("space");
    let dir = space_data_dir_path_for_environment(root, environment);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create Space data dir: {}", e))?;
    Ok(dir)
}

fn space_data_dir_path_for_environment(root: PathBuf, environment: SpaceEnvironment) -> PathBuf {
    match environment {
        SpaceEnvironment::Production => root,
        SpaceEnvironment::Dev => root.join(environment.config_value()),
    }
}

fn space_data_dir() -> Result<PathBuf, String> {
    space_data_dir_for_environment(space_build_capability().active_environment)
}

fn session_path_in_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(SESSION_FILE)
}

fn session_path() -> Result<PathBuf, String> {
    Ok(session_path_in_dir(&space_data_dir()?))
}

fn read_session_from_path(path: &Path) -> Result<Option<SpaceSession>, String> {
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content)
            .map(Some)
            .map_err(|e| format!("Invalid Space session file: {}", e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Failed to read Space session file: {}", e)),
    }
}

fn require_session() -> Result<AuthenticatedSpaceSession, String> {
    if crate::space_cloud_mock::is_enabled() {
        return AuthenticatedSpaceSession::from_account(
            crate::space_cloud_mock::session(),
            PathBuf::from("mock-session.json"),
        );
    }
    let configured_base_url = space_base_url()?;
    let path = session_path()?;
    let session = read_session_from_path(&path)?
        .ok_or_else(|| "NOT_AUTHENTICATED: Not logged in to MyAgents Space.".to_string())?;
    if !space_base_urls_equal(&session.base_url, &configured_base_url) {
        return Err(
            "Space session belongs to a different Space service. Please log in again.".to_string(),
        );
    }
    AuthenticatedSpaceSession::from_account(session, path)
}

fn read_current_session() -> Result<Option<SpaceSession>, String> {
    if crate::space_cloud_mock::is_enabled() {
        return Ok(Some(crate::space_cloud_mock::session()));
    }
    let configured_base_url = space_base_url()?;
    read_current_session_for_base_url(&configured_base_url, &space_data_dir()?)
}

fn read_current_session_for_base_url(
    base_url: &str,
    data_dir: &Path,
) -> Result<Option<SpaceSession>, String> {
    Ok(read_session_from_path(&session_path_in_dir(data_dir))?
        .filter(|session| space_base_urls_equal(&session.base_url, base_url)))
}

fn session_user_id(session: &SpaceSession) -> Option<String> {
    optional_value_string(&session.user, "id")
}

fn session_space_id(session: &SpaceSession) -> Option<String> {
    session
        .last_active_space_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .or_else(|| optional_value_string(&session.space, "id"))
        .or_else(|| optional_value_string(&session.space, "slug"))
}

fn with_json_file_lock<F, T>(path: &Path, mutator: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let lock = path.with_extension("lock");
    crate::utils::file_lock::with_file_lock_blocking(
        &lock,
        crate::utils::file_lock::FileLockOptions::default(),
        move || {
            mutator()
                .map_err(|e| crate::utils::file_lock::FileLockError::Io(std::io::Error::other(e)))
        },
    )
    .map_err(String::from)
}

fn mark_user_session_reauth_required_at_path(
    path: &Path,
    expected_session_binding_id: &str,
) -> Result<bool, String> {
    let path = path.to_path_buf();
    let expected_session_binding_id = expected_session_binding_id.to_string();
    with_json_file_lock(&path.clone(), move || {
        let Some(mut current) = read_session_from_path(&path)? else {
            return Ok(false);
        };
        if current.invalidated_session_binding_id() == Some(expected_session_binding_id.as_str()) {
            return Ok(true);
        }
        if current.authenticated_token().is_none()
            || current.session_binding_id() != expected_session_binding_id
        {
            return Ok(false);
        }
        current.user_credential = SpaceUserCredential::ReauthRequired {
            invalidated_session_binding_id: expected_session_binding_id,
        };
        current.updated_at = chrono::Utc::now().to_rfc3339();
        write_private_json_unlocked(&path, &current)?;
        Ok(true)
    })
}

fn commit_authenticated_session_if_unchanged_at_path(
    path: &Path,
    expected_session_binding_id: Option<&str>,
    session: &SpaceSession,
) -> Result<bool, String> {
    let path = path.to_path_buf();
    let expected_session_binding_id = expected_session_binding_id.map(ToString::to_string);
    let session = session.clone();
    with_json_file_lock(&path.clone(), move || {
        let current_session_binding_id = read_session_from_path(&path)?
            .as_ref()
            .map(SpaceSession::session_binding_id);
        if current_session_binding_id != expected_session_binding_id {
            return Ok(false);
        }
        write_private_json_unlocked(&path, &session)?;
        Ok(true)
    })
}

async fn mark_user_session_reauth_required(
    session: &AuthenticatedSpaceSession,
) -> Result<bool, String> {
    let path = session.session_path().to_path_buf();
    let expected_session_binding_id = session.session_binding_id().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        mark_user_session_reauth_required_at_path(&path, &expected_session_binding_id)
    })
    .await
    .map_err(|error| format!("mark Space session reauth task failed: {error:?}"))?
}

fn space_session_binding_id_for_token(base_url: &str, session_token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(base_url.trim().trim_end_matches('/').as_bytes());
    hasher.update([0]);
    hasher.update(session_token.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn space_session_binding_id(session: &SpaceSession) -> String {
    session.session_binding_id()
}

fn set_active_space_in_session_file(
    path: &Path,
    configured_base_url: &str,
    expected_session_binding_id: &str,
    active_space_id: &str,
) -> Result<Option<SpaceSession>, String> {
    let path = path.to_path_buf();
    let configured_base_url = configured_base_url.to_string();
    let expected_session_binding_id = expected_session_binding_id.to_string();
    let active_space_id = active_space_id.to_string();
    with_json_file_lock(&path.clone(), move || {
        let Some(mut session) = read_session_from_path(&path)? else {
            return Ok(None);
        };
        if session.authenticated_token().is_none() {
            return Ok(None);
        }
        if !space_base_urls_equal(&session.base_url, &configured_base_url)
            || space_session_binding_id(&session) != expected_session_binding_id
        {
            return Err("Space session changed before active Space was saved".to_string());
        }
        session.last_active_space_id = (!active_space_id.is_empty()).then_some(active_space_id);
        session.updated_at = chrono::Utc::now().to_rfc3339();
        write_private_json_unlocked(&path, &session)?;
        Ok(Some(session))
    })
}

fn take_session_for_logout(path: &Path) -> Result<Option<SpaceSession>, String> {
    let path = path.to_path_buf();
    with_json_file_lock(&path.clone(), move || {
        let Some(session) = read_session_from_path(&path)? else {
            return Ok(None);
        };
        match fs::remove_file(&path) {
            Ok(()) => Ok(Some(session)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("Failed to remove Space session: {error}")),
        }
    })
}

fn commit_refreshed_session_blocking(
    path: &Path,
    mut refreshed: SpaceSession,
) -> Result<SpaceSession, String> {
    let path = path.to_path_buf();
    with_json_file_lock(&path.clone(), move || {
        let Some(current) = read_session_from_path(&path)? else {
            return Err("Space session changed while refresh was in flight".to_string());
        };
        if current.authenticated_token().is_none()
            || refreshed.authenticated_token().is_none()
            || !space_base_urls_equal(&current.base_url, &refreshed.base_url)
            || current.session_binding_id() != refreshed.session_binding_id()
        {
            return Err("Space session changed while refresh was in flight".to_string());
        }
        refreshed.last_active_space_id = current.last_active_space_id;
        write_private_json_unlocked(&path, &refreshed)?;
        Ok(refreshed)
    })
}

async fn commit_refreshed_session(refreshed: SpaceSession) -> Result<SpaceSession, String> {
    let path = session_path()?;
    tauri::async_runtime::spawn_blocking(move || {
        commit_refreshed_session_blocking(&path, refreshed)
    })
    .await
    .map_err(|error| format!("commit refreshed Space session task failed: {error:?}"))?
}

#[cfg(test)]
fn write_private_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let path = path.to_path_buf();
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|e| format!("Failed to serialize JSON: {}", e))?;
    with_json_file_lock(&path.clone(), move || {
        write_private_bytes_unlocked(&path, &bytes)
    })
}

fn write_private_json_unlocked<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|e| format!("Failed to serialize JSON: {}", e))?;
    write_private_bytes_unlocked(path, &bytes)
}

fn write_private_bytes_unlocked(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent dir: {}", e))?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("Failed to write temp file: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Failed to chmod temp file: {}", e))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("Failed to commit file: {}", e))?;
    Ok(())
}

fn space_base_url() -> Result<String, String> {
    capability_base_url(&ensure_space_available()?)
}

fn space_base_urls_equal(a: &str, b: &str) -> bool {
    a.trim().trim_end_matches('/') == b.trim().trim_end_matches('/')
}

fn team_space_runtime_enabled() -> bool {
    let Some(dir) = crate::app_dirs::myagents_data_dir() else {
        return true;
    };
    let Ok(content) = fs::read_to_string(dir.join("config.json")) else {
        return true;
    };
    let Ok(config) = serde_json::from_str::<Value>(crate::utils::bom::strip_bom(&content)) else {
        return true;
    };
    team_space_dev_gate_enabled(&config)
}

fn team_space_dev_gate_enabled(config: &Value) -> bool {
    // The former opt-in Lab setting is deliberately ignored. Only an explicit
    // Developer opt-out pauses the Connector, matching the Renderer policy.
    config.get("teamSpaceDevGate") != Some(&Value::Bool(false))
}

fn required_value_string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| format!("Space API response missing {}", key))
}

fn required_non_empty_value_string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| format!("Space API response missing or invalid {}", key))
}

fn required_nullable_value_string(value: &Value, key: &str) -> Result<Option<String>, String> {
    match value.get(key) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(raw)) if !raw.trim().is_empty() => Ok(Some(raw.trim().to_string())),
        _ => Err(format!(
            "Space API response missing explicit nullable {}",
            key
        )),
    }
}

fn optional_value_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn value_string_array(value: &Value, key: &str) -> Option<Vec<String>> {
    let array = value.get(key)?.as_array()?;
    Some(
        array
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .collect(),
    )
}

fn safe_local_name(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
            out.push(ch.to_ascii_lowercase());
        } else if ch.is_whitespace() {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches(['-', '.', '_']).to_string();
    if trimmed.is_empty() {
        "item".to_string()
    } else {
        trimmed
    }
}

fn safe_local_filename(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch == '/'
            || ch == '\\'
            || ch == '\0'
            || matches!(ch, ':' | '*' | '?' | '"' | '<' | '>' | '|')
        {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    out.trim().trim_matches('.').to_string()
}

fn open_local_file_no_follow(
    path: &Path,
    max_bytes: u64,
    label: &str,
) -> Result<(fs::File, fs::Metadata), String> {
    let validated_metadata =
        fs::symlink_metadata(path).map_err(|e| format!("Failed to inspect {}: {}", label, e))?;
    if validated_metadata.file_type().is_symlink() {
        return Err(format!("{} path must not be a symlink", label));
    }
    if !validated_metadata.is_file() {
        return Err(format!("{} path must be a file", label));
    }
    if validated_metadata.len() > max_bytes {
        return Err(format!("{} exceeds {} bytes", label, max_bytes));
    }

    let file = open_regular_file_no_follow(path, label)?;
    let opened_metadata = file
        .metadata()
        .map_err(|e| format!("Failed to inspect opened {}: {}", label, e))?;
    if !opened_metadata.is_file() {
        return Err(format!("{} path must be a file", label));
    }
    if opened_metadata.len() > max_bytes {
        return Err(format!("{} exceeds {} bytes", label, max_bytes));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if validated_metadata.dev() != opened_metadata.dev()
            || validated_metadata.ino() != opened_metadata.ino()
        {
            return Err(format!("{} changed while reading", label));
        }
    }
    let after_metadata =
        fs::symlink_metadata(path).map_err(|e| format!("Failed to re-inspect {}: {}", label, e))?;
    if after_metadata.file_type().is_symlink() || !after_metadata.is_file() {
        return Err(format!("{} changed while reading", label));
    }
    Ok((file, opened_metadata))
}

fn inspect_local_file_no_follow(path: &Path, max_bytes: u64, label: &str) -> Result<u64, String> {
    let (_file, metadata) = open_local_file_no_follow(path, max_bytes, label)?;
    Ok(metadata.len())
}

fn read_local_file_no_follow(path: &Path, max_bytes: u64, label: &str) -> Result<Vec<u8>, String> {
    let (file, opened_metadata) = open_local_file_no_follow(path, max_bytes, label)?;
    let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read {}: {}", label, e))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("{} exceeds {} bytes", label, max_bytes));
    }
    Ok(bytes)
}

fn filename_from_content_disposition(value: Option<&str>) -> Option<String> {
    let raw = value?;
    for part in raw.split(';') {
        let trimmed = part.trim();
        if let Some(name) = trimmed.strip_prefix("filename=") {
            return Some(safe_local_filename(name.trim_matches('"')));
        }
    }
    None
}

fn url_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

#[cfg(test)]
mod tests;

/// Fan out an already committed account transition from the authentication
/// owner. Every account projection clears synchronously before remote refresh.
pub(crate) fn account_auth_boundary_changed<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let _ = app.emit("space-account:changed", "auth");
    crate::agent_network::actor::auth_boundary_changed(app);
    if let Some(center) = app.try_state::<notifications::ManagedNotificationCenter>() {
        notifications::auth_boundary_changed(app, center.inner());
    }
}
fn account_profile_changed() {
    if let Some(app) = crate::logger::get_app_handle() {
        let _ = app.emit("space-account:changed", "profile");
    }
}
pub(crate) fn account_user_session_invalidated() {
    if let Some(app) = crate::logger::get_app_handle() {
        account_auth_boundary_changed(app);
    }
}
