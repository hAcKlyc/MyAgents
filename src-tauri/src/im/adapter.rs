// Abstract IM channel adapter trait.
//
// Each messaging platform (Telegram, Discord, Slack, ...) implements this
// trait so that the core processing loop in `mod.rs` stays channel-agnostic.

/// Result alias with plain String error (channel-specific error types are
/// mapped to String at the impl boundary).
pub type AdapterResult<T> = Result<T, String>;

/// A terminal handoff ACK is distinct from the producer's execution outcome
/// and from the plugin's eventual platform delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplyDispatchAdmission {
    Accepted,
    /// The Bridge explicitly confirmed that the original dispatcher is gone.
    DispatchMissing,
}

use super::types::{AskUserQuestionPayload, ImSourceType};
use serde_json::Value;

pub trait ImAdapter: Send + Sync + 'static {
    /// Optional, read-only display metadata for already configured peers.
    /// Implementations bound IO and never authorize peers or send messages.
    fn peer_names(
        &self,
        _targets: &super::peer_names::PeerNameTargets,
    ) -> impl std::future::Future<Output = Vec<super::peer_names::PeerDisplayName>> + Send {
        async { Vec::new() }
    }

    /// Verify the bot connection and return a human-readable identifier
    /// (e.g. Telegram bot username, Discord bot tag).
    fn verify_connection(&self) -> impl std::future::Future<Output = AdapterResult<String>> + Send;

    /// Register platform-specific commands (e.g. Telegram BotFather menu).
    /// No-op for platforms that don't support command registration.
    fn register_commands(&self) -> impl std::future::Future<Output = AdapterResult<()>> + Send;

    /// Start the message receive loop (long-polling, WebSocket, etc.).
    /// Blocks until `shutdown_rx` signals `true`.
    fn listen_loop(
        &self,
        shutdown_rx: tokio::sync::watch::Receiver<bool>,
    ) -> impl std::future::Future<Output = ()> + Send;

    /// Send a text message to the given chat.
    fn send_message(
        &self,
        chat_id: &str,
        text: &str,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send;

    /// React to indicate the message was received (e.g. 👀).
    fn ack_received(
        &self,
        chat_id: &str,
        message_id: &str,
    ) -> impl std::future::Future<Output = ()> + Send;

    /// React to indicate processing has started (e.g. ⏳).
    fn ack_processing(
        &self,
        chat_id: &str,
        message_id: &str,
    ) -> impl std::future::Future<Output = ()> + Send;

    /// Clear acknowledgement reactions.
    fn ack_clear(
        &self,
        chat_id: &str,
        message_id: &str,
    ) -> impl std::future::Future<Output = ()> + Send;

    /// Send a "typing" / "processing" indicator to the chat.
    fn send_typing(&self, chat_id: &str) -> impl std::future::Future<Output = ()> + Send;
}

/// Extended adapter trait for platforms that support streaming draft messages.
/// Provides send_message_returning_id, edit_message, and delete_message
/// so the SSE stream loop can manage draft messages generically.
pub trait ImStreamAdapter: ImAdapter {
    /// Send a message and return its ID (for later edit/delete).
    fn send_message_returning_id(
        &self,
        chat_id: &str,
        text: &str,
    ) -> impl std::future::Future<Output = AdapterResult<Option<String>>> + Send;

