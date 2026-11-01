use super::*;

/// Approval callback from IM platform (button click or text command)
pub struct ApprovalCallback {
    pub request_id: String,
    pub decision: String, // "allow_once" | "always_allow" | "deny"
    #[allow(dead_code)]
    pub user_id: String,
}

/// AskUserQuestion callback from IM platform card button or text fallback.
pub struct QuestionCallback {
    /// Zero-based option in a single-choice question (compact platform callbacks).
    pub option_index: Option<usize>,
    pub request_id: String,
    pub answers: Option<HashMap<String, String>>,
    #[allow(dead_code)]
    pub user_id: String,
}

/// Pending approval waiting for user response
#[derive(Clone)]
pub(crate) struct PendingApproval {
    pub(crate) requester_user_id: Option<String>,
    pub(crate) sidecar_port: u16,
    pub(crate) chat_id: String,
    pub(crate) card_message_id: String,
    pub(crate) created_at: Instant,
}

pub(crate) type PendingApprovals = Arc<Mutex<HashMap<String, PendingApproval>>>;

/// Pending structured question waiting for user response.
#[derive(Clone)]
pub(crate) struct PendingQuestion {
    pub(crate) sidecar_port: u16,
    pub(crate) chat_id: String,
    pub(crate) card_message_id: String,
    pub(crate) requester_user_id: Option<String>,
    pub(crate) source_type: ImSourceType,
    pub(crate) questions: Vec<AskUserQuestionItem>,
    pub(crate) created_at: Instant,
}

pub(crate) type PendingQuestions = Arc<Mutex<HashMap<String, PendingQuestion>>>;

/// Per-peer locks: serializes the *enqueue* phase (drift check + ensure_sidecar
/// + POST /api/im/enqueue) per peer_session. Pattern C dropped the lock to
/// ms-level scope — the SSE long-poll consumer in `event_consumer.rs` runs
/// independently per peer_session, decoupling lock duration from turn duration.
pub(crate) type PeerLocks = Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>;

/// Pattern C: per-peer-session reply consumer state. One ImEventConsumer task
/// + ReplyRouter per session_key. The consumer lazily starts on the first
/// /api/im/enqueue for a session_key, and is cancelled when the session_key
/// is no longer active (Sidecar shutdown / peer eviction).
pub(crate) struct ImConsumerHandle {
    pub(crate) retire_when_idle: event_consumer::CancelFlag,
    pub(crate) cancel: event_consumer::CancelFlag,
    pub(crate) reply_router: reply_router::SharedReplyRouter,
    /// Sidecar port the consumer is currently bound to (used to detect Sidecar
    /// rotation — if the port changes, the old consumer must be cancelled
    /// and a new one spawned).
    pub(crate) sidecar_port: u16,
    /// Sidecar session_id this consumer is bound to. Combined with
    /// `sidecar_generation` to uniquely identify the specific sidecar
    /// instance: a remove + recreate under the same session_id (idle
    /// collector preserves session_id, next message rebuilds) gets a
    /// fresh generation, so a stale stop event from the previous
    /// instance no longer matches this entry.
    pub(crate) sidecar_session_id: String,
    /// Sidecar generation at the time the consumer was spawned. Bumped
    /// on every `insert_sidecar`. Match `(sidecar_session_id, sidecar_generation)`
    /// pairs to map broadcast stop events to consumer entries.
    pub(crate) sidecar_generation: u64,
    /// Kept for lifecycle joining; dropping a Tokio handle does not stop its task.
    pub(crate) _join: tauri::async_runtime::JoinHandle<()>,
}

pub(crate) type ImConsumers = Arc<Mutex<HashMap<String, ImConsumerHandle>>>;

/// Admission boundary for model-bound work owned by one IM channel. Proxy
/// reconnect closes the gate, waits for admitted work plus ReplyRouter slots
/// to drain, then uses the normal channel lifecycle.
pub(crate) struct ChannelModelWorkGate {
    accepting: std::sync::atomic::AtomicBool,
    active: std::sync::atomic::AtomicUsize,
}

impl ChannelModelWorkGate {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            accepting: std::sync::atomic::AtomicBool::new(true),
            active: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    pub(crate) fn try_enter(self: &Arc<Self>) -> Option<ChannelModelWorkGuard> {
        use std::sync::atomic::Ordering;

        if !self.accepting.load(Ordering::SeqCst) {
            return None;
        }
        self.active.fetch_add(1, Ordering::SeqCst);
        if self.accepting.load(Ordering::SeqCst) {
            Some(ChannelModelWorkGuard {
                gate: Arc::clone(self),
            })
        } else {
            self.active.fetch_sub(1, Ordering::SeqCst);
            None
        }
    }

    /// Transfer work from another tracked owner (for example ReplyRouter) into
    /// an async finalizer without reopening admission.
    pub(crate) fn begin_handoff(self: &Arc<Self>) -> ChannelModelWorkGuard {
        self.active
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        ChannelModelWorkGuard {
            gate: Arc::clone(self),
        }
    }

