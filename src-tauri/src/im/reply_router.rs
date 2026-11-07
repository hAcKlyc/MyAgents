#![allow(dead_code)] // Wired up in Pattern C-6 (mod.rs spawn refactor).
                     // IM Pipeline v2 — Pattern C: ReplyRouter
                     //
                     // Per peer_session reply state machine. Replaces the per-request SSE consumer
                     // that lived inside `stream_to_im` (legacy /api/im/chat path). For each
                     // in-flight requestId, holds a `ReplySlot` capturing block-text accumulator,
                     // draft / placeholder message IDs, and stream protocol state. Events arrive
                     // from `ImEventConsumer` (which long-polls /api/im/events), get routed by
                     // requestId, mutate the slot, then dispatch the appropriate adapter call
                     // (send / edit / finalize / abort).
                     //
                     // Architectural note: ReplyRouter is owned by a single `ImEventConsumer`
                     // task, so event-to-adapter handoff is naturally ordered. Native adapters
                     // perform their platform I/O here. OpenClaw adapters only await the Bridge's
                     // enqueue ACK; the plugin-owned dispatcher performs renderer/platform I/O on
                     // its own per-request queue. The "concurrent in-flight requests" win comes
                     // from request-scoped ownership, not from parallelizing this router.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::adapter::{self, ImStreamAdapter};
use super::types::{AskUserQuestionPayload, ImDeliveryProtocol, ImSourceType};
use super::{
    finalize_block, format_draft_text, has_sentence_boundary, GroupStreamContext, PendingApproval,
    PendingApprovals, PendingQuestion, PendingQuestions, THINKING_PLACEHOLDER,
};
use crate::{ulog_error, ulog_info, ulog_warn};

fn terminal_text(data: Option<&Value>) -> Option<&str> {
    data.and_then(|value| {
        value.as_str().or_else(|| {
            value
                .get("finalPayloads")
                .and_then(Value::as_array)
                .and_then(|payloads| payloads.first())
                .and_then(|payload| payload.get("text"))
                .and_then(Value::as_str)
        })
    })
}

/// Each admission has a unique lease, so late cleanup can never release a
/// newly registered request's owner (even in the same process generation).
struct ReplyLease {
    manager: crate::sidecar::ManagedSidecarManager,
    session_id: String,
    owner: Option<crate::sidecar::SidecarOwner>,
}

impl Drop for ReplyLease {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            crate::sidecar::schedule_release_session_sidecar(
                self.manager.clone(),
                self.session_id.clone(),
                owner,
            );
        }
    }
}

struct ReplyLifecycle {
    cancel: super::event_consumer::CancelFlag,
    manager: crate::sidecar::ManagedSidecarManager,
    session_id: String,
    generation: u64,
}

/// Per-requestId reply state. Mirrors the locals previously declared at the
/// top of `stream_to_im` / `stream_to_im_streaming`. One slot per in-flight
/// IM user message.
pub struct ReplySlot {
    pub delivery_mode: super::types::ChannelDeliveryMode,
    policy_admitted: bool,
    pub request_id: String,
    pub chat_id: String,
    /// Original IM message_id — used by adapter.ack_clear() on terminal.
    pub message_id: String,
    pub source_type: ImSourceType,
    pub requester_user_id: Option<String>,
    pub delivery_protocol: Option<ImDeliveryProtocol>,
    /// Whether the request is in group "always" mode (for NO_REPLY detection).
    pub group_activation_always: bool,

    // ── Edit-based protocol state (Telegram, Feishu, Dingtalk basic, Bridge) ──
    pub block_text: String,
    pub draft_id: Option<String>,
    pub last_edit: Instant,
    pub any_text_sent: bool,
    pub placeholder_id: Option<String>,
    pub first_content_sent: bool,
    pub last_block_text: String,

    // ── Streaming protocol state (Dingtalk AI Card / supports_streaming) ──
    pub stream_id: Option<String>,
    pub sequence: u32,
    pub reply_dispatch_started: bool,

    // Result session_id (carried out via 'complete' event for the caller)
    pub completed_session_id: Option<String>,
    /// Whether reply settlement is finished. A producer terminal alone does
    /// not finish an OpenClaw slot until the Bridge acknowledges its handoff.
    pub is_done: bool,
    interaction_ids: Vec<String>,
    _lease: Option<ReplyLease>,
    admission_finished: bool,
    terminal_callback_claimed: bool,
    producer_terminal: Option<Value>,
}

impl ReplySlot {
    pub fn new(
        request_id: String,
        chat_id: String,
        message_id: String,
        source_type: ImSourceType,
        requester_user_id: Option<String>,
        group_activation_always: bool,
        delivery_protocol: Option<ImDeliveryProtocol>,
    ) -> Self {
        Self {
            delivery_mode: super::types::ChannelDeliveryMode::Auto,
            policy_admitted: false,
            request_id,
            chat_id,
            message_id,
            source_type,
            requester_user_id,
            delivery_protocol,
            group_activation_always,
            block_text: String::new(),
            draft_id: None,
            last_edit: Instant::now(),
            any_text_sent: false,
            placeholder_id: None,
            first_content_sent: false,
            last_block_text: String::new(),
            stream_id: None,
            sequence: 0,
            reply_dispatch_started: false,
            completed_session_id: None,
            is_done: false,
            interaction_ids: Vec::new(),
            _lease: None,
            admission_finished: false,
            terminal_callback_claimed: false,
            producer_terminal: None,
        }
    }
}

/// Per peer_session reply dispatcher. Maps requestId → slot, processes events
/// from /api/im/events, calls adapter to render content. Owned by ImEventConsumer.
pub struct ReplyRouter {
    slots: HashMap<String, ReplySlot>,
    lifecycle: Option<ReplyLifecycle>,
    pending_approvals: PendingApprovals,
    pending_questions: PendingQuestions,
}

impl ReplyRouter {
    pub(crate) fn new(
        pending_approvals: PendingApprovals,
        pending_questions: PendingQuestions,
    ) -> Self {
        Self {
            slots: HashMap::new(),
            lifecycle: None,
            pending_approvals,
            pending_questions,
        }
    }

    /// Pre-register a slot when /api/im/enqueue accepts the request.
    /// If a slot already exists (rare race — re-enqueue), it's preserved.
    pub(crate) fn register(
        &mut self,
        request_id: String,
        chat_id: String,
        message_id: String,
        source_type: ImSourceType,
        requester_user_id: Option<String>,
        group_ctx: Option<&GroupStreamContext>,
        delivery_protocol: Option<ImDeliveryProtocol>,
    ) -> bool {
        if self
            .lifecycle
            .as_ref()
            .is_some_and(|lifecycle| lifecycle.cancel.load(std::sync::atomic::Ordering::SeqCst))
        {
            return false;
        }
        if self.slots.contains_key(&request_id) {
            return true;
        }
        let group_activation_always = matches!(
            group_ctx.map(|g| &g.activation),
            Some(super::types::GroupActivation::Always),
        );
        let mut slot = ReplySlot::new(
            request_id.clone(),
            chat_id,
            message_id,
            source_type,
            requester_user_id,
            group_activation_always,
            delivery_protocol,
        );
        if let Some(lifecycle) = &self.lifecycle {
            let owner = crate::sidecar::SidecarOwner::BackgroundCompletion(format!(
                "im-reply:{}",
                uuid::Uuid::new_v4()
            ));
            let mut manager = lifecycle.manager.lock().unwrap_or_else(|e| e.into_inner());
            if !manager.add_session_owner_to_generation(
                &lifecycle.session_id,
                lifecycle.generation,
                owner.clone(),
            ) {
                return false;
            }
            slot._lease = Some(ReplyLease {
                manager: lifecycle.manager.clone(),
                session_id: lifecycle.session_id.clone(),
                owner: Some(owner),
            });
        }
        self.slots.insert(request_id, slot);
        true
    }

    pub(crate) fn set_pending_delivery_mode(
        &mut self,
        request_id: &str,
        mode: super::types::ChannelDeliveryMode,
    ) {
        if let Some(slot) = self.slots.get_mut(request_id) {
            if !slot.policy_admitted && slot.producer_terminal.is_none() {
                slot.delivery_mode = mode;
            }
        }
    }

