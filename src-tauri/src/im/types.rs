// IM Bot integration types (Rust side)

use serde::{Deserialize, Deserializer, Serialize};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::Instant;

use super::{is_external_runtime_type, normalize_runtime_type, runtime_source_for_runtime};

const CODEX_SUBSCRIPTION_PROVIDER_ID: &str = "codex-sub";
const ANTHROPIC_SUBSCRIPTION_PROVIDER_ID: &str = "anthropic-sub";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelDeliveryMode {
    #[default]
    Auto,
    ToolOnly,
}

impl ChannelDeliveryMode {
    /// Delivery policy does not grant send permission or change the reply owner.
    pub fn allows_automatic(self) -> bool {
        self == Self::Auto
    }
}

/// Partial update patch for IM Bot config.
/// Each `None` field means "no change"; `Some("")` means "clear the field".
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotConfigPatch {
    pub model: Option<String>,
    pub provider_id: Option<String>,
    pub provider_env_json: Option<String>,
    pub permission_mode: Option<String>,
    /// Complete MCP server definitions JSON (pushed to Sidecar at runtime, also persisted for auto-start)
    pub mcp_servers_json: Option<String>,
    /// Enabled MCP server ID list (persisted to imBotConfigs)
    pub mcp_enabled_servers: Option<Vec<String>>,
    pub allowed_users: Option<Vec<String>>,
    pub default_workspace_path: Option<String>,
    pub heartbeat_config_json: Option<String>,
    pub name: Option<String>,
    pub bot_token: Option<String>,
    pub feishu_app_id: Option<String>,
    pub feishu_app_secret: Option<String>,
    // ===== DingTalk-specific credentials =====
    pub dingtalk_client_id: Option<String>,
    pub dingtalk_client_secret: Option<String>,
    pub dingtalk_use_ai_card: Option<bool>,
    pub dingtalk_card_template_id: Option<String>,
    // ===== Telegram-specific options =====
    pub telegram_use_draft: Option<bool>,
    pub enabled: Option<bool>,
    pub setup_completed: Option<bool>,
    pub group_permissions: Option<Vec<GroupPermission>>,
    pub group_activation: Option<String>,
    pub group_tools_deny: Option<Vec<String>>,
    // ===== OpenClaw Channel Plugin =====
    pub openclaw_plugin_config: Option<serde_json::Value>,
    pub openclaw_enabled_tool_groups: Option<Vec<String>>,
}

/// IM platform type
#[derive(Debug, Clone, PartialEq)]
pub enum ImPlatform {
    Telegram,
    Feishu,
    Dingtalk,
    /// OpenClaw route identity. Historical data may store either the protocol
    /// channel ID (e.g. "qqbot") or the install plugin ID (e.g.
    /// "wecom-openclaw-plugin"). Bridge config canonicalization resolves the
    /// protocol channel ID from the OpenClaw manifest at runtime.
    OpenClaw(String),
}

/// Request-scoped delivery contract selected by the inbound producer.
/// This is an observed fact for one message, not a channel capability.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ImDeliveryProtocol {
    #[serde(rename = "openclaw-reply")]
    OpenClawReply,
}

impl Serialize for ImPlatform {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Telegram => serializer.serialize_str("telegram"),
            Self::Feishu => serializer.serialize_str("feishu"),
            Self::Dingtalk => serializer.serialize_str("dingtalk"),
            Self::OpenClaw(id) => serializer.serialize_str(&format!("openclaw:{}", id)),
        }
    }
}

impl<'de> Deserialize<'de> for ImPlatform {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        match s.as_str() {
            "telegram" => Ok(Self::Telegram),
            "feishu" => Ok(Self::Feishu),
            "dingtalk" => Ok(Self::Dingtalk),
            other if other.starts_with("openclaw:") => {
                let channel_id = other.strip_prefix("openclaw:").unwrap_or("").to_string();
                if channel_id.is_empty() {
                    Err(serde::de::Error::custom("openclaw: missing channel ID"))
                } else {
                    Ok(Self::OpenClaw(channel_id))
                }
            }
            _ => Err(serde::de::Error::unknown_variant(
                &s,
                &["telegram", "feishu", "dingtalk", "openclaw:<id>"],
            )),
        }
    }
}

impl std::fmt::Display for ImPlatform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Telegram => write!(f, "telegram"),
            Self::Feishu => write!(f, "feishu"),
            Self::Dingtalk => write!(f, "dingtalk"),
            Self::OpenClaw(id) => write!(f, "openclaw:{}", id),
        }
    }
}

/// IM Bot operational status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ImStatus {
    Online,
    Connecting,
    Error,
    Stopped,
}

/// IM source type (private chat vs group)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ImSourceType {
    Private,
    Group,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInteractionCapability {
    pub ask_user_question: String,
}

impl HostInteractionCapability {
    pub fn none() -> Self {
        Self {
            ask_user_question: "none".to_string(),
        }
    }

    pub fn native_card() -> Self {
        Self {
            ask_user_question: "native-card".to_string(),
        }
    }