    pub(crate) fn try_close(&self) -> bool {
        self.accepting
            .compare_exchange(
                true,
                false,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .is_ok()
    }

    pub(crate) fn reopen(&self) {
        self.accepting
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub(crate) fn active(&self) -> usize {
        self.active.load(std::sync::atomic::Ordering::SeqCst)
    }
}

pub(crate) struct ChannelModelWorkGuard {
    gate: Arc<ChannelModelWorkGate>,
}

impl Drop for ChannelModelWorkGuard {
    fn drop(&mut self) {
        self.gate
            .active
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

use bridge::BridgeAdapter;
use buffer::MessageBuffer;
use dingtalk::DingtalkAdapter;
use feishu::FeishuAdapter;
use group_history::GroupHistoryBuffer;
use health::HealthManager;
use router::SessionRouter;
use telegram::TelegramAdapter;
use types::{GroupActivation, GroupPermission, ImConfig, ImPlatform};

pub(super) fn normalize_runtime_type(runtime: Option<&str>) -> String {
    match runtime {
        Some("dsh") => "dsh".to_string(),
        Some("claude-code") => "claude-code".to_string(),
        Some("codex") => "codex".to_string(),
        _ => "builtin".to_string(),
    }
}

pub(super) fn is_external_runtime_type(runtime: &str) -> bool {
    matches!(runtime, "claude-code" | "codex")
}

pub(super) fn runtime_source_for_runtime(
    runtime: &str,
    runtime_config: Option<&serde_json::Value>,
) -> Option<String> {
    let runtime = normalize_runtime_type(Some(runtime));
    if runtime == "builtin" {
        return None;
    }
    if runtime == "dsh" {
        return Some("integrated".to_string());
    }
    if runtime == "codex"
        && runtime_config
            .and_then(|value| value.get("source"))
            .and_then(serde_json::Value::as_str)
            == Some("managed-provider")
    {
        return Some("managed-provider".to_string());
    }
    Some("system-cli".to_string())
}

pub(super) async fn ensure_sidecar_port_for_command<R: Runtime>(
    router: &Arc<Mutex<SessionRouter>>,
    session_key: &str,
    _desired_runtime: &str,
    _desired_runtime_source: Option<&str>,
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    health: &Arc<HealthManager>,
) -> Result<u16, String> {
    let (port, _) = SessionRouter::ensure_sidecar(router, session_key, app_handle, manager).await?;
    let _ = health::persist_router_active_sessions(health, router, "command-ensure-sidecar").await;
    Ok(port)
}

/// Platform-agnostic adapter enum — avoids dyn dispatch overhead.
pub(crate) enum AnyAdapter {
    Telegram(Arc<TelegramAdapter>),
    Feishu(Arc<FeishuAdapter>),
    Dingtalk(Arc<DingtalkAdapter>),
    Bridge(Arc<BridgeAdapter>),
}

impl AnyAdapter {
    /// Transport identity is supplied by the live adapter, not its installation config.
    pub(crate) fn routing_platform(&self) -> Result<ImPlatform, String> {
        match self {
            Self::Telegram(_) => Ok(ImPlatform::Telegram),
            Self::Feishu(_) => Ok(ImPlatform::Feishu),
            Self::Dingtalk(_) => Ok(ImPlatform::Dingtalk),
            Self::Bridge(adapter) => adapter.routing_platform(),
        }
    }
}

impl adapter::ImAdapter for AnyAdapter {
    async fn peer_names(
        &self,
        targets: &super::peer_names::PeerNameTargets,
    ) -> Vec<super::peer_names::PeerDisplayName> {
        match self {
            Self::Telegram(a) => a.peer_names(targets).await,
            Self::Feishu(a) => a.peer_names(targets).await,
            Self::Dingtalk(a) => a.peer_names(targets).await,
            Self::Bridge(a) => a.peer_names(targets).await,
        }
    }

    async fn verify_connection(&self) -> adapter::AdapterResult<String> {
        match self {
            Self::Telegram(a) => a.verify_connection().await,
            Self::Feishu(a) => a.verify_connection().await,
            Self::Dingtalk(a) => a.verify_connection().await,
            Self::Bridge(a) => a.verify_connection().await,
        }
    }
    async fn register_commands(&self) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => a.register_commands().await,
            Self::Feishu(a) => a.register_commands().await,
            Self::Dingtalk(a) => a.register_commands().await,
            Self::Bridge(a) => a.register_commands().await,
        }
    }
    async fn listen_loop(&self, shutdown_rx: tokio::sync::watch::Receiver<bool>) {
        match self {
            Self::Telegram(a) => a.listen_loop(shutdown_rx).await,
            Self::Feishu(a) => a.listen_loop(shutdown_rx).await,
            Self::Dingtalk(a) => a.listen_loop(shutdown_rx).await,
            Self::Bridge(a) => a.listen_loop(shutdown_rx).await,
        }
    }
    async fn send_message(&self, chat_id: &str, text: &str) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => adapter::ImAdapter::send_message(a.as_ref(), chat_id, text).await,
            Self::Feishu(a) => adapter::ImAdapter::send_message(a.as_ref(), chat_id, text).await,
            Self::Dingtalk(a) => adapter::ImAdapter::send_message(a.as_ref(), chat_id, text).await,
            Self::Bridge(a) => adapter::ImAdapter::send_message(a.as_ref(), chat_id, text).await,
        }
    }
    async fn ack_received(&self, chat_id: &str, message_id: &str) {
        match self {
            Self::Telegram(a) => {
                adapter::ImAdapter::ack_received(a.as_ref(), chat_id, message_id).await
            }
            Self::Feishu(a) => {
                adapter::ImAdapter::ack_received(a.as_ref(), chat_id, message_id).await
            }
            Self::Dingtalk(a) => {
                adapter::ImAdapter::ack_received(a.as_ref(), chat_id, message_id).await
            }
            Self::Bridge(a) => {
                adapter::ImAdapter::ack_received(a.as_ref(), chat_id, message_id).await
            }
        }
    }
    async fn ack_processing(&self, chat_id: &str, message_id: &str) {
        match self {
            Self::Telegram(a) => {
                adapter::ImAdapter::ack_processing(a.as_ref(), chat_id, message_id).await
            }
            Self::Feishu(a) => {
                adapter::ImAdapter::ack_processing(a.as_ref(), chat_id, message_id).await
            }
            Self::Dingtalk(a) => {
                adapter::ImAdapter::ack_processing(a.as_ref(), chat_id, message_id).await
            }
            Self::Bridge(a) => {
                adapter::ImAdapter::ack_processing(a.as_ref(), chat_id, message_id).await
            }
        }
    }
    async fn ack_clear(&self, chat_id: &str, message_id: &str) {
        match self {
            Self::Telegram(a) => {
                adapter::ImAdapter::ack_clear(a.as_ref(), chat_id, message_id).await
            }
            Self::Feishu(a) => adapter::ImAdapter::ack_clear(a.as_ref(), chat_id, message_id).await,
            Self::Dingtalk(a) => {
                adapter::ImAdapter::ack_clear(a.as_ref(), chat_id, message_id).await
            }
            Self::Bridge(a) => adapter::ImAdapter::ack_clear(a.as_ref(), chat_id, message_id).await,
        }
    }
    async fn send_typing(&self, chat_id: &str) {
        match self {
            Self::Telegram(a) => a.send_typing(chat_id).await,
            Self::Feishu(a) => a.send_typing(chat_id).await,
            Self::Dingtalk(a) => a.send_typing(chat_id).await,
            Self::Bridge(a) => a.send_typing(chat_id).await,
        }
    }
}