    /// Dispatch a single event from /api/im/events to the matching slot.
    ///
    /// Returns `Some(TerminalOutcome)` when the slot reaches a terminal state
    /// (caller can use this to record session_id, etc.). Returns `None` when
    /// the slot stays alive. Post-stream hooks (ack_clear + post_stream_cleanup)
    /// fire automatically on terminal so callers don't repeat the dance.
    pub async fn dispatch<A: ImStreamAdapter>(
        &mut self,
        event: &Value,
        adapter: &A,
        sidecar_port: u16,
    ) -> Option<TerminalOutcome> {
        // Bus events have shape: { seq, requestId, type, data, ts }
        let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");

        // C7 fix: session-level events (requestId=null) MUST be handled before the
        // requestId-scoped routing below. The legacy code returned None on null
        // requestId, silently dropping `gap` (eviction / cross-generation reset)
        // and any future system-wide events the bus introduces.
        let request_id_opt = event.get("requestId").and_then(|v| v.as_str());
        if request_id_opt.is_none() || request_id_opt == Some("") {
            self.handle_session_event(event_type, event, adapter).await;
            return None;
        }
        let request_id = request_id_opt.unwrap().to_string();

        if !self.slots.contains_key(&request_id) {
            ulog_warn!(
                "[reply-router] Dropped event for unregistered requestId={} type={}",
                request_id,
                event_type,
            );
            return None;
        }

        let (chat_id, message_id, already_done) = {
            let slot = self.slots.get(&request_id).expect("checked above");
            (slot.chat_id.clone(), slot.message_id.clone(), slot.is_done)
        };
        if already_done {
            return None;
        }
        let uses_openclaw_reply = self.uses_idempotent_terminal(&request_id);
        let is_terminal = matches!(event_type, "complete" | "error" | "cancelled");
        if uses_openclaw_reply
            && self.producer_terminal(&request_id).is_some()
            && !is_terminal
        {
            // Late partial/policy/interaction events cannot reopen an already
            // terminal execution while its original handoff is being recovered.
            return None;
        }
        // Preserve producer authority before any cancellable delivery await.
        // Shutdown may interrupt transport, but cannot replace this outcome.
        if matches!(event_type, "complete" | "error" | "cancelled") {
            self.slots
                .get_mut(&request_id)?
                .producer_terminal
                .get_or_insert_with(|| event.clone());
        }
        // Retried receipts (including a later registry-expired error) must
        // never replace the original outcome, payload or delivery policy.
        let retained_terminal = if uses_openclaw_reply && is_terminal {
            self.producer_terminal(&request_id).cloned()
        } else {
            None
        };
        let event = retained_terminal.as_ref().unwrap_or(event);
        let event_type = event["type"].as_str().unwrap_or("");

        if let Some(mode) = event
            .get("channelDeliveryMode")
            .and_then(|value| serde_json::from_value(value.clone()).ok())
        {
            let slot = self.slots.get_mut(&request_id)?;
            slot.delivery_mode = mode;
        }
        if event_type == "delivery-policy" {
            let slot = self.slots.get_mut(&request_id)?;
            if !slot.policy_admitted {
                slot.policy_admitted = true;
                if matches!(
                    slot.delivery_protocol,
                    Some(ImDeliveryProtocol::OpenClawReply)
                ) {
                    if let Err(error) = adapter
                        .set_reply_delivery_mode(&request_id, slot.delivery_mode)
                        .await
                    {
                        ulog_error!(
                            "[reply-router] delivery policy rejected requestId={}: {}",
                            request_id,
                            error
                        );
                    }
                }
                if slot.delivery_mode.allows_automatic() {
                    adapter.ack_processing(&chat_id, &message_id).await;
                    adapter.send_typing(&chat_id).await;
                }
            }
            return None;
        }
        if !self
            .slots
            .get(&request_id)?
            .delivery_mode
            .allows_automatic()
            && !matches!(
                event_type,
                "permission-request" | "ask-user-question-request" | "ask-user-question-expired"
            )
        {
            if matches!(event_type, "complete" | "error" | "cancelled") {
                let slot = self.slots.get_mut(&request_id)?;
                if matches!(
                    slot.delivery_protocol,
                    Some(ImDeliveryProtocol::OpenClawReply)
                ) {
                    return self.dispatch_openclaw_terminal(event, &request_id, adapter).await;
                }
                slot.is_done = true;
                return Some(TerminalOutcome {
                    session_id: event
                        .pointer("/data/sessionId")
                        .and_then(Value::as_str)
                        .map(String::from),
                    silent: true,
                });
            }
            return None;
        }

        // The producer's explicit empty terminal is a lifecycle receipt, for
        // example an IM input merged into an already replying runtime turn.
        // Do not manufacture a second "No response"/error/cancelled message.
        // Legacy terminals without finalPayloads still use the old fallback.
        let empty_terminal = matches!(event_type, "complete" | "error" | "cancelled")
            && event
                .pointer("/data/finalPayloads")
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty);
        if !uses_openclaw_reply && empty_terminal {
            let slot = self.slots.get_mut(&request_id)?;
            if !slot.any_text_sent && slot.block_text.is_empty() && slot.stream_id.is_none() {
                if let Some(id) = slot.placeholder_id.take() {
                    let _ = adapter.delete_message(&chat_id, &id).await;
                }
                if let Some(id) = slot.draft_id.take() {
                    let _ = adapter.delete_message(&chat_id, &id).await;
                }
                slot.is_done = true;
                adapter.post_stream_cleanup(&chat_id).await;
                adapter::ImAdapter::ack_clear(adapter, &chat_id, &message_id).await;
                return Some(TerminalOutcome {
                    session_id: None,
                    silent: true,
                });
            }
        }
        if !uses_openclaw_reply && event_type == "complete" && event["reconciled"] == true {
            // A receipt may replace missing deltas. Never finalize a stale
            // partial as the whole answer; use producer-owned canonical text.
            let text = event
                .pointer("/data/finalPayloads")
                .and_then(Value::as_array)
                .map(|payloads| {
                    payloads
                        .iter()
                        .filter_map(|p| p["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n\n")
                });
            if let Some(text) = text.filter(|text| !text.is_empty()) {
                let slot = self.slots.get_mut(&request_id)?;
                if text != slot.last_block_text {
                    slot.block_text = text.clone();
                    slot.last_block_text = text;
                }
            }
        }
        let outcome = if uses_openclaw_reply {
            self.dispatch_openclaw_reply(event_type, event, &request_id, adapter, sidecar_port)
                .await
        } else if adapter.supports_streaming() {
            self.dispatch_streaming(event_type, event, &request_id, adapter, sidecar_port)
                .await
        } else {
            self.dispatch_edit_based(event_type, event, &request_id, adapter, sidecar_port)
                .await
        };

        // Pattern C: terminal cleanup hooks. Fire AFTER inner dispatch completes
        // (slot is_done set, last edit/finalize already done) and BEFORE the
        // caller unregister + on_terminal callback runs. Keeps the protocol-
        // specific cleanup (DingTalk AI Card finalize) and ACK reaction clear
        // in one place — adapter calls can be retired later without touching
        // every call site.
        if outcome.is_some() {
            if !uses_openclaw_reply {
                adapter.post_stream_cleanup(&chat_id).await;
            }
            adapter::ImAdapter::ack_clear(adapter, &chat_id, &message_id).await;
        }

        outcome
    }

    async fn handle_question_request<A: ImStreamAdapter>(
        &mut self,
        event: &Value,
        request_id: &str,
        adapter: &A,
        sidecar_port: u16,
    ) {
        let Some(slot) = self.slots.get(request_id) else {
            return;
        };
        let raw = event.get("data").and_then(|v| v.as_str()).unwrap_or("");
        let payload: AskUserQuestionPayload = match serde_json::from_str(raw) {
            Ok(payload) => payload,
            Err(e) => {
                ulog_warn!("[reply-router] Invalid AskUserQuestion payload: {}", e);
                return;
            }
        };
        let question_request_id = payload.request_id.clone();
        let chat_id = slot.chat_id.clone();
        let requester_user_id = slot.requester_user_id.clone();
        let source_type = slot.source_type.clone();

        if payload.questions.iter().any(|q| q.is_secret) {
            let _ = adapter
                .send_message(
                    &chat_id,
                    "本次提问包含敏感输入，IM 渠道暂不支持安全收集，已自动取消。请在桌面端继续，或改用非敏感文本。",
                )
                .await;
            super::questions::cancel_question(sidecar_port, &question_request_id).await;
            return;
        }

        self.slots
            .get_mut(request_id)
            .expect("registered slot")
            .interaction_ids
            .push(question_request_id.clone());
        // Register before platform I/O: a button can arrive before send returns.
        self.pending_questions.lock().await.insert(
            question_request_id.clone(),
            PendingQuestion {
                sidecar_port,
                chat_id: chat_id.clone(),
                card_message_id: String::new(),
                requester_user_id,
                source_type: source_type.clone(),
                questions: payload.questions.clone(),
                created_at: Instant::now(),
            },
        );
        match adapter
            .send_question_card(&chat_id, &payload, &source_type)
            .await
        {
            Ok(message_id) => {
                let mut guard = self.pending_questions.lock().await;
                if let Some(pending) = guard.get_mut(&question_request_id) {
                    pending.card_message_id = message_id.unwrap_or_default();
                } else if let Some(message_id) = message_id {
                    drop(guard);
                    let _ = adapter
                        .update_question_status(&chat_id, &message_id, "resolved")
                        .await;
                }
            }
            Err(_) => {
                ulog_error!("[reply-router] Question delivery failed; cancelling pending question");
                if super::questions::cancel_question(sidecar_port, &question_request_id).await {
                    self.pending_questions
                        .lock()
                        .await
                        .remove(&question_request_id);
                }
            }
        }
    }

    async fn handle_question_expired<A: ImStreamAdapter>(&mut self, event: &Value, adapter: &A) {
        let raw = event.get("data").and_then(|v| v.as_str()).unwrap_or("");
        let json_payload: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
        let question_request_id = json_payload["requestId"].as_str().unwrap_or("").to_string();
        if question_request_id.is_empty() {
            return;
        }
        let pending = self
            .pending_questions
            .lock()
            .await
            .remove(&question_request_id);
        if let Some(p) = pending {
            if !p.card_message_id.is_empty() {
                let _ = adapter
                    .update_question_status(&p.chat_id, &p.card_message_id, "expired")
                    .await;
            }
        }
    }

    async fn dispatch_edit_based<A: ImStreamAdapter>(
        &mut self,
        event_type: &str,
        event: &Value,
        request_id: &str,
        adapter: &A,
        sidecar_port: u16,
    ) -> Option<TerminalOutcome> {
        let slot = self.slots.get_mut(request_id)?;
        let chat_id = slot.chat_id.clone();
        let data = event.get("data");

        match event_type {
            // Bus emits 'delta' (per-token streaming text). The accumulated text
            // arrives via separate state — the legacy SSE protocol used 'partial'
            // with full text. Bus events deliver the delta only; we accumulate.
            "delta" => {
                let chunk = data.and_then(|v| v.as_str()).unwrap_or("");
                if chunk.is_empty() {
                    return None;
                }
                slot.block_text.push_str(chunk);

                // First meaningful text → create draft message (if adapter supports edit)
                if adapter.supports_edit()
                    && slot.draft_id.is_none()
                    && !slot.block_text.trim().is_empty()
                    && has_sentence_boundary(&slot.block_text)
                {
                    let display = format_draft_text(&slot.block_text, adapter.max_message_length());
                    if let Ok(Some(id)) =
                        adapter.send_message_returning_id(&chat_id, &display).await
                    {
                        slot.draft_id = Some(id);
                        slot.last_edit = Instant::now();
                    }
                    slot.first_content_sent = true;
                }

                // Throttled edit
                if let Some(ref did) = slot.draft_id {
                    let throttle = Duration::from_millis(adapter.preferred_throttle_ms());
                    if slot.last_edit.elapsed() >= throttle {
                        slot.last_edit = Instant::now();
                        let display =
                            format_draft_text(&slot.block_text, adapter.max_message_length());
                        let _ = adapter.edit_message(&chat_id, did, &display).await;
                    }
                }
                None
            }

            "block-end" => {
                // Producer (agent-session.ts) emits `block-end` with `data: ''`
                // (no payload — the SDK's content_block_stop carries no text).
                // Empty `data` means "use the slot's accumulated text"; the
                // legacy `unwrap_or_else` fallback only fired on `None`, so
                // `Some("")` slipped through as `final_text = ""` → trim empty
                // → abort_stream (which renders `[Aborted]` on Feishu lark
                // streaming sessions). Treat empty string as "not provided".
                let final_text = data
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| slot.block_text.clone());
                if final_text.trim().is_empty() {
                    if let Some(ref did) = slot.draft_id {
                        let _ = adapter.delete_message(&chat_id, did).await;
                    }
                } else {
                    finalize_block(adapter, &chat_id, slot.draft_id.clone(), &final_text).await;
                    slot.any_text_sent = true;
                }
                slot.last_block_text = std::mem::take(&mut slot.block_text);
                slot.draft_id = None;
                None
            }

            "complete" => {
                // C5 fix: bus emits 'complete' with `data` = the SDK's result text
                // (legacy 'partial-then-complete' would carry the result string),
                // NOT a session_id. The session_id for record_response is taken from
                // the peer_session, not from the event payload. Returning None here
                // tells the caller "use the existing peer_session_id".
                let trimmed_last = slot.last_block_text.trim();
                let is_no_reply = (slot.group_activation_always
                    || matches!(slot.source_type, ImSourceType::Group))
                    && (trimmed_last == "<NO_REPLY>" || trimmed_last == "NO_REPLY");

                if is_no_reply {
                    if let Some(ref did) = slot.draft_id {
                        let _ = adapter.delete_message(&chat_id, did).await;
                    }
                    if let Some(ref pid) = slot.placeholder_id {
                        let _ = adapter.delete_message(&chat_id, pid).await;
                    }
                    slot.is_done = true;
                    return Some(TerminalOutcome {
                        session_id: None,
                        silent: true,
                    });
                }

                // Flush any remaining block text
                if !slot.block_text.trim().is_empty() {
                    finalize_block(
                        adapter,
                        &chat_id,
                        slot.draft_id.clone(),
                        &slot.block_text.clone(),
                    )
                    .await;
                    slot.any_text_sent = true;
                } else if let Some(ref did) = slot.draft_id {
                    let _ = adapter.delete_message(&chat_id, did).await;
                }
                if !slot.any_text_sent {
                    if let Some(ref pid) = slot.placeholder_id {
                        if adapter
                            .edit_message(&chat_id, pid, "(No response)")
                            .await
                            .is_err()
                        {
                            let _ = adapter.delete_message(&chat_id, pid).await;
                            let _ = adapter.send_message(&chat_id, "(No response)").await;
                        }
                    } else {
                        let _ = adapter.send_message(&chat_id, "(No response)").await;
                    }
                }
                slot.is_done = true;
                Some(TerminalOutcome {
                    session_id: None,
                    silent: false,
                })
            }

            "ask-user-question-request" => {
                self.handle_question_request(event, request_id, adapter, sidecar_port)
                    .await;
                None
            }

            "ask-user-question-expired" => {
                self.handle_question_expired(event, adapter).await;
                None
            }

            "permission-request" => {
                let raw = data.and_then(|v| v.as_str()).unwrap_or("");
                let json_payload: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
                let perm_request_id = json_payload["requestId"].as_str().unwrap_or("").to_string();
                let tool_name = json_payload["toolName"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_string();
                let tool_input_str = match json_payload["input"] {
                    Value::String(ref s) => s.clone(),
                    Value::Null => String::new(),
                    ref other => serde_json::to_string(other).unwrap_or_default(),
                };
                ulog_info!(
                    "[reply-router] Permission request: tool={}, rid={}",
                    tool_name,
                    &perm_request_id[..perm_request_id.len().min(16)],
                );
                {
                    let mut guard = self.pending_approvals.lock().await;
                    let now = Instant::now();
                    guard.retain(|_, p| {
                        now.duration_since(p.created_at) < Duration::from_secs(15 * 60)
                    });
                    guard.insert(
                        perm_request_id.clone(),
                        PendingApproval {
                            requester_user_id: slot.requester_user_id.clone(),
                            sidecar_port,
                            chat_id: chat_id.clone(),
                            card_message_id: String::new(),
                            created_at: now,
                        },
                    );
                }
                slot.interaction_ids.push(perm_request_id.clone());
                let card_msg_id = match adapter
                    .send_approval_card(&chat_id, &perm_request_id, &tool_name, &tool_input_str)
                    .await
                {
                    Ok(Some(mid)) => mid,
                    Ok(None) => String::new(),
                    Err(e) => {
                        ulog_error!("[reply-router] Failed to send approval card: {}", e);
                        String::new()
                    }
                };
                if let Some(pending) = self
                    .pending_approvals
                    .lock()
                    .await
                    .get_mut(&perm_request_id)
                {
                    pending.card_message_id = card_msg_id;
                }

                None
            }

            "activity" => {
                // Non-text block (thinking / tool_use). Show placeholder if user
                // hasn't seen any content yet.
                if !slot.first_content_sent && slot.placeholder_id.is_none() {
                    if let Ok(Some(id)) = adapter
                        .send_message_returning_id(&chat_id, THINKING_PLACEHOLDER)
                        .await
                    {
                        slot.placeholder_id = Some(id);
                    }
                    slot.first_content_sent = true;
                }
                None
            }

            "error" | "cancelled" => {
                let msg = terminal_text(data).unwrap_or("Unknown error");
                if let Some(ref did) = slot.draft_id {
                    let _ = adapter.delete_message(&chat_id, did).await;
                }
                if let Some(ref pid) = slot.placeholder_id {
                    let _ = adapter.delete_message(&chat_id, pid).await;
                }
                // W4 fix: cancel reason ('user' / 'timeout' / etc.) is an internal
                // CancelReason enum string — never surface it raw to chat. Show a
                // localized line; reason stays in logs.
                let user_msg = if event_type == "cancelled" {
                    "🛑 已取消".to_string()
                } else {
                    format!("⚠️ {}", msg)
                };
                let _ = adapter.send_message(&chat_id, &user_msg).await;
                slot.is_done = true;
                Some(TerminalOutcome {
                    session_id: None,
                    silent: false,
                })
            }

            _ => None, // unknown event type — ignore
        }
    }

