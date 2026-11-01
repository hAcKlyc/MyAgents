// IM Pipeline v2 — Pattern C: ImEventConsumer
//
// Long-polls /api/im/events on the Sidecar for one peer_session, demuxes the
// fan-in event stream by requestId via ReplyRouter. Owns the SSE connection
// + reconnect lifecycle (exponential backoff, `since=<lastSeq>` resume on
// reconnect for crash-recovery semantics).
//
// One ImEventConsumer task per peer_session. Spawned by `mod.rs` after
// `ensure_sidecar` returns, cancelled by setting the shared AtomicBool when
// the peer_session goes idle. Replaces the per-message SSE consumer that
// lived inside `stream_to_im` (the old /api/im/chat path).

#![allow(dead_code)] // Wired up in Pattern C-6 (mod.rs spawn refactor).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::{FutureExt, StreamExt};
use reqwest::Client;
use serde_json::Value;
use std::panic::AssertUnwindSafe;
use tauri::async_runtime::JoinHandle;
use tokio::sync::Mutex;

use super::adapter::ImStreamAdapter;
use super::reply_router::{ReplyRouter, TerminalOutcome};
use crate::{ulog_info, ulog_warn};

const RECONNECT_INITIAL_MS: u64 = 200;
const RECONNECT_MAX_MS: u64 = 5_000;

/// Shared cancellation flag handed to the consumer task. The owner (mod.rs
/// spawn or peer_session lifecycle) flips it via `cancel.store(true,
/// Ordering::SeqCst)` to terminate the loop.
pub type CancelFlag = Arc<AtomicBool>;

/// Spawns a long-poll consumer task. The task runs until `cancel` flips true;
/// on transient errors it reconnects with exponential backoff and resumes via
/// `?since=<lastSeq>`.
///
/// On a terminal event ('complete' / 'error' / 'cancelled'), the matching
/// slot is removed from `router` and `on_terminal` is invoked with the
/// requestId + outcome (used by mod.rs to record session_id + fire post-stream
/// cleanup).
/// Spawn a long-poll consumer for a peer_session. The `session_label` arg is
/// used for log identification only — the Sidecar's /api/im/events does not
/// filter by session (Sidecar is 1:1 with session, so the bus implicitly
/// scopes). Kept as a parameter so the log line can identify which
/// peer_session this consumer belongs to.
pub(super) struct ConsumerLifetime {
    pub cancel: CancelFlag,
    pub retire_when_idle: CancelFlag,
    pub manager: crate::sidecar::ManagedSidecarManager,
    pub generation: u64,
}