impl adapter::ImStreamAdapter for AnyAdapter {
    async fn set_reply_delivery_mode(
        &self,
        request_id: &str,
        mode: super::types::ChannelDeliveryMode,
    ) -> adapter::AdapterResult<()> {
        match self {
            Self::Bridge(adapter) => adapter.set_reply_delivery_mode(request_id, mode).await,
            _ => Ok(()),
        }
    }
    async fn send_message_returning_id(
        &self,
        chat_id: &str,
        text: &str,
    ) -> adapter::AdapterResult<Option<String>> {
        match self {
            Self::Telegram(a) => a.send_message_returning_id(chat_id, text).await,
            Self::Feishu(a) => a.send_message_returning_id(chat_id, text).await,
            Self::Dingtalk(a) => a.send_message_returning_id(chat_id, text).await,
            Self::Bridge(a) => a.send_message_returning_id(chat_id, text).await,
        }
    }
    async fn edit_message(
        &self,
        chat_id: &str,
        message_id: &str,
        text: &str,
    ) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => {
                adapter::ImStreamAdapter::edit_message(a.as_ref(), chat_id, message_id, text).await
            }
            Self::Feishu(a) => {
                adapter::ImStreamAdapter::edit_message(a.as_ref(), chat_id, message_id, text).await
            }
            Self::Dingtalk(a) => {
                adapter::ImStreamAdapter::edit_message(a.as_ref(), chat_id, message_id, text).await
            }
            Self::Bridge(a) => {
                adapter::ImStreamAdapter::edit_message(a.as_ref(), chat_id, message_id, text).await
            }
        }
    }
    async fn delete_message(&self, chat_id: &str, message_id: &str) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => {
                adapter::ImStreamAdapter::delete_message(a.as_ref(), chat_id, message_id).await
            }
            Self::Feishu(a) => {
                adapter::ImStreamAdapter::delete_message(a.as_ref(), chat_id, message_id).await
            }
            Self::Dingtalk(a) => {
                adapter::ImStreamAdapter::delete_message(a.as_ref(), chat_id, message_id).await
            }
            Self::Bridge(a) => {
                adapter::ImStreamAdapter::delete_message(a.as_ref(), chat_id, message_id).await
            }
        }
    }
    fn max_message_length(&self) -> usize {
        match self {
            Self::Telegram(a) => a.max_message_length(),
            Self::Feishu(a) => a.max_message_length(),
            Self::Dingtalk(a) => a.max_message_length(),
            Self::Bridge(a) => a.max_message_length(),
        }
    }
    async fn send_approval_card(
        &self,
        chat_id: &str,
        request_id: &str,
        tool_name: &str,
        tool_input: &str,
    ) -> adapter::AdapterResult<Option<String>> {
        match self {
            Self::Telegram(a) => a
                .send_approval_card(chat_id, request_id, tool_name, tool_input)
                .await
                .map_err(|e| e.to_string()),
            Self::Feishu(a) => {
                a.send_approval_card(chat_id, request_id, tool_name, tool_input)
                    .await
            }
            Self::Dingtalk(a) => {
                adapter::ImStreamAdapter::send_approval_card(
                    a.as_ref(),
                    chat_id,
                    request_id,
                    tool_name,
                    tool_input,
                )
                .await
            }
            Self::Bridge(a) => {
                a.send_approval_card(chat_id, request_id, tool_name, tool_input)
                    .await
            }
        }
    }
    async fn update_approval_status(
        &self,
        chat_id: &str,
        message_id: &str,
        status: &str,
    ) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => a
                .update_approval_status(chat_id, message_id, status)
                .await
                .map_err(|e| e.to_string()),
            Self::Feishu(a) => a.update_approval_status(message_id, status).await,
            Self::Dingtalk(a) => {
                adapter::ImStreamAdapter::update_approval_status(
                    a.as_ref(),
                    chat_id,
                    message_id,
                    status,
                )
                .await
            }
            Self::Bridge(a) => {
                adapter::ImStreamAdapter::update_approval_status(
                    a.as_ref(),
                    chat_id,
                    message_id,
                    status,
                )
                .await
            }
        }
    }
    async fn send_question_card(
        &self,
        chat_id: &str,
        payload: &AskUserQuestionPayload,
        source_type: &ImSourceType,
    ) -> adapter::AdapterResult<Option<String>> {
        match self {
            Self::Telegram(a) => {
                adapter::ImStreamAdapter::send_question_card(
                    a.as_ref(),
                    chat_id,
                    payload,
                    source_type,
                )
                .await
            }
            Self::Feishu(a) => a.send_question_card(chat_id, payload, source_type).await,
            Self::Dingtalk(a) => {
                adapter::ImStreamAdapter::send_question_card(
                    a.as_ref(),
                    chat_id,
                    payload,
                    source_type,
                )
                .await
            }
            Self::Bridge(a) => {
                adapter::ImStreamAdapter::send_question_card(
                    a.as_ref(),
                    chat_id,
                    payload,
                    source_type,
                )
                .await
            }
        }
    }
    async fn update_question_status(
        &self,
        chat_id: &str,
        message_id: &str,
        status: &str,
    ) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => {
                adapter::ImStreamAdapter::update_question_status(
                    a.as_ref(),
                    chat_id,
                    message_id,
                    status,
                )
                .await
            }
            Self::Feishu(a) => a.update_question_status(message_id, status).await,
            Self::Dingtalk(a) => {
                adapter::ImStreamAdapter::update_question_status(
                    a.as_ref(),
                    chat_id,
                    message_id,
                    status,
                )
                .await
            }
            Self::Bridge(a) => {
                adapter::ImStreamAdapter::update_question_status(
                    a.as_ref(),
                    chat_id,
                    message_id,
                    status,
                )
                .await
            }
        }
    }
    async fn send_photo(
        &self,
        chat_id: &str,
        data: Vec<u8>,
        filename: &str,
        caption: Option<&str>,
    ) -> adapter::AdapterResult<Option<String>> {
        match self {
            Self::Telegram(a) => a.send_photo(chat_id, data, filename, caption).await,
            Self::Feishu(a) => a.send_photo(chat_id, data, filename, caption).await,
            Self::Dingtalk(a) => a.send_photo(chat_id, data, filename, caption).await,
            Self::Bridge(a) => a.send_photo(chat_id, data, filename, caption).await,
        }
    }
    async fn send_file(
        &self,
        chat_id: &str,
        data: Vec<u8>,
        filename: &str,
        mime_type: &str,
        caption: Option<&str>,
    ) -> adapter::AdapterResult<Option<String>> {
        match self {
            Self::Telegram(a) => {
                a.send_file(chat_id, data, filename, mime_type, caption)
                    .await
            }
            Self::Feishu(a) => {
                a.send_file(chat_id, data, filename, mime_type, caption)
                    .await
            }
            Self::Dingtalk(a) => {
                a.send_file(chat_id, data, filename, mime_type, caption)
                    .await
            }
            Self::Bridge(a) => {
                a.send_file(chat_id, data, filename, mime_type, caption)
                    .await
            }
        }
    }
    async fn finalize_message(
        &self,
        chat_id: &str,
        message_id: &str,
        text: &str,
    ) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => a.finalize_message(chat_id, message_id, text).await,
            Self::Feishu(a) => a.finalize_message(chat_id, message_id, text).await,
            Self::Dingtalk(a) => a.finalize_message(chat_id, message_id, text).await,
            Self::Bridge(a) => a.finalize_message(chat_id, message_id, text).await,
        }
    }
    fn use_draft_streaming(&self) -> bool {
        match self {
            Self::Telegram(a) => a.use_draft_streaming(),
            Self::Feishu(a) => a.use_draft_streaming(),
            Self::Dingtalk(a) => a.use_draft_streaming(),
            Self::Bridge(a) => a.use_draft_streaming(),
        }
    }
    fn preferred_throttle_ms(&self) -> u64 {
        match self {
            Self::Telegram(a) => a.preferred_throttle_ms(),
            Self::Feishu(a) => a.preferred_throttle_ms(),
            Self::Dingtalk(a) => a.preferred_throttle_ms(),
            Self::Bridge(a) => a.preferred_throttle_ms(),
        }
    }
    fn supports_edit(&self) -> bool {
        match self {
            Self::Telegram(a) => a.supports_edit(),
            Self::Feishu(a) => a.supports_edit(),
            Self::Dingtalk(a) => a.supports_edit(),
            Self::Bridge(a) => a.supports_edit(),
        }
    }
    fn bridge_context(&self) -> Option<(u16, String, Vec<String>)> {
        match self {
            Self::Telegram(a) => a.bridge_context(),
            Self::Feishu(a) => a.bridge_context(),
            Self::Dingtalk(a) => a.bridge_context(),
            Self::Bridge(a) => a.bridge_context(),
        }
    }
    async fn start_reply_dispatch(&self, request_id: &str) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => a.start_reply_dispatch(request_id).await,
            Self::Feishu(a) => a.start_reply_dispatch(request_id).await,
            Self::Dingtalk(a) => a.start_reply_dispatch(request_id).await,
            Self::Bridge(a) => a.start_reply_dispatch(request_id).await,
        }
    }
    async fn start_reply_stream(
        &self,
        request_id: &str,
        chat_id: &str,
        initial_text: &str,
    ) -> adapter::AdapterResult<String> {
        match self {
            Self::Telegram(a) => {
                a.start_reply_stream(request_id, chat_id, initial_text)
                    .await
            }
            Self::Feishu(a) => {
                a.start_reply_stream(request_id, chat_id, initial_text)
                    .await
            }
            Self::Dingtalk(a) => {
                a.start_reply_stream(request_id, chat_id, initial_text)
                    .await
            }
            Self::Bridge(a) => {
                a.start_reply_stream(request_id, chat_id, initial_text)
                    .await
            }
        }
    }
    async fn update_reply_stream(
        &self,
        stream_id: &str,
        text: &str,
        sequence: u32,
        is_thinking: bool,
    ) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => {
                a.update_reply_stream(stream_id, text, sequence, is_thinking)
                    .await
            }
            Self::Feishu(a) => {
                a.update_reply_stream(stream_id, text, sequence, is_thinking)
                    .await
            }
            Self::Dingtalk(a) => {
                a.update_reply_stream(stream_id, text, sequence, is_thinking)
                    .await
            }
            Self::Bridge(a) => {
                a.update_reply_stream(stream_id, text, sequence, is_thinking)
                    .await
            }
        }
    }
    async fn finish_reply_stream_block(&self, stream_id: &str) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => a.finish_reply_stream_block(stream_id).await,
            Self::Feishu(a) => a.finish_reply_stream_block(stream_id).await,
            Self::Dingtalk(a) => a.finish_reply_stream_block(stream_id).await,
            Self::Bridge(a) => a.finish_reply_stream_block(stream_id).await,
        }
    }
    async fn complete_reply_dispatch(
        &self,
        request_id: &str,
        final_payloads: &serde_json::Value,
    ) -> adapter::AdapterResult<adapter::ReplyDispatchAdmission> {
        match self {
            Self::Telegram(a) => a.complete_reply_dispatch(request_id, final_payloads).await,
            Self::Feishu(a) => a.complete_reply_dispatch(request_id, final_payloads).await,
            Self::Dingtalk(a) => a.complete_reply_dispatch(request_id, final_payloads).await,
            Self::Bridge(a) => a.complete_reply_dispatch(request_id, final_payloads).await,
        }
    }
    async fn abort_reply_dispatch(
        &self,
        request_id: &str,
        reason: &str,
        terminal_payload: &serde_json::Value,
    ) -> adapter::AdapterResult<adapter::ReplyDispatchAdmission> {
        match self {
            Self::Telegram(a) => {
                a.abort_reply_dispatch(request_id, reason, terminal_payload)
                    .await
            }
            Self::Feishu(a) => {
                a.abort_reply_dispatch(request_id, reason, terminal_payload)
                    .await
            }
            Self::Dingtalk(a) => {
                a.abort_reply_dispatch(request_id, reason, terminal_payload)
                    .await
            }
            Self::Bridge(a) => {
                a.abort_reply_dispatch(request_id, reason, terminal_payload)
                    .await
            }
        }
    }
    fn supports_streaming(&self) -> bool {
        match self {
            Self::Telegram(a) => a.supports_streaming(),
            Self::Feishu(a) => a.supports_streaming(),
            Self::Dingtalk(a) => a.supports_streaming(),
            Self::Bridge(a) => a.supports_streaming(),
        }
    }
    async fn start_stream(
        &self,
        chat_id: &str,
        initial_text: &str,
    ) -> adapter::AdapterResult<String> {
        match self {
            Self::Telegram(a) => a.start_stream(chat_id, initial_text).await,
            Self::Feishu(a) => a.start_stream(chat_id, initial_text).await,
            Self::Dingtalk(a) => a.start_stream(chat_id, initial_text).await,
            Self::Bridge(a) => a.start_stream(chat_id, initial_text).await,
        }
    }
    async fn stream_chunk(
        &self,
        chat_id: &str,
        stream_id: &str,
        text: &str,
        sequence: u32,
        is_thinking: bool,
    ) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => {
                a.stream_chunk(chat_id, stream_id, text, sequence, is_thinking)
                    .await
            }
            Self::Feishu(a) => {
                a.stream_chunk(chat_id, stream_id, text, sequence, is_thinking)
                    .await
            }
            Self::Dingtalk(a) => {
                a.stream_chunk(chat_id, stream_id, text, sequence, is_thinking)
                    .await
            }
            Self::Bridge(a) => {
                a.stream_chunk(chat_id, stream_id, text, sequence, is_thinking)
                    .await
            }
        }
    }
    async fn finalize_stream(
        &self,
        chat_id: &str,
        stream_id: &str,
        final_text: &str,
    ) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => a.finalize_stream(chat_id, stream_id, final_text).await,
            Self::Feishu(a) => a.finalize_stream(chat_id, stream_id, final_text).await,
            Self::Dingtalk(a) => a.finalize_stream(chat_id, stream_id, final_text).await,
            Self::Bridge(a) => a.finalize_stream(chat_id, stream_id, final_text).await,
        }
    }
    async fn abort_stream(&self, chat_id: &str, stream_id: &str) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => a.abort_stream(chat_id, stream_id).await,
            Self::Feishu(a) => a.abort_stream(chat_id, stream_id).await,
            Self::Dingtalk(a) => a.abort_stream(chat_id, stream_id).await,
            Self::Bridge(a) => a.abort_stream(chat_id, stream_id).await,
        }
    }
    async fn post_stream_cleanup(&self, chat_id: &str) {
        match self {
            Self::Telegram(_) | Self::Feishu(_) | Self::Bridge(_) => { /* no-op */ }
            Self::Dingtalk(a) => {
                adapter::ImStreamAdapter::post_stream_cleanup(a.as_ref(), chat_id).await
            }
        }
    }
}