    async fn dispatch_openclaw_reply<A: ImStreamAdapter>(
        &mut self,
        event_type: &str,
        event: &Value,
        request_id: &str,
        adapter: &A,
        sidecar_port: u16,
    ) -> Option<TerminalOutcome> {
        // Interactive cards remain ordinary adapter operations. They do not
        // participate in the reply snapshot/final transport.
        if matches!(
            event_type,
            "ask-user-question-request" | "ask-user-question-expired" | "permission-request"
        ) {
            return self
                .dispatch_edit_based(event_type, event, request_id, adapter, sidecar_port)
                .await;
        }

        let slot = self.slots.get_mut(request_id)?;
        let chat_id = slot.chat_id.clone();
        let data = event.get("data");

        if !slot.reply_dispatch_started {
            if let Err(error) = adapter.start_reply_dispatch(request_id).await {
                ulog_error!(
                    "[reply-router] OpenClaw run start failed requestId={}: {}",
                    request_id,
                    error
                );
                // Delivery failure is not an execution terminal. Keep the slot
                // and its lease until the producer terminal (or confirmed loss).
                // Terminal RPCs do not require a successful start ACK.
                if !matches!(event_type, "complete" | "error" | "cancelled") {
                    return None;
                }
            } else {
                slot.reply_dispatch_started = true;
            }
        }

        match event_type {
            "delta" => {
                let chunk = data.and_then(Value::as_str).unwrap_or("");
                if chunk.is_empty() {
                    return None;
                }
                slot.block_text.push_str(chunk);
                if let Some(stream_id) = slot.stream_id.as_deref() {
                    slot.sequence += 1;
                    if let Err(error) = adapter
                        .update_reply_stream(stream_id, &slot.block_text, slot.sequence, false)
                        .await
                    {
                        ulog_error!(
                            "[reply-router] OpenClaw partial handoff failed requestId={} streamId={}: {}",
                            request_id,
                            stream_id,
                            error
                        );
                    }
                } else {
                    match adapter
                        .start_reply_stream(request_id, &chat_id, &slot.block_text)
                        .await
                    {
                        Ok(stream_id) if !stream_id.is_empty() => {
                            slot.stream_id = Some(stream_id);
                            slot.sequence = 1;
                        }
                        Ok(_) => ulog_error!(
                            "[reply-router] OpenClaw start stream returned empty ID requestId={}",
                            request_id
                        ),
                        Err(error) => ulog_error!(
                            "[reply-router] OpenClaw start stream failed requestId={}: {}",
                            request_id,
                            error
                        ),
                    }
                }
                None
            }

            "block-end" => {
                if let Some(stream_id) = slot.stream_id.take() {
                    if let Err(error) = adapter.finish_reply_stream_block(&stream_id).await {
                        ulog_error!(
                            "[reply-router] OpenClaw block barrier failed requestId={} streamId={}: {}",
                            request_id,
                            stream_id,
                            error
                        );
                    }
                }
                slot.last_block_text = std::mem::take(&mut slot.block_text);
                slot.sequence = 0;
                None
            }

            "complete" | "error" | "cancelled" => self.dispatch_openclaw_terminal(event, request_id, adapter).await,

            "activity" => None,
            _ => None,
        }
    }

    async fn dispatch_openclaw_terminal<A: ImStreamAdapter>(
        &mut self,
        event: &Value,
        request_id: &str,
        adapter: &A,
    ) -> Option<TerminalOutcome> {
        let slot = self.slots.get_mut(request_id)?;
        let event_type = event["type"].as_str()?;
        let automatic = slot.delivery_mode.allows_automatic();
        let payloads = if automatic {
            event
                .pointer("/data/finalPayloads")
                .filter(|value| value.is_array())
                .cloned()
                .unwrap_or_else(|| json!([]))
        } else {
            // An empty terminal settles tool-only input without another reply.
            let _ = adapter
                .set_reply_delivery_mode(request_id, slot.delivery_mode)
                .await;
            json!([])
        };
        let admission = if event_type == "complete" {
            adapter.complete_reply_dispatch(request_id, &payloads).await
        } else {
            let payload = payloads
                .as_array()
                .and_then(|values| values.first())
                .cloned()
                .unwrap_or_else(|| json!({}));
            adapter
                .abort_reply_dispatch(request_id, event_type, &payload)
                .await
        };
        match admission {
            Err(error) => {
                ulog_warn!("[reply-router] OpenClaw terminal handoff pending requestId={} terminal={}: {}; retaining original outcome for recovery",
                    request_id, event_type, error);
                return None;
            }
            Ok(adapter::ReplyDispatchAdmission::DispatchMissing) => {
                ulog_warn!("[reply-router] OpenClaw delivery unknown requestId={} terminal={}: original dispatcher no longer exists",
                    request_id, event_type);
            }
            Ok(adapter::ReplyDispatchAdmission::Accepted) => {
                ulog_info!(
                    "[reply-router] OpenClaw terminal handoff accepted requestId={} terminal={}",
                    request_id,
                    event_type
                );
            }
        }
        slot.is_done = true;
        let silent = !automatic
            || (event_type == "complete"
                && slot.group_activation_always
                && payloads.as_array().is_some_and(|values| {
                    values.iter().any(|payload| {
                        matches!(
                            payload.get("text").and_then(Value::as_str).map(str::trim),
                            Some("<NO_REPLY>" | "NO_REPLY")
                        )
                    })
                }));
        Some(TerminalOutcome {
            session_id: if automatic {
                None
            } else {
                event
                    .pointer("/data/sessionId")
                    .and_then(Value::as_str)
                    .map(String::from)
            },
            silent,
        })
    }