    pub fn for_platform(platform: &ImPlatform) -> Self {
        match platform {
            ImPlatform::Feishu | ImPlatform::Telegram => Self::native_card(),
            _ => Self {
                ask_user_question: "text".to_string(),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskUserQuestionOption {
    pub label: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskUserQuestionItem {
    #[serde(default)]
    pub id: Option<String>,
    pub question: String,
    pub header: String,
    #[serde(default)]
    pub options: Vec<AskUserQuestionOption>,
    #[serde(default)]
    pub multi_select: bool,
    #[serde(default = "default_question_required")]
    pub required: bool,
    #[serde(default)]
    pub is_secret: bool,
}

fn default_question_required() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskUserQuestionPayload {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    pub questions: Vec<AskUserQuestionItem>,
    #[serde(default)]
    pub preview_format: Option<String>,
}

/// Group permission status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum GroupPermissionStatus {
    Pending,
    Approved,
}

/// Group chat permission record
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupPermission {
    pub group_id: String,
    pub group_name: String,
    pub platform: ImPlatform,
    pub status: GroupPermissionStatus,
    pub discovered_at: String,
    pub added_by: Option<String>,
}

/// Group activation mode (when bot responds in groups)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum GroupActivation {
    /// Only respond when @mentioned, replied-to, or /ask
    Mention,
    /// Respond to all messages (with NO_REPLY option)
    Always,
}

impl Default for GroupActivation {
    fn default() -> Self {
        Self::Mention
    }
}

/// Group lifecycle events from platform adapters
#[derive(Debug, Clone)]
pub enum GroupEvent {
    BotAdded {
        chat_id: String,
        chat_title: String,
        platform: ImPlatform,
        added_by_name: Option<String>,
    },
    BotRemoved {
        chat_id: String,
        platform: ImPlatform,
    },
}

/// Media type classification for outbound file sending
#[derive(Debug, Clone, PartialEq)]
pub enum MediaType {
    /// Image formats: jpg, jpeg, png, gif, webp, bmp, svg
    Image,
    /// Document/media formats: pdf, doc(x), xls(x), ppt(x), mp4, mp3, ogg, wav, zip, csv, json, xml, html
    File,
    /// Code and other non-media files: ts, js, py, rs, etc. — not sent as media
    NonMedia,
}

impl MediaType {
    /// Classify a file extension into a media type for outbound sending.
    pub fn from_extension(ext: &str) -> Self {
        match ext.to_lowercase().as_str() {
            // Images
            "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "svg" => Self::Image,
            // Documents & media files
            "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "mp4" | "mp3" | "ogg"
            | "wav" | "avi" | "mov" | "mkv" | "zip" | "rar" | "7z" | "tar" | "gz" | "csv"
            | "json" | "xml" | "html" | "txt" => Self::File,
            // Everything else (code files, etc.)
            _ => Self::NonMedia,
        }
    }

    /// Check if a file extension is a sendable media type (Image or File).
    pub fn is_media_extension(ext: &str) -> bool {
        !matches!(Self::from_extension(ext), Self::NonMedia)
    }
}

/// Attachment type determines processing path
#[derive(Debug, Clone)]
pub enum ImAttachmentType {
    /// SDK Vision (base64 image content block) — photo, static sticker
    Image,
    /// Copy to workspace + @path reference — voice, audio, video, document
    File,
}

/// Media attachment downloaded from Telegram
#[derive(Debug, Clone)]
pub struct ImAttachment {
    pub file_name: String,
    pub mime_type: String,
    pub data: Vec<u8>,
    pub attachment_type: ImAttachmentType,
}

/// Incoming IM message (from adapter)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImSourceMetadata {
    #[serde(default)]
    pub parts: Vec<ImSourcePart>,
    pub context_data: Option<serde_json::Value>,
    pub configured_instructions: Option<String>,
    pub platform_message_id: Option<String>,
    pub sent_at: Option<chrono::DateTime<chrono::Utc>>,
    pub sender_id_type: Option<String>,
    pub sender_username: Option<String>,
    pub sender_is_bot: Option<bool>,
    pub self_id: Option<String>,
    pub self_id_type: Option<String>,
    pub self_name: Option<String>,
    pub self_username: Option<String>,
    pub mentions_self: Option<bool>,
    pub reply_to_self: Option<bool>,
    pub thread_id: Option<String>,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImSourcePart {
    pub event_id: String,
    pub platform_message_id: Option<String>,
    pub sender_id: String,
    pub sender_name: Option<String>,
    pub sender_username: Option<String>,
    pub sender_is_bot: Option<bool>,
    pub sent_at: Option<chrono::DateTime<chrono::Utc>>,
}

impl ImSourcePart {
    pub fn from_message(message: &ImMessage) -> Self {
        Self {
            event_id: if message.request_id.is_empty() {
                uuid::Uuid::new_v4().to_string()
            } else {
                message.request_id.clone()
            },
            platform_message_id: message.source_metadata.platform_message_id.clone(),
            sender_id: message.sender_id.clone(),
            sender_name: message.sender_name.clone(),
            sender_username: message.source_metadata.sender_username.clone(),
            sender_is_bot: message.source_metadata.sender_is_bot,
            sent_at: message.source_metadata.sent_at,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ImMessage {
    pub access_admission: Option<super::access::InputAdmission>,
    pub source_metadata: ImSourceMetadata,
    pub chat_id: String,
    pub message_id: String,
    pub text: String,
    pub sender_id: String,
    pub sender_name: Option<String>,
    /// Adapter account that received this message (community plugins only).
    pub account_id: Option<String>,
    pub source_type: ImSourceType,
    pub platform: ImPlatform,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub attachments: Vec<ImAttachment>,
    pub media_group_id: Option<String>,
    /// Whether this message triggers bot response (@mention, /ask, reply-to-bot)
    pub is_mention: bool,
    /// Whether this is specifically a reply to bot's message
    pub reply_to_bot: bool,
    /// Human-readable group name hint (from Bridge plugins; native adapters resolve via API)
    pub hint_group_name: Option<String>,
    /// Quoted reply body (for threaded replies from Bridge plugins)
    pub reply_to_body: Option<String>,
    /// Group-level custom system prompt (from Bridge plugin config)
    pub group_system_prompt: Option<String>,
    /// Per-request identity (Pattern A — IM Pipeline v2).
    /// Empty by default; mod.rs main loop fills it in when dispatching to spawn task.
    /// Carried through to /api/im/chat payload + all log statements for full-chain trace.
    /// Native buffered replays generate a fresh request_id. OpenClaw reply
    /// dispatches preserve the producer-owned ID so the waiting plugin promise
    /// remains correlated across a temporary Sidecar outage.
    pub request_id: String,
    pub delivery_protocol: Option<ImDeliveryProtocol>,
}

impl ImMessage {
    /// Canonical session key for routing (single source of truth for the format).
    pub fn session_key(&self) -> String {
        let source = match self.source_type {
            ImSourceType::Private => "private",
            ImSourceType::Group => "group",
        };
        format!("im:{}:{}:{}", self.platform, source, self.chat_id)
    }
}

/// IM Bot configuration (from frontend settings)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImConfig {
    #[serde(flatten)]
    pub access: super::access::ChannelAccessConfig,
    #[serde(default)]
    pub message_delivery_mode: ChannelDeliveryMode,
    #[serde(default = "default_platform")]
    pub platform: ImPlatform,
    #[serde(default)]
    pub name: Option<String>,
    pub bot_token: String,
    pub allowed_users: Vec<String>,
    /// Display metadata only; never used for access control or routing.
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub user_display_names: std::collections::HashMap<String, String>,
    pub permission_mode: String,
    pub default_workspace_path: Option<String>,
    pub enabled: bool,
    // ===== Feishu-specific credentials =====
    #[serde(default)]
    pub feishu_app_id: Option<String>,
    #[serde(default)]
    pub feishu_app_secret: Option<String>,
    // ===== DingTalk-specific credentials =====
    #[serde(default)]
    pub dingtalk_client_id: Option<String>,
    #[serde(default)]
    pub dingtalk_client_secret: Option<String>,
    #[serde(default)]
    pub dingtalk_use_ai_card: Option<bool>,
    #[serde(default)]
    pub dingtalk_card_template_id: Option<String>,
    // ===== Telegram-specific options =====
    #[serde(default)]
    pub telegram_use_draft: Option<bool>,
    // ===== AI config =====
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider_env_json: Option<String>,
    #[serde(default)]
    pub mcp_servers_json: Option<String>,
    // ===== Agent Runtime (v0.1.64) =====
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub runtime_config: Option<serde_json::Value>,
    // ===== Heartbeat (v0.1.21) =====
    #[serde(default)]
    pub heartbeat_config: Option<HeartbeatConfig>,
    // ===== Group Chat (v0.1.28) =====
    #[serde(default)]
    pub group_permissions: Vec<GroupPermission>,
    #[serde(default)]
    pub group_activation: Option<String>,
    #[serde(default)]
    pub group_tools_deny: Vec<String>,
    // ===== OpenClaw Channel Plugin =====
    #[serde(default)]
    pub openclaw_plugin_id: Option<String>,
    #[serde(default)]
    pub openclaw_npm_spec: Option<String>,
    #[serde(default)]
    pub openclaw_plugin_config: Option<serde_json::Value>,
    #[serde(default)]
    pub openclaw_enabled_tool_groups: Option<Vec<String>>,
}

/// Canonical execution identity of one running IM Channel.
///
/// Agent defaults intentionally keep runtime-backed Providers in their
/// provider-facing raw shape (`runtime=builtin`, no runtime source). Only an
/// effective `ImConfig` owns the projected runtime identity used by the
/// Channel process and its sessions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ImRuntimeIdentity {
    pub runtime: String,
    pub runtime_source: Option<String>,
}

impl ImRuntimeIdentity {
    pub fn from_runtime_config(runtime: &str, runtime_config: Option<&serde_json::Value>) -> Self {
        let runtime = normalize_runtime_type(Some(runtime));
        let runtime_source = runtime_source_for_runtime(&runtime, runtime_config);
        Self {
            runtime,
            runtime_source,
        }
    }
}

impl ImConfig {
    pub(crate) fn runtime_identity(&self) -> ImRuntimeIdentity {
        ImRuntimeIdentity::from_runtime_config(
            self.runtime.as_deref().unwrap_or("builtin"),
            self.runtime_config.as_ref(),
        )
    }
}

fn default_platform() -> ImPlatform {
    ImPlatform::Telegram
}

impl Default for ImConfig {
    fn default() -> Self {
        Self {
            access: Default::default(),
            message_delivery_mode: ChannelDeliveryMode::Auto,
            platform: ImPlatform::Telegram,
            name: None,
            bot_token: String::new(),
            allowed_users: Vec::new(),
            user_display_names: Default::default(),
            permission_mode: "plan".to_string(),
            default_workspace_path: None,
            enabled: false,
            feishu_app_id: None,
            feishu_app_secret: None,
            dingtalk_client_id: None,
            dingtalk_client_secret: None,
            dingtalk_use_ai_card: None,
            dingtalk_card_template_id: None,
            telegram_use_draft: None,
            provider_id: None,
            model: None,
            provider_env_json: None,
            mcp_servers_json: None,
            runtime: None,
            runtime_config: None,
            heartbeat_config: None,
            group_permissions: Vec::new(),
            group_activation: None,
            group_tools_deny: Vec::new(),
            openclaw_plugin_id: None,
            openclaw_npm_spec: None,
            openclaw_plugin_config: None,
            openclaw_enabled_tool_groups: None,
        }
    }
}

/// Active session info for status display
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImActiveSession {
    pub session_key: String,
    pub session_id: String,
    pub source_type: ImSourceType,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub source_display_name: Option<String>,
    #[serde(default)]
    pub last_sender_name: Option<String>,
    pub workspace_path: String,
    pub message_count: u32,
    #[serde(default)]
    pub metadata_birth_pending: bool,
    /// True after the sidecar has confirmed/created a SessionStore metadata row.
    /// The router reconciles this cached flag against `sessions.json` on restore
    /// and before sidecar wakeup. If an indexed binding no longer exists in the
    /// authoritative index, the peer rotates to a fresh birth-pending session
    /// instead of resurrecting the stale id.
    #[serde(default)]
    pub metadata_indexed: bool,
    pub last_active: String,
}

/// IM Bot runtime status (returned to frontend)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImBotStatus {
    pub bot_username: Option<String>,
    pub status: ImStatus,
    pub uptime_seconds: u64,
    pub last_message_at: Option<String>,
    pub active_sessions: Vec<ImActiveSession>,
    pub error_message: Option<String>,
    pub restart_count: u32,
    pub buffered_messages: usize,
    /// Deep link URL for QR code (e.g. https://t.me/BotName?start=BIND_xxxx)
    pub bind_url: Option<String>,
    /// Plain bind code for platforms without deep links (e.g. Feishu)
    pub bind_code: Option<String>,
}

impl Default for ImBotStatus {
    fn default() -> Self {
        Self {
            bot_username: None,
            status: ImStatus::Stopped,
            uptime_seconds: 0,
            last_message_at: None,
            active_sessions: Vec::new(),
            error_message: None,
            restart_count: 0,
            buffered_messages: 0,
            bind_url: None,
            bind_code: None,
        }
    }
}

/// IM conversation summary (for listing in Desktop UI)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImConversation {
    pub session_id: String,
    pub session_key: String,
    pub source_type: ImSourceType,
    pub source_id: String,
    pub workspace_path: String,
    pub message_count: u32,
    pub last_active: String,
}

/// Per-peer session tracking in SessionRouter
#[derive(Debug, Clone)]
pub struct PeerSession {
    pub session_key: String,
    pub session_id: String,
    pub sidecar_port: u16,
    pub workspace_path: PathBuf,
    pub source_type: ImSourceType,
    pub source_id: String,
    pub source_display_name: Option<String>,
    pub last_sender_name: Option<String>,
    pub message_count: u32,
    pub metadata_birth_pending: bool,
    /// Router-side evidence that `session_id` has been materialized into
    /// `sessions.json`. This is a cache, not authority: restore and sidecar
    /// wakeup reconcile it against the SessionStore index before reusing an id.
    pub metadata_indexed: bool,
    pub last_active: Instant,
}

/// Buffered message (when Sidecar is unavailable)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BufferedMessage {
    #[serde(default)]
    pub access_admission: Option<super::access::InputAdmission>,
    #[serde(default)]
    pub source_metadata: ImSourceMetadata,
    pub chat_id: String,
    pub message_id: String,
    pub text: String,
    pub sender_id: String,
    pub sender_name: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    pub source_type: ImSourceType,
    #[serde(default = "default_platform")]
    pub platform: ImPlatform,
    pub timestamp: String,
    pub retry_count: u32,
    /// Cached session key for efficient pop_for_session matching
    #[serde(default)]
    pub session_key: String,
    /// Whether this message triggers bot response (@mention, /ask, reply-to-bot)
    #[serde(default)]
    pub is_mention: bool,
    /// Whether this is specifically a reply to bot's message
    #[serde(default)]
    pub reply_to_bot: bool,
    /// Human-readable group name hint (from Bridge plugins; native adapters resolve via API)
    #[serde(default)]
    pub hint_group_name: Option<String>,
    /// Quoted reply body (for threaded replies from Bridge plugins)
    #[serde(default)]
    pub reply_to_body: Option<String>,
    /// Group-level custom system prompt (from Bridge plugin config)
    #[serde(default)]
    pub group_system_prompt: Option<String>,
    /// Process-scoped correlation for an in-memory replay. A Bridge pending
    /// dispatcher cannot survive an app restart, so this must not be persisted.
    #[serde(skip)]
    pub request_id: String,
    /// Same process-lifetime boundary as `request_id`.
    #[serde(skip)]
    pub delivery_protocol: Option<ImDeliveryProtocol>,
}

impl BufferedMessage {
    pub fn from_im_message(msg: &ImMessage) -> Self {
        Self {
            access_admission: msg.access_admission.clone(),
            source_metadata: msg.source_metadata.clone(),
            session_key: msg.session_key(),
            chat_id: msg.chat_id.clone(),
            message_id: msg.message_id.clone(),
            text: msg.text.clone(),
            sender_id: msg.sender_id.clone(),
            sender_name: msg.sender_name.clone(),
            account_id: msg.account_id.clone(),
            source_type: msg.source_type.clone(),
            platform: msg.platform.clone(),
            timestamp: msg.timestamp.to_rfc3339(),
            retry_count: 0,
            is_mention: msg.is_mention,
            reply_to_bot: msg.reply_to_bot,
            hint_group_name: msg.hint_group_name.clone(),
            reply_to_body: msg.reply_to_body.clone(),
            group_system_prompt: msg.group_system_prompt.clone(),
            request_id: if msg.delivery_protocol.is_some() {
                msg.request_id.clone()
            } else {
                String::new()
            },
            delivery_protocol: msg.delivery_protocol.clone(),
        }
    }