/// Managed state for the IM Bot subsystem (multi-bot: bot_id → instance)
pub type ManagedImBots = Arc<Mutex<HashMap<String, ImBotInstance>>>;

/// Running IM Bot instance
pub struct ImBotInstance {
    #[allow(dead_code)]
    pub(crate) bot_id: String,
    #[allow(dead_code)]
    pub(crate) platform: ImPlatform,
    pub(super) shutdown_tx: watch::Sender<bool>,
    pub(crate) health: Arc<HealthManager>,
    pub(crate) router: Arc<Mutex<SessionRouter>>,
    /// Existing per-peer enqueue fence, also reused by explicit binding
    /// mutations so desktop migration cannot race `/new` or a normal IM turn.
    pub(crate) peer_locks: PeerLocks,
    pub(crate) im_consumers: ImConsumers,
    /// Covers enqueue setup, heartbeat turns, cron hand-off, and terminal
    /// finalization across a proxy-triggered transport restart boundary.
    pub(crate) model_work_gate: Arc<ChannelModelWorkGate>,
    pub(super) buffer: Arc<Mutex<MessageBuffer>>,
    pub(super) started_at: Instant,
    /// JoinHandle for the message processing loop (awaited during graceful shutdown)
    pub(super) process_handle: tauri::async_runtime::JoinHandle<()>,
    /// JoinHandle for the platform listen loop (long-poll / WebSocket)
    pub(super) poll_handle: tauri::async_runtime::JoinHandle<()>,
    /// JoinHandle for the approval callback handler
    pub(super) approval_handle: tauri::async_runtime::JoinHandle<()>,
    /// JoinHandle for the AskUserQuestion callback handler
    pub(super) question_handle: tauri::async_runtime::JoinHandle<()>,
    /// JoinHandle for the health persist loop
    pub(super) health_handle: tauri::async_runtime::JoinHandle<()>,
    /// Random bind code for QR code binding flow
    pub(super) bind_code: String,
    #[allow(dead_code)]
    pub(crate) config: ImConfig,
    // ===== Heartbeat (v0.1.21) =====
    /// Heartbeat runner background task handle
    pub(super) heartbeat_handle: Option<tauri::async_runtime::JoinHandle<()>>,
    /// Channel to send wake signals to heartbeat runner
    pub heartbeat_wake_tx: Option<mpsc::Sender<types::HeartbeatWake>>,
    /// Shared heartbeat config (for hot updates)
    pub(super) heartbeat_config: Option<Arc<tokio::sync::RwLock<types::HeartbeatConfig>>>,
    /// Pending cron-completion events waiting to be relayed to IM (v0.2.4).
    /// Source of truth for cron→IM hand-off: `deliver_cron_result_to_bot` pushes
    /// here, the heartbeat runner ships a snapshot to the sidecar via heartbeat
    /// HTTP body, then clears the snapshot only after `push_text_preferring_stream`
    /// confirms the IM platform accepted the relay text. Survives sidecar
    /// process restarts (queue lives in Rust, not in the Node sidecar's memory).
    /// Shared with the heartbeat runner via Arc clone — both sides hold the same
    /// Vec, so deliver-side appends are visible to the runner without any IPC.
    pub pending_cron_events: Arc<Mutex<Vec<types::PendingCronEvent>>>,
    /// JoinHandle for the sidecar-stop subscriber loop. Coupled to the bot
    /// lifecycle: on bot shutdown the watch flag flips and this task exits.
    /// Held here (not detached) so a forced bot drop can't leak it; also
    /// explicitly aborted + awaited in `shutdown_bot_instance` for prompt
    /// teardown.
    pub(super) sidecar_stop_handle: tauri::async_runtime::JoinHandle<()>,
    /// Platform adapter (retained for graceful shutdown — e.g. dedup flush)
    pub(crate) adapter: Arc<AnyAdapter>,
    /// Bridge process handle (OpenClaw plugins only)
    pub(super) bridge_process: Option<tokio::sync::Mutex<bridge::BridgeProcess>>,
    // ===== Hot-reloadable config =====
    pub(crate) current_model: Arc<tokio::sync::RwLock<Option<String>>>,
    pub(crate) current_provider_env: Arc<tokio::sync::RwLock<Option<serde_json::Value>>>,
    pub(crate) permission_mode: Arc<tokio::sync::RwLock<String>>,
    pub(crate) mcp_servers_json: Arc<tokio::sync::RwLock<Option<String>>>,
    pub(crate) runtime: Arc<tokio::sync::RwLock<String>>,
    pub(crate) runtime_config: Arc<tokio::sync::RwLock<Option<serde_json::Value>>>,
    pub(crate) allowed_users: Arc<tokio::sync::RwLock<Vec<String>>>,
    // ===== Group Chat (v0.1.28) =====
    pub(crate) group_permissions: Arc<tokio::sync::RwLock<Vec<GroupPermission>>>,
    pub(crate) group_activation: Arc<tokio::sync::RwLock<GroupActivation>>,
    pub(crate) group_tools_deny: Arc<tokio::sync::RwLock<Vec<String>>>,
    pub(crate) group_history: Arc<Mutex<GroupHistoryBuffer>>,
    // ===== Agent link (v0.1.41) =====
    /// Set after the bot is moved into an AgentInstance; the processing loop sees updates via Arc.
    pub(crate) agent_link: SharedAgentLink,
}