    async fn dispatch_streaming<A: ImStreamAdapter>(
        &mut self,
        event_type: &str,
        event: &Value,
        request_id: &str,
        adapter: &A,
        sidecar_port: u16,
    ) -> Option<TerminalOutcome> {
        let slot = self.slots.get_mut(request_id)?;
        let chat_id = slot.chat_id.clone();
        let data = event.get("data");

        match event_type {
            "delta" => {
                let chunk = data.and_then(|v| v.as_str()).unwrap_or("");
                if chunk.is_empty() {
                    return None;
                }
                slot.block_text.push_str(chunk);

                if slot.stream_id.is_none()
                    && !slot.block_text.trim().is_empty()
                    && has_sentence_boundary(&slot.block_text)
                {
                    if let Ok(sid) = adapter.start_stream(&chat_id, &slot.block_text).await {
                        if !sid.is_empty() {
                            slot.stream_id = Some(sid);
                            slot.sequence = 1;
                            slot.any_text_sent = true;
                            slot.first_content_sent = true;
                        }
                    }
                } else if let Some(ref sid) = slot.stream_id {
                    slot.sequence += 1;
                    let _ = adapter
                        .stream_chunk(&chat_id, sid, &slot.block_text, slot.sequence, false)
                        .await;
                }
                None
            }

            "activity" => {
                if let Some(ref sid) = slot.stream_id {
                    slot.sequence += 1;
                    let _ = adapter
                        .stream_chunk(&chat_id, sid, "", slot.sequence, true)
                        .await;
                } else if !slot.first_content_sent {
                    if let Ok(Some(id)) = adapter
                        .send_message_returning_id(&chat_id, THINKING_PLACEHOLDER)
                        .await
                    {
                        slot.placeholder_id = Some(id);
                    }
                    slot.first_content_sent = true;
                }
                None
            }

            "block-end" => {
                // Same fallback semantics as the edit-based path: producer
                // emits `block-end` with empty `data` — fall back to the slot
                // accumulator. Without this filter, every block-end aborted
                // the active stream → Feishu lark card showed `[Aborted]`.
                let final_text = data
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| slot.block_text.clone());
                if !final_text.trim().is_empty() {
                    if let Some(ref sid) = slot.stream_id {
                        let _ = adapter.finalize_stream(&chat_id, sid, &final_text).await;
                        slot.any_text_sent = true;
                    } else {
                        let _ = adapter.send_message(&chat_id, &final_text).await;
                        slot.any_text_sent = true;
                    }
                } else if let Some(ref sid) = slot.stream_id {
                    let _ = adapter.abort_stream(&chat_id, sid).await;
                }
                slot.last_block_text = std::mem::take(&mut slot.block_text);
                slot.stream_id = None;
                slot.sequence = 0;
                None
            }

            "complete" => {
                // C5 fix: see edit-based path. session_id NOT taken from event payload.
                let trimmed_last = slot.last_block_text.trim();
                let is_no_reply = slot.group_activation_always
                    && (trimmed_last == "<NO_REPLY>" || trimmed_last == "NO_REPLY");
                if is_no_reply {
                    if let Some(ref sid) = slot.stream_id {
                        let _ = adapter.abort_stream(&chat_id, sid).await;
                    }
                    if let Some(ref pid) = slot.placeholder_id {
                        let _ = adapter.delete_message(&chat_id, pid).await;
                    }
                    slot.is_done = true;
                    return Some(TerminalOutcome {
                        session_id: None,
                        silent: true,
                    });
                }

                if !slot.block_text.trim().is_empty() {
                    if let Some(ref sid) = slot.stream_id {
                        let _ = adapter
                            .finalize_stream(&chat_id, sid, &slot.block_text.clone())
                            .await;
                    } else {
                        let _ = adapter
                            .send_message(&chat_id, &slot.block_text.clone())
                            .await;
                    }
                    slot.any_text_sent = true;
                } else if let Some(ref sid) = slot.stream_id {
                    let _ = adapter.abort_stream(&chat_id, sid).await;
                }
                if !slot.any_text_sent {
                    if let Some(ref pid) = slot.placeholder_id {
                        if adapter
                            .edit_message(&chat_id, pid, "(No response)")
                            .await
                            .is_err()
                        {
                            let _ = adapter.delete_message(&chat_id, pid).await;
                            let _ = adapter.send_message(&chat_id, "(No response)").await;
                        }
                    } else {
                        let _ = adapter.send_message(&chat_id, "(No response)").await;
                    }
                }
                slot.is_done = true;
                Some(TerminalOutcome {
                    session_id: None,
                    silent: false,
                })
            }

            "ask-user-question-request" => {
                self.handle_question_request(event, request_id, adapter, sidecar_port)
                    .await;
                None
            }

            "ask-user-question-expired" => {
                self.handle_question_expired(event, adapter).await;
                None
            }

            "permission-request" => {
                // Same as edit-based path
                let raw = data.and_then(|v| v.as_str()).unwrap_or("");
                let json_payload: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
                let perm_request_id = json_payload["requestId"].as_str().unwrap_or("").to_string();
                let tool_name = json_payload["toolName"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_string();
                let tool_input_str = match json_payload["input"] {
                    Value::String(ref s) => s.clone(),
                    Value::Null => String::new(),
                    ref other => serde_json::to_string(other).unwrap_or_default(),
                };
                {
                    let mut guard = self.pending_approvals.lock().await;
                    let now = Instant::now();
                    guard.retain(|_, p| {
                        now.duration_since(p.created_at) < Duration::from_secs(15 * 60)
                    });
                    guard.insert(
                        perm_request_id.clone(),
                        PendingApproval {
                            requester_user_id: slot.requester_user_id.clone(),
                            sidecar_port,
                            chat_id: chat_id.clone(),
                            card_message_id: String::new(),
                            created_at: now,
                        },
                    );
                }
                slot.interaction_ids.push(perm_request_id.clone());
                let card_msg_id = adapter
                    .send_approval_card(&chat_id, &perm_request_id, &tool_name, &tool_input_str)
                    .await
                    .ok()
                    .flatten()
                    .unwrap_or_default();
                if let Some(pending) = self
                    .pending_approvals
                    .lock()
                    .await
                    .get_mut(&perm_request_id)
                {
                    pending.card_message_id = card_msg_id;
                }

                None
            }

            "error" | "cancelled" => {
                let msg = terminal_text(data).unwrap_or("Unknown error");
                if let Some(ref sid) = slot.stream_id {
                    let _ = adapter.abort_stream(&chat_id, sid).await;
                }
                if let Some(ref pid) = slot.placeholder_id {
                    let _ = adapter.delete_message(&chat_id, pid).await;
                }
                // W4 fix: cancel reason ('user' / 'timeout' / etc.) is an internal
                // CancelReason enum string — never surface it raw to chat. Show a
                // localized line; reason stays in logs.
                let user_msg = if event_type == "cancelled" {
                    "🛑 已取消".to_string()
                } else {
                    format!("⚠️ {}", msg)
                };
                let _ = adapter.send_message(&chat_id, &user_msg).await;
                slot.is_done = true;
                Some(TerminalOutcome {
                    session_id: None,
                    silent: false,
                })
            }

            _ => None,
        }
    }