    /// Edit an existing message by ID.
    fn edit_message(
        &self,
        chat_id: &str,
        message_id: &str,
        text: &str,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send;

    /// Delete a message by ID.
    fn delete_message(
        &self,
        chat_id: &str,
        message_id: &str,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send;

    /// Max message length in bytes for this platform (Telegram: 4096, Feishu: 15000).
    fn max_message_length(&self) -> usize;

    /// Send an interactive approval card/keyboard and return its message ID.
    /// Used for permission requests when the bot runs in non-fullAgency mode.
    fn send_approval_card(
        &self,
        chat_id: &str,
        request_id: &str,
        tool_name: &str,
        tool_input: &str,
    ) -> impl std::future::Future<Output = AdapterResult<Option<String>>> + Send;

    /// Update an approval card/message to show resolved status (approved/denied).
    fn update_approval_status(
        &self,
        chat_id: &str,
        message_id: &str,
        status: &str,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send;

    /// Send AskUserQuestion using a native card, or the shared text presentation.
    /// Both transports answer the same pending request.
    fn send_question_card(
        &self,
        chat_id: &str,
        payload: &AskUserQuestionPayload,
        source_type: &ImSourceType,
    ) -> impl std::future::Future<Output = AdapterResult<Option<String>>> + Send {
        async move {
            self.send_message(
                chat_id,
                &super::questions::format_question_content(payload, source_type),
            )
            .await?;
            Ok(None)
        }
    }

    /// Update a question card/message to show submitted/cancelled/expired status.
    fn update_question_status(
        &self,
        _chat_id: &str,
        _message_id: &str,
        _status: &str,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send {
        async { Ok(()) }
    }

    /// Send a photo/image to the given chat. Returns the sent message ID if available.
    fn send_photo(
        &self,
        chat_id: &str,
        data: Vec<u8>,
        filename: &str,
        caption: Option<&str>,
    ) -> impl std::future::Future<Output = AdapterResult<Option<String>>> + Send;

    /// Send a file/document to the given chat. Returns the sent message ID if available.
    fn send_file(
        &self,
        chat_id: &str,
        data: Vec<u8>,
        filename: &str,
        mime_type: &str,
        caption: Option<&str>,
    ) -> impl std::future::Future<Output = AdapterResult<Option<String>>> + Send;

    /// Finalize a streamed message block. Override for format-switching
    /// (e.g., Feishu Card Kit: detect table/code → delete Post + send Card).
    /// Default: edit in place.
    fn finalize_message(
        &self,
        chat_id: &str,
        message_id: &str,
        text: &str,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send;

    /// Whether this adapter uses draft streaming (affects finalize behavior).
    /// When true, finalize_block will delete draft + send_message instead of edit_message.
    fn use_draft_streaming(&self) -> bool {
        false
    }

    /// Whether this adapter supports edit_message (progressive updates during streaming).
    /// When false, the streaming loop skips draft creation and edit calls entirely,
    /// accumulating text and sending once at block-end via finalize_block.
    /// Default: true. Bridge adapter returns false when the plugin lacks edit capability.
    fn supports_edit(&self) -> bool {
        true
    }

    /// Preferred throttle interval in ms for draft edits. Default 1000ms.
    fn preferred_throttle_ms(&self) -> u64 {
        1000
    }

    /// Bridge context for OpenClaw plugin adapters.
    /// Returns (bridge_port, plugin_id, enabled_tool_groups) if this is a Bridge adapter.
    /// Default: None (not a Bridge adapter).
    fn bridge_context(&self) -> Option<(u16, String, Vec<String>)> {
        None
    }

    // ===== Request-scoped OpenClaw reply protocol =====
    // The producer selects this contract per message. Implementations only
    // transport operations; rendering, pacing, fallback, and delivery idle
    // remain owned by the loaded OpenClaw plugin.

    fn start_reply_dispatch(
        &self,
        _request_id: &str,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send {
        async { Err("request-scoped reply dispatch is not supported".to_string()) }
    }

    fn set_reply_delivery_mode(
        &self,
        _request_id: &str,
        _mode: super::types::ChannelDeliveryMode,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send {
        async { Ok(()) }
    }

    fn start_reply_stream(
        &self,
        _request_id: &str,
        _chat_id: &str,
        _initial_text: &str,
    ) -> impl std::future::Future<Output = AdapterResult<String>> + Send {
        async { Err("request-scoped reply streaming is not supported".to_string()) }
    }

    fn update_reply_stream(
        &self,
        _stream_id: &str,
        _text: &str,
        _sequence: u32,
        _is_thinking: bool,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send {
        async { Err("request-scoped reply streaming is not supported".to_string()) }
    }

    fn finish_reply_stream_block(
        &self,
        _stream_id: &str,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send {
        async { Err("request-scoped reply streaming is not supported".to_string()) }
    }

    fn complete_reply_dispatch(
        &self,
        _request_id: &str,
        _final_payloads: &Value,
    ) -> impl std::future::Future<Output = AdapterResult<ReplyDispatchAdmission>> + Send {
        async { Err("request-scoped reply dispatch is not supported".to_string()) }
    }

    fn abort_reply_dispatch(
        &self,
        _request_id: &str,
        _reason: &str,
        _terminal_payload: &Value,
    ) -> impl std::future::Future<Output = AdapterResult<ReplyDispatchAdmission>> + Send {
        async { Err("request-scoped reply dispatch is not supported".to_string()) }
    }

    // ===== CardKit Streaming Protocol =====
    // These methods enable adapters to use a dedicated streaming protocol
    // (e.g., Feishu CardKit streaming, Bridge plugin streaming) instead of
    // the default edit-based draft message flow.
    //
    // Default implementations are no-ops / stubs. Adapters that support
    // streaming MUST override `supports_streaming()` to return `true` and
    // provide real implementations for the other methods.

    /// Whether this adapter supports the streaming protocol.
    /// When true, `stream_to_im` will use `start_stream` / `stream_chunk` /
    /// `finalize_stream` / `abort_stream` instead of the edit-based flow.
    fn supports_streaming(&self) -> bool {
        false
    }

    /// Start a streaming session. Returns a stream_id for subsequent chunks.
    /// Default: returns empty string (never called when `supports_streaming` is false).
    fn start_stream(
        &self,
        _chat_id: &str,
        _initial_text: &str,
    ) -> impl std::future::Future<Output = AdapterResult<String>> + Send {
        async { Ok(String::new()) }
    }

    /// Push a content chunk to an active stream.
    /// Default: no-op (never called when `supports_streaming` is false).
    fn stream_chunk(
        &self,
        _chat_id: &str,
        _stream_id: &str,
        _text: &str,
        _sequence: u32,
        _is_thinking: bool,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send {
        async { Ok(()) }
    }

    /// Finalize a stream with final content.
    /// Default: no-op (never called when `supports_streaming` is false).
    fn finalize_stream(
        &self,
        _chat_id: &str,
        _stream_id: &str,
        _final_text: &str,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send {
        async { Ok(()) }
    }

    /// Abort an active stream.
    /// Default: no-op.
    fn abort_stream(
        &self,
        _chat_id: &str,
        _stream_id: &str,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send {
        async { Ok(()) }
    }

    /// Hook called after a turn's events have been fully dispatched (terminal
    /// 'complete' / 'error'). DingTalk overrides this to finalize AI Card
    /// state. Default: no-op.
    fn post_stream_cleanup(&self, _chat_id: &str) -> impl std::future::Future<Output = ()> + Send {
        async { /* default no-op */ }
    }
}

/// Push a fully-formed text message to IM, preferring the streaming protocol
/// when the adapter supports it.
///
/// Why this exists: chat replies go through `reply_router` which uses
/// `start_stream` / `stream_chunk` / `finalize_stream` (CardKit on Feishu,
/// AI Card on DingTalk, draft+edit on Telegram). Out-of-band pushes
/// (heartbeat content, cron-completion notifications, system pause notices)
/// historically called plain `send_message`, which on Feishu maps to
/// `msg_type: "post"` (chat bubble) instead of `msg_type: "interactive"`
/// (CardKit). The two surfaces render with different font sizes and styles
/// in the Feishu client, breaking visual consistency.
///
/// This helper closes that gap: complete content is delivered via
/// `start_stream(text) → finalize_stream(text)`, so it lands on the same
/// CardKit surface as live chat replies. Falls back to `send_message`
/// transparently when the adapter doesn't support streaming, or when
/// any streaming step fails.
pub async fn push_text_preferring_stream<A: ImStreamAdapter>(
    adapter: &A,
    chat_id: &str,
    text: &str,
) -> AdapterResult<()> {
    if !adapter.supports_streaming() {
        return adapter.send_message(chat_id, text).await;
    }
    match adapter.start_stream(chat_id, text).await {
        Ok(stream_id) => {
            if let Err(e) = adapter.finalize_stream(chat_id, &stream_id, text).await {
                let _ = adapter.abort_stream(chat_id, &stream_id).await;
                crate::ulog_warn!(
                    "[adapter] push_text_preferring_stream: finalize_stream failed, falling back: {}",
                    e
                );
                return adapter.send_message(chat_id, text).await;
            }
            Ok(())
        }
        Err(e) => {
            crate::ulog_warn!(
                "[adapter] push_text_preferring_stream: start_stream failed, falling back: {}",
                e
            );
            adapter.send_message(chat_id, text).await
        }
    }
}

/// Split a message into chunks at natural break points (paragraph, line, sentence, word).
/// Used by platform adapters to split oversized messages into multiple sends.
pub fn split_message(text: &str, max_len: usize) -> Vec<String> {
    if text.len() <= max_len {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut remaining = text;

    while !remaining.is_empty() {
        if remaining.len() <= max_len {
            chunks.push(remaining.to_string());
            break;
        }

        // Find a char-boundary-safe upper bound (max_len may fall mid-character for CJK/emoji)
        let mut safe_end = max_len.min(remaining.len());
        while !remaining.is_char_boundary(safe_end) {
            safe_end -= 1;
        }

        // Try to find a good break point within the safe range
        let search_range = &remaining[..safe_end];
        let break_point = search_range
            .rfind("\n\n") // Paragraph break
            .or_else(|| search_range.rfind('\n')) // Line break
            .or_else(|| search_range.rfind(". ")) // Sentence
            .or_else(|| search_range.rfind(' ')) // Word
            .unwrap_or(safe_end); // Hard cut at char boundary

        let break_at = if break_point == 0 {
            safe_end
        } else {
            break_point
        };

        chunks.push(remaining[..break_at].to_string());
        remaining = remaining[break_at..].trim_start();
    }

    chunks
}