pub(super) fn spawn_consumer<A>(
    client: Client,
    sidecar_port: u16,
    session_label: String,
    initial_replay_request_id: String,
    router: Arc<Mutex<ReplyRouter>>,
    adapter: Arc<A>,
    lifetime: ConsumerLifetime,
    on_terminal: Arc<dyn Fn(String, TerminalOutcome) + Send + Sync>,
) -> JoinHandle<()>
where
    A: ImStreamAdapter + Send + Sync + 'static,
{
    tauri::async_runtime::spawn(async move {
        let ConsumerLifetime {
            cancel,
            retire_when_idle,
            manager,
            generation,
        } = lifetime;
        let mut last_seq: u64 = 0;
        let mut backoff_ms = RECONNECT_INITIAL_MS;
        let mut reconcile_tick = tokio::time::interval(Duration::from_secs(15));
        reconcile_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        let consume = AssertUnwindSafe(async {
            'consume: loop {
                if retire_when_idle.load(Ordering::SeqCst) && router.lock().await.slot_count() == 0 {
                    cancel.store(true, Ordering::SeqCst);
                    break 'consume;
                }
                if cancel.load(Ordering::SeqCst) {
                    ulog_info!(
                        "[event-consumer] Cancelled (session={})",
                        &session_label[..session_label.len().min(8)],
                    );
                    break 'consume;
                }

                reconcile_requests(&client, sidecar_port, &router, adapter.as_ref(), &on_terminal).await;
                // W6 fix: legacy URL had `?session=<id>` but the Sidecar handler
                // never read it (Sidecar is 1:1 with session). Removed to avoid
                // misleading future readers.
                let url = events_url(sidecar_port, last_seq, &initial_replay_request_id);

                let response_result = client
                    .get(&url)
                    .header("Accept", "text/event-stream")
                    .send()
                    .await;

                let response = match response_result {
                    Ok(resp) if resp.status().is_success() => {
                        backoff_ms = RECONNECT_INITIAL_MS;
                        resp
                    }
                    Ok(resp) => {
                        ulog_warn!(
                            "[event-consumer] /api/im/events returned {} (port={})",
                            resp.status(),
                            sidecar_port,
                        );
                        sleep_with_cancel(&cancel, backoff_ms).await;
                        backoff_ms = (backoff_ms * 2).min(RECONNECT_MAX_MS);
                        continue;
                    }
                    Err(e) => {
                        ulog_warn!(
                            "[event-consumer] connect failed: {} (port={}) — retry in {}ms",
                            e,
                            sidecar_port,
                            backoff_ms,
                        );
                        sleep_with_cancel(&cancel, backoff_ms).await;
                        backoff_ms = (backoff_ms * 2).min(RECONNECT_MAX_MS);
                        continue;
                    }
                };

                let mut byte_stream = response.bytes_stream();
                let mut buffer = String::new();

                'inner: loop {
                    if retire_when_idle.load(Ordering::SeqCst) && router.lock().await.slot_count() == 0
                    {
                        cancel.store(true, Ordering::SeqCst);
                        break 'consume;
                    }
                    if cancel.load(Ordering::SeqCst) {
                        break 'consume;
                    }
                    // W8a fix: race the stream read against a periodic cancel
                    // poll. Without this, a quiet stream (no events for tens of
                    // seconds) leaves us blocked on `byte_stream.next()` until
                    // the next byte arrives — flipping `cancel` from outside
                    // takes effect only when the upstream reconnect happens.
                    // 1s tick is fine; bus produces deltas << 1s apart in
                    // active turns, and idle is the case we're optimizing.
                    let chunk_result = tokio::select! {
                        biased;
                        _ = tokio::time::sleep(Duration::from_secs(1)) => {
                            // Tick: check cancel and continue waiting for the next byte.
                            if cancel.load(Ordering::SeqCst) {
                                break 'consume;
                            }
                            continue 'inner;
                        }
                        _ = reconcile_tick.tick() => {
                            reconcile_requests(&client, sidecar_port, &router, adapter.as_ref(), &on_terminal).await;
                            continue 'inner;
                        }
                        res = byte_stream.next() => res,
                    };
                    match chunk_result {
                        Some(Ok(chunk)) => {
                            let bytes_ref: &[u8] = chunk.as_ref();
                            buffer.push_str(&String::from_utf8_lossy(bytes_ref));
                            while let Some(pos) = buffer.find("\n\n") {
                                let event_str: String = buffer.drain(..pos).collect();
                                buffer.drain(..2);
                                if event_str.starts_with(':') {
                                    continue;
                                }
                                let data = extract_data(&event_str);
                                if data.is_empty() {
                                    continue;
                                }
                                let bus_event: Value = match serde_json::from_str(&data) {
                                    Ok(v) => v,
                                    Err(_) => continue,
                                };
                                if let Some(seq) = bus_event.get("seq").and_then(|s| s.as_u64()) {
                                    if seq > last_seq {
                                        last_seq = seq;
                                    }
                                }
                                // Reconnect and reconcile receipts on a gap. Missing
                                // deltas alone must never abort an active execution.
                                if bus_event["type"] == "gap" {
                                    if let Some(end) = bus_event.pointer("/data/droppedSeqs/1").and_then(Value::as_u64) {
                                        last_seq = last_seq.max(end);
                                    }
                                    break 'inner;
                                }
                                dispatch_event(&bus_event, &router, adapter.as_ref(), sidecar_port, &on_terminal).await;
                            }
                        }
                        Some(Err(e)) => {
                            ulog_warn!("[event-consumer] stream error: {} — reconnecting", e);
                            break 'inner;
                        }
                        None => {
                            ulog_info!("[event-consumer] stream ended — reconnecting");
                            break 'inner;
                        }
                    }
                }

                sleep_with_cancel(&cancel, backoff_ms).await;
                backoff_ms = (backoff_ms * 2).min(RECONNECT_MAX_MS);
            }
        }).catch_unwind();
        tokio::select! {
            result = consume => {
                if result.is_err() {
                    ulog_warn!("[event-consumer] Consumer failed; settling outstanding replies");
                }
            }
            _ = async {
                loop {
                    if cancel.load(Ordering::SeqCst)
                        || !manager.lock().unwrap_or_else(|e| e.into_inner()).is_live(&session_label, generation)
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            } => {}
        }
        cancel.store(true, Ordering::SeqCst);
        let mut pending = router.lock().await.take_for_shutdown();
        for request_id in pending.request_ids() {
            // A live producer must receive explicit cancellation on Channel or
            // consumer shutdown. An SSE transport error never enters this path.
            let producer_live = manager
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_live(&session_label, generation);
            let observed_terminal = pending.producer_terminal(&request_id).cloned();
            if producer_live && observed_terminal.is_none() {
                let _ = client
                    .post(format!("http://127.0.0.1:{sidecar_port}/api/im/cancel"))
                    .timeout(Duration::from_secs(2))
                    .json(
                        &serde_json::json!({"requestId": request_id, "reason": "channel-stopped"}),
                    )
                    .send()
                    .await;
            }
            // Terminal admission is bounded; a dead bridge cannot retain an
            // execution lease forever. Timeout means unknown delivery, not sent.
            let replay_terminal =
                observed_terminal.is_none() || pending.uses_idempotent_terminal(&request_id);
            let terminal = observed_terminal.unwrap_or_else(|| {
                serde_json::json!({
                    "requestId": request_id, "type": "error",
                    "data": {"finalPayloads": [{"text": if producer_live {
                        "回复连接已中断，已请求停止本轮执行；请在桌面确认状态后重试。"
                    } else { "会话执行已中断，请重新发送。" }, "isError": true}]}
                })
            });
            // Native platform I/O has no idempotent terminal contract. If it
            // was interrupted, keep the execution result and do not replay it.
            let result = if replay_terminal {
                tokio::time::timeout(
                    Duration::from_secs(10),
                    AssertUnwindSafe(pending.dispatch(&terminal, adapter.as_ref(), sidecar_port))
                        .catch_unwind(),
                )
                .await
                .ok()
            } else {
                None
            };
            if !matches!(result, Some(Ok(Some(_)))) {
                ulog_warn!(
                    "[event-consumer] Interrupted reply delivery unknown requestId={}",
                    request_id
                );
            }
            let claimed = pending.claim_terminal_callback(&request_id);
            pending.clear_interactions(&request_id).await;
            pending.unregister(&request_id).await;
            if !claimed {
                continue;
            }
            let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
                on_terminal(
                    request_id,
                    TerminalOutcome {
                        session_id: None,
                        silent: false,
                    },
                )
            }));
        }
    })
}