    /// Convert back to ImMessage for route_message() replay.
    /// Note: attachments are lost (binary data too large for JSON serialization).
    /// Native messages keep request_id empty for a fresh replay identity;
    /// request-scoped plugin protocols retain their original identity.
    pub fn to_im_message(&self) -> ImMessage {
        ImMessage {
            access_admission: self.access_admission.clone(),
            source_metadata: self.source_metadata.clone(),
            chat_id: self.chat_id.clone(),
            message_id: self.message_id.clone(),
            text: self.text.clone(),
            sender_id: self.sender_id.clone(),
            sender_name: self.sender_name.clone(),
            account_id: self.account_id.clone(),
            source_type: self.source_type.clone(),
            platform: self.platform.clone(),
            timestamp: chrono::DateTime::parse_from_rfc3339(&self.timestamp)
                .map(|dt| dt.with_timezone(&chrono::Utc))
                .unwrap_or_else(|_| chrono::Utc::now()),
            attachments: Vec::new(),
            media_group_id: None,
            is_mention: self.is_mention,
            reply_to_bot: self.reply_to_bot,
            hint_group_name: self.hint_group_name.clone(),
            reply_to_body: self.reply_to_body.clone(),
            group_system_prompt: self.group_system_prompt.clone(),
            request_id: self.request_id.clone(),
            delivery_protocol: self.delivery_protocol.clone(),
        }
    }
}

/// Persistent message buffer (serializable for disk persistence)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageBufferData {
    pub messages: VecDeque<BufferedMessage>,
}

impl Default for MessageBufferData {
    fn default() -> Self {
        Self {
            messages: VecDeque::new(),
        }
    }
}

/// Durable peer membership, separate from the mutable current binding.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerSessionHistory {
    pub session_key: String,
    pub source_type: ImSourceType,
    pub source_id: String,
    pub source_display_name: Option<String>,
    /// Observed private-chat sender, not necessarily the delivery chat ID.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_username: Option<String>,
    pub workspace_path: String,
    pub session_ids: Vec<String>,
}

/// Health state for persistence (written to im_state.json)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImHealthState {
    pub bot_username: Option<String>,
    pub status: ImStatus,
    pub uptime_seconds: u64,
    pub last_message_at: Option<String>,
    pub active_sessions: Vec<ImActiveSession>,
    #[serde(default)]
    pub peer_session_history: Vec<PeerSessionHistory>,
    pub error_message: Option<String>,
    pub restart_count: u32,
    pub buffered_messages: usize,
    pub last_persisted: String,
}

impl Default for ImHealthState {
    fn default() -> Self {
        Self {
            bot_username: None,
            status: ImStatus::Stopped,
            uptime_seconds: 0,
            last_message_at: None,
            active_sessions: Vec::new(),
            peer_session_history: Vec::new(),
            error_message: None,
            restart_count: 0,
            buffered_messages: 0,
            last_persisted: chrono::Utc::now().to_rfc3339(),
        }
    }
}

// ===== Heartbeat types (v0.1.21) =====

/// Heartbeat configuration for periodic autonomous checks.
/// The actual checklist content lives in HEARTBEAT.md in the workspace root,
/// not in this config — the config only controls timing and behavior.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatConfig {
    /// Enable/disable heartbeat (default: true)
    #[serde(default = "default_hb_enabled")]
    pub enabled: bool,
    /// Interval in minutes between checks (default: 240, min: 5)
    #[serde(default = "default_hb_interval")]
    pub interval_minutes: u32,
    /// Active hours window
    #[serde(default = "default_hb_active_hours")]
    pub active_hours: Option<ActiveHours>,
    /// Max chars for HEARTBEAT_OK detection (default: 300)
    #[serde(default = "default_hb_ack_max_chars")]
    pub ack_max_chars: Option<u32>,
}

fn default_hb_enabled() -> bool {
    true
}

fn default_hb_interval() -> u32 {
    240
}

fn default_hb_active_hours() -> Option<ActiveHours> {
    Some(ActiveHours {
        start: "09:00".to_string(),
        end: "21:00".to_string(),
        timezone: "Asia/Shanghai".to_string(),
    })
}

fn default_hb_ack_max_chars() -> Option<u32> {
    Some(300)
}

impl Default for HeartbeatConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_minutes: 240,
            active_hours: default_hb_active_hours(),
            ack_max_chars: Some(300),
        }
    }
}

/// Active hours window for heartbeat scheduling
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveHours {
    /// Start time in HH:MM format (inclusive)
    pub start: String,
    /// End time in HH:MM format (exclusive)
    pub end: String,
    /// IANA timezone name (e.g. "Asia/Shanghai")
    pub timezone: String,
}

// ===== Memory Auto-Update types (v0.1.43) =====

/// Memory auto-update configuration for periodic memory maintenance.
/// The actual update instructions live in UPDATE_MEMORY.md in the workspace root.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryAutoUpdateConfig {
    #[serde(default = "default_mau_enabled")]
    pub enabled: bool,
    #[serde(default = "default_mau_interval")]
    pub interval_hours: u32,
    #[serde(default = "default_mau_threshold")]
    pub query_threshold: u32,
    #[serde(default = "default_mau_window_start")]
    pub update_window_start: String,
    #[serde(default = "default_mau_window_end")]
    pub update_window_end: String,
    #[serde(default)]
    pub update_window_timezone: Option<String>,
    #[serde(default)]
    pub last_batch_at: Option<String>,
    #[serde(default)]
    pub last_batch_session_count: Option<u32>,
}

fn default_mau_interval() -> u32 {
    24
}
fn default_mau_enabled() -> bool {
    true
}
fn default_mau_threshold() -> u32 {
    3
}
fn default_mau_window_start() -> String {
    "21:00".to_string()
}
fn default_mau_window_end() -> String {
    "09:00".to_string()
}

impl Default for MemoryAutoUpdateConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_hours: 24,
            query_threshold: 3,
            update_window_start: "21:00".to_string(),
            update_window_end: "09:00".to_string(),
            update_window_timezone: None,
            last_batch_at: None,
            last_batch_session_count: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MemoryEvolutionJobStatus {
    Completed,
    Skipped,
    Error,
    Timeout,
}

/// Long-term memory evolution configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEvolutionConfig {
    #[serde(default = "default_memory_evolution_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub last_gardener_at: Option<String>,
    #[serde(default)]
    pub last_gardener_status: Option<MemoryEvolutionJobStatus>,
    #[serde(default)]
    pub last_gardener_message: Option<String>,
    #[serde(default)]
    pub last_molt_at: Option<String>,
    #[serde(default)]
    pub last_molt_status: Option<MemoryEvolutionJobStatus>,
    #[serde(default)]
    pub last_molt_message: Option<String>,
}

fn default_memory_evolution_enabled() -> bool {
    true
}

impl Default for MemoryEvolutionConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            last_gardener_at: None,
            last_gardener_status: None,
            last_gardener_message: None,
            last_molt_at: None,
            last_molt_status: None,
            last_molt_message: None,
        }
    }
}