impl ImBotInstance {
    /// Read-only lifecycle authority for projections outside the IM module.
    /// Callers snapshot the Instant under the registry lock, then calculate
    /// elapsed time without holding that lock across awaits.
    pub(crate) fn started_at(&self) -> Instant {
        self.started_at
    }
}

// ===== Agent Architecture (v0.1.41) =====

use types::{AgentConfigRust, LastActiveChannel, LastActivePrivateTarget};

/// Info linking an ImBotInstance back to its parent Agent (set after moving into AgentInstance).
/// The processing loop holds a clone of this Arc; writing to it after spawn is visible to the task.
#[derive(Clone)]
pub(crate) struct AgentChannelLink {
    pub channel_id: String,
    pub agent_id: String,
    /// Shared with `AgentInstance.last_active_channel` — the processing loop writes here.
    pub last_active_channel: Arc<RwLock<Option<LastActiveChannel>>>,
    /// Shared with `AgentInstance.last_active_private_target` — private-only HB target.
    pub last_active_private_target: Arc<RwLock<Option<LastActivePrivateTarget>>>,
}

/// Shared, write-after-spawn link — the processing loop reads this via Arc.
pub(crate) type SharedAgentLink = Arc<RwLock<Option<AgentChannelLink>>>;

/// Running Channel instance within an Agent
pub struct ChannelInstance {
    pub channel_id: String,
    /// The underlying ImBotInstance that does the actual work
    /// (reuses existing infrastructure — adapter, router, buffer, health, etc.)
    pub bot_instance: ImBotInstance,
}