async fn dispatch_event<A: ImStreamAdapter>(
    event: &Value,
    router: &Arc<Mutex<ReplyRouter>>,
    adapter: &A,
    port: u16,
    on_terminal: &Arc<dyn Fn(String, TerminalOutcome) + Send + Sync>,
) {
    let mut replies = router.lock().await;
    if let Some(outcome) = replies.dispatch(event, adapter, port).await {
        let request_id = event["requestId"].as_str().unwrap_or("").to_string();
        let claimed = replies.claim_terminal_callback(&request_id);
        drop(replies);
        // The callback acquires its model-work guard before the reply lease is
        // released. Never call it under the router lock (also on recovery).
        if claimed {
            on_terminal(request_id.clone(), outcome);
        }
        let mut replies = router.lock().await;
        replies.clear_interactions(&request_id).await;
        replies.unregister(&request_id).await;
    }
}

/// Recovery stays inside the existing consumer and request registry. The
/// producer atomically seals truly missing IDs, fencing delayed enqueue POSTs.
async fn reconcile_requests<A: ImStreamAdapter>(
    client: &Client,
    port: u16,
    router: &Arc<Mutex<ReplyRouter>>,
    adapter: &A,
    on_terminal: &Arc<dyn Fn(String, TerminalOutcome) + Send + Sync>,
) {
    let (retained, ids, settle_unknown) = {
        let replies = router.lock().await;
        let mut retained = Vec::new();
        let mut ids = Vec::new();
        for id in replies.request_ids() {
            if replies.uses_idempotent_terminal(&id) {
                if let Some(terminal) = replies.producer_terminal(&id) {
                    retained.push(terminal.clone());
                    continue;
                }
            }
            ids.push(id);
        }
        (retained, ids, replies.reconcilable_request_ids())
    };
    // A known producer terminal no longer depends on its delta ring, retained
    // receipt TTL or even a reachable producer. Retry the original handoff
    // inside this consumer's existing recovery cycle, outside the wait loop.
    for event in retained {
        dispatch_event(&event, router, adapter, port, on_terminal).await;
    }
    for ids in ids.chunks(200) {
        let response = client
            .post(format!("http://127.0.0.1:{port}/api/im/requests"))
            .timeout(Duration::from_secs(3))
            .json(&serde_json::json!({"requestIds": ids, "settleUnknown": settle_unknown}))
            .send()
            .await;
        let Ok(response) = response else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let Ok(body) = response.json::<Value>().await else {
            continue;
        };
        for id in ids {
            let outcome = &body["outcomes"][id];
            if outcome["state"] != "terminal" {
                continue;
            }
            let mut event = outcome["event"].clone();
            event["reconciled"] = Value::Bool(true);
            dispatch_event(&event, router, adapter, port, on_terminal).await;
        }
    }
}