/// A cron task completion event awaiting IM delivery (Rust-side truth source).
///
/// Lives in `ImBotInstance.pending_cron_events` from the moment
/// `deliver_cron_result_to_bot` records it until the heartbeat runner confirms
/// the IM platform actually accepted the AI-relayed text. Not cleared by the
/// sidecar-side `drainSystemEvents()` call (which is downgraded to a transport
/// buffer): the sidecar will re-receive the same payload via heartbeat HTTP body
/// on every retry until Rust pops the entry. This is what makes cron→IM
/// at-least-once delivery — sidecar process death, AI silent reply, and
/// `push_text_preferring_stream` failure all leave the entry intact for the next
/// heartbeat to retry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingCronEvent {
    /// Private peer session this event is allowed to wake/deliver into. Agent
    /// channels with multiple private peers share one channel-level pending vec;
    /// binding each event to the selected peer prevents cron result A from being
    /// shipped during peer B's targeted wake. Legacy per-bot events leave this
    /// unset and keep the historical latest-private behavior.
    #[serde(default)]
    pub target_session_key: Option<String>,
    /// Always `"cron_complete"`. Kept as a tagged-union discriminator so the
    /// sidecar handler can stay symmetric with the legacy `systemEventQueue`
    /// path (which carries other event kinds for non-cron callers).
    pub event: String,
    /// Cron task id. Identifies the source task; together with `timestamp`
    /// uniquely identifies this delivery instance for clear-on-success.
    pub task_id: String,
    /// Raw cron result body (already includes whatever the cron AI emitted);
    /// the next heartbeat AI turn relays this to the user with friendly framing.
    pub content: String,
    /// Unix-millis timestamp at the moment of `deliver_cron_result_to_bot`.
    /// Acts as the disambiguator when the same task fires twice before the
    /// first delivery clears (rare, but keeps `retain` idempotent).
    pub timestamp: u64,
    /// PRD 0.2.18 Session Inbox bridge — cron task's session id (the source).
    /// Sidecar uses this + `from_label` to wrap the prompt with an
    /// `<inbox-message from="Cron: <name>" reply_back="false">` prefix so the
    /// IM Bot AI sees the same envelope context as messages from
    /// `myagents session send`. Without this, the AI doesn't know which
    /// session to reply back to if the user wants to follow up.
    /// `#[serde(default)]` keeps backward compatibility with old payloads.
    #[serde(default)]
    pub from_session_id: Option<String>,
    /// PRD 0.2.18 Session Inbox bridge — caller's human-readable label
    /// (e.g. "Issue Triage 凌晨任务"). Sanitized by sidecar before injection.
    #[serde(default)]
    pub from_label: Option<String>,
}

/// Reason for heartbeat wake-up
#[derive(Debug, Clone)]
pub enum WakeReason {
    /// Regular interval tick
    Interval,
    /// Cron task completed — high priority, skips active hours check
    CronComplete { task_id: String, summary: String },
    /// Manual/external trigger — high priority
    Manual,
}

impl WakeReason {
    /// High-priority wakes skip active hours and empty-prompt checks
    pub fn is_high_priority(&self) -> bool {
        !matches!(self, WakeReason::Interval)
    }
}

/// Wake envelope for a per-bot heartbeat runner.
///
/// `WakeReason` keeps priority/business semantics. `target_session_key` is
/// routing metadata supplied by the Agent-level arbiter when it has already
/// selected the exact private peer session to wake.
#[derive(Debug, Clone)]
pub struct HeartbeatWake {
    pub reason: WakeReason,
    pub target_session_key: Option<String>,
}

impl HeartbeatWake {
    pub fn new(reason: WakeReason) -> Self {
        Self {
            reason,
            target_session_key: None,
        }
    }

    pub fn targeted(reason: WakeReason, target_session_key: String) -> Self {
        Self {
            reason,
            target_session_key: Some(target_session_key),
        }
    }

    pub fn with_target(mut self, target_session_key: Option<String>) -> Self {
        self.target_session_key = target_session_key;
        self
    }

    pub fn is_high_priority(&self) -> bool {
        self.reason.is_high_priority()
    }
}

/// Telegram API error types
#[derive(Debug)]
pub enum TelegramError {
    /// Network timeout during API call
    NetworkTimeout,
    /// Rate limited by Telegram (retry after N seconds)
    RateLimited(u64),
    /// Markdown parsing failed (should retry as plain text)
    MarkdownParseError,
    /// Message content didn't change (safe to ignore)
    MessageNotModified,
    /// Message exceeds 4096 char limit
    MessageTooLong,
    /// Group thread no longer exists
    ThreadNotFound,
    /// Bot was kicked from group
    BotKicked,
    /// Bot token is invalid
    TokenUnauthorized,
    /// sendMessageDraft not supported for this peer/chat type
    DraftPeerInvalid,
    /// Other API error
    Other(String),
}

impl std::fmt::Display for TelegramError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NetworkTimeout => write!(f, "Network timeout"),
            Self::RateLimited(secs) => write!(f, "Rate limited, retry after {}s", secs),
            Self::MarkdownParseError => write!(f, "Markdown parse error"),
            Self::MessageNotModified => write!(f, "Message not modified"),
            Self::MessageTooLong => write!(f, "Message too long"),
            Self::ThreadNotFound => write!(f, "Thread not found"),
            Self::BotKicked => write!(f, "Bot kicked from group"),
            Self::TokenUnauthorized => write!(f, "Token unauthorized"),
            Self::DraftPeerInvalid => write!(f, "Draft peer invalid"),
            Self::Other(msg) => write!(f, "{}", msg),
        }
    }
}

impl std::error::Error for TelegramError {}

// ===== Agent Architecture types (v0.1.41) =====

/// Channel-level config overrides (None = inherit from Agent)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePreferenceRust {
    pub family: String,
    pub id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelOverrides {
    pub provider_id: Option<String>,
    pub provider_env_json: Option<String>,
    pub model: Option<String>,
    pub runtime: Option<String>,
    pub runtime_config: Option<serde_json::Value>,
    pub runtime_preference: Option<RuntimePreferenceRust>,
    pub permission_mode: Option<String>,
    pub tools_deny: Option<Vec<String>>,
}

/// Channel configuration within an Agent
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelConfigRust {
    #[serde(flatten)]
    pub access: super::access::ChannelAccessConfig,
    #[serde(default)]
    pub message_delivery_mode: ChannelDeliveryMode,
    pub id: String,
    #[serde(rename = "type")]
    pub channel_type: ImPlatform,
    #[serde(default)]
    pub name: Option<String>,
    pub enabled: bool,

    // Platform credentials
    #[serde(default)]
    pub bot_token: Option<String>,
    #[serde(default)]
    pub telegram_use_draft: Option<bool>,
    #[serde(default)]
    pub feishu_app_id: Option<String>,
    #[serde(default)]
    pub feishu_app_secret: Option<String>,
    #[serde(default)]
    pub dingtalk_client_id: Option<String>,
    #[serde(default)]
    pub dingtalk_client_secret: Option<String>,
    #[serde(default)]
    pub dingtalk_use_ai_card: Option<bool>,
    #[serde(default)]
    pub dingtalk_card_template_id: Option<String>,
    #[serde(default)]
    pub openclaw_plugin_id: Option<String>,
    #[serde(default)]
    pub openclaw_npm_spec: Option<String>,
    #[serde(default)]
    pub openclaw_plugin_config: Option<serde_json::Value>,
    #[serde(default)]
    pub openclaw_manifest: Option<serde_json::Value>,
    #[serde(default)]
    pub openclaw_enabled_tool_groups: Option<Vec<String>>,

    // User management
    #[serde(default)]
    pub allowed_users: Vec<String>,
    /// Display metadata only; never used for access control or routing.
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub user_display_names: std::collections::HashMap<String, String>,

    // Group chat
    #[serde(default)]
    pub group_permissions: Vec<GroupPermission>,
    #[serde(default)]
    pub group_activation: Option<String>,

    // Overrides
    #[serde(default)]
    pub overrides: Option<ChannelOverrides>,

    /// Team AI peer birth templates keyed by Router sessionKey. Node owns the
    /// value shape (`src/server/utils/peer-profile.ts`); Rust stores it opaquely
    /// and writes it only through `team_ai::write_peer_profile` (sync / clear / invalid-birth cleanup).
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub peer_profiles: std::collections::BTreeMap<String, serde_json::Value>,

    // Legacy root-level AI fields (written by /provider command before v0.1.45 bc06386 fix).
    // Only used as fallback in to_im_config when overrides + agent are both missing.
    #[serde(default)]
    provider_id: Option<String>,
    #[serde(default)]
    provider_env_json: Option<String>,
    #[serde(default)]
    model: Option<String>,

    #[serde(default)]
    pub setup_completed: Option<bool>,
}

/// Last active channel tracking for heartbeat/cron routing
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastActiveChannel {
    pub channel_id: String,
    pub session_key: String,
    pub last_active_at: String,
}

/// Private-only heartbeat/cron target tracking.
///
/// `LastActiveChannel` remains the generic "last IM entry" and may point at a
/// group. Heartbeat delivery is private-only, so it needs its own authority.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LastActivePrivateTarget {
    pub channel_id: String,
    pub session_key: String,
    pub last_active_at: String,
}

/// Complete Agent-level heartbeat delivery target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeartbeatTarget {
    pub channel_id: String,
    pub session_key: String,
}