/// Running Agent instance (holds multiple ChannelInstances)
pub struct AgentInstance {
    pub agent_id: String,
    pub config: AgentConfigRust,
    pub channels: HashMap<String, ChannelInstance>,
    pub last_active_channel: Arc<tokio::sync::RwLock<Option<LastActiveChannel>>>,
    pub last_active_private_target: Arc<tokio::sync::RwLock<Option<LastActivePrivateTarget>>>,
    // Agent-level heartbeat (shared across channels)
    pub heartbeat_handle: Option<tauri::async_runtime::JoinHandle<()>>,
    pub heartbeat_wake_tx: Option<mpsc::Sender<types::WakeReason>>,
    pub heartbeat_config: Option<Arc<tokio::sync::RwLock<types::HeartbeatConfig>>>,
    // Agent-level hot-reloadable AI config (shared defaults)
    pub current_model: Arc<tokio::sync::RwLock<Option<String>>>,
    pub current_provider_env: Arc<tokio::sync::RwLock<Option<serde_json::Value>>>,
    pub permission_mode: Arc<tokio::sync::RwLock<String>>,
    pub mcp_servers_json: Arc<tokio::sync::RwLock<Option<String>>>,
    // Raw Agent default. Effective runtime identity belongs to each Channel.
    pub runtime_config: Arc<tokio::sync::RwLock<Option<serde_json::Value>>>,
    // Long-term memory evolution (v0.2.49)
    pub memory_evolution_config:
        Option<Arc<tokio::sync::RwLock<Option<types::MemoryEvolutionConfig>>>>,
}