fn events_url(sidecar_port: u16, last_seq: u64, initial_replay_request_id: &str) -> String {
    if last_seq == 0 {
        format!(
            "http://127.0.0.1:{}/api/im/events?since=0&replayRequestId={}",
            sidecar_port, initial_replay_request_id,
        )
    } else {
        format!(
            "http://127.0.0.1:{}/api/im/events?since={}",
            sidecar_port, last_seq
        )
    }
}

async fn sleep_with_cancel(cancel: &CancelFlag, ms: u64) {
    let deadline = std::time::Instant::now() + Duration::from_millis(ms);
    while std::time::Instant::now() < deadline {
        if cancel.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50.min(ms))).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::im::bridge::BridgeAdapter;
    use crate::im::types::{ChannelDeliveryMode, ImDeliveryProtocol, ImSourceType};
    use std::sync::Mutex as StdMutex;

    #[derive(Clone, Default)]
    struct TerminalBridge {
        fail: Arc<AtomicBool>,
        accept_before_failure: bool,
        attempts: Arc<StdMutex<Vec<(String, Value)>>>,
        accepted: Arc<StdMutex<std::collections::HashMap<String, Value>>>,
    }

    async fn terminal_bridge_request(
        axum::extract::State(state): axum::extract::State<TerminalBridge>,
        uri: axum::http::Uri,
        axum::Json(body): axum::Json<Value>,
    ) -> (axum::http::StatusCode, axum::Json<Value>) {
        let path = uri.path();
        if !matches!(path, "/complete-dispatch" | "/abort-dispatch") {
            return (
                axum::http::StatusCode::OK,
                axum::Json(serde_json::json!({"ok":true})),
            );
        }
        state
            .attempts
            .lock()
            .unwrap()
            .push((path.to_string(), body.clone()));
        let fail = state.fail.load(Ordering::SeqCst);
        if !fail || state.accept_before_failure {
            let mut accepted = state.accepted.lock().unwrap();
            let id = body["requestId"].as_str().unwrap().to_string();
            if let Some(first) = accepted.get(&id) {
                assert_eq!(
                    first, &body,
                    "terminal retries must preserve the original payload"
                );
            } else {
                accepted.insert(id, body);
            }
        }
        (
            if fail {
                axum::http::StatusCode::SERVICE_UNAVAILABLE
            } else {
                axum::http::StatusCode::OK
            },
            axum::Json(serde_json::json!({"ok":!fail})),
        )
    }

    #[tokio::test]
    async fn failed_terminal_handoffs_recover_without_producer_receipts_or_model_replay() {
        for mode in [ChannelDeliveryMode::Auto, ChannelDeliveryMode::ToolOnly] {
            for terminal in ["complete", "error", "cancelled"] {
                for payloads in [
                    serde_json::json!([]),
                    serde_json::json!([{"text":"original answer"}]),
                ] {
                    let state = TerminalBridge::default();
                    state.fail.store(true, Ordering::SeqCst);
                    let server = axum::Router::new()
                        .route("/{*path}", axum::routing::post(terminal_bridge_request))
                        .with_state(state.clone());
                    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                    let port = listener.local_addr().unwrap().port();
                    let task = tauri::async_runtime::spawn(async move {
                        axum::serve(listener, server).await.unwrap();
                    });
                    let adapter = BridgeAdapter::new("wecom".into(), port);
                    let router = Arc::new(Mutex::new(ReplyRouter::new(
                        Default::default(),
                        Default::default(),
                    )));
                    let consumers = super::super::ImConsumers::default();
                    consumers.lock().await.insert(
                        "chat".into(),
                        super::super::ImConsumerHandle {
                            retire_when_idle: Arc::new(AtomicBool::new(false)),
                            cancel: Arc::new(AtomicBool::new(false)),
                            reply_router: router.clone(),
                            sidecar_port: 0,
                            sidecar_session_id: "fixture".into(),
                            sidecar_generation: 0,
                            _join: tauri::async_runtime::spawn(async {}),
                        },
                    );
                    assert!(super::super::health::reply_handoff_warning(&consumers)
                        .await
                        .is_none());
                    let event = serde_json::json!({"requestId":"first","type":terminal,"data":{"finalPayloads":payloads}});
                    {
                        let mut replies = router.lock().await;
                        replies.register(
                            "first".into(),
                            "chat".into(),
                            "message".into(),
                            ImSourceType::Private,
                            Some("sender".into()),
                            None,
                            Some(ImDeliveryProtocol::OpenClawReply),
                        );
                        replies.set_pending_delivery_mode("first", mode);
                        replies.finish_admission("first");
                        assert!(
                            replies.dispatch(&event, &adapter, 0).await.is_none(),
                            "an unacknowledged terminal must retain its delivery obligation"
                        );
                        assert_eq!(replies.producer_terminal("first"), Some(&event));
                        // A later receipt/expiry must not replace the producer's first terminal.
                        assert!(replies.dispatch(&serde_json::json!({"requestId":"first","type":"error",
                            "channelDeliveryMode":"auto","data":{"finalPayloads":[{"text":"conflicting later result"}]}}), &adapter, 0).await.is_none());
                    }
                    assert_eq!(state.attempts.lock().unwrap().len(), 6);
                    assert_eq!(
                        super::super::health::reply_handoff_warning(&consumers)
                            .await
                            .as_deref(),
                        Some("有 1 条回复投递暂未完成，正在自动恢复。")
                    );
                    let first_body = state.attempts.lock().unwrap()[0].clone();
                    assert!(state
                        .attempts
                        .lock()
                        .unwrap()
                        .iter()
                        .all(|attempt| attempt == &first_body));
                    state.fail.store(false, Ordering::SeqCst);
                    let completions = Arc::new(StdMutex::new(Vec::new()));
                    let observed = completions.clone();
                    let callback: Arc<dyn Fn(String, TerminalOutcome) + Send + Sync> =
                        Arc::new(move |id, _| observed.lock().unwrap().push(id));
                    // Port zero deliberately has no producer. Recovery must use the retained
                    // terminal even after its original registry receipt has expired/disappeared.
                    let client = crate::local_http::json_client(Duration::from_secs(1));
                    reconcile_requests(&client, 0, &router, &adapter, &callback).await;
                    assert_eq!(*completions.lock().unwrap(), vec!["first"]);
                    assert!(router.lock().await.request_ids().is_empty());
                    assert!(super::super::health::reply_handoff_warning(&consumers)
                        .await
                        .is_none());
                    assert_eq!(state.accepted.lock().unwrap().len(), 1);
                    // A following same-chat request can complete and the old request is not replayed.
                    {
                        let mut replies = router.lock().await;
                        replies.register(
                            "next".into(),
                            "chat".into(),
                            "next-message".into(),
                            ImSourceType::Private,
                            Some("sender".into()),
                            None,
                            Some(ImDeliveryProtocol::OpenClawReply),
                        );
                    }
                    dispatch_event(&serde_json::json!({"requestId":"next","type":"complete","data":{"finalPayloads":[]}}),
                        &router, &adapter, 0, &callback).await;
                    reconcile_requests(&client, 0, &router, &adapter, &callback).await;
                    assert_eq!(*completions.lock().unwrap(), vec!["first", "next"]);
                    assert!(router.lock().await.request_ids().is_empty());
                    task.abort();
                }
            }
        }
    }

    #[tokio::test]
    async fn lost_terminal_ack_is_retried_without_duplicate_delivery() {
        let state = TerminalBridge {
            accept_before_failure: true,
            ..Default::default()
        };
        state.fail.store(true, Ordering::SeqCst);
        let server = axum::Router::new()
            .route("/{*path}", axum::routing::post(terminal_bridge_request))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tauri::async_runtime::spawn(async move {
            axum::serve(listener, server).await.unwrap();
        });
        let adapter = BridgeAdapter::new("wecom".into(), port);
        let router = Arc::new(Mutex::new(ReplyRouter::new(
            Default::default(),
            Default::default(),
        )));
        {
            let mut replies = router.lock().await;
            replies.register(
                "first".into(),
                "chat".into(),
                "message".into(),
                ImSourceType::Private,
                Some("sender".into()),
                None,
                Some(ImDeliveryProtocol::OpenClawReply),
            );
            assert!(replies.dispatch(&serde_json::json!({"requestId":"first","type":"complete","data":{"finalPayloads":[{"text":"answer"}]}}), &adapter, 0).await.is_none());
        }
        assert_eq!(state.accepted.lock().unwrap().len(), 1);
        state.fail.store(false, Ordering::SeqCst);
        let callback: Arc<dyn Fn(String, TerminalOutcome) + Send + Sync> = Arc::new(|_, _| {});
        reconcile_requests(
            &crate::local_http::json_client(Duration::from_secs(1)),
            0,
            &router,
            &adapter,
            &callback,
        )
        .await;
        assert_eq!(state.attempts.lock().unwrap().len(), 4);
        assert_eq!(state.accepted.lock().unwrap().len(), 1);
        assert!(router.lock().await.request_ids().is_empty());
        task.abort();
    }

    #[tokio::test]
    async fn only_explicit_missing_dispatcher_receipts_retire_an_unaccepted_terminal() {
        for missing_dispatcher in [true, false] {
            let server = axum::Router::new().route(
                "/{*path}",
                axum::routing::post(move || async move {
                    (
                        axum::http::StatusCode::NOT_FOUND,
                        axum::Json(serde_json::json!({"error":
                    if missing_dispatcher { "protocol_dispatch_missing" } else { "route_not_found" }})),
                    )
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let task = tauri::async_runtime::spawn(async move {
                axum::serve(listener, server).await.unwrap();
            });
            let adapter = BridgeAdapter::new("wecom".into(), port);
            let mut replies = ReplyRouter::new(Default::default(), Default::default());
            replies.register(
                "first".into(),
                "chat".into(),
                "message".into(),
                ImSourceType::Private,
                Some("sender".into()),
                None,
                Some(ImDeliveryProtocol::OpenClawReply),
            );
            let outcome = replies
                .dispatch(
                    &serde_json::json!({"requestId":"first","type":"complete",
                "data":{"finalPayloads":[]}}),
                    &adapter,
                    0,
                )
                .await;
            assert_eq!(outcome.is_some(), missing_dispatcher);
            assert_eq!(
                replies.pending_terminal_handoff_count(),
                usize::from(!missing_dispatcher)
            );
            task.abort();
        }
    }

    #[test]
    fn first_connection_replays_only_the_initial_request() {
        assert_eq!(
            events_url(31415, 0, "req-1"),
            "http://127.0.0.1:31415/api/im/events?since=0&replayRequestId=req-1",
        );
    }

    #[test]
    fn reconnect_resumes_after_last_seen_sequence() {
        assert_eq!(
            events_url(31415, 42, "req-1"),
            "http://127.0.0.1:31415/api/im/events?since=42",
        );
    }
}

fn extract_data(event_str: &str) -> String {
    let mut data_lines = Vec::new();
    for line in event_str.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.trim_start());
        }
    }
    data_lines.join("\n")
}