/// Agent configuration (read from config.json agents[])
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigRust {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    pub enabled: bool,

    /// Runtime-only workspace projection. Never serialized into agents[].
    /// Project.path is authoritative; the config-store compatibility adapter
    /// fills this from a legacy Agent path only for an unlinked orphan.
    #[serde(default, skip_serializing, skip_deserializing)]
    pub resolved_workspace_path: String,

    // AI config (Agent-level defaults)
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider_env_json: Option<String>,
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    #[serde(default)]
    pub mcp_enabled_servers: Option<Vec<String>>,
    /// Complete MCP server definitions JSON (persisted for auto-start, rebuilt on manual start)
    #[serde(default)]
    pub mcp_servers_json: Option<String>,

    // Heartbeat (Agent-level)
    #[serde(default)]
    pub heartbeat: Option<HeartbeatConfig>,

    // Memory auto-update (v0.1.43)
    #[serde(default)]
    pub memory_auto_update: Option<MemoryAutoUpdateConfig>,

    // Long-term memory evolution (v0.2.49)
    #[serde(default)]
    pub memory_evolution: Option<MemoryEvolutionConfig>,

    // Channels
    #[serde(default)]
    pub channels: Vec<ChannelConfigRust>,

    // Active message routing
    #[serde(default)]
    pub last_active_channel: Option<LastActiveChannel>,
    #[serde(default)]
    pub last_active_private_target: Option<LastActivePrivateTarget>,

    // Agent Runtime compatibility projection. runtimePreference is authoritative.
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub runtime_config: Option<serde_json::Value>,
    #[serde(default)]
    pub runtime_preference: Option<RuntimePreferenceRust>,
    /// Runtime-only projection of the build distribution selector policy.
    #[serde(default = "default_true", skip_serializing)]
    pub runtime_selection_available: bool,
    /// Root default for Agents without an explicit Runtime preference.
    #[serde(default, skip_serializing, skip_deserializing)]
    pub default_integrated_runtime: Option<String>,

    #[serde(default)]
    pub setup_completed: Option<bool>,
}

impl AgentConfigRust {
    /// Effective heartbeat gate. The persisted child config keeps the user's
    /// independent choice; execution additionally requires Proactive Agent.
    pub fn effective_heartbeat(&self) -> HeartbeatConfig {
        let mut heartbeat = self.heartbeat.clone().unwrap_or_default();
        heartbeat.enabled = self.enabled && heartbeat.enabled;
        heartbeat
    }
}

fn default_permission_mode() -> String {
    "plan".to_string()
}

fn default_true() -> bool {
    true
}

fn runtime_from_preference(
    preference: &RuntimePreferenceRust,
) -> Result<(String, Option<String>), String> {
    match (preference.family.as_str(), preference.id.as_str()) {
        ("integrated", "claude-agent-sdk") => Ok(("builtin".to_string(), None)),
        ("integrated", "dsh") => Ok(("dsh".to_string(), Some("integrated".to_string()))),
        ("external", runtime @ ("claude-code" | "codex" | "antigravity")) => {
            Ok((runtime.to_string(), Some("system-cli".to_string())))
        }
        (family, id) => Err(format!("unsupported runtimePreference {family}/{id}")),
    }
}

pub(crate) fn project_runtime_for_provider(
    provider_id: Option<&str>,
    model: Option<&str>,
    runtime: Option<String>,
    runtime_config: Option<serde_json::Value>,
) -> (Option<String>, Option<serde_json::Value>) {
    let normalized_runtime = normalize_runtime_type(runtime.as_deref());
    let configured_source = runtime_config
        .as_ref()
        .and_then(|value| value.get("source"))
        .and_then(|value| value.as_str());
    // An explicit External CLI preference wins over dormant Product provider
    // defaults. Integrated preferences remain subject to Provider constraints.
    if is_external_runtime_type(&normalized_runtime)
        && configured_source != Some("managed-provider")
    {
        return (runtime, runtime_config);
    }
    if provider_id == Some(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID)
        || provider_id == Some("anthropic-api")
    {
        return (Some("builtin".to_string()), None);
    }
    let uses_managed_codex = provider_id == Some(CODEX_SUBSCRIPTION_PROVIDER_ID)
        && (normalized_runtime == "builtin"
            || normalized_runtime == "dsh"
            || (normalized_runtime == "codex" && configured_source == Some("managed-provider")));

    if !uses_managed_codex {
        if configured_source == Some("managed-provider") {
            let mut config = runtime_config
                .and_then(|value| value.as_object().cloned())
                .unwrap_or_default();
            for key in [
                "source",
                "model",
                "permissionMode",
                "reasoningEffort",
                "additionalArgs",
            ] {
                config.remove(key);
            }
            return (
                runtime,
                (!config.is_empty()).then_some(serde_json::Value::Object(config)),
            );
        }
        return (runtime, runtime_config);
    }
    let mut config = runtime_config
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    for key in [
        "source",
        "model",
        "permissionMode",
        "reasoningEffort",
        "additionalArgs",
    ] {
        config.remove(key);
    }
    config.insert(
        "source".to_string(),
        serde_json::Value::String("managed-provider".to_string()),
    );
    if let Some(model) = model.filter(|m| !m.is_empty()) {
        config.insert(
            "model".to_string(),
            serde_json::Value::String(model.to_string()),
        );
    } else {
        config.remove("model");
    }
    (
        Some("codex".to_string()),
        Some(serde_json::Value::Object(config)),
    )
}

pub(crate) fn project_permission_for_provider(
    provider_id: Option<&str>,
    permission_mode: String,
) -> String {
    if provider_id != Some(CODEX_SUBSCRIPTION_PROVIDER_ID) {
        return permission_mode;
    }
    let trimmed = permission_mode.trim();
    match trimmed {
        "suggest" | "auto-edit" | "no-restrictions" => trimmed.to_string(),
        "auto" => "auto-edit".to_string(),
        "plan" => "suggest".to_string(),
        "fullAgency" => "no-restrictions".to_string(),
        _ => "auto-edit".to_string(),
    }
}

pub(crate) fn max_permission_for_runtime(runtime: Option<&str>) -> &'static str {
    match runtime {
        Some("dsh") => "full-autonomous",
        Some("claude-code") => "bypassPermissions",
        Some("antigravity") => "dangerously-skip-permissions",
        Some("codex") => "no-restrictions",
        _ => "fullAgency",
    }
}

fn deserialize_nullable_value<'de, D>(
    deserializer: D,
) -> Result<Option<Option<serde_json::Value>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<serde_json::Value>::deserialize(deserializer).map(Some)
}

fn deserialize_nullable_runtime_preference<'de, D>(
    deserializer: D,
) -> Result<Option<Option<RuntimePreferenceRust>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<RuntimePreferenceRust>::deserialize(deserializer).map(Some)
}

fn deserialize_nullable_string<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

/// Agent-level status (aggregates all channel statuses)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub agent_id: String,
    pub agent_name: String,
    pub enabled: bool,
    pub channels: Vec<ChannelStatus>,
}

/// Per-channel runtime status
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelStatus {
    pub channel_id: String,
    pub channel_type: ImPlatform,
    pub name: Option<String>,
    pub status: ImStatus,
    pub bot_username: Option<String>,
    pub uptime_seconds: u64,
    pub last_message_at: Option<String>,
    pub active_sessions: Vec<ImActiveSession>,
    pub error_message: Option<String>,
    pub restart_count: u32,
    pub buffered_messages: usize,
    pub bind_url: Option<String>,
    pub bind_code: Option<String>,
}

impl ChannelConfigRust {
    fn runtime_config_for_preference(
        runtime_config: Option<serde_json::Value>,
        source: Option<&str>,
    ) -> Option<serde_json::Value> {
        if source != Some("system-cli") {
            return runtime_config;
        }
        let mut config = runtime_config
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        // An authoritative External preference cannot inherit a stale managed
        // Provider source. Other runtime-specific values remain valid inputs
        // for the chosen CLI and are scrubbed by ordinary Runtime writers.
        config.remove("source");
        (!config.is_empty()).then_some(serde_json::Value::Object(config))
    }

    fn selected_runtime_with_policy(
        &self,
        agent: &AgentConfigRust,
        policy: &crate::runtime_distribution_policy::RuntimeDistributionPolicy,
    ) -> Result<(Option<String>, Option<serde_json::Value>), String> {
        if !agent.runtime_selection_available {
            return Ok((
                Some(
                    policy
                        .default_runtime_for_override(agent.default_integrated_runtime.as_deref())
                        .to_string(),
                ),
                None,
            ));
        }
        let runtime_config = agent.runtime_config.clone();
        if let Some(preference) = agent.runtime_preference.as_ref() {
            let (runtime, source) = runtime_from_preference(preference)?;
            return Ok((
                Some(runtime),
                Self::runtime_config_for_preference(runtime_config, source.as_deref()),
            ));
        }
        let runtime = agent.runtime.clone().unwrap_or_else(|| {
            policy
                .default_runtime_for_override(agent.default_integrated_runtime.as_deref())
                .to_string()
        });
        Ok((Some(runtime), runtime_config))
    }

    fn effective_runtime_projection(
        &self,
        agent: &AgentConfigRust,
        provider_id: Option<&str>,
        model: Option<&str>,
    ) -> Result<(Option<String>, Option<serde_json::Value>), String> {
        self.effective_runtime_projection_with_policy(
            agent,
            provider_id,
            model,
            crate::runtime_distribution_policy::policy(),
        )
    }