/// Managed state for the Agent subsystem (agent_id → instance)
pub type ManagedAgents = Arc<Mutex<HashMap<String, AgentInstance>>>;

/// Create the managed Agent state (called during app setup)
pub fn create_agent_state() -> ManagedAgents {
    Arc::new(Mutex::new(HashMap::new()))
}

#[cfg(test)]
mod tests {
    use super::runtime_source_for_runtime;

    #[test]
    fn runtime_source_projection_keeps_dsh_integrated_and_external_cli_explicit() {
        assert_eq!(
            runtime_source_for_runtime("dsh", None).as_deref(),
            Some("integrated"),
        );
        assert_eq!(
            runtime_source_for_runtime(
                "codex",
                Some(&serde_json::json!({ "source": "managed-provider" })),
            )
            .as_deref(),
            Some("managed-provider"),
        );
        assert_eq!(
            runtime_source_for_runtime("claude-code", None).as_deref(),
            Some("system-cli"),
        );
        assert_eq!(runtime_source_for_runtime("builtin", None), None);
    }
}

/// Signal all running agents and release their process owners (sync, app exit only).
pub fn signal_all_agents_shutdown(agent_state: &ManagedAgents) {
    let mut agents = agent_state.blocking_lock();
    for (agent_id, instance) in agents.iter() {
        ulog_info!("[agent] Signaling shutdown for agent {}", agent_id);
        for (channel_id, ch) in &instance.channels {
            ulog_info!(
                "[agent] Shutting down channel {} of agent {}",
                channel_id,
                agent_id
            );
            let _ = ch.bot_instance.shutdown_tx.send(true);
            ch.bot_instance.poll_handle.abort();
            ch.bot_instance.process_handle.abort();
            ch.bot_instance.approval_handle.abort();
            ch.bot_instance.question_handle.abort();
            ch.bot_instance.health_handle.abort();
            if let Some(ref h) = ch.bot_instance.heartbeat_handle {
                h.abort();
            }
        }
        if let Some(ref h) = instance.heartbeat_handle {
            h.abort();
        }
    }
    // ExitRequested is terminal for this app instance. Dropping the map also
    // drops every retained Plugin Bridge ChildTree, initiating exact tree
    // termination before the process-exit settlement barrier.
    agents.clear();
}

/// Create the managed IM Bot state (called during app setup)
pub fn create_im_bot_state() -> ManagedImBots {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Signal all running IM bots and release their process owners (app exit only).
pub fn signal_all_bots_shutdown(im_state: &ManagedImBots) {
    let mut bots = im_state.blocking_lock();
    for (bot_id, instance) in bots.iter() {
        ulog_info!("[im] Signaling shutdown for bot {}", bot_id);
        let _ = instance.shutdown_tx.send(true);
        instance.poll_handle.abort();
        instance.process_handle.abort();
        instance.approval_handle.abort();
        instance.question_handle.abort();
        instance.health_handle.abort();
        if let Some(ref h) = instance.heartbeat_handle {
            h.abort();
        }
    }
    bots.clear();
}