    /// Handle bus session-level events (requestId=null) — primarily `gap`
    /// (ImEventBus ring eviction or cross-generation reset). Currently
    /// surfaces a single user-visible warning to ALL active slots when a gap
    /// is observed; in practice IM volumes don't trigger eviction often.
    async fn handle_session_event<A: ImStreamAdapter>(
        &mut self,
        event_type: &str,
        event: &Value,
        adapter: &A,
    ) {
        if event_type != "gap" {
            return; // unknown session-level event — ignore
        }
        let dropped_seqs = event
            .get("data")
            .and_then(|d| d.get("droppedSeqs"))
            .and_then(|s| s.as_array())
            .and_then(|arr| {
                let lo = arr.first().and_then(|v| v.as_u64())?;
                let hi = arr.get(1).and_then(|v| v.as_u64())?;
                Some((lo, hi))
            });
        let reason = event
            .get("data")
            .and_then(|d| d.get("reason"))
            .and_then(|r| r.as_str())
            .unwrap_or("eviction");
        let affected_request_ids: Option<std::collections::HashSet<String>> = event
            .get("data")
            .and_then(|d| d.get("requestIds"))
            .and_then(|ids| ids.as_array())
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| id.as_str().map(ToString::to_string))
                    .collect()
            });
        ulog_warn!(
            "[reply-router] gap event observed reason={} dropped={:?} active_slots={}",
            reason,
            dropped_seqs,
            self.slots.len(),
        );
        // For each active slot, surface a one-line warning so the user
        // doesn't see partial replies as truthful complete content. Skip
        // already-done slots (their UI is finalized).
        let chat_ids: Vec<String> = self
            .slots
            .iter()
            .filter(|(request_id, slot)| {
                !slot.is_done
                    && slot.delivery_mode.allows_automatic()
                    && affected_request_ids
                        .as_ref()
                        .map_or(true, |ids| ids.contains(request_id.as_str()))
            })
            .map(|(_, slot)| slot.chat_id.clone())
            .collect();
        if chat_ids.is_empty() {
            return;
        }
        let prefix = if reason == "session-reset" {
            "⚠️ 会话已重置，部分回复未送达"
        } else {
            "⚠️ 部分流式内容丢失（事件队列溢出）"
        };
        // De-dup chat_ids — multiple slots in the same chat get one warning each.
        let mut seen = std::collections::HashSet::new();
        for chat_id in chat_ids {
            if seen.insert(chat_id.clone()) {
                let _ = adapter.send_message(&chat_id, prefix).await;
            }
        }
    }

    pub(crate) fn set_lifecycle(
        &mut self,
        cancel: super::event_consumer::CancelFlag,
        manager: crate::sidecar::ManagedSidecarManager,
        session_id: String,
        generation: u64,
    ) {
        self.lifecycle = Some(ReplyLifecycle {
            cancel,
            manager,
            session_id,
            generation,
        });
    }

    /// Claim all outstanding obligations under the short router lock. Cleanup
    /// and platform I/O then run on this detached router, never the registry lock.
    pub(crate) fn take_for_shutdown(&mut self) -> Self {
        if let Some(lifecycle) = &self.lifecycle {
            lifecycle
                .cancel
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        let mut pending = Self::new(
            self.pending_approvals.clone(),
            self.pending_questions.clone(),
        );
        pending.slots = std::mem::take(&mut self.slots);
        pending
    }

    pub(crate) fn request_ids(&self) -> Vec<String> {
        self.slots.keys().cloned().collect()
    }

    pub(crate) fn producer_terminal(&self, request_id: &str) -> Option<&Value> {
        self.slots.get(request_id)?.producer_terminal.as_ref()
    }

    pub(crate) fn uses_idempotent_terminal(&self, request_id: &str) -> bool {
        self.slots.get(request_id).is_some_and(|slot| {
            matches!(
                slot.delivery_protocol,
                Some(ImDeliveryProtocol::OpenClawReply)
            )
        })
    }

    pub(crate) async fn clear_interactions(&mut self, request_id: &str) {
        if let Some(slot) = self.slots.get_mut(request_id) {
            let mut approvals = self.pending_approvals.lock().await;
            let mut questions = self.pending_questions.lock().await;
            for id in slot.interaction_ids.drain(..) {
                approvals.remove(&id);
                questions.remove(&id);
            }
        }
    }

    /// Drop a slot after handling its terminal event. Caller invokes after
    /// processing TerminalOutcome.
    pub async fn unregister(&mut self, request_id: &str) {
        if let Some(mut slot) = self.slots.remove(request_id) {
            if let Some(mut lease) = slot._lease.take() {
                if let Some(owner) = lease.owner.take() {
                    if let Err(error) = crate::sidecar::release_session_sidecar(
                        &lease.manager,
                        &lease.session_id,
                        &owner,
                    )
                    .await
                    {
                        ulog_warn!("[reply-router] Reply lease release failed: {}", error);
                    }
                }
            }
        }
    }

    pub(crate) fn claim_terminal_callback(&mut self, request_id: &str) -> bool {
        let Some(slot) = self.slots.get_mut(request_id) else {
            return false;
        };
        if slot.terminal_callback_claimed {
            return false;
        }
        slot.terminal_callback_claimed = true;
        true
    }

    pub(crate) fn finish_admission(&mut self, request_id: &str) {
        if let Some(slot) = self.slots.get_mut(request_id) {
            slot.admission_finished = true;
        }
    }

    pub(crate) fn reconcilable_request_ids(&self) -> Vec<String> {
        self.slots
            .iter()
            .filter(|(_, slot)| slot.admission_finished)
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub(crate) fn pending_terminal_handoff_count(&self) -> usize {
        self.slots
            .values()
            .filter(|slot| {
                !slot.is_done
                    && slot.producer_terminal.is_some()
                    && slot.delivery_protocol == Some(ImDeliveryProtocol::OpenClawReply)
            })
            .count()
    }

    /// Diagnostic.
    pub fn slot_count(&self) -> usize {
        self.slots.len()
    }
}

/// Returned by `dispatch` when a slot reaches a terminal state.
#[derive(Debug)]
pub struct TerminalOutcome {
    /// Sidecar's session_id from the 'complete' event payload, if any.
    pub session_id: Option<String>,
    /// Group "always" mode NO_REPLY → don't surface to the user (silent close).
    pub silent: bool,
}

/// Thin wrapper enabling sharing a `ReplyRouter` across `ImEventConsumer`
/// reconnect cycles via Arc<Mutex<...>>. Each `dispatch` call is brief
/// (one event), so contention is negligible.
pub type SharedReplyRouter = Arc<Mutex<ReplyRouter>>;

pub(crate) fn shared_router(
    pending_approvals: PendingApprovals,
    pending_questions: PendingQuestions,
) -> SharedReplyRouter {
    Arc::new(Mutex::new(ReplyRouter::new(
        pending_approvals,
        pending_questions,
    )))
}

// Allow `adapter` module to be referenced — keeps cargo check happy if no other
// reference exists in this file (currently used via type imports above).
#[allow(unused_imports)]
use adapter::ImStreamAdapter as _ImStreamAdapter;

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::{Duration, Instant};
    use tokio::sync::Mutex;

    use serde_json::json;

    use super::ReplyRouter;
    use crate::im::adapter::{AdapterResult, ImAdapter, ImStreamAdapter};
    use crate::im::types::{ImDeliveryProtocol, ImSourceType};

    #[derive(Default)]
    struct RecordingAdapter {
        sent_messages: StdMutex<Vec<(String, String)>>,
        reply_operations: StdMutex<Vec<serde_json::Value>>,
        ordinary_effects: StdMutex<Vec<&'static str>>,
        question_pending: Option<crate::im::PendingQuestions>,
        fail_send: bool,
        fail_start: bool,
        panic_start_once: std::sync::atomic::AtomicBool,
        terminal_pause: Option<Arc<TerminalPause>>,
    }

    struct TerminalPause {
        before_accept: bool,
        used: std::sync::atomic::AtomicBool,
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }

    impl RecordingAdapter {
        fn sent_messages(&self) -> Vec<(String, String)> {
            self.sent_messages.lock().unwrap().clone()
        }

        fn reply_operations(&self) -> Vec<serde_json::Value> {
            self.reply_operations.lock().unwrap().clone()
        }
    }

    impl ImAdapter for RecordingAdapter {
        async fn verify_connection(&self) -> AdapterResult<String> {
            Ok("test".to_string())
        }

        async fn register_commands(&self) -> AdapterResult<()> {
            Ok(())
        }

        async fn listen_loop(&self, _shutdown_rx: tokio::sync::watch::Receiver<bool>) {}

        async fn send_message(&self, chat_id: &str, text: &str) -> AdapterResult<()> {
            if let Some(pending) = &self.question_pending {
                assert!(
                    pending.lock().await.contains_key("ask-1"),
                    "pending must exist before platform send"
                );
            }
            if self.fail_send {
                return Err("delivery failed".to_string());
            }
            self.sent_messages
                .lock()
                .unwrap()
                .push((chat_id.to_string(), text.to_string()));
            Ok(())
        }

        async fn ack_received(&self, _chat_id: &str, _message_id: &str) {
            self.ordinary_effects.lock().unwrap().push("received");
        }

        async fn ack_processing(&self, _chat_id: &str, _message_id: &str) {
            self.ordinary_effects.lock().unwrap().push("processing");
        }

        async fn ack_clear(&self, _chat_id: &str, _message_id: &str) {
            self.ordinary_effects.lock().unwrap().push("clear");
        }

        async fn send_typing(&self, _chat_id: &str) {
            self.ordinary_effects.lock().unwrap().push("typing");
        }
    }

    impl ImStreamAdapter for RecordingAdapter {
        async fn send_message_returning_id(
            &self,
            chat_id: &str,
            text: &str,
        ) -> AdapterResult<Option<String>> {
            self.send_message(chat_id, text).await?;
            Ok(Some("sent-id".to_string()))
        }

        async fn edit_message(
            &self,
            _chat_id: &str,
            _message_id: &str,
            _text: &str,
        ) -> AdapterResult<()> {
            Ok(())
        }

        async fn delete_message(&self, _chat_id: &str, _message_id: &str) -> AdapterResult<()> {
            Ok(())
        }

        fn max_message_length(&self) -> usize {
            4096
        }

        async fn send_approval_card(
            &self,
            _chat_id: &str,
            _request_id: &str,
            _tool_name: &str,
            _tool_input: &str,
        ) -> AdapterResult<Option<String>> {
            Ok(Some("approval-id".to_string()))
        }

        async fn update_approval_status(
            &self,
            _chat_id: &str,
            _message_id: &str,
            _status: &str,
        ) -> AdapterResult<()> {
            Ok(())
        }

        async fn update_question_status(
            &self,
            _chat_id: &str,
            _message_id: &str,
            _status: &str,
        ) -> AdapterResult<()> {
            Ok(())
        }

        async fn send_photo(
            &self,
            _chat_id: &str,
            _data: Vec<u8>,
            _filename: &str,
            _caption: Option<&str>,
        ) -> AdapterResult<Option<String>> {
            Ok(Some("photo-id".to_string()))
        }

        async fn send_file(
            &self,
            _chat_id: &str,
            _data: Vec<u8>,
            _filename: &str,
            _mime_type: &str,
            _caption: Option<&str>,
        ) -> AdapterResult<Option<String>> {
            Ok(Some("file-id".to_string()))
        }

        async fn finalize_message(
            &self,
            _chat_id: &str,
            _message_id: &str,
            _text: &str,
        ) -> AdapterResult<()> {
            Ok(())
        }

        async fn start_reply_dispatch(&self, request_id: &str) -> AdapterResult<()> {
            assert!(
                !self
                    .panic_start_once
                    .swap(false, std::sync::atomic::Ordering::SeqCst),
                "fixture adapter panic"
            );
            if self.fail_start {
                return Err("temporary connection failure".into());
            }
            self.reply_operations
                .lock()
                .unwrap()
                .push(json!({ "kind": "start", "requestId": request_id }));
            Ok(())
        }

        async fn start_reply_stream(
            &self,
            request_id: &str,
            chat_id: &str,
            initial_text: &str,
        ) -> AdapterResult<String> {
            let stream_id = format!("stream-{}", self.reply_operations.lock().unwrap().len());
            self.reply_operations.lock().unwrap().push(json!({
                "kind": "stream-start",
                "requestId": request_id,
                "chatId": chat_id,
                "text": initial_text,
                "streamId": stream_id,
            }));
            Ok(stream_id)
        }

        async fn update_reply_stream(
            &self,
            stream_id: &str,
            text: &str,
            sequence: u32,
            is_thinking: bool,
        ) -> AdapterResult<()> {
            self.reply_operations.lock().unwrap().push(json!({
                "kind": "partial",
                "streamId": stream_id,
                "text": text,
                "sequence": sequence,
                "isThinking": is_thinking,
            }));
            Ok(())
        }

        async fn finish_reply_stream_block(&self, stream_id: &str) -> AdapterResult<()> {
            self.reply_operations
                .lock()
                .unwrap()
                .push(json!({ "kind": "block-boundary", "streamId": stream_id }));
            Ok(())
        }

        async fn complete_reply_dispatch(
            &self,
            request_id: &str,
            final_payloads: &serde_json::Value,
        ) -> AdapterResult<crate::im::adapter::ReplyDispatchAdmission> {
            let pause = self
                .terminal_pause
                .as_ref()
                .filter(|pause| !pause.used.swap(true, std::sync::atomic::Ordering::SeqCst));
            if let Some(pause) = pause.filter(|pause| pause.before_accept) {
                pause.entered.notify_one();
                pause.release.notified().await;
            }
            // Model the Bridge's existing idempotent terminal admission.
            {
                let mut operations = self.reply_operations.lock().unwrap();
                if !operations
                    .iter()
                    .any(|op| op["kind"] == "complete" && op["requestId"] == request_id)
                {
                    operations.push(json!({ "kind": "complete", "requestId": request_id, "finalPayloads": final_payloads }));
                }
            }
            if let Some(pause) = pause.filter(|pause| !pause.before_accept) {
                pause.entered.notify_one();
                pause.release.notified().await;
            }
            Ok(crate::im::adapter::ReplyDispatchAdmission::Accepted)
        }

        async fn abort_reply_dispatch(
            &self,
            request_id: &str,
            reason: &str,
            terminal_payload: &serde_json::Value,
        ) -> AdapterResult<crate::im::adapter::ReplyDispatchAdmission> {
            self.reply_operations.lock().unwrap().push(json!({
                "kind": "abort",
                "requestId": request_id,
                "reason": reason,
                "terminalPayload": terminal_payload,
            }));
            Ok(crate::im::adapter::ReplyDispatchAdmission::Accepted)
        }
    }

    #[tokio::test]
    async fn empty_producer_terminal_settles_joined_requests_without_a_second_reply() {
        for protocol in [None, Some(ImDeliveryProtocol::OpenClawReply)] {
            for terminal in ["complete", "error", "cancelled"] {
                let mut router = ReplyRouter::new(Default::default(), Default::default());
                let adapter = RecordingAdapter::default();
                router.register(
                    "joined".into(),
                    "chat".into(),
                    "message".into(),
                    ImSourceType::Private,
                    Some("user".into()),
                    None,
                    protocol.clone(),
                );
                let outcome = router
                    .dispatch(
                        &json!({"requestId":"joined","type":terminal,
                    "data":{"finalPayloads":[]}}),
                        &adapter,
                        1,
                    )
                    .await
                    .unwrap();
                assert!(adapter.sent_messages().is_empty());
                if protocol.is_none() {
                    assert!(outcome.silent);
                }
                assert!(router.slots.get("joined").unwrap().is_done);
                router.unregister("joined").await;
                assert_eq!(router.slot_count(), 0);
            }
        }
    }

    #[tokio::test]
    async fn tool_only_discards_normal_events_and_settles_native_and_plugin_requests() {
        for protocol in [None, Some(ImDeliveryProtocol::OpenClawReply)] {
            for terminal in ["complete", "error", "cancelled"] {
                let mut router = ReplyRouter::new(Default::default(), Default::default());
                let adapter = RecordingAdapter::default();
                router.register(
                    "r".into(),
                    "chat".into(),
                    "message".into(),
                    ImSourceType::Private,
                    Some("user".into()),
                    None,
                    protocol.clone(),
                );
                router.set_pending_delivery_mode(
                    "r",
                    crate::im::types::ChannelDeliveryMode::ToolOnly,
                );
                for kind in [
                    "delivery-policy",
                    "delta",
                    "thinking",
                    "tool-start",
                    "block-end",
                    "gap",
                ] {
                    let request = if kind == "gap" {
                        serde_json::Value::Null
                    } else {
                        json!("r")
                    };
                    router.dispatch(&json!({"requestId":request,"type":kind,"channelDeliveryMode":"tool_only","data":"must not send"}), &adapter, 1).await;
                }
                let outcome = router.dispatch(&json!({"requestId":"r","type":terminal,"channelDeliveryMode":"tool_only","data":{"sessionId":"s","text":"must not send"}}), &adapter, 1).await.unwrap();
                assert!(outcome.silent);
                assert_eq!(outcome.session_id.as_deref(), Some("s"));
                assert!(adapter.sent_messages().is_empty());
                assert!(adapter.ordinary_effects.lock().unwrap().is_empty());
                let operations = adapter.reply_operations();
                assert!(operations
                    .iter()
                    .all(|op| op["kind"] == "complete" || op["kind"] == "abort"));
                if protocol.is_some() {
                    assert_eq!(operations.len(), 1);
                }
                router.unregister("r").await;
                assert_eq!(router.slot_count(), 0);
            }
        }
    }

    #[tokio::test]
    async fn ask_user_question_request_registers_pending_question_by_inner_id() {
        let pending_approvals = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let pending_questions = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let mut router = ReplyRouter::new(
            Arc::clone(&pending_approvals),
            Arc::clone(&pending_questions),
        );
        router.register(
            "turn-1".to_string(),
            "chat-1".to_string(),
            "msg-1".to_string(),
            ImSourceType::Private,
            Some("user-1".to_string()),
            None,
            None,
        );
        let adapter = RecordingAdapter {
            question_pending: Some(Arc::clone(&pending_questions)),
            ..Default::default()
        };

        router
            .dispatch(
                &json!({
                    "seq": 1,
                    "requestId": "turn-1",
                    "type": "ask-user-question-request",
                    "data": serde_json::to_string(&json!({
                        "requestId": "ask-1",
                        "questions": [{
                            "id": "choice",
                            "header": "Choice",
                            "question": "Pick one",
                            "options": [{ "label": "A", "description": "" }],
                            "multiSelect": false
                        }],
                        "previewFormat": "html"
                    })).unwrap(),
                    "ts": 0
                }),
                &adapter,
                4321,
            )
            .await;

        let guard = pending_questions.lock().await;
        let pending = guard
            .get("ask-1")
            .expect("question is tracked by inner request id");
        assert_eq!(pending.sidecar_port, 4321);
        assert_eq!(pending.chat_id, "chat-1");
        assert_eq!(pending.requester_user_id.as_deref(), Some("user-1"));
        assert!(!guard.contains_key("turn-1"));
        assert!(pending.card_message_id.is_empty());
        let messages = adapter.sent_messages();
        assert!(messages[0].1.contains("Pick one"));
        assert!(messages[0].1.contains("1. A"));
    }

    #[tokio::test]
    async fn invisible_question_is_cancelled_and_only_removed_after_runtime_acceptance() {
        use axum::{routing::post, Json, Router};
        for accepted in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let received = Arc::new(StdMutex::new(Vec::new()));
            let captured = Arc::clone(&received);
            let app = Router::new().route(
                "/api/ask-user-question/respond",
                post(move |Json(body): Json<serde_json::Value>| {
                    let captured = Arc::clone(&captured);
                    async move {
                        captured.lock().unwrap().push(body);
                        Json(json!({"success":accepted}))
                    }
                }),
            );
            let server = tauri::async_runtime::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            let pending = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
            let mut router = ReplyRouter::new(Default::default(), Arc::clone(&pending));
            router.register(
                "turn".into(),
                "chat".into(),
                "msg".into(),
                ImSourceType::Private,
                Some("user".into()),
                None,
                None,
            );
            router
                .dispatch(
                    &json!({"requestId":"turn", "type":"ask-user-question-request", "data":json!({
                "requestId":"ask-1", "questions":[{"question":"Pick", "header":"Choice"}]
            }).to_string()}),
                    &RecordingAdapter {
                        fail_send: true,
                        question_pending: Some(Arc::clone(&pending)),
                        ..Default::default()
                    },
                    port,
                )
                .await;
            assert_eq!(
                received.lock().unwrap().as_slice(),
                &[json!({"requestId":"ask-1", "answers":null})]
            );
            assert_eq!(pending.lock().await.contains_key("ask-1"), !accepted);
            server.abort();
        }
    }

    #[tokio::test]
    async fn rejected_bridge_card_uses_text_or_cancels_only_after_runtime_acceptance() {
        use axum::{http::StatusCode, routing::post, Json, Router};
        for (text_delivered, cancellation_accepted) in
            [(true, false), (false, false), (false, true)]
        {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let texts = Arc::new(StdMutex::new(Vec::new()));
            let cancellations = Arc::new(StdMutex::new(Vec::new()));
            let captured_texts = Arc::clone(&texts);
            let captured_cancellations = Arc::clone(&cancellations);
            let app = Router::new()
                .route(
                    "/send-question-card",
                    post(|| async {
                        // The Bridge maps Lark's resolved empty message ID to this response.
                        (StatusCode::BAD_GATEWAY, Json(json!({"ok":false})))
                    }),
                )
                .route(
                    "/send-text",
                    post(move |Json(body): Json<serde_json::Value>| {
                        let captured = Arc::clone(&captured_texts);
                        async move {
                            captured.lock().unwrap().push(body);
                            if text_delivered {
                                (
                                    StatusCode::OK,
                                    Json(json!({"ok":true,"messageId":"text-1"})),
                                )
                            } else {
                                (StatusCode::BAD_GATEWAY, Json(json!({"ok":false})))
                            }
                        }
                    }),
                )
                .route(
                    "/api/ask-user-question/respond",
                    post(move |Json(body): Json<serde_json::Value>| {
                        let captured = Arc::clone(&captured_cancellations);
                        async move {
                            captured.lock().unwrap().push(body);
                            Json(json!({"success":cancellation_accepted}))
                        }
                    }),
                );
            let server = tauri::async_runtime::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            let pending = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
            let mut router = ReplyRouter::new(Default::default(), Arc::clone(&pending));
            router.register(
                "turn".into(),
                "chat".into(),
                "msg".into(),
                ImSourceType::Private,
                Some("user".into()),
                None,
                None,
            );
            router.dispatch(&json!({"requestId":"turn", "type":"ask-user-question-request", "data":json!({
                "requestId":"ask-1", "questions":[{"id":"choice", "question":"Pick one", "header":"Choice",
                    "options":[{"label":"Original option","description":"Original detail"}]}]
            }).to_string()}), &super::super::bridge::BridgeAdapter::new("lark".into(), port), port).await;
            let sent = texts.lock().unwrap().clone();
            assert_eq!(sent.len(), 1);
            assert_eq!(sent[0]["chatId"], "chat");
            let text = sent[0]["text"].as_str().unwrap();
            assert!(
                text.contains("Pick one")
                    && text.contains("Original option")
                    && text.contains("Original detail")
            );
            let pending = pending.lock().await;
            if text_delivered {
                assert_eq!(pending["ask-1"].card_message_id, "text-1");
                assert!(cancellations.lock().unwrap().is_empty());
            } else {
                assert_eq!(
                    cancellations.lock().unwrap().as_slice(),
                    &[json!({"requestId":"ask-1","answers":null})]
                );
                assert_eq!(pending.contains_key("ask-1"), !cancellation_accepted);
            }
            server.abort();
        }
    }

    #[tokio::test]
    async fn scoped_gap_warns_only_affected_active_slots() {
        let pending_approvals = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let pending_questions = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let mut router = ReplyRouter::new(pending_approvals, pending_questions);
        router.register(
            "active-request".to_string(),
            "chat-active".to_string(),
            "msg-active".to_string(),
            ImSourceType::Private,
            None,
            None,
            None,
        );
        router.register(
            "other-request".to_string(),
            "chat-other".to_string(),
            "msg-other".to_string(),
            ImSourceType::Private,
            None,
            None,
            None,
        );
        let adapter = RecordingAdapter::default();

        router
            .dispatch(
                &json!({
                    "seq": 1,
                    "requestId": null,
                    "type": "gap",
                    "data": {
                        "droppedSeqs": [1, 42],
                        "requestIds": ["other-request"]
                    },
                    "ts": 0
                }),
                &adapter,
                0,
            )
            .await;

        assert_eq!(
            adapter.sent_messages(),
            vec![(
                "chat-other".to_string(),
                "⚠️ 部分流式内容丢失（事件队列溢出）".to_string(),
            )],
        );
    }

    #[tokio::test]
    async fn openclaw_reply_uses_request_protocol_and_keeps_block_boundary_non_terminal() {
        let pending_approvals = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let pending_questions = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let mut router = ReplyRouter::new(pending_approvals, pending_questions);
        router.register(
            "request-1".to_string(),
            "chat-1".to_string(),
            "msg-1".to_string(),
            ImSourceType::Private,
            None,
            None,
            Some(ImDeliveryProtocol::OpenClawReply),
        );
        let adapter = RecordingAdapter::default();

        assert!(router
            .dispatch(
                &json!({ "requestId": "request-1", "type": "delta", "data": "first" }),
                &adapter,
                0,
            )
            .await
            .is_none());
        assert!(router
            .dispatch(
                &json!({ "requestId": "request-1", "type": "block-end", "data": "" }),
                &adapter,
                0,
            )
            .await
            .is_none());
        assert_eq!(router.slot_count(), 1);
        assert!(router
            .dispatch(
                &json!({ "requestId": "request-1", "type": "delta", "data": "second" }),
                &adapter,
                0,
            )
            .await
            .is_none());
        let terminal = router
            .dispatch(
                &json!({
                    "requestId": "request-1",
                    "type": "complete",
                    "data": { "finalPayloads": [{ "text": "canonical final" }] }
                }),
                &adapter,
                0,
            )
            .await;

        assert!(terminal.is_some());
        assert_eq!(adapter.sent_messages(), Vec::<(String, String)>::new());
        assert_eq!(
            adapter.reply_operations(),
            vec![
                json!({ "kind": "start", "requestId": "request-1" }),
                json!({
                    "kind": "stream-start",
                    "requestId": "request-1",
                    "chatId": "chat-1",
                    "text": "first",
                    "streamId": "stream-1"
                }),
                json!({ "kind": "block-boundary", "streamId": "stream-1" }),
                json!({
                    "kind": "stream-start",
                    "requestId": "request-1",
                    "chatId": "chat-1",
                    "text": "second",
                    "streamId": "stream-3"
                }),
                json!({
                    "kind": "complete",
                    "requestId": "request-1",
                    "finalPayloads": [{ "text": "canonical final" }]
                }),
            ]
        );
    }

    #[tokio::test]
    async fn openclaw_reply_abort_forwards_only_the_producer_terminal_payload() {
        let pending_approvals = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let pending_questions = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let mut router = ReplyRouter::new(pending_approvals, pending_questions);
        router.register(
            "request-1".to_string(),
            "chat-1".to_string(),
            "msg-1".to_string(),
            ImSourceType::Private,
            None,
            None,
            Some(ImDeliveryProtocol::OpenClawReply),
        );
        let adapter = RecordingAdapter::default();

        let terminal = router
            .dispatch(
                &json!({
                    "requestId": "request-1",
                    "type": "error",
                    "data": {
                        "finalPayloads": [{ "text": "safe error", "isError": true }]
                    }
                }),
                &adapter,
                0,
            )
            .await;

        assert!(terminal.is_some());
        assert_eq!(
            adapter.reply_operations(),
            vec![
                json!({ "kind": "start", "requestId": "request-1" }),
                json!({
                    "kind": "abort",
                    "requestId": "request-1",
                    "reason": "error",
                    "terminalPayload": { "text": "safe error", "isError": true }
                }),
            ]
        );
    }

    #[tokio::test]
    async fn native_adapter_reads_error_text_from_typed_terminal_payload() {
        let pending_approvals = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let pending_questions = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let mut router = ReplyRouter::new(pending_approvals, pending_questions);
        router.register(
            "request-1".to_string(),
            "chat-1".to_string(),
            "msg-1".to_string(),
            ImSourceType::Private,
            None,
            None,
            None,
        );
        let adapter = RecordingAdapter::default();

        let terminal = router
            .dispatch(
                &json!({
                    "requestId": "request-1",
                    "type": "error",
                    "data": {
                        "finalPayloads": [{ "text": "safe error", "isError": true }]
                    }
                }),
                &adapter,
                0,
            )
            .await;

        assert!(terminal.is_some());
        assert_eq!(
            adapter.sent_messages(),
            vec![("chat-1".to_string(), "⚠️ safe error".to_string())]
        );
    }
    #[tokio::test]
    async fn retired_consumer_delivers_the_admitted_terminal_before_exiting() {
        for protocol in [None, Some(ImDeliveryProtocol::OpenClawReply)] {
            use super::super::event_consumer::{spawn_consumer, ConsumerLifetime};
            use axum::response::sse::{Event, Sse};
            use std::sync::atomic::{AtomicBool, Ordering};
            let pending_approvals = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
            let pending_questions = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
            let mut router = ReplyRouter::new(pending_approvals, pending_questions);
            router.register(
                "old-request".into(),
                "chat".into(),
                "msg".into(),
                ImSourceType::Private,
                Some("user".into()),
                None,
                protocol.clone(),
            );
            let router = Arc::new(tokio::sync::Mutex::new(router));
            let adapter = Arc::new(RecordingAdapter::default());
            let (events_tx, events_rx) =
                tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
            let receiver = Arc::new(tokio::sync::Mutex::new(Some(events_rx)));
            let connected = Arc::new(tokio::sync::Notify::new());
            let app = axum::Router::new().route(
                "/api/im/events",
                axum::routing::get({
                    let connected = connected.clone();
                    move || {
                        let receiver = receiver.clone();
                        let connected = connected.clone();
                        async move {
                            let rx = receiver.lock().await.take().unwrap();
                            connected.notify_one();
                            Sse::new(futures_util::stream::unfold(rx, |mut rx| async {
                                rx.recv().await.map(|value| {
                                    (
                                        Ok::<_, std::convert::Infallible>(
                                            Event::default().json_data(value).unwrap(),
                                        ),
                                        rx,
                                    )
                                })
                            }))
                        }
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tauri::async_runtime::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            let retired = Arc::new(AtomicBool::new(true));
            let cancel = Arc::new(AtomicBool::new(false));
            let terminal = Arc::new(AtomicBool::new(false));
            let manager = crate::sidecar::create_sidecar_manager();
            let owner = crate::sidecar::SidecarOwner::BackgroundCompletion("test-old-reply".into());
            manager.lock().unwrap().insert_test_ready_frontend_sidecar(
                "old-session",
                port,
                owner.clone(),
            );
            let generation = manager
                .lock()
                .unwrap()
                .generation_for("old-session")
                .unwrap();
            let handle = spawn_consumer(
                crate::local_http::sse_client(),
                port,
                "old-session".into(),
                "old-request".into(),
                router.clone(),
                adapter.clone(),
                ConsumerLifetime {
                    cancel: cancel.clone(),
                    retire_when_idle: retired,
                    manager: manager.clone(),
                    generation,
                },
                Arc::new({
                    let terminal = terminal.clone();
                    move |id, _| {
                        assert_eq!(id, "old-request");
                        terminal.store(true, Ordering::SeqCst);
                    }
                }),
            );
            tokio::time::timeout(std::time::Duration::from_secs(3), connected.notified())
                .await
                .unwrap();
            assert!(!cancel.load(Ordering::SeqCst));
            events_tx.send(serde_json::json!({ "seq":1, "requestId":"old-request", "type":"error", "data":{"finalPayloads":[{"text":"old turn completed","isError":true}]} })).unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(3), handle)
                .await
                .unwrap()
                .unwrap();
            crate::sidecar::release_session_sidecar(&manager, "old-session", &owner)
                .await
                .unwrap();
            assert!(terminal.load(Ordering::SeqCst));
            assert!(cancel.load(Ordering::SeqCst));
            assert_eq!(router.lock().await.slot_count(), 0);
            if protocol.is_some() {
                assert!(adapter
                    .reply_operations()
                    .iter()
                    .any(|operation| operation.to_string().contains("old turn completed")));
            } else {
                assert!(adapter
                    .sent_messages()
                    .iter()
                    .any(|(_, text)| text.contains("old turn completed")));
            }
            server.abort();
        }
    }

    #[tokio::test]
    async fn delivery_start_failure_does_not_end_execution_or_hide_real_terminal() {
        let mut replies = ReplyRouter::new(
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(Mutex::new(HashMap::new())),
        );
        replies.register(
            "r".into(),
            "chat".into(),
            "m".into(),
            ImSourceType::Private,
            None,
            None,
            Some(ImDeliveryProtocol::OpenClawReply),
        );
        let adapter = RecordingAdapter {
            fail_start: true,
            ..Default::default()
        };
        assert!(replies
            .dispatch(
                &json!({"requestId":"r", "type":"delta", "data":"working"}),
                &adapter,
                0
            )
            .await
            .is_none());
        assert_eq!(replies.slot_count(), 1);
        assert!(!replies.slots["r"].is_done);
        assert!(replies.dispatch(&json!({"requestId":"r", "type":"error", "data":{"finalPayloads":[{"text":"producer failure"}]}}), &adapter, 0).await.is_some());
        assert!(adapter
            .reply_operations()
            .iter()
            .any(|op| op["kind"] == "abort"));
    }

    fn idle_peer(key: &str, session: &str, port: u16) -> crate::im::types::PeerSession {
        crate::im::types::PeerSession {
            session_key: key.into(),
            session_id: session.into(),
            sidecar_port: port,
            workspace_path: std::path::PathBuf::from("/synthetic"),
            source_type: ImSourceType::Private,
            source_id: "chat".into(),
            source_display_name: None,
            last_sender_name: None,
            message_count: 1,
            metadata_birth_pending: false,
            metadata_indexed: true,
            last_active: Instant::now() - Duration::from_secs(1900),
        }
    }

    #[tokio::test]
    async fn idle_gc_keeps_silent_work_with_or_without_a_tab_and_releases_after_terminal() {
        use crate::im::enqueue::{collect_idle_im_sessions, ensure_im_consumer};
        use crate::sidecar::{create_sidecar_manager, release_session_sidecar, SidecarOwner};
        for tab_present in [false, true] {
            let manager = create_sidecar_manager();
            let agent = SidecarOwner::Agent("peer".into());
            let tab = SidecarOwner::Tab("tab".into());
            let port = 1; // No network server is needed to exercise lifecycle ownership.
            manager.lock().unwrap().insert_test_ready_frontend_sidecar(
                "session",
                port,
                agent.clone(),
            );
            if tab_present {
                manager
                    .lock()
                    .unwrap()
                    .add_session_owner("session", tab.clone());
            }
            let generation = manager.lock().unwrap().generation_for("session").unwrap();
            let consumers = Arc::new(Mutex::new(HashMap::new()));
            let adapter = Arc::new(RecordingAdapter::default());
            let replies = ensure_im_consumer(
                &consumers,
                &manager,
                "peer",
                port,
                "session",
                generation,
                "r".into(),
                adapter.clone(),
                Arc::new(Mutex::new(HashMap::new())),
                Arc::new(Mutex::new(HashMap::new())),
                crate::local_http::sse_client(),
                Arc::new(|_, _| {}),
            )
            .await
            .unwrap();
            assert!(replies.lock().await.register(
                "r".into(),
                "chat".into(),
                "m".into(),
                ImSourceType::Private,
                None,
                None,
                Some(ImDeliveryProtocol::OpenClawReply)
            ));
            let router = Arc::new(Mutex::new(crate::im::router::SessionRouter::new(
                std::path::PathBuf::from("/synthetic"),
            )));
            router
                .lock()
                .await
                .upsert_peer_session(idle_peer("peer", "session", port));
            let peer_locks = Arc::new(Mutex::new(HashMap::new()));
            assert_eq!(
                collect_idle_im_sessions(&router, &manager, &consumers, &peer_locks, |_| panic!(
                    "busy work must not enter GC"
                ))
                .await,
                0
            );
            assert!(manager.lock().unwrap().is_live("session", generation));
            assert!(!consumers.lock().await["peer"]
                .cancel
                .load(std::sync::atomic::Ordering::SeqCst));
            // Even a binding-owner release cannot kill the request lease.
            release_session_sidecar(&manager, "session", &agent)
                .await
                .unwrap();
            assert!(manager.lock().unwrap().is_live("session", generation));
            manager
                .lock()
                .unwrap()
                .add_session_owner("session", agent.clone());
            {
                let mut replies = replies.lock().await;
                assert!(replies
                    .dispatch(
                        &json!({"requestId":"r","type":"complete","data":{"finalPayloads":[]}}),
                        adapter.as_ref(),
                        port
                    )
                    .await
                    .is_some());
                replies.unregister("r").await;
            }
            // Failed preservation keeps the binding and consumer intact.
            assert_eq!(
                collect_idle_im_sessions(&router, &manager, &consumers, &peer_locks, |_| Err(
                    "unavailable".into()
                ))
                .await,
                0
            );
            assert_eq!(
                collect_idle_im_sessions(&router, &manager, &consumers, &peer_locks, |_| Ok(()))
                    .await,
                1
            );
            assert_eq!(
                router
                    .lock()
                    .await
                    .peer_session_snapshot("peer")
                    .unwrap()
                    .sidecar_port,
                0
            );
            assert!(consumers.lock().await.is_empty());
            assert_eq!(
                manager.lock().unwrap().is_live("session", generation),
                tab_present
            );
            if tab_present {
                release_session_sidecar(&manager, "session", &tab)
                    .await
                    .unwrap();
            }
        }
    }

    #[tokio::test]
    async fn stopped_consumer_settles_each_pending_request_and_rejects_late_registration() {
        use crate::im::enqueue::{drop_im_consumer, ensure_im_consumer};
        use crate::sidecar::{create_sidecar_manager, release_session_sidecar, SidecarOwner};
        let manager = create_sidecar_manager();
        let agent = SidecarOwner::Agent("peer".into());
        manager
            .lock()
            .unwrap()
            .insert_test_ready_frontend_sidecar("session", 1, agent.clone());
        let generation = manager.lock().unwrap().generation_for("session").unwrap();
        let consumers = Arc::new(Mutex::new(HashMap::new()));
        let adapter = Arc::new(RecordingAdapter::default());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let replies = ensure_im_consumer(
            &consumers,
            &manager,
            "peer",
            1,
            "session",
            generation,
            "r1".into(),
            adapter.clone(),
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(Mutex::new(HashMap::new())),
            crate::local_http::sse_client(),
            Arc::new(move |id, _| {
                let _ = tx.send(id);
            }),
        )
        .await
        .unwrap();
        for id in ["r1", "r2"] {
            assert!(replies.lock().await.register(
                id.into(),
                "chat".into(),
                "m".into(),
                ImSourceType::Private,
                None,
                None,
                Some(ImDeliveryProtocol::OpenClawReply)
            ));
        }
        drop_im_consumer(&consumers, "peer").await;
        for _ in 0..2 {
            tokio::time::timeout(Duration::from_secs(3), rx.recv())
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(replies.lock().await.slot_count(), 0);
        assert!(!replies.lock().await.register(
            "late".into(),
            "chat".into(),
            "m".into(),
            ImSourceType::Private,
            None,
            None,
            None
        ));
        assert_eq!(
            adapter
                .reply_operations()
                .iter()
                .filter(|op| op["kind"] == "abort")
                .count(),
            2
        );
        release_session_sidecar(&manager, "session", &agent)
            .await
            .unwrap();
        assert!(!manager.lock().unwrap().is_live("session", generation));
    }

    #[tokio::test]
    async fn old_generation_cleanup_cannot_release_or_cancel_a_new_request() {
        use crate::im::enqueue::{drop_im_consumer, ensure_im_consumer};
        use crate::sidecar::{create_sidecar_manager, release_session_sidecar, SidecarOwner};
        let manager = create_sidecar_manager();
        let agent = SidecarOwner::Agent("peer".into());
        manager
            .lock()
            .unwrap()
            .insert_test_ready_frontend_sidecar("session", 1, agent.clone());
        let old_generation = manager.lock().unwrap().generation_for("session").unwrap();
        let consumers = Arc::new(Mutex::new(HashMap::new()));
        let adapter = Arc::new(RecordingAdapter::default());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let callback: Arc<dyn Fn(String, super::TerminalOutcome) + Send + Sync> =
            Arc::new(move |id, _| {
                let _ = tx.send(id);
            });
        let old = ensure_im_consumer(
            &consumers,
            &manager,
            "peer",
            1,
            "session",
            old_generation,
            "old".into(),
            adapter.clone(),
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(Mutex::new(HashMap::new())),
            crate::local_http::sse_client(),
            callback.clone(),
        )
        .await
        .unwrap();
        assert!(old.lock().await.register(
            "old".into(),
            "chat".into(),
            "m".into(),
            ImSourceType::Private,
            None,
            None,
            Some(ImDeliveryProtocol::OpenClawReply)
        ));
        manager
            .lock()
            .unwrap()
            .insert_test_ready_frontend_sidecar("session", 1, agent.clone());
        let generation = manager.lock().unwrap().generation_for("session").unwrap();
        assert_ne!(generation, old_generation);
        let new = ensure_im_consumer(
            &consumers,
            &manager,
            "peer",
            1,
            "session",
            generation,
            "new".into(),
            adapter.clone(),
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(Mutex::new(HashMap::new())),
            crate::local_http::sse_client(),
            callback,
        )
        .await
        .unwrap();
        assert!(new.lock().await.register(
            "new".into(),
            "chat".into(),
            "m".into(),
            ImSourceType::Private,
            None,
            None,
            Some(ImDeliveryProtocol::OpenClawReply)
        ));
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), rx.recv())
                .await
                .unwrap()
                .unwrap(),
            "old"
        );
        assert_eq!(old.lock().await.slot_count(), 0);
        assert_eq!(new.lock().await.slot_count(), 1);
        assert!(!consumers.lock().await["peer"]
            .cancel
            .load(std::sync::atomic::Ordering::SeqCst));
        release_session_sidecar(&manager, "session", &agent)
            .await
            .unwrap();
        assert!(manager.lock().unwrap().is_live("session", generation));
        drop_im_consumer(&consumers, "peer").await;
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), rx.recv())
                .await
                .unwrap()
                .unwrap(),
            "new"
        );
        assert!(!manager.lock().unwrap().is_live("session", generation));
    }

    #[tokio::test]
    async fn recovered_terminal_uses_canonical_text_instead_of_a_truncated_native_draft() {
        let mut replies = ReplyRouter::new(
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(Mutex::new(HashMap::new())),
        );
        replies.register(
            "r".into(),
            "chat".into(),
            "m".into(),
            ImSourceType::Private,
            None,
            None,
            None,
        );
        let adapter = RecordingAdapter::default();
        replies
            .dispatch(
                &json!({"requestId":"r","type":"delta","data":"partial"}),
                &adapter,
                0,
            )
            .await;
        assert!(replies.dispatch(&json!({"requestId":"r","type":"complete","reconciled":true,"data":{"finalPayloads":[{"text":"full canonical answer"}]}}), &adapter, 0).await.is_some());
        assert!(adapter
            .sent_messages()
            .iter()
            .any(|(_, text)| text == "full canonical answer"));
        assert!(replies.claim_terminal_callback("r"));
        assert!(!replies.claim_terminal_callback("r"));
    }
    struct ConsumerProbe {
        replies: super::SharedReplyRouter,
        consumers: crate::im::ImConsumers,
        manager: crate::sidecar::ManagedSidecarManager,
        events: tokio::sync::broadcast::Sender<serde_json::Value>,
        receipt: Arc<StdMutex<serde_json::Value>>,
        queries: Arc<StdMutex<Vec<serde_json::Value>>>,
        queried: Arc<tokio::sync::Notify>,
        cancellations: Arc<StdMutex<Vec<serde_json::Value>>>,
        terminal: tokio::sync::mpsc::UnboundedReceiver<String>,
        connections: tokio::sync::mpsc::UnboundedReceiver<u64>,
        server: tauri::async_runtime::JoinHandle<()>,
        port: u16,
    }

    impl ConsumerProbe {
        async fn start(adapter: Arc<RecordingAdapter>) -> Self {
            use crate::sidecar::{create_sidecar_manager, SidecarOwner};
            use axum::{
                extract::Query,
                response::sse::{Event, Sse},
                routing::{get, post},
                Json,
            };
            let (events, _) = tokio::sync::broadcast::channel::<serde_json::Value>(32);
            let (connected, mut connections) = tokio::sync::mpsc::unbounded_channel();
            let receipt = Arc::new(StdMutex::new(json!({"outcomes":{"r":{"state":"active"}}})));
            let queries = Arc::new(StdMutex::new(Vec::new()));
            let queried = Arc::new(tokio::sync::Notify::new());
            let cancellations = Arc::new(StdMutex::new(Vec::new()));
            let app = axum::Router::new()
                .route(
                    "/api/im/events",
                    get({
                        let events = events.clone();
                        let connected = connected.clone();
                        move |Query(query): Query<HashMap<String, String>>| {
                            let receiver = events.subscribe();
                            connected
                                .send(query["since"].parse::<u64>().unwrap())
                                .unwrap();
                            async move {
                                Sse::new(futures_util::stream::unfold(receiver, |mut rx| async {
                                    rx.recv().await.ok().map(|event| {
                                        (
                                            Ok::<_, std::convert::Infallible>(
                                                Event::default().json_data(event).unwrap(),
                                            ),
                                            rx,
                                        )
                                    })
                                }))
                            }
                        }
                    }),
                )
                .route(
                    "/api/im/requests",
                    post({
                        let receipt = receipt.clone();
                        let queries = queries.clone();
                        let queried = queried.clone();
                        move |Json(body): Json<serde_json::Value>| {
                            // Pre-admission queries stay active in this scenario,
                            // including an immediate interval query still in flight
                            // when the test installs the post-admission terminal.
                            let result = if body["settleUnknown"] == json!([]) {
                                json!({"outcomes":{"r":{"state":"active"}}})
                            } else {
                                receipt.lock().unwrap().clone()
                            };
                            queries.lock().unwrap().push(body);
                            queried.notify_one();
                            async move { Json(result) }
                        }
                    }),
                )
                .route(
                    "/api/im/cancel",
                    post({
                        let cancellations = cancellations.clone();
                        move |Json(body): Json<serde_json::Value>| {
                            cancellations.lock().unwrap().push(body);
                            async { Json(json!({"success":true})) }
                        }
                    }),
                );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tauri::async_runtime::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            let manager = create_sidecar_manager();
            manager.lock().unwrap().insert_test_ready_frontend_sidecar(
                "session",
                port,
                SidecarOwner::Tab("tab".into()),
            );
            let generation = manager.lock().unwrap().generation_for("session").unwrap();
            let consumers = Arc::new(Mutex::new(HashMap::new()));
            let (tx, terminal) = tokio::sync::mpsc::unbounded_channel();
            let replies = crate::im::enqueue::ensure_im_consumer(
                &consumers,
                &manager,
                "peer",
                port,
                "session",
                generation,
                "r".into(),
                adapter,
                Default::default(),
                Default::default(),
                crate::local_http::sse_client(),
                Arc::new(move |id, _| {
                    tx.send(id).unwrap();
                }),
            )
            .await
            .unwrap();
            assert!(replies.lock().await.register(
                "r".into(),
                "chat".into(),
                "msg".into(),
                ImSourceType::Private,
                None,
                None,
                Some(ImDeliveryProtocol::OpenClawReply)
            ));
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(3), connections.recv())
                    .await
                    .unwrap(),
                Some(0)
            );
            Self {
                replies,
                consumers,
                manager,
                events,
                receipt,
                queries,
                queried,
                cancellations,
                terminal,
                connections,
                server,
                port,
            }
        }

        async fn stopped(&mut self) {
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(3), self.terminal.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                "r"
            );
            assert_eq!(self.replies.lock().await.slot_count(), 0);
            assert!(self.terminal.try_recv().is_err());
        }

        async fn close(self) {
            let handle = self.consumers.lock().await.remove("peer").unwrap();
            handle
                .cancel
                .store(true, std::sync::atomic::Ordering::SeqCst);
            tokio::time::timeout(Duration::from_secs(3), handle._join)
                .await
                .unwrap()
                .unwrap();
            crate::sidecar::release_session_sidecar(
                &self.manager,
                "session",
                &crate::sidecar::SidecarOwner::Tab("tab".into()),
            )
            .await
            .unwrap();
            assert!(!self.manager.lock().unwrap().has_session_sidecar("session"));
            self.server.abort();
        }
    }

    #[tokio::test]
    async fn consumer_stop_preserves_terminal_before_and_after_bridge_acceptance() {
        for before_accept in [true, false] {
            let pause = Arc::new(TerminalPause {
                before_accept,
                used: false.into(),
                entered: Default::default(),
                release: Default::default(),
            });
            let adapter = Arc::new(RecordingAdapter {
                terminal_pause: Some(pause.clone()),
                ..Default::default()
            });
            let mut probe = ConsumerProbe::start(adapter.clone()).await;
            let payload = json!([{"text":"canonical result"}]);
            probe.events.send(json!({"seq":1,"requestId":"r","type":"complete","data":{"finalPayloads":payload}})).unwrap();
            tokio::time::timeout(Duration::from_secs(3), pause.entered.notified())
                .await
                .unwrap();
            probe.consumers.lock().await["peer"]
                .cancel
                .store(true, std::sync::atomic::Ordering::SeqCst);
            probe.stopped().await;
            let operations = adapter.reply_operations();
            assert_eq!(
                operations
                    .iter()
                    .filter(|op| op["kind"] == "complete")
                    .count(),
                1
            );
            assert!(operations.iter().any(|op| op["finalPayloads"] == payload));
            assert!(!operations.iter().any(|op| op["kind"] == "abort"));
            assert!(probe.cancellations.lock().unwrap().is_empty());
            probe.close().await;
        }
    }

    #[tokio::test]
    async fn consumer_reconciles_gap_after_active_receipt_without_reexecuting() {
        let adapter = Arc::new(RecordingAdapter::default());
        let mut probe = ConsumerProbe::start(adapter.clone()).await;
        tokio::time::timeout(Duration::from_secs(3), async {
            while probe.queries.lock().unwrap().is_empty() {
                probe.queried.notified().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(probe.queries.lock().unwrap()[0]["settleUnknown"], json!([]));
        assert_eq!(probe.replies.lock().await.slot_count(), 1);
        assert!(probe.terminal.try_recv().is_err());
        probe.replies.lock().await.finish_admission("r");
        let payload = json!([{"text":"recovered canonical"}]);
        *probe.receipt.lock().unwrap() = json!({"outcomes":{"r":{"state":"terminal","event":{
            "requestId":"r","type":"complete","data":{"finalPayloads":payload}
        }}}});
        probe
            .events
            .send(json!({"seq":20,"requestId":null,"type":"gap","data":{"droppedSeqs":[1,20]}}))
            .unwrap();
        probe.stopped().await;
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), probe.connections.recv())
                .await
                .unwrap(),
            Some(20),
            "the gap must reconnect from its last dropped sequence"
        );
        assert!(probe
            .queries
            .lock()
            .unwrap()
            .iter()
            .any(|q| q["settleUnknown"] == json!(["r"])));
        assert_eq!(
            adapter
                .reply_operations()
                .iter()
                .filter(|op| op["kind"] == "complete")
                .count(),
            1
        );
        assert!(probe.cancellations.lock().unwrap().is_empty());
        probe.close().await;
    }

    #[tokio::test]
    async fn consumer_panic_cleans_question_and_releases_request_lease() {
        let adapter = Arc::new(RecordingAdapter {
            panic_start_once: true.into(),
            ..Default::default()
        });
        let mut probe = ConsumerProbe::start(adapter.clone()).await;
        probe.replies.lock().await.dispatch(&json!({"requestId":"r","type":"ask-user-question-request","data":serde_json::to_string(&json!({
            "requestId":"ask-1","questions":[{"id":"choice","header":"Choice","question":"Pick one","options":[{"label":"A","description":""}],"multiSelect":false}]
        })).unwrap()}), adapter.as_ref(), probe.port).await;
        let questions = probe.replies.lock().await.pending_questions.clone();
        assert!(questions.lock().await.contains_key("ask-1"));
        probe
            .events
            .send(json!({"seq":1,"requestId":"r","type":"delta","data":"trigger panic"}))
            .unwrap();
        probe.stopped().await;
        assert!(questions.lock().await.is_empty());
        assert_eq!(
            adapter
                .reply_operations()
                .iter()
                .filter(|op| op["kind"] == "abort")
                .count(),
            1
        );
        assert_eq!(probe.cancellations.lock().unwrap().len(), 1);
        let generation = probe
            .manager
            .lock()
            .unwrap()
            .generation_for("session")
            .unwrap();
        // A replacement consumer can still admit work on the retained Tab's Session.
        let mut replacement = ReplyRouter::new(Default::default(), Default::default());
        replacement.set_lifecycle(
            Arc::new(false.into()),
            probe.manager.clone(),
            "session".into(),
            generation,
        );
        assert!(replacement.register(
            "next".into(),
            "chat".into(),
            "msg".into(),
            ImSourceType::Private,
            None,
            None,
            None
        ));
        replacement.unregister("next").await;
        probe.close().await;
    }
}