    fn effective_runtime_projection_with_policy(
        &self,
        agent: &AgentConfigRust,
        provider_id: Option<&str>,
        model: Option<&str>,
        policy: &crate::runtime_distribution_policy::RuntimeDistributionPolicy,
    ) -> Result<(Option<String>, Option<serde_json::Value>), String> {
        let (runtime, runtime_config) = self.selected_runtime_with_policy(agent, policy)?;
        let projected = project_runtime_for_provider(provider_id, model, runtime, runtime_config);
        let projected_runtime = projected.0.as_deref().unwrap_or("builtin");
        let projected_source = projected
            .1
            .as_ref()
            .and_then(|value| value.get("source"))
            .and_then(serde_json::Value::as_str);
        if policy.allows_runtime(projected_runtime, projected_source) {
            Ok(projected)
        } else {
            Err(format!(
                "Runtime {}/{} is not included in this distribution",
                projected_runtime,
                projected_source.unwrap_or("builtin"),
            ))
        }
    }

    pub(crate) fn effective_permission_mode(&self, agent: &AgentConfigRust) -> String {
        let provider_id = agent.provider_id.clone();
        let model = agent.model.clone();
        let (runtime, projected_runtime_config) = self
            .effective_runtime_projection(agent, provider_id.as_deref(), model.as_deref())
            .unwrap_or_else(|_| (Some("builtin".to_string()), None));
        let permission_provider_id = if projected_runtime_config
            .as_ref()
            .and_then(|value| value.get("source"))
            .and_then(|value| value.as_str())
            == Some("managed-provider")
        {
            provider_id.as_deref()
        } else {
            None
        };
        project_permission_for_provider(
            permission_provider_id,
            max_permission_for_runtime(runtime.as_deref()).to_string(),
        )
    }

    /// Convert to ImConfig for backward compatibility with existing start_im_bot logic.
    pub fn to_im_config(&self, agent: &AgentConfigRust) -> ImConfig {
        let overrides = self.overrides.as_ref();
        let provider_id = agent.provider_id.clone();
        let model = agent.model.clone();
        let runtime_projection =
            self.effective_runtime_projection(agent, provider_id.as_deref(), model.as_deref());
        let runtime_compatible = runtime_projection.is_ok();
        let (runtime, runtime_config) =
            runtime_projection.unwrap_or_else(|_| (Some("builtin".to_string()), None));
        let permission_mode = self.effective_permission_mode(agent);

        ImConfig {
            access: self.access.clone(),
            message_delivery_mode: self.message_delivery_mode,
            platform: self.channel_type.clone(),
            // For OpenClaw channels, self.name is the npm package name (e.g., "larksuite/openclaw-lark")
            // which is meaningless as a bot display name. Prefer agent name in that case.
            name: if self.channel_type.to_string().starts_with("openclaw:") {
                Some(agent.name.clone())
            } else {
                self.name.clone().or_else(|| Some(agent.name.clone()))
            },
            bot_token: self.bot_token.clone().unwrap_or_default(),
            allowed_users: self.allowed_users.clone(),
            user_display_names: self.user_display_names.clone(),
            permission_mode,
            default_workspace_path: Some(agent.resolved_workspace_path.clone()),
            // Channel availability is owned by ChannelConfig. Proactive Agent
            // mode gates heartbeat/memory only and must not stop chat ingress.
            enabled: self.enabled && runtime_compatible,
            feishu_app_id: self.feishu_app_id.clone(),
            feishu_app_secret: self.feishu_app_secret.clone(),
            dingtalk_client_id: self.dingtalk_client_id.clone(),
            dingtalk_client_secret: self.dingtalk_client_secret.clone(),
            dingtalk_use_ai_card: self.dingtalk_use_ai_card,
            dingtalk_card_template_id: self.dingtalk_card_template_id.clone(),
            telegram_use_draft: self.telegram_use_draft,
            // Fallback chain: overrides → channel root (legacy pre-v0.1.45) → agent default
            // Channel root has higher priority than agent default because the user explicitly
            // chose a provider for this specific channel via /provider command (written to root
            // by persist_bot_config_patch before the bc06386 fix moved writes to overrides).
            provider_id,
            model,
            provider_env_json: agent.provider_env_json.clone(),
            mcp_servers_json: agent.mcp_servers_json.clone(),
            runtime,
            runtime_config,
            heartbeat_config: agent.heartbeat.clone(),
            group_permissions: self.group_permissions.clone(),
            group_activation: self.group_activation.clone(),
            group_tools_deny: overrides
                .and_then(|o| o.tools_deny.clone())
                .unwrap_or_default(),
            openclaw_plugin_id: self.openclaw_plugin_id.clone(),
            openclaw_npm_spec: self.openclaw_npm_spec.clone(),
            openclaw_plugin_config: self.openclaw_plugin_config.clone(),
            openclaw_enabled_tool_groups: self.openclaw_enabled_tool_groups.clone(),
        }
    }
}

/// Partial update patch for Agent config (used by cmd_update_agent_config)
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigPatch {
    pub name: Option<String>,
    pub icon: Option<String>,
    pub enabled: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_nullable_string")]
    pub provider_id: Option<Option<String>>,
    pub model: Option<String>,
    /// Tri-state patch field: missing = do not change, null = clear,
    /// string = replace. Renderer sends null when switching away from a
    /// provider-backed route; treating that as "absent" leaves hot Agent/IM
    /// instances with stale provider credentials.
    #[serde(default, deserialize_with = "deserialize_nullable_string")]
    pub provider_env_json: Option<Option<String>>,
    pub permission_mode: Option<String>,
    pub mcp_enabled_servers: Option<Vec<String>>,
    pub mcp_servers_json: Option<String>,
    pub runtime: Option<String>,
    #[serde(default, deserialize_with = "deserialize_nullable_runtime_preference")]
    pub runtime_preference: Option<Option<RuntimePreferenceRust>>,
    /// Tri-state patch field: missing = do not change, null = clear,
    /// object = replace. Tauri JSON command patches need this distinction;
    /// `Option<Value>` would deserialize both missing and null to `None`.
    #[serde(default, deserialize_with = "deserialize_nullable_value")]
    pub runtime_config: Option<Option<serde_json::Value>>,
    pub heartbeat_config_json: Option<String>,
    pub memory_auto_update_config_json: Option<String>,
    pub memory_evolution_config_json: Option<String>,
    pub channels: Option<Vec<ChannelConfigRust>>,
    pub setup_completed: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffered_openclaw_reply_identity_is_process_scoped() {
        let message = ImMessage {
            access_admission: None,
            source_metadata: Default::default(),
            chat_id: "chat-1".to_string(),
            message_id: "message-1".to_string(),
            text: "hello".to_string(),
            sender_id: "user-1".to_string(),
            sender_name: None,
            account_id: Some("account-1".to_string()),
            source_type: ImSourceType::Private,
            platform: ImPlatform::OpenClaw("openclaw-lark".to_string()),
            timestamp: chrono::Utc::now(),
            attachments: Vec::new(),
            media_group_id: None,
            is_mention: true,
            reply_to_bot: false,
            hint_group_name: None,
            reply_to_body: None,
            group_system_prompt: None,
            request_id: "request-1".to_string(),
            delivery_protocol: Some(ImDeliveryProtocol::OpenClawReply),
        };

        let buffered = BufferedMessage::from_im_message(&message);
        assert_eq!(buffered.to_im_message().request_id, "request-1");
        assert_eq!(
            buffered.to_im_message().account_id.as_deref(),
            Some("account-1")
        );
        assert_eq!(
            buffered.to_im_message().delivery_protocol,
            Some(ImDeliveryProtocol::OpenClawReply)
        );

        let persisted = serde_json::to_value(&buffered).unwrap();
        assert!(persisted.get("request_id").is_none());
        assert!(persisted.get("delivery_protocol").is_none());
        let restored: BufferedMessage = serde_json::from_value(persisted).unwrap();
        assert!(restored.request_id.is_empty());
        assert!(restored.delivery_protocol.is_none());
    }

    fn base_agent() -> AgentConfigRust {
        AgentConfigRust {
            id: "agent-1".to_string(),
            name: "Agent".to_string(),
            icon: None,
            enabled: true,
            resolved_workspace_path: "/tmp/workspace".to_string(),
            provider_id: Some("openrouter".to_string()),
            model: Some("anthropic/claude-sonnet-4.6".to_string()),
            provider_env_json: None,
            permission_mode: "auto".to_string(),
            mcp_enabled_servers: None,
            mcp_servers_json: None,
            heartbeat: None,
            memory_auto_update: None,
            memory_evolution: None,
            channels: vec![],
            last_active_channel: None,
            last_active_private_target: None,
            runtime: Some("builtin".to_string()),
            runtime_config: None,
            runtime_preference: None,
            runtime_selection_available: true,
            default_integrated_runtime: None,
            setup_completed: Some(true),
        }
    }

    fn base_channel() -> ChannelConfigRust {
        ChannelConfigRust {
            access: Default::default(),
            message_delivery_mode: ChannelDeliveryMode::Auto,
            id: "channel-1".to_string(),
            channel_type: ImPlatform::Telegram,
            name: None,
            enabled: true,
            bot_token: Some("token".to_string()),
            telegram_use_draft: None,
            feishu_app_id: None,
            feishu_app_secret: None,
            dingtalk_client_id: None,
            dingtalk_client_secret: None,
            dingtalk_use_ai_card: None,
            dingtalk_card_template_id: None,
            openclaw_plugin_id: None,
            openclaw_npm_spec: None,
            openclaw_plugin_config: None,
            openclaw_manifest: None,
            openclaw_enabled_tool_groups: None,
            allowed_users: vec![],
            user_display_names: Default::default(),
            group_permissions: vec![],
            group_activation: None,
            overrides: None,
            peer_profiles: Default::default(),
            provider_id: None,
            provider_env_json: None,
            model: None,
            setup_completed: Some(true),
        }
    }

    #[test]
    fn agent_channel_defaults_to_full_agency_when_channel_has_no_permission_override() {
        let mut agent = base_agent();
        agent.permission_mode = "plan".to_string();
        let channel = base_channel();

        let config = channel.to_im_config(&agent);

        assert_eq!(config.permission_mode, "fullAgency");
        assert_eq!(channel.effective_permission_mode(&agent), "fullAgency");
    }

    #[test]
    fn agent_channel_enablement_is_independent_from_proactive_agent() {
        let mut agent = base_agent();
        agent.enabled = false;
        let channel = base_channel();

        assert!(channel.to_im_config(&agent).enabled);
        assert!(!agent.effective_heartbeat().enabled);
    }

    #[test]
    fn heartbeat_and_memory_defaults_match_product_defaults() {
        let heartbeat = HeartbeatConfig::default();
        assert!(heartbeat.enabled);
        assert_eq!(heartbeat.interval_minutes, 240);
        assert_eq!(heartbeat.ack_max_chars, Some(300));
        assert_eq!(
            heartbeat.active_hours,
            Some(ActiveHours {
                start: "09:00".to_string(),
                end: "21:00".to_string(),
                timezone: "Asia/Shanghai".to_string(),
            })
        );

        let memory = MemoryAutoUpdateConfig::default();
        assert!(memory.enabled);
        assert_eq!(memory.interval_hours, 24);
        assert_eq!(memory.query_threshold, 3);
        assert_eq!(memory.update_window_start, "21:00");
        assert_eq!(memory.update_window_end, "09:00");
        assert_eq!(memory.update_window_timezone, None);
    }

    #[test]
    fn agent_channel_uses_runtime_max_permission_when_channel_has_no_override() {
        let mut agent = base_agent();
        agent.permission_mode = "plan".to_string();
        agent.runtime = Some("codex".to_string());
        let channel = base_channel();

        let config = channel.to_im_config(&agent);

        assert_eq!(config.permission_mode, "no-restrictions");
    }

    #[test]
    fn integrated_dsh_preference_projects_complete_im_runtime_identity() {
        let mut agent = base_agent();
        agent.runtime = Some("dsh".to_string());
        agent.runtime_preference = Some(RuntimePreferenceRust {
            family: "integrated".to_string(),
            id: "dsh".to_string(),
        });

        let config = base_channel().to_im_config(&agent);

        assert_eq!(config.runtime.as_deref(), Some("dsh"));
        assert_eq!(
            config.runtime_identity(),
            ImRuntimeIdentity {
                runtime: "dsh".to_string(),
                runtime_source: Some("integrated".to_string()),
            }
        );
        assert!(config.enabled);
        assert_eq!(config.permission_mode, "full-autonomous");

        let mut channel = base_channel();
        channel.overrides = Some(ChannelOverrides {
            permission_mode: Some("workspace-autonomous".to_string()),
            ..Default::default()
        });
        assert_eq!(
            channel.to_im_config(&agent).permission_mode,
            "full-autonomous"
        );
    }

    #[test]
    fn hidden_selector_defaults_new_im_sessions_without_erasing_preference() {
        let mut agent = base_agent();
        agent.runtime = Some("dsh".to_string());
        agent.runtime_preference = Some(RuntimePreferenceRust {
            family: "integrated".to_string(),
            id: "dsh".to_string(),
        });
        agent.runtime_selection_available = false;

        let config = base_channel().to_im_config(&agent);

        assert_eq!(config.runtime.as_deref(), Some("builtin"));
        assert_eq!(
            agent
                .runtime_preference
                .as_ref()
                .map(|value| value.id.as_str()),
            Some("dsh")
        );
    }

    #[test]
    fn unset_agent_uses_the_configured_integrated_default() {
        let mut agent = base_agent();
        agent.runtime_selection_available = true;
        agent.runtime = None;
        agent.default_integrated_runtime = Some("dsh".to_string());

        let config = base_channel().to_im_config(&agent);

        assert_eq!(config.runtime.as_deref(), Some("dsh"));
        assert_eq!(
            config.runtime_identity().runtime_source.as_deref(),
            Some("integrated")
        );

        agent.runtime = Some("builtin".to_string());
        assert_eq!(
            base_channel().to_im_config(&agent).runtime.as_deref(),
            Some("builtin")
        );
        agent.runtime = None;
        agent.runtime_preference = Some(RuntimePreferenceRust {
            family: "integrated".to_string(),
            id: "claude-agent-sdk".to_string(),
        });
        assert_eq!(
            base_channel().to_im_config(&agent).runtime.as_deref(),
            Some("builtin")
        );
    }

    #[test]
    fn dsh_only_policy_drives_im_birth_and_rejects_incompatible_provider() {
        let policy = crate::runtime_distribution_policy::RuntimeDistributionPolicy::parse(
            r#"{
                "schemaVersion": 1,
                "allowedIntegratedRuntimes": ["dsh"],
                "allowedExternalRuntimes": [],
                "defaultIntegratedRuntime": "dsh",
                "selectorAvailability": "hidden"
            }"#,
        )
        .expect("valid DSH-only policy");
        let mut agent = base_agent();
        agent.runtime = Some("codex".to_string());
        agent.runtime_preference = Some(RuntimePreferenceRust {
            family: "external".to_string(),
            id: "codex".to_string(),
        });
        agent.runtime_selection_available = false;
        let channel = base_channel();

        let ordinary = channel
            .effective_runtime_projection_with_policy(&agent, None, None, &policy)
            .expect("DSH-only ordinary IM projection");
        assert_eq!(ordinary.0.as_deref(), Some("dsh"));

        let incompatible = channel.effective_runtime_projection_with_policy(
            &agent,
            Some(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID),
            None,
            &policy,
        );
        assert!(incompatible.is_err());
    }

    #[test]
    fn subscription_provider_constraint_overrides_integrated_dsh_preference() {
        let mut agent = base_agent();
        agent.provider_id = Some(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID.to_string());
        agent.runtime = Some("dsh".to_string());
        agent.runtime_preference = Some(RuntimePreferenceRust {
            family: "integrated".to_string(),
            id: "dsh".to_string(),
        });

        let config = base_channel().to_im_config(&agent);

        assert_eq!(config.runtime.as_deref(), Some("builtin"));
        assert_eq!(config.runtime_identity().runtime_source, None);

        agent.provider_id = Some("anthropic-api".to_string());
        let claude_api = base_channel().to_im_config(&agent);
        assert_eq!(claude_api.runtime.as_deref(), Some("builtin"));

        agent.provider_id = Some("xai-sub".to_string());
        let grok = base_channel().to_im_config(&agent);
        assert_eq!(grok.runtime.as_deref(), Some("dsh"));
    }

    #[test]
    fn invalid_authoritative_im_runtime_preference_fails_closed() {
        let mut agent = base_agent();
        agent.runtime_preference = Some(RuntimePreferenceRust {
            family: "integrated".to_string(),
            id: "future-runtime".to_string(),
        });

        let config = base_channel().to_im_config(&agent);

        assert!(!config.enabled);
        assert_eq!(config.runtime.as_deref(), Some("builtin"));
    }

    #[test]
    fn channel_legacy_runtime_override_does_not_override_agent_preference() {
        let mut agent = base_agent();
        agent.runtime_preference = Some(RuntimePreferenceRust {
            family: "integrated".to_string(),
            id: "dsh".to_string(),
        });
        let mut channel = base_channel();
        channel.overrides = Some(ChannelOverrides {
            runtime: Some("claude-code".to_string()),
            ..ChannelOverrides::default()
        });

        let config = channel.to_im_config(&agent);

        assert_eq!(config.runtime.as_deref(), Some("dsh"));
        assert_eq!(
            config.runtime_identity().runtime_source.as_deref(),
            Some("integrated"),
        );
    }

    #[test]
    fn explicit_external_preference_drops_stale_managed_source() {
        let mut agent = base_agent();
        agent.provider_id = Some(CODEX_SUBSCRIPTION_PROVIDER_ID.to_string());
        agent.runtime_config = Some(serde_json::json!({
            "source": "managed-provider",
            "envPolicy": { "proxy": "terminal" }
        }));
        agent.runtime_preference = Some(RuntimePreferenceRust {
            family: "external".to_string(),
            id: "codex".to_string(),
        });

        let config = base_channel().to_im_config(&agent);

        assert_eq!(config.runtime.as_deref(), Some("codex"));
        assert_eq!(
            config.runtime_identity().runtime_source.as_deref(),
            Some("system-cli"),
        );
        assert_eq!(
            config
                .runtime_config
                .as_ref()
                .and_then(|value| value.get("envPolicy")),
            Some(&serde_json::json!({ "proxy": "terminal" })),
        );
    }

    #[test]
    fn system_runtime_channel_ignores_legacy_permission_overrides() {
        let mut agent = base_agent();
        agent.runtime = Some("claude-code".to_string());
        let mut channel = base_channel();
        channel.overrides = Some(ChannelOverrides {
            permission_mode: Some("fullAgency".to_string()),
            ..Default::default()
        });

        assert_eq!(
            channel.to_im_config(&agent).permission_mode,
            "bypassPermissions"
        );

        channel.overrides.as_mut().unwrap().permission_mode = Some("dontAsk".to_string());
        assert_eq!(
            channel.to_im_config(&agent).permission_mode,
            "bypassPermissions"
        );

        agent.runtime = Some("codex".to_string());
        channel.overrides.as_mut().unwrap().permission_mode = Some("fullAgency".to_string());
        assert_eq!(
            channel.to_im_config(&agent).permission_mode,
            "no-restrictions"
        );

        agent.runtime = Some("claude-code".to_string());
        assert_eq!(
            channel.to_im_config(&agent).permission_mode,
            "bypassPermissions"
        );
        agent.runtime = Some("antigravity".to_string());
        assert_eq!(
            channel.to_im_config(&agent).permission_mode,
            "dangerously-skip-permissions"
        );
    }

    #[test]
    fn agent_channel_ignores_legacy_permission_override() {
        let agent = base_agent();
        let mut channel = base_channel();
        channel.overrides = Some(ChannelOverrides {
            permission_mode: Some("plan".to_string()),
            ..Default::default()
        });

        let config = channel.to_im_config(&agent);

        assert_eq!(config.permission_mode, "fullAgency");
    }

    #[test]
    fn legacy_channel_provider_and_permission_do_not_select_managed_codex() {
        let agent = base_agent();
        let mut channel = base_channel();
        channel.overrides = Some(ChannelOverrides {
            provider_id: Some(CODEX_SUBSCRIPTION_PROVIDER_ID.to_string()),
            model: Some("gpt-5.5-codex".to_string()),
            permission_mode: Some("plan".to_string()),
            ..Default::default()
        });

        let config = channel.to_im_config(&agent);

        assert_eq!(config.runtime.as_deref(), Some("builtin"));
        assert_eq!(config.permission_mode, "fullAgency");
    }

    #[test]
    fn codex_subscription_does_not_treat_system_full_auto_as_full_agency() {
        let agent = base_agent();
        let mut channel = base_channel();
        channel.overrides = Some(ChannelOverrides {
            provider_id: Some(CODEX_SUBSCRIPTION_PROVIDER_ID.to_string()),
            model: Some("gpt-5.5-codex".to_string()),
            permission_mode: Some("full-auto".to_string()),
            ..Default::default()
        });

        assert_eq!(channel.to_im_config(&agent).permission_mode, "fullAgency");
    }

    #[test]
    fn agent_codex_subscription_projects_to_managed_runtime() {
        let mut agent = base_agent();
        agent.provider_id = Some(CODEX_SUBSCRIPTION_PROVIDER_ID.to_string());
        agent.model = Some("gpt-5.5-codex".to_string());
        agent.runtime_config = Some(serde_json::json!({"envPolicy":{"proxy":"terminal"}}));
        let mut channel = base_channel();
        channel.overrides = Some(ChannelOverrides {
            provider_id: Some(CODEX_SUBSCRIPTION_PROVIDER_ID.to_string()),
            model: Some("gpt-5.5-codex".to_string()),
            runtime_config: Some(serde_json::json!({
                "envPolicy": { "proxy": "terminal" },
                "permissionMode": "fullAgency",
                "reasoningEffort": "max",
                "additionalArgs": ["--legacy"]
            })),
            ..Default::default()
        });

        let config = channel.to_im_config(&agent);

        assert_eq!(
            config.provider_id.as_deref(),
            Some(CODEX_SUBSCRIPTION_PROVIDER_ID)
        );
        assert_eq!(config.model.as_deref(), Some("gpt-5.5-codex"));
        assert_eq!(config.runtime.as_deref(), Some("codex"));
        assert_eq!(config.permission_mode, "no-restrictions");
        assert_eq!(
            config
                .runtime_config
                .as_ref()
                .and_then(|v| v.get("source"))
                .and_then(|v| v.as_str()),
            Some("managed-provider")
        );
        assert_eq!(
            config
                .runtime_config
                .as_ref()
                .and_then(|v| v.get("model"))
                .and_then(|v| v.as_str()),
            Some("gpt-5.5-codex")
        );
        assert_eq!(
            config
                .runtime_config
                .as_ref()
                .and_then(|v| v.get("envPolicy"))
                .and_then(|v| v.get("proxy"))
                .and_then(|v| v.as_str()),
            Some("terminal")
        );
        assert!(config
            .runtime_config
            .as_ref()
            .and_then(|v| v.get("permissionMode"))
            .is_none());
        assert!(config
            .runtime_config
            .as_ref()
            .and_then(|v| v.get("reasoningEffort"))
            .is_none());
        assert!(config
            .runtime_config
            .as_ref()
            .and_then(|v| v.get("additionalArgs"))
            .is_none());
    }

    #[test]
    fn managed_codex_model_change_keeps_channel_runtime_identity() {
        let mut before = base_agent();
        before.provider_id = Some(CODEX_SUBSCRIPTION_PROVIDER_ID.to_string());
        before.model = Some("gpt-5.5".to_string());
        before.runtime = Some("builtin".to_string());
        before.runtime_config = Some(serde_json::json!({
            "permissionMode": "no-restrictions"
        }));
        let channel = base_channel();
        let old_identity = channel.to_im_config(&before).runtime_identity();

        let mut after = before.clone();
        after.model = Some("gpt-5.6-sol".to_string());
        let new_identity = channel.to_im_config(&after).runtime_identity();

        assert_eq!(
            old_identity,
            ImRuntimeIdentity {
                runtime: "codex".to_string(),
                runtime_source: Some("managed-provider".to_string()),
            }
        );
        assert_eq!(new_identity, old_identity);
    }

    #[test]
    fn channel_template_tracks_agent_defaults_while_legacy_overrides_are_ignored() {
        let mut before = base_agent();
        before.provider_id = Some(CODEX_SUBSCRIPTION_PROVIDER_ID.to_string());
        before.model = Some("gpt-5.5".to_string());
        let mut channel = base_channel();
        channel.overrides = Some(ChannelOverrides {
            provider_id: Some("openrouter".to_string()),
            model: Some("anthropic/claude-sonnet-4.6".to_string()),
            runtime: Some("builtin".to_string()),
            ..Default::default()
        });
        let old_identity = channel.to_im_config(&before).runtime_identity();

        let mut after = before.clone();
        after.provider_id = Some("openrouter".to_string());
        after.model = Some("anthropic/claude-opus-4.6".to_string());
        let new_identity = channel.to_im_config(&after).runtime_identity();

        assert_eq!(old_identity.runtime, "codex");
        assert_eq!(new_identity.runtime, "builtin");
        assert_ne!(new_identity, old_identity);
    }

    #[test]
    fn agent_config_patch_runtime_config_distinguishes_missing_null_and_value() {
        let missing: AgentConfigPatch = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(missing.runtime_config.is_none());

        let clear: AgentConfigPatch =
            serde_json::from_value(serde_json::json!({ "runtimeConfig": null })).unwrap();
        assert_eq!(clear.runtime_config, Some(None));

        let replace: AgentConfigPatch = serde_json::from_value(serde_json::json!({
            "runtimeConfig": { "source": "managed-provider" }
        }))
        .unwrap();
        assert_eq!(
            replace
                .runtime_config
                .as_ref()
                .and_then(|v| v.as_ref())
                .and_then(|v| v.get("source"))
                .and_then(|v| v.as_str()),
            Some("managed-provider")
        );
    }

    #[test]
    fn agent_config_patch_provider_id_distinguishes_missing_null_and_value() {
        let missing: AgentConfigPatch = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(missing.provider_id.is_none());

        let clear: AgentConfigPatch =
            serde_json::from_value(serde_json::json!({ "providerId": null })).unwrap();
        assert_eq!(clear.provider_id, Some(None));

        let replace: AgentConfigPatch = serde_json::from_value(serde_json::json!({
            "providerId": CODEX_SUBSCRIPTION_PROVIDER_ID
        }))
        .unwrap();
        assert_eq!(
            replace.provider_id.as_ref().and_then(|v| v.as_deref()),
            Some(CODEX_SUBSCRIPTION_PROVIDER_ID)
        );
    }

    #[test]
    fn agent_config_patch_provider_env_json_distinguishes_missing_null_and_value() {
        let missing: AgentConfigPatch = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(missing.provider_env_json.is_none());

        let clear: AgentConfigPatch =
            serde_json::from_value(serde_json::json!({ "providerEnvJson": null })).unwrap();
        assert_eq!(clear.provider_env_json, Some(None));

        let replace: AgentConfigPatch = serde_json::from_value(serde_json::json!({
            "providerEnvJson": "{\"providerId\":\"openrouter\"}"
        }))
        .unwrap();
        assert_eq!(
            replace
                .provider_env_json
                .as_ref()
                .and_then(|v| v.as_deref()),
            Some("{\"providerId\":\"openrouter\"}")
        );
    }

    #[test]
    fn project_runtime_for_provider_preserves_explicit_runtime_when_provider_is_dormant() {
        let (runtime, runtime_config) = project_runtime_for_provider(
            Some("openrouter"),
            Some("anthropic/claude-sonnet-4.6"),
            Some("codex".to_string()),
            Some(serde_json::json!({
                "source": "managed-provider",
                "model": "gpt-5"
            })),
        );

        assert_eq!(runtime.as_deref(), Some("codex"));
        assert!(runtime_config.is_none());
    }

    #[test]
    fn project_runtime_for_provider_preserves_explicit_system_codex_with_dormant_provider() {
        let runtime_config = serde_json::json!({
            "source": "system-cli",
            "permissionMode": "full-auto"
        });
        let (runtime, projected) = project_runtime_for_provider(
            Some(CODEX_SUBSCRIPTION_PROVIDER_ID),
            Some("gpt-5.5-codex"),
            Some("codex".to_string()),
            Some(runtime_config.clone()),
        );

        assert_eq!(runtime.as_deref(), Some("codex"));
        assert_eq!(projected, Some(runtime_config));
    }

    #[test]
    fn project_runtime_for_provider_does_not_let_stale_source_hijack_other_runtime() {
        let runtime_config = serde_json::json!({ "source": "managed-provider" });
        let (runtime, projected) = project_runtime_for_provider(
            Some(CODEX_SUBSCRIPTION_PROVIDER_ID),
            Some("gpt-5.5-codex"),
            Some("claude-code".to_string()),
            Some(runtime_config),
        );

        assert_eq!(runtime.as_deref(), Some("claude-code"));
        assert!(projected.is_none());
    }
}
