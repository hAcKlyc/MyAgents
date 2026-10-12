//! Bounded WebSocket transport for the opaque AgentNet relay.
//!
//! Authentication and relay state remain owned by the synchronous handler.
//! This module only enforces transport framing, queues, deadlines, and exact
//! connection cleanup; it never interprets TLS payloads.

use axum::{
    Router,
    body::Body,
    extract::{
        State,
        ws::{CloseCode, CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use myagents_agent_network_protocol::{
    budget, decode_tls_frame, validate_control, validate_server_control,
};
use myagents_agentnet_admission_core::ValidatedAccess;
use myagents_agentnet_relay_core::Effect;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Semaphore, mpsc, watch};

pub const RELAY_SUBPROTOCOL: &str = "myagents-agent-network.v1";
const MAX_HEADER_BYTES: usize = 16 * 1024;
const HELLO_BYTES: usize = 16 * 1024;
const OUTBOUND_ITEMS: usize = 8;
const MAX_CLEANUP_EFFECTS: usize = 128;
const BLOCKING_WORKERS: usize = 32;
const HELLO_DEADLINE: Duration = Duration::from_secs(10);
const WRITE_DEADLINE: Duration = Duration::from_secs(5);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(1);
const TLS_FRAME_HEADER: usize = 22;
const WS_CLOSE_PROTOCOL: CloseCode = 1002;
const WS_CLOSE_POLICY: CloseCode = 1008;
const WS_CLOSE_SIZE: CloseCode = 1009;
const WS_CLOSE_INTERNAL: CloseCode = 1011;

/// Fixed failure code supplied by the owner. It is never sent to a peer or
/// logged by this transport.
#[derive(Clone, PartialEq, Eq)]
pub struct RelayFailure {
    code: &'static str,
    cleanup: Vec<Effect>,
}

impl RelayFailure {
    pub const fn new(code: &'static str) -> Self {
        Self {
            code,
            cleanup: Vec::new(),
        }
    }

    /// Attach a bounded set of already-authorized cleanup effects. Oversized
    /// cleanup batches are discarded as a whole rather than partially sent.
    pub fn with_cleanup(mut self, cleanup: Vec<Effect>) -> Self {
        self.cleanup = if cleanup.len() <= MAX_CLEANUP_EFFECTS {
            cleanup
        } else {
            Vec::new()
        };
        self
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn into_cleanup(self) -> Vec<Effect> {
        self.cleanup
    }
}

impl std::fmt::Debug for RelayFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RelayFailure")
            .field("code", &self.code)
            .finish()
    }
}

/// Synchronous state owner. Every method runs on a bounded blocking worker,
/// never on the async socket task.
pub trait RelayHandler: Send + Sync + 'static {
    fn preflight(&self, headers: &HeaderMap, uri: &Uri) -> Result<ValidatedAccess, Box<Response>>;
    fn hello(
        &self,
        access: ValidatedAccess,
        hello: Value,
    ) -> Result<(String, Vec<Effect>), RelayFailure>;
    fn control(&self, connection_id: &str, control: Value) -> Result<Vec<Effect>, RelayFailure>;
    fn binary(&self, connection_id: &str, frame: Vec<u8>) -> Result<Vec<Effect>, RelayFailure>;
    fn heartbeat(&self, connection_id: &str) -> Result<Vec<Effect>, RelayFailure>;
    fn disconnect(&self, connection_id: &str) -> Vec<Effect>;
    fn delivery_failed(&self, connection_id: &str, channel_id: &str) -> Vec<Effect>;
}

#[derive(Clone)]
struct RegistryEntry {
    sender: mpsc::Sender<Outbound>,
    shutdown: watch::Sender<bool>,
    urgent: watch::Sender<Option<Outbound>>,
    failed_channels: Arc<Mutex<HashSet<String>>>,
}

#[derive(Clone)]
struct Outbound {
    effect: Effect,
    wire: WireMessage,
}

#[derive(Clone)]
enum WireMessage {
    Text(String),
    Binary(Vec<u8>),
}

/// Router factory only; binding/listener exposure remains the caller's job.
pub struct RelayTransport {
    handler: Arc<dyn RelayHandler>,
    blocking: Arc<Semaphore>,
    pending: Arc<Semaphore>,
    registry: Arc<Mutex<HashMap<String, RegistryEntry>>>,
}

impl Clone for RelayTransport {
    fn clone(&self) -> Self {
        Self {
            handler: self.handler.clone(),
            blocking: self.blocking.clone(),
            pending: self.pending.clone(),
            registry: self.registry.clone(),
        }
    }
}

impl RelayTransport {
    pub fn new(handler: Arc<dyn RelayHandler>) -> Self {
        Self {
            handler,
            blocking: Arc::new(Semaphore::new(BLOCKING_WORKERS)),
            pending: Arc::new(Semaphore::new(budget("pending"))),
            registry: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn router(&self) -> Router<()> {
        Router::new()
            .route("/v1/ws", get(websocket))
            .layer(middleware::from_fn(no_store))
            .with_state(Arc::new(self.clone()))
    }

    async fn blocking<T, F>(&self, operation: F) -> Result<T, BlockingError>
    where
        T: Send + 'static,
        F: FnOnce() -> T + Send + 'static,
    {
        let permit = self
            .blocking
            .clone()
            .try_acquire_owned()
            .map_err(|_| BlockingError::Capacity)?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            operation()
        })
        .await
        .map_err(|_| BlockingError::Worker)
    }

    fn registry_entry(&self, connection_id: &str) -> Option<RegistryEntry> {
        self.registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(connection_id)
            .cloned()
    }

    fn signal_shutdown(&self, connection_id: &str) {
        if let Some(entry) = self.registry_entry(connection_id) {
            let _ = entry.shutdown.send(true);
        }
    }

    fn deliver_urgent(&self, connection_id: &str, outbound: Outbound) {
        if let Some(entry) = self.registry_entry(connection_id) {
            if entry.urgent.borrow().is_none() && entry.urgent.send(Some(outbound)).is_ok() {
                return;
            }
            let _ = entry.shutdown.send(true);
        }
    }

    fn mark_channel_failed(&self, connection_id: &str, channel_id: &str) -> bool {
        let Some(entry) = self.registry_entry(connection_id) else {
            return false;
        };
        let mut failed = entry
            .failed_channels
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if failed.contains(channel_id) {
            return false;
        }
        if failed.len() >= budget("pending") {
            drop(failed);
            self.signal_shutdown(connection_id);
            return false;
        }
        failed.insert(channel_id.to_owned())
    }

    fn channel_failed(&self, connection_id: &str, channel_id: &str) -> bool {
        self.registry_entry(connection_id).is_some_and(|entry| {
            entry
                .failed_channels
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .contains(channel_id)
        })
    }

    fn dispatch_cleanup_effects(&self, effects: Vec<Effect>) {
        if effects.len() > MAX_CLEANUP_EFFECTS {
            return;
        }
        for effect in effects {
            let Ok(Some((target, outbound))) = outbound(effect) else {
                continue;
            };
            if let Effect::Control { json, .. } = &outbound.effect
                && json["type"] == "channel.closed"
                && let Some(channel_id) = json["channelId"].as_str()
            {
                self.mark_channel_failed(&target, channel_id);
            }
            let Some(entry) = self.registry_entry(&target) else {
                continue;
            };
            if entry.sender.try_send(outbound.clone()).is_err() {
                self.deliver_urgent(&target, outbound);
            }
        }
    }

    /// Effects are routed by exact connection ID. Queue overflow of an opaque
    /// frame fails its channel once, then tries the resulting cleanup effects
    /// without recursively invoking failure handling.
    async fn dispatch_effects(&self, effects: Vec<Effect>, handle_failure: bool) {
        for effect in effects {
            let Some((target, outbound)) = (match outbound(effect) {
                Ok(Some(value)) => Some(value),
                Ok(None) => None,
                Err(_) => continue,
            }) else {
                continue;
            };
            let Some(entry) = self.registry_entry(&target) else {
                continue;
            };
            match entry.sender.try_send(outbound.clone()) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Closed(_)) => {}
                Err(mpsc::error::TrySendError::Full(_)) => {
                    let channel_id = match &outbound.effect {
                        Effect::OpaqueFrame { bytes, .. } => decode_tls_frame(bytes)
                            .ok()
                            .map(|(channel_id, _)| channel_id),
                        Effect::Control { json, .. } => json
                            .get("channelId")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        Effect::Close { .. } => None,
                    };
                    let mut channel_failure_handled = false;
                    if handle_failure && let Some(channel_id) = channel_id {
                        let first_global = self.mark_channel_failed(&target, &channel_id);
                        if first_global {
                            let handler = self.handler.clone();
                            let exact_target = target.clone();
                            match self
                                .blocking(move || {
                                    handler.delivery_failed(&exact_target, &channel_id)
                                })
                                .await
                            {
                                Ok(failed) => self.dispatch_cleanup_effects(failed),
                                Err(_) => self.signal_shutdown(&target),
                            }
                        }
                        channel_failure_handled = true;
                    }
                    if !channel_failure_handled {
                        self.signal_shutdown(&target);
                    }
                }
            }
        }
    }
}

#[derive(Clone, Copy)]
enum BlockingError {
    Capacity,
    Worker,
}

async fn websocket(
    State(transport): State<Arc<RelayTransport>>,
    uri: Uri,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !valid_upgrade_request(&headers, &uri) {
        return fixed_http(StatusCode::BAD_REQUEST);
    }
    let pending = match transport.pending.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return fixed_http(StatusCode::SERVICE_UNAVAILABLE),
    };
    let preflight = transport
        .blocking({
            let handler = transport.handler.clone();
            let headers = headers.clone();
            let uri = uri.clone();
            move || handler.preflight(&headers, &uri)
        })
        .await;
    let access = match preflight {
        Ok(Ok(access)) => access,
        Ok(Err(mut response)) => {
            set_no_store(&mut response);
            return *response;
        }
        Err(BlockingError::Capacity) => return fixed_http(StatusCode::SERVICE_UNAVAILABLE),
        Err(BlockingError::Worker) => return fixed_http(StatusCode::SERVICE_UNAVAILABLE),
    };
    ws.protocols([RELAY_SUBPROTOCOL])
        .read_buffer_size(16 * 1024)
        .write_buffer_size(4 * 1024)
        .max_write_buffer_size(4 * max_ws_message())
        .max_message_size(max_ws_message())
        .max_frame_size(max_ws_message())
        .on_upgrade(move |socket| async move {
            let _pending = pending;
            serve_socket(transport, socket, access).await;
        })
}

fn valid_upgrade_request(headers: &HeaderMap, uri: &Uri) -> bool {
    if uri.query().is_some() {
        return false;
    }
    let mut total = 0usize;
    for name in headers.keys() {
        let values = headers.get_all(name);
        let mut count = 0usize;
        for value in values.iter() {
            count += 1;
            total = total
                .saturating_add(name.as_str().len())
                .saturating_add(value.as_bytes().len());
        }
        if count != 1 || total > MAX_HEADER_BYTES {
            return false;
        }
    }
    if total > MAX_HEADER_BYTES || headers.contains_key("sec-websocket-extensions") {
        return false;
    }
    let Some(protocol) = headers.get("sec-websocket-protocol") else {
        return false;
    };
    protocol
        .to_str()
        .is_ok_and(|value| value.trim() == RELAY_SUBPROTOCOL)
}

fn max_ws_message() -> usize {
    TLS_FRAME_HEADER + budget("tlsChunkBytes")
}

async fn serve_socket(
    transport: Arc<RelayTransport>,
    mut socket: WebSocket,
    access: ValidatedAccess,
) {
    let first = tokio::time::timeout(HELLO_DEADLINE, socket.recv()).await;
    let hello = match first {
        Ok(Some(Ok(Message::Text(text)))) if text.len() <= HELLO_BYTES => {
            match serde_json::from_str::<Value>(&text) {
                Ok(value)
                    if validate_control(&value).is_ok()
                        && value.get("type").and_then(Value::as_str) == Some("hello") =>
                {
                    value
                }
                _ => {
                    send_close(&mut socket, WS_CLOSE_PROTOCOL, "invalid hello").await;
                    return;
                }
            }
        }
        Ok(Some(Ok(Message::Text(_)))) | Ok(Some(Ok(Message::Binary(_)))) => {
            send_close(&mut socket, WS_CLOSE_SIZE, "hello too large").await;
            return;
        }
        Ok(Some(Ok(Message::Ping(_)))) => {
            send_close(&mut socket, WS_CLOSE_PROTOCOL, "hello required").await;
            return;
        }
        Ok(Some(Ok(Message::Pong(_)))) | Ok(Some(Ok(Message::Close(_)))) | Ok(None) => return,
        Ok(Some(Err(_))) => return,
        Err(_) => {
            send_close(&mut socket, WS_CLOSE_POLICY, "hello deadline").await;
            return;
        }
    };
    let handler = transport.handler.clone();
    let opened = transport
        .blocking(move || handler.hello(access, hello))
        .await;
    let (connection_id, effects) = match opened {
        Ok(Ok(value)) => value,
        Ok(Err(failure)) => {
            transport.dispatch_cleanup_effects(failure.into_cleanup());
            send_close(&mut socket, WS_CLOSE_INTERNAL, "relay unavailable").await;
            return;
        }
        Err(_) => {
            send_close(&mut socket, WS_CLOSE_INTERNAL, "relay unavailable").await;
            return;
        }
    };

    let (sender, mut receiver) = mpsc::channel(OUTBOUND_ITEMS);
    let (shutdown, mut shutdown_rx) = watch::channel(false);
    let (urgent, mut urgent_rx) = watch::channel(None);
    let entry = RegistryEntry {
        sender,
        shutdown,
        urgent: urgent.clone(),
        failed_channels: Arc::new(Mutex::new(HashSet::new())),
    };
    let duplicate_id = {
        let mut registry = transport
            .registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if registry.contains_key(&connection_id) {
            true
        } else {
            registry.insert(connection_id.clone(), entry);
            false
        }
    };
    if duplicate_id {
        // Never disconnect a duplicate ID: it may name the already-registered
        // socket. The owner must mint unique connection IDs.
        send_close(&mut socket, WS_CLOSE_INTERNAL, "relay unavailable").await;
        return;
    }

    transport.dispatch_effects(effects, true).await;
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.tick().await;
    loop {
        tokio::select! {
            changed = shutdown_rx.changed() => {
                if changed.is_err() || *shutdown_rx.borrow() { break; }
            }
            changed = urgent_rx.changed() => {
                if changed.is_ok() {
                    let pending_urgent = { urgent_rx.borrow_and_update().clone() };
                    if let Some(outbound) = pending_urgent {
                        let message = match &outbound.wire {
                            WireMessage::Text(text) => Message::Text(text.clone().into()),
                            WireMessage::Binary(bytes) => Message::Binary(bytes.clone().into()),
                        };
                        if write_message(&mut socket, message).await.is_err() {
                            fail_outbound(&transport, &connection_id, outbound).await;
                            break;
                        }
                        let _ = urgent.send(None);
                    }
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if text.len() > budget("controlBytes") {
                            send_close(&mut socket, WS_CLOSE_SIZE, "message too large").await;
                            break;
                        }
                        match serde_json::from_str::<Value>(&text) {
                            Ok(Value::String(ref value)) if value == "ma-network-ping" => {
                                if write_message(&mut socket, Message::Text("\"ma-network-pong\"".into())).await.is_err() { break; }
                            }
                            Ok(value) if validate_control(&value).is_ok()
                                && value.get("type").and_then(Value::as_str) != Some("hello") => {
                                let handler = transport.handler.clone();
                                let id = connection_id.clone();
                                match transport.blocking(move || handler.control(&id, value)).await {
                                    Ok(Ok(effects)) => transport.dispatch_effects(effects, true).await,
                                    Ok(Err(failure)) => {
                                        transport.dispatch_cleanup_effects(failure.into_cleanup());
                                        send_close(&mut socket, WS_CLOSE_POLICY, "relay rejected request").await;
                                        break;
                                    }
                                    Err(_) => {
                                        send_close(&mut socket, WS_CLOSE_POLICY, "relay rejected request").await;
                                        break;
                                    }
                                }
                            }
                            _ => {
                                send_close(&mut socket, WS_CLOSE_PROTOCOL, "invalid control").await;
                                break;
                            }
                        }
                    }
                    Some(Ok(Message::Binary(bytes))) => {
                        if bytes.len() > max_ws_message() || decode_tls_frame(&bytes).is_err() {
                            send_close(&mut socket, WS_CLOSE_SIZE, "invalid relay frame").await;
                            break;
                        }
                        let handler = transport.handler.clone();
                        let id = connection_id.clone();
                        match transport.blocking(move || handler.binary(&id, bytes.to_vec())).await {
                            Ok(Ok(effects)) => transport.dispatch_effects(effects, true).await,
                            Ok(Err(failure)) => {
                                transport.dispatch_cleanup_effects(failure.into_cleanup());
                                send_close(&mut socket, WS_CLOSE_POLICY, "relay rejected frame").await;
                                break;
                            }
                            Err(_) => {
                                send_close(&mut socket, WS_CLOSE_POLICY, "relay rejected frame").await;
                                break;
                            }
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if write_message(&mut socket, Message::Pong(payload)).await.is_err() { break; }
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                }
            }
            outgoing = receiver.recv() => {
                match outgoing {
                    Some(outbound) => {
                        if let Effect::OpaqueFrame { bytes, .. } = &outbound.effect
                            && let Ok((channel_id, _)) = decode_tls_frame(bytes)
                            && transport.channel_failed(&connection_id, &channel_id)
                        {
                            continue;
                        }
                        let message = match &outbound.wire {
                            WireMessage::Text(text) => Message::Text(text.clone().into()),
                            WireMessage::Binary(bytes) => Message::Binary(bytes.clone().into()),
                        };
                        if write_message(&mut socket, message).await.is_err() {
                            fail_outbound(&transport, &connection_id, outbound).await;
                            break;
                        }
                    }
                    None => break,
                }
            }
            _ = heartbeat.tick() => {
                let handler = transport.handler.clone();
                let id = connection_id.clone();
                match transport.blocking(move || handler.heartbeat(&id)).await {
                    Ok(Ok(effects)) => transport.dispatch_effects(effects, true).await,
                    _ => {
                        send_close(&mut socket, WS_CLOSE_POLICY, "relay session ended").await;
                        break;
                    }
                }
            }
        }
    }

    {
        let mut registry = transport
            .registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        registry.remove(&connection_id);
    }
    let handler = transport.handler.clone();
    let effects = transport
        .blocking(move || handler.disconnect(&connection_id))
        .await
        .unwrap_or_default();
    transport.dispatch_cleanup_effects(effects);
}

async fn fail_outbound(transport: &RelayTransport, connection_id: &str, outbound: Outbound) {
    let channel_id = match outbound.effect {
        Effect::OpaqueFrame { bytes, .. } => decode_tls_frame(&bytes).ok().map(|(id, _)| id),
        Effect::Control { ref json, .. } => json
            .get("channelId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        Effect::Close { .. } => None,
    };
    if let Some(channel_id) = channel_id
        && transport.mark_channel_failed(connection_id, &channel_id)
    {
        let handler = transport.handler.clone();
        let id = connection_id.to_owned();
        let effects = transport
            .blocking(move || handler.delivery_failed(&id, &channel_id))
            .await
            .unwrap_or_default();
        transport.dispatch_cleanup_effects(effects);
    }
}

fn outbound(effect: Effect) -> Result<Option<(String, Outbound)>, ()> {
    let value = match effect {
        Effect::Control {
            target_connection_id,
            json,
        } => {
            if validate_server_control(&json).is_err() {
                return Err(());
            }
            let bytes = serde_json::to_vec(&json).map_err(|_| ())?;
            if bytes.len() > budget("controlBytes") {
                return Err(());
            }
            let text = String::from_utf8(bytes).map_err(|_| ())?;
            (
                target_connection_id,
                Outbound {
                    effect: Effect::Control {
                        target_connection_id: String::new(),
                        json,
                    },
                    wire: WireMessage::Text(text),
                },
            )
        }
        Effect::OpaqueFrame {
            target_connection_id,
            bytes,
        } => {
            decode_tls_frame(&bytes).map_err(|_| ())?;
            if bytes.len() > max_ws_message() {
                return Err(());
            }
            (
                target_connection_id,
                Outbound {
                    effect: Effect::OpaqueFrame {
                        target_connection_id: String::new(),
                        bytes: bytes.clone(),
                    },
                    wire: WireMessage::Binary(bytes),
                },
            )
        }
        Effect::Close { .. } => return Ok(None),
    };
    Ok(Some(value))
}

async fn write_message(socket: &mut WebSocket, message: Message) -> Result<(), ()> {
    match tokio::time::timeout(WRITE_DEADLINE, socket.send(message)).await {
        Ok(Ok(())) => Ok(()),
        _ => Err(()),
    }
}

async fn send_close(socket: &mut WebSocket, code: CloseCode, reason: &'static str) {
    let _ = write_message(
        socket,
        Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })),
    )
    .await;
}

async fn no_store(request: axum::extract::Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    set_no_store(&mut response);
    response
}

fn set_no_store(response: &mut Response) {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
}

fn fixed_http(status: StatusCode) -> Response {
    (status, "WebSocket request rejected").into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        network_http::tests::{Device, Fixture},
        relay_controller::RelayController,
        relay_http,
    };
    use axum::http::HeaderName;
    use axum::http::Method;
    use futures_util::{SinkExt, StreamExt};
    use myagents_agent_network_crypto::DevicePrivateKey;
    use myagents_agent_network_protocol::{DeviceScope, encode_tls_frame};
    use myagents_agentnet_admission_core::{AdmissionValidator, ExpectedService, ReplayPolicy};
    use myagents_agentnet_identity_core::{IdentityRequest, IssuerProfile, ServiceKeys};
    use serde_json::json;
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        sync::{
            Mutex,
            atomic::{AtomicUsize, Ordering},
        },
    };
    use tempfile::TempDir;
    use tokio_tungstenite::{
        connect_async,
        tungstenite::{Message as ClientMessage, client::IntoClientRequest},
    };
    use url::Url;
    use uuid::Uuid;

    const ISSUER: &str = "https://relay.example.test";
    const NONCE: &str = "fixed-test-boot-nonce";
    const ACCESS_URL: &str = "https://relay.example.test/v1/ws";

    struct MockHandler {
        access: ValidatedAccess,
        scope: DeviceScope,
        connection_id: String,
        preflights: AtomicUsize,
        deny_preflight: std::sync::atomic::AtomicBool,
        controls: Mutex<Vec<String>>,
        control_failure: Mutex<Option<Vec<Effect>>>,
        binaries: Mutex<Vec<Vec<u8>>>,
        disconnects: Mutex<Vec<String>>,
        failed: Mutex<Vec<(String, String)>>,
        hello_epoch: Mutex<Option<(String, String)>>,
        hello_failure: Mutex<Option<Vec<Effect>>>,
        hello_count: AtomicUsize,
        flood_binary: std::sync::atomic::AtomicBool,
    }

    impl RelayHandler for MockHandler {
        fn preflight(
            &self,
            headers: &HeaderMap,
            uri: &Uri,
        ) -> Result<ValidatedAccess, Box<Response>> {
            self.preflights.fetch_add(1, Ordering::SeqCst);
            if self.deny_preflight.load(Ordering::SeqCst)
                || uri.path() != "/v1/ws"
                || headers.get("authorization").is_none()
            {
                return Err(Box::new(fixed_http(StatusCode::UNAUTHORIZED)));
            }
            Ok(self.access.clone())
        }

        fn hello(
            &self,
            _access: ValidatedAccess,
            _hello: Value,
        ) -> Result<(String, Vec<Effect>), RelayFailure> {
            if let Some(cleanup) = self.hello_failure.lock().unwrap().take() {
                return Err(RelayFailure::new("TEST_HELLO_FAILED").with_cleanup(cleanup));
            }
            let connection_id = if self.hello_count.fetch_add(1, Ordering::SeqCst) == 0 {
                self.connection_id.clone()
            } else {
                Uuid::new_v4().to_string()
            };
            let scope = &self.scope;
            let boot_epoch = Uuid::new_v4().to_string();
            let connection_epoch = Uuid::new_v4().to_string();
            *self.hello_epoch.lock().unwrap() =
                Some((boot_epoch.clone(), connection_epoch.clone()));
            let response = json!({
                "version":1,
                "controlId":Uuid::new_v4().to_string(),
                "type":"hello.result",
                "serviceId":scope.service_id,
                "networkId":scope.network_id,
                "bootEpoch":boot_epoch,
                "connectionEpoch":connection_epoch,
                "identity":scope,
                "networkRevision":1,
                "membershipRevision":1,
                "connectorNonce":Uuid::new_v4().to_string()
            });
            Ok((
                connection_id.clone(),
                vec![Effect::Control {
                    target_connection_id: connection_id,
                    json: response,
                }],
            ))
        }

        fn control(&self, _id: &str, value: Value) -> Result<Vec<Effect>, RelayFailure> {
            if let Some(cleanup) = self.control_failure.lock().unwrap().take() {
                return Err(RelayFailure::new("TEST_CONTROL_FAILED").with_cleanup(cleanup));
            }
            self.controls
                .lock()
                .unwrap()
                .push(value["type"].as_str().unwrap_or_default().to_owned());
            Ok(Vec::new())
        }

        fn binary(&self, id: &str, frame: Vec<u8>) -> Result<Vec<Effect>, RelayFailure> {
            self.binaries.lock().unwrap().push(frame.clone());
            let count = if self.flood_binary.load(Ordering::SeqCst) {
                10
            } else {
                1
            };
            Ok((0..count)
                .map(|_| Effect::OpaqueFrame {
                    target_connection_id: id.to_owned(),
                    bytes: frame.clone(),
                })
                .collect())
        }

        fn heartbeat(&self, _id: &str) -> Result<Vec<Effect>, RelayFailure> {
            Ok(Vec::new())
        }

        fn disconnect(&self, id: &str) -> Vec<Effect> {
            self.disconnects.lock().unwrap().push(id.to_owned());
            Vec::new()
        }

        fn delivery_failed(&self, id: &str, channel_id: &str) -> Vec<Effect> {
            self.failed
                .lock()
                .unwrap()
                .push((id.to_owned(), channel_id.to_owned()));
            let Some((boot_epoch, connection_epoch)) = self.hello_epoch.lock().unwrap().clone()
            else {
                return Vec::new();
            };
            vec![Effect::Control {
                target_connection_id: id.to_owned(),
                json: json!({
                    "version":1,
                    "controlId":Uuid::new_v4().to_string(),
                    "type":"channel.closed",
                    "serviceId":self.scope.service_id,
                    "networkId":self.scope.network_id,
                    "bootEpoch":boot_epoch,
                    "connectionEpoch":connection_epoch,
                    "channelId":channel_id,
                    "reason":"delivery-failed"
                }),
            }]
        }
    }

    struct TestServer {
        _dir: TempDir,
        handler: Arc<MockHandler>,
        url: String,
        task: tokio::task::JoinHandle<()>,
    }

    impl TestServer {
        async fn start() -> Self {
            let dir = tempfile::tempdir().unwrap();
            fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
            let keys =
                ServiceKeys::generate_initial(dir.path().join("identity-keys.json")).unwrap();
            let profile = IssuerProfile {
                issuer: ISSUER.to_owned(),
                service_id: Uuid::new_v4().to_string(),
                environment: "development".to_owned(),
                network_id: Uuid::new_v4().to_string(),
            };
            let key = Arc::new(DevicePrivateKey::generate().unwrap());
            let principal_id = Uuid::new_v4().to_string();
            let device_id = Uuid::new_v4().to_string();
            let binding_id = Uuid::new_v4().to_string();
            let session_handle = Uuid::new_v4().to_string();
            let request = IdentityRequest {
                principal_id: principal_id.clone(),
                device_id: device_id.clone(),
                key_generation: 1,
                identity_binding_id: binding_id,
                session_handle,
                csr_pem: key.csr().unwrap(),
            };
            let issued = keys.issue(&profile, &request).unwrap();
            let validator = AdmissionValidator::new(
                ExpectedService {
                    https_origin_canonical: ISSUER.to_owned(),
                    service_id: profile.service_id.clone(),
                    environment: profile.environment.clone(),
                    network_id: profile.network_id.clone(),
                    jwks: keys.jwks(),
                },
                ReplayPolicy::default(),
            )
            .unwrap();
            let proof = key
                .dpop(
                    "GET",
                    &Url::parse(ACCESS_URL).unwrap(),
                    &issued.access_token,
                    Some(NONCE),
                )
                .unwrap();
            let access = validator
                .validate(&issued.access_token, &proof, "GET", ACCESS_URL, Some(NONCE))
                .unwrap();
            let scope = DeviceScope {
                service_id: profile.service_id,
                environment: profile.environment,
                network_id: profile.network_id,
                principal_id,
                device_id,
                key_generation: 1,
            };
            let handler = Arc::new(MockHandler {
                access,
                scope,
                connection_id: Uuid::new_v4().to_string(),
                preflights: AtomicUsize::new(0),
                deny_preflight: std::sync::atomic::AtomicBool::new(false),
                controls: Mutex::new(Vec::new()),
                control_failure: Mutex::new(None),
                binaries: Mutex::new(Vec::new()),
                disconnects: Mutex::new(Vec::new()),
                failed: Mutex::new(Vec::new()),
                hello_epoch: Mutex::new(None),
                hello_failure: Mutex::new(None),
                hello_count: AtomicUsize::new(0),
                flood_binary: std::sync::atomic::AtomicBool::new(false),
            });
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let router = RelayTransport::new(handler.clone()).router();
            let task = tokio::spawn(async move {
                axum::serve(listener, router).await.unwrap();
            });
            Self {
                _dir: dir,
                handler,
                url: format!("ws://{address}/v1/ws"),
                task,
            }
        }

        async fn connect(
            &self,
            extra: &[(&str, &str)],
        ) -> Result<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            tokio_tungstenite::tungstenite::Error,
        > {
            let mut request = self.url.clone().into_client_request().unwrap();
            request.headers_mut().insert(
                "authorization",
                HeaderValue::from_static("Bearer test-only"),
            );
            request.headers_mut().insert(
                "sec-websocket-protocol",
                HeaderValue::from_static(RELAY_SUBPROTOCOL),
            );
            for (name, value) in extra {
                request.headers_mut().insert(
                    HeaderName::from_bytes(name.as_bytes()).unwrap(),
                    HeaderValue::from_str(value).unwrap(),
                );
            }
            connect_async(request).await.map(|(socket, _)| socket)
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    fn hello() -> String {
        json!({
            "version":1,
            "controlId":Uuid::new_v4().to_string(),
            "type":"hello",
            "clientVersion":"0.1.0",
            "capabilities":[]
        })
        .to_string()
    }

    async fn wait_for_disconnect(handler: &MockHandler) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while handler.disconnects.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn requires_single_protocol_and_rejects_extensions_before_preflight() {
        let server = TestServer::start().await;
        let missing = connect_async(&server.url).await;
        assert!(missing.is_err());
        assert_eq!(server.handler.preflights.load(Ordering::SeqCst), 0);

        let wrong_protocol = server
            .connect(&[("sec-websocket-protocol", "another.protocol")])
            .await;
        assert!(wrong_protocol.is_err());
        assert_eq!(server.handler.preflights.load(Ordering::SeqCst), 0);

        let with_extension = server
            .connect(&[("sec-websocket-extensions", "permessage-deflate")])
            .await;
        assert!(with_extension.is_err());
        assert_eq!(server.handler.preflights.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn denied_preflight_never_upgrades_and_response_is_not_cacheable() {
        let server = TestServer::start().await;
        server.handler.deny_preflight.store(true, Ordering::SeqCst);
        let result = server.connect(&[]).await;
        match result {
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
                assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
            }
            other => panic!("expected fixed HTTP preflight rejection, got {other:?}"),
        }
        assert_eq!(server.handler.preflights.load(Ordering::SeqCst), 1);
        assert!(server.handler.disconnects.lock().unwrap().is_empty());
    }

    #[test]
    fn upgrade_header_validation_rejects_duplicates_limits_and_query() {
        let uri: Uri = "/v1/ws".parse().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            "sec-websocket-protocol",
            HeaderValue::from_static(RELAY_SUBPROTOCOL),
        );
        assert!(valid_upgrade_request(&headers, &uri));

        headers.append("x-duplicate", HeaderValue::from_static("one"));
        headers.append("x-duplicate", HeaderValue::from_static("two"));
        assert!(!valid_upgrade_request(&headers, &uri));

        let mut oversized = HeaderMap::new();
        oversized.insert(
            "sec-websocket-protocol",
            HeaderValue::from_static(RELAY_SUBPROTOCOL),
        );
        oversized.insert(
            "x-large",
            HeaderValue::from_bytes(&vec![b'a'; MAX_HEADER_BYTES]).unwrap(),
        );
        assert!(!valid_upgrade_request(&oversized, &uri));

        let query: Uri = "/v1/ws?unexpected=1".parse().unwrap();
        let mut query_headers = HeaderMap::new();
        query_headers.insert(
            "sec-websocket-protocol",
            HeaderValue::from_static(RELAY_SUBPROTOCOL),
        );
        assert!(!valid_upgrade_request(&query_headers, &query));
    }

    #[tokio::test]
    async fn hello_control_binary_and_json_heartbeat_follow_bounded_transport() {
        let server = TestServer::start().await;
        let mut socket = server.connect(&[]).await.unwrap();
        socket
            .send(ClientMessage::Text(hello().into()))
            .await
            .unwrap();
        let response = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let hello_result: Value = serde_json::from_str(response.to_text().unwrap()).unwrap();
        assert_eq!(hello_result["type"], "hello.result");

        let ready = json!({
            "version":1,
            "controlId":Uuid::new_v4().to_string(),
            "type":"ready",
            "serviceId":hello_result["serviceId"],
            "networkId":hello_result["networkId"],
            "bootEpoch":hello_result["bootEpoch"],
            "connectionEpoch":hello_result["connectionEpoch"],
            "catalogSeq":1
        });
        socket
            .send(ClientMessage::Text(ready.to_string().into()))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while server.handler.controls.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();

        socket
            .send(ClientMessage::Text("\"ma-network-ping\"".into()))
            .await
            .unwrap();
        let pong = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(pong.to_text().unwrap(), "\"ma-network-pong\"");

        let frame = encode_tls_frame(&Uuid::new_v4().to_string(), &[1, 2, 3, 4]).unwrap();
        socket
            .send(ClientMessage::Binary(frame.clone().into()))
            .await
            .unwrap();
        let echoed = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(echoed.into_data().as_ref(), frame.as_slice());
        assert_eq!(server.handler.binaries.lock().unwrap().as_slice(), &[frame]);

        socket.close(None).await.unwrap();
        wait_for_disconnect(&server.handler).await;
        assert_eq!(server.handler.disconnects.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn hello_failure_dispatches_bounded_cleanup_to_existing_peer_before_close() {
        let server = TestServer::start().await;
        let mut existing = server.connect(&[]).await.unwrap();
        existing
            .send(ClientMessage::Text(hello().into()))
            .await
            .unwrap();
        let hello_result: Value = serde_json::from_str(
            &tokio::time::timeout(Duration::from_secs(2), existing.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .into_text()
                .unwrap(),
        )
        .unwrap();
        let channel_id = Uuid::new_v4().to_string();
        server
            .handler
            .hello_failure
            .lock()
            .unwrap()
            .replace(vec![Effect::Control {
                target_connection_id: server.handler.connection_id.clone(),
                json: json!({
                    "version":1,
                    "controlId":Uuid::new_v4().to_string(),
                    "type":"channel.closed",
                    "serviceId":hello_result["serviceId"],
                    "networkId":hello_result["networkId"],
                    "bootEpoch":hello_result["bootEpoch"],
                    "connectionEpoch":hello_result["connectionEpoch"],
                    "channelId":channel_id,
                    "reason":"connection-replaced"
                }),
            }]);

        let mut rejected = server.connect(&[]).await.unwrap();
        rejected
            .send(ClientMessage::Text(hello().into()))
            .await
            .unwrap();
        let cleanup: Value = serde_json::from_str(
            &tokio::time::timeout(Duration::from_secs(2), existing.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .into_text()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(cleanup["type"], "channel.closed");
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), rejected.next())
                .await
                .unwrap(),
            Some(Ok(ClientMessage::Close(_)))
        ));
        assert!(server.handler.disconnects.lock().unwrap().is_empty());
        existing.close(None).await.unwrap();
        wait_for_disconnect(&server.handler).await;
        assert_eq!(server.handler.disconnects.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn control_failure_dispatches_bounded_cleanup_to_peer_before_closing_sender() {
        let server = TestServer::start().await;
        let mut existing = server.connect(&[]).await.unwrap();
        existing
            .send(ClientMessage::Text(hello().into()))
            .await
            .unwrap();
        let existing_hello: Value = serde_json::from_str(
            &tokio::time::timeout(Duration::from_secs(2), existing.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .into_text()
                .unwrap(),
        )
        .unwrap();

        let mut rejected = server.connect(&[]).await.unwrap();
        rejected
            .send(ClientMessage::Text(hello().into()))
            .await
            .unwrap();
        let rejected_hello: Value = serde_json::from_str(
            &tokio::time::timeout(Duration::from_secs(2), rejected.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .into_text()
                .unwrap(),
        )
        .unwrap();
        let channel_id = Uuid::new_v4().to_string();
        server
            .handler
            .control_failure
            .lock()
            .unwrap()
            .replace(vec![Effect::Control {
                target_connection_id: server.handler.connection_id.clone(),
                json: json!({
                    "version":1,
                    "controlId":Uuid::new_v4().to_string(),
                    "type":"channel.closed",
                    "serviceId":existing_hello["serviceId"],
                    "networkId":existing_hello["networkId"],
                    "bootEpoch":existing_hello["bootEpoch"],
                    "connectionEpoch":existing_hello["connectionEpoch"],
                    "channelId":channel_id,
                    "reason":"connection-disconnected"
                }),
            }]);
        rejected
            .send(ClientMessage::Text(
                json!({
                    "version":1,
                    "controlId":Uuid::new_v4().to_string(),
                    "type":"ready",
                    "serviceId":rejected_hello["serviceId"],
                    "networkId":rejected_hello["networkId"],
                    "bootEpoch":rejected_hello["bootEpoch"],
                    "connectionEpoch":rejected_hello["connectionEpoch"],
                    "catalogSeq":1
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

        let cleanup: Value = serde_json::from_str(
            &tokio::time::timeout(Duration::from_secs(2), existing.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .into_text()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(cleanup["type"], "channel.closed");
        assert_eq!(cleanup["channelId"], channel_id);
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), rejected.next())
                .await
                .unwrap(),
            Some(Ok(ClientMessage::Close(_)))
        ));
        existing.close(None).await.unwrap();
        wait_for_disconnect(&server.handler).await;
    }

    #[test]
    fn relay_failure_discards_cleanup_batches_over_fixed_limit() {
        let cleanup = (0..=MAX_CLEANUP_EFFECTS)
            .map(|_| Effect::Close {
                target_connection_id: Uuid::new_v4().to_string(),
                channel_id: Uuid::new_v4().to_string(),
                reason: "connection-disconnected",
            })
            .collect();
        let failure = RelayFailure::new("fixed-error").with_cleanup(cleanup);
        assert!(failure.into_cleanup().is_empty());
    }

    #[tokio::test]
    async fn first_hello_deadline_closes_without_creating_connection() {
        let server = TestServer::start().await;
        let mut socket = server.connect(&[]).await.unwrap();
        let close = tokio::time::timeout(HELLO_DEADLINE + Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        match close {
            ClientMessage::Close(Some(frame)) => {
                assert_eq!(u16::from(frame.code), WS_CLOSE_POLICY);
                assert_eq!(frame.reason, "hello deadline");
            }
            other => panic!("unexpected first-message deadline result: {other:?}"),
        }
        assert!(server.handler.disconnects.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn full_outbound_queue_fails_exact_channel_and_delivers_one_close() {
        let server = TestServer::start().await;
        server.handler.flood_binary.store(true, Ordering::SeqCst);
        let mut socket = server.connect(&[]).await.unwrap();
        socket
            .send(ClientMessage::Text(hello().into()))
            .await
            .unwrap();
        let hello_result: Value = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .to_text()
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(hello_result["type"], "hello.result");

        let channel_id = Uuid::new_v4().to_string();
        let frame = encode_tls_frame(&channel_id, &[0x5a]).unwrap();
        socket
            .send(ClientMessage::Binary(frame.into()))
            .await
            .unwrap();

        let mut close_count = 0;
        tokio::time::timeout(Duration::from_secs(3), async {
            while close_count == 0 {
                let message = socket.next().await.unwrap().unwrap();
                if let ClientMessage::Text(text) = message {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if value["type"] == "channel.closed" {
                        assert_eq!(value["reason"], "delivery-failed");
                        assert_eq!(value["channelId"], channel_id);
                        close_count += 1;
                    }
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(close_count, 1);
        assert_eq!(
            server.handler.failed.lock().unwrap().as_slice(),
            &[(server.handler.connection_id.clone(), channel_id)]
        );
        socket.close(None).await.unwrap();
        wait_for_disconnect(&server.handler).await;
    }

    /// Records only lifecycle ids while all decisions/effects remain owned by
    /// the real RelayController and its Auth/Device/Peer/Metadata stores.
    struct ObservedController {
        inner: Arc<RelayController>,
        connections: Mutex<Vec<String>>,
        disconnects: Mutex<Vec<String>>,
    }

    impl RelayHandler for ObservedController {
        fn preflight(
            &self,
            headers: &HeaderMap,
            uri: &Uri,
        ) -> Result<ValidatedAccess, Box<Response>> {
            self.inner.preflight(headers, uri)
        }
        fn hello(
            &self,
            access: ValidatedAccess,
            hello: Value,
        ) -> Result<(String, Vec<Effect>), RelayFailure> {
            let result = self.inner.hello(access, hello)?;
            self.connections.lock().unwrap().push(result.0.clone());
            Ok(result)
        }
        fn control(&self, id: &str, value: Value) -> Result<Vec<Effect>, RelayFailure> {
            self.inner.control(id, value)
        }
        fn binary(&self, id: &str, frame: Vec<u8>) -> Result<Vec<Effect>, RelayFailure> {
            self.inner.binary(id, frame)
        }
        fn heartbeat(&self, id: &str) -> Result<Vec<Effect>, RelayFailure> {
            self.inner.heartbeat(id)
        }
        fn disconnect(&self, id: &str) -> Vec<Effect> {
            let effects = self.inner.disconnect(id);
            self.disconnects.lock().unwrap().push(id.to_owned());
            effects
        }
        fn delivery_failed(&self, id: &str, channel: &str) -> Vec<Effect> {
            self.inner.delivery_failed(id, channel)
        }
    }

    struct RealRelayServer {
        fixture: Fixture,
        controller: Arc<RelayController>,
        observed: Arc<ObservedController>,
        http_url: String,
        ws_url: String,
        task: tokio::task::JoinHandle<()>,
    }

    impl RealRelayServer {
        async fn start() -> Self {
            let fixture = Fixture::new();
            let controller = Arc::new(RelayController::new(fixture.service.clone()).unwrap());
            let observed = Arc::new(ObservedController {
                inner: controller.clone(),
                connections: Mutex::new(Vec::new()),
                disconnects: Mutex::new(Vec::new()),
            });
            let app = Router::new()
                .merge(relay_http::router(controller.clone()))
                .merge(RelayTransport::new(observed.clone()).router());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            Self {
                fixture,
                controller,
                observed,
                http_url: format!("http://{addr}"),
                ws_url: format!("ws://{addr}/v1/ws"),
                task,
            }
        }

        async fn joined_device(&self) -> Device {
            let device = self.fixture.device("loopback-owner");
            self.fixture.register(&device).await;
            let path = format!(
                "/v1/networks/{}/devices/{}/join",
                self.fixture.network, device.context.device_id
            );
            let body =
                json!({"mutationId":Uuid::new_v4().to_string(),"expectedMembershipRevision":0})
                    .to_string();
            let (status, _, _) = self.fixture.request(&device, "POST", &path, &body).await;
            assert_eq!(status, StatusCode::OK);
            device
        }

        fn nonce(&self, device: &Device, method: &str, path: &str) -> String {
            let mut headers = HeaderMap::new();
            headers.insert(
                header::AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {}", device.access.as_str())).unwrap(),
            );
            let uri: Uri = path.parse().unwrap();
            let method: Method = method.parse().unwrap();
            let response = self
                .controller
                .admit_http(&headers, &method, &uri)
                .unwrap_err();
            response
                .headers()
                .get("dpop-nonce")
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned()
        }

        async fn ws(
            &self,
            device: &Device,
        ) -> tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        > {
            let nonce = self.nonce(device, "GET", "/v1/ws");
            let proof = self.fixture.proof(device, "GET", "/v1/ws", Some(&nonce));
            let mut request = self.ws_url.clone().into_client_request().unwrap();
            request.headers_mut().insert(
                header::AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {}", device.access.as_str())).unwrap(),
            );
            request
                .headers_mut()
                .insert("dpop", HeaderValue::from_str(&proof).unwrap());
            request.headers_mut().insert(
                "sec-websocket-protocol",
                HeaderValue::from_static(RELAY_SUBPROTOCOL),
            );
            connect_async(request).await.unwrap().0
        }

        async fn hello(
            &self,
            socket: &mut tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
        ) -> Value {
            socket.send(ClientMessage::Text(json!({"version":1,"controlId":Uuid::new_v4().to_string(),"type":"hello","clientVersion":"test","capabilities":[]}).to_string().into())).await.unwrap();
            let message = tokio::time::timeout(Duration::from_secs(3), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let result: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
            assert_eq!(result["type"], "hello.result");
            result
        }

        async fn upload_catalog(&self, device: &Device, epoch: &str) -> reqwest::Response {
            let path = "/v1/devices/self/catalog";
            let nonce = self.nonce(device, "PUT", path);
            let proof = self.fixture.proof(device, "PUT", path, Some(&nonce));
            reqwest::Client::new()
                .put(format!("{}{}", self.http_url, path))
                .header(
                    header::AUTHORIZATION.as_str(),
                    format!("Bearer {}", device.access.as_str()),
                )
                .header("dpop", proof)
                .header(header::CONTENT_TYPE.as_str(), "application/json")
                .body(
                    json!({"version":1,"connectionEpoch":epoch,"catalogSeq":1,"items":[]})
                        .to_string(),
                )
                .send()
                .await
                .unwrap()
        }

        async fn ready_device(
            &self,
            device: &Device,
        ) -> (
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            Value,
        ) {
            let mut socket = self.ws(device).await;
            let hello = self.hello(&mut socket).await;
            let uploaded = self
                .upload_catalog(device, hello["connectionEpoch"].as_str().unwrap())
                .await;
            assert_eq!(uploaded.status(), StatusCode::OK);
            socket
                .send(ClientMessage::Text(
                    scoped_control(&hello, "ready", json!({"catalogSeq":1}))
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            let ready = receive_control(&mut socket, "ready.result").await;
            assert_eq!(ready["connectionEpoch"], hello["connectionEpoch"]);
            (socket, hello)
        }
    }

    impl Drop for RealRelayServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn wait_until(mut predicate: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(4), async {
            while !predicate() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    fn scoped_control(hello: &Value, kind: &str, extra: Value) -> Value {
        let mut control = json!({
            "version":1,
            "controlId":Uuid::new_v4().to_string(),
            "type":kind,
            "serviceId":hello["serviceId"],
            "networkId":hello["networkId"],
            "bootEpoch":hello["bootEpoch"],
            "connectionEpoch":hello["connectionEpoch"]
        });
        for (key, value) in extra.as_object().unwrap() {
            control[key] = value.clone();
        }
        control
    }

    async fn receive_control(
        socket: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        expected: &str,
    ) -> Value {
        tokio::time::timeout(Duration::from_secs(4), async {
            loop {
                let message = socket.next().await.expect("socket remains open").unwrap();
                if let ClientMessage::Text(text) = message {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if value["type"] == expected {
                        return value;
                    }
                }
            }
        })
        .await
        .unwrap()
    }

    async fn establish_real_channel(
        first_socket: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        first_hello: &Value,
        second_socket: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        second_hello: &Value,
    ) -> String {
        let channel_id = Uuid::new_v4().to_string();
        let first_scope = &first_hello["identity"];
        let second_scope = &second_hello["identity"];
        let open = scoped_control(
            first_hello,
            "channel.open",
            json!({
                "channelId":channel_id,
                "targetDeviceId":second_scope["deviceId"],
                "targetKeyGeneration":second_scope["keyGeneration"],
                "targetConnectionEpoch":second_hello["connectionEpoch"],
                "targetBinding":null
            }),
        );
        first_socket
            .send(ClientMessage::Text(open.to_string().into()))
            .await
            .unwrap();
        let first_offer = receive_control(first_socket, "channel.offer").await;
        let second_offer = receive_control(second_socket, "channel.offer").await;
        assert_eq!(first_offer["channelId"], channel_id);
        assert_eq!(second_offer["channelId"], channel_id);
        assert_eq!(first_offer["initiator"], second_offer["initiator"]);
        assert_eq!(first_offer["responder"], second_offer["responder"]);

        let binding_for = |offer: &Value, scope: &Value| {
            if offer["initiator"] == *scope {
                offer["initiatorBinding"].as_str().unwrap().to_owned()
            } else {
                assert_eq!(offer["responder"], *scope);
                offer["responderBinding"].as_str().unwrap().to_owned()
            }
        };
        let first_accept = scoped_control(
            first_hello,
            "channel.accept",
            json!({"channelId":channel_id,"signedBinding":binding_for(&first_offer, first_scope)}),
        );
        let second_accept = scoped_control(
            second_hello,
            "channel.accept",
            json!({"channelId":channel_id,"signedBinding":binding_for(&second_offer, second_scope)}),
        );
        first_socket
            .send(ClientMessage::Text(first_accept.to_string().into()))
            .await
            .unwrap();
        second_socket
            .send(ClientMessage::Text(second_accept.to_string().into()))
            .await
            .unwrap();
        let first_accepted = receive_control(first_socket, "channel.accepted").await;
        let second_accepted = receive_control(second_socket, "channel.accepted").await;
        assert_eq!(
            first_accepted["initiatorBinding"],
            second_accepted["initiatorBinding"]
        );
        assert_eq!(
            first_accepted["responderBinding"],
            second_accepted["responderBinding"]
        );

        let first_ready = scoped_control(
            first_hello,
            "channel.ready",
            json!({"channelId":channel_id}),
        );
        first_socket
            .send(ClientMessage::Text(first_ready.to_string().into()))
            .await
            .unwrap();
        let second_ready = scoped_control(
            second_hello,
            "channel.ready",
            json!({"channelId":channel_id}),
        );
        second_socket
            .send(ClientMessage::Text(second_ready.to_string().into()))
            .await
            .unwrap();
        assert_eq!(
            receive_control(first_socket, "channel.ready").await["channelId"],
            channel_id
        );
        assert_eq!(
            receive_control(second_socket, "channel.ready").await["channelId"],
            channel_id
        );
        channel_id
    }

    #[tokio::test]
    async fn real_loopback_websocket_requires_catalog_ack_and_live_session() {
        let server = RealRelayServer::start().await;
        let device = server.joined_device().await;
        let mut socket = server.ws(&device).await;
        let hello = server.hello(&mut socket).await;
        let epoch = hello["connectionEpoch"].as_str().unwrap();
        let uploaded = server.upload_catalog(&device, epoch).await;
        assert_eq!(uploaded.status(), StatusCode::OK);
        assert_eq!(uploaded.headers()[header::CACHE_CONTROL], "no-store");

        socket.send(ClientMessage::Text(json!({
            "version":1,"controlId":Uuid::new_v4().to_string(),"type":"ready",
            "serviceId":hello["serviceId"],"networkId":hello["networkId"],
            "bootEpoch":hello["bootEpoch"],"connectionEpoch":hello["connectionEpoch"],"catalogSeq":1
        }).to_string().into())).await.unwrap();
        let ready = tokio::time::timeout(Duration::from_secs(3), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let ready: Value = serde_json::from_str(ready.to_text().unwrap()).unwrap();
        assert_eq!(ready["type"], "ready.result");

        server
            .fixture
            .auth
            .revoke_session(&device.account_token)
            .unwrap();
        let close = tokio::time::timeout(Duration::from_secs(4), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(matches!(close, ClientMessage::Close(_)));
        wait_until(|| !server.observed.disconnects.lock().unwrap().is_empty()).await;

        // The access JWT remains cryptographically valid, but every relay HTTP
        // operation consults the current account-session owner.
        let policy_path = "/api/agent-network/policy/self";
        let policy_nonce = server.nonce(&device, "GET", policy_path);
        let policy_proof = server
            .fixture
            .proof(&device, "GET", policy_path, Some(&policy_nonce));
        let policy = reqwest::Client::new()
            .get(format!(
                "{}{}",
                server.http_url, "/api/agent-network/policy/self"
            ))
            .header(
                header::AUTHORIZATION.as_str(),
                format!("Bearer {}", device.access.as_str()),
            )
            .header("dpop", policy_proof)
            .send()
            .await
            .unwrap();
        assert_eq!(policy.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn real_loopback_ready_without_durable_catalog_ack_is_rejected() {
        let server = RealRelayServer::start().await;
        let device = server.joined_device().await;
        let mut socket = server.ws(&device).await;
        let hello = server.hello(&mut socket).await;
        socket.send(ClientMessage::Text(json!({
            "version":1,"controlId":Uuid::new_v4().to_string(),"type":"ready",
            "serviceId":hello["serviceId"],"networkId":hello["networkId"],
            "bootEpoch":hello["bootEpoch"],"connectionEpoch":hello["connectionEpoch"],"catalogSeq":1
        }).to_string().into())).await.unwrap();
        let close = tokio::time::timeout(Duration::from_secs(3), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(matches!(close, ClientMessage::Close(_)));
        wait_until(|| !server.observed.disconnects.lock().unwrap().is_empty()).await;
        let state = server
            .fixture
            .service
            .metadata
            .read_relay_state(&device.context, &device.context.device_id)
            .unwrap();
        assert_eq!(
            state.presence,
            myagents_agentnet_metadata_core::Presence::Offline
        );
    }

    #[tokio::test]
    async fn two_real_devices_open_accept_forward_opaque_bytes_and_close_channel() {
        let server = RealRelayServer::start().await;
        let first_device = server.joined_device().await;
        let second_device = server.joined_device().await;
        assert_eq!(
            first_device.context.principal_id,
            second_device.context.principal_id
        );
        let (mut first_socket, first_hello) = server.ready_device(&first_device).await;
        let (mut second_socket, second_hello) = server.ready_device(&second_device).await;
        let channel_id = establish_real_channel(
            &mut first_socket,
            &first_hello,
            &mut second_socket,
            &second_hello,
        )
        .await;

        let frame = encode_tls_frame(&channel_id, &[0x16, 0x03, 0x04, 0x00, 0x7f]).unwrap();
        first_socket
            .send(ClientMessage::Binary(frame.clone().into()))
            .await
            .unwrap();
        let forwarded = tokio::time::timeout(Duration::from_secs(4), second_socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(matches!(forwarded, ClientMessage::Binary(ref bytes) if bytes.as_ref() == frame));

        first_socket
            .send(ClientMessage::Text(
                scoped_control(
                    &first_hello,
                    "channel.close",
                    json!({"channelId":channel_id,"reason":"test"}),
                )
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        let first_closed = receive_control(&mut first_socket, "channel.closed").await;
        let second_closed = receive_control(&mut second_socket, "channel.closed").await;
        assert_eq!(first_closed["channelId"], channel_id);
        assert_eq!(second_closed["channelId"], channel_id);
        assert_eq!(first_closed["reason"], "peer-closed");
        assert_eq!(second_closed["reason"], "peer-closed");
        first_socket.close(None).await.unwrap();
        second_socket.close(None).await.unwrap();
    }

    #[tokio::test]
    async fn revoking_device_session_cleans_active_channel_for_peer() {
        let server = RealRelayServer::start().await;
        let first_device = server.joined_device().await;
        let second_device = server.joined_device().await;
        let (mut first_socket, first_hello) = server.ready_device(&first_device).await;
        let (mut second_socket, second_hello) = server.ready_device(&second_device).await;
        let channel_id = establish_real_channel(
            &mut first_socket,
            &first_hello,
            &mut second_socket,
            &second_hello,
        )
        .await;

        server
            .fixture
            .auth
            .revoke_session(&first_device.account_token)
            .unwrap();
        let closed = receive_control(&mut second_socket, "channel.closed").await;
        assert_eq!(closed["channelId"], channel_id);
        assert_eq!(closed["reason"], "connection-disconnected");
        let first_close = tokio::time::timeout(Duration::from_secs(4), first_socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(matches!(first_close, ClientMessage::Close(_)));

        let frame = encode_tls_frame(&channel_id, &[0x16, 0x03, 0x04]).unwrap();
        second_socket
            .send(ClientMessage::Binary(frame.into()))
            .await
            .unwrap();
        let peer_close = tokio::time::timeout(Duration::from_secs(4), second_socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(matches!(peer_close, ClientMessage::Close(_)));
    }

    #[tokio::test]
    async fn stale_websocket_eof_cannot_offline_replacement_epoch() {
        let server = RealRelayServer::start().await;
        let device = server.joined_device().await;
        let peer_device = server.joined_device().await;
        let (mut old_socket, old_hello) = server.ready_device(&device).await;
        let (mut peer_socket, peer_hello) = server.ready_device(&peer_device).await;
        let old_id = server.observed.connections.lock().unwrap()[0].clone();
        let channel_id =
            establish_real_channel(&mut old_socket, &old_hello, &mut peer_socket, &peer_hello)
                .await;

        let mut new_socket = server.ws(&device).await;
        let new_hello = server.hello(&mut new_socket).await;
        let new_id = server.observed.connections.lock().unwrap()[2].clone();
        assert_ne!(old_id, new_id);
        assert_ne!(old_hello["connectionEpoch"], new_hello["connectionEpoch"]);

        let peer_closed = receive_control(&mut peer_socket, "channel.closed").await;
        assert_eq!(peer_closed["channelId"], channel_id);
        assert_eq!(peer_closed["reason"], "connection-replaced");

        let upload = server
            .upload_catalog(&device, new_hello["connectionEpoch"].as_str().unwrap())
            .await;
        assert_eq!(upload.status(), StatusCode::OK);
        new_socket
            .send(ClientMessage::Text(
                scoped_control(&new_hello, "ready", json!({"catalogSeq":1}))
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        receive_control(&mut new_socket, "ready.result").await;

        old_socket.close(None).await.unwrap();
        wait_until(|| {
            server
                .observed
                .disconnects
                .lock()
                .unwrap()
                .contains(&old_id)
        })
        .await;
        let state = server
            .fixture
            .service
            .metadata
            .read_relay_state(&device.context, &device.context.device_id)
            .unwrap();
        assert_eq!(
            state.connection_epoch.as_deref(),
            new_hello["connectionEpoch"].as_str()
        );
        assert_eq!(
            state.presence,
            myagents_agentnet_metadata_core::Presence::Ready
        );

        new_socket.close(None).await.unwrap();
        wait_until(|| {
            server
                .observed
                .disconnects
                .lock()
                .unwrap()
                .contains(&new_id)
        })
        .await;
        let state = server
            .fixture
            .service
            .metadata
            .read_relay_state(&device.context, &device.context.device_id)
            .unwrap();
        assert_eq!(
            state.presence,
            myagents_agentnet_metadata_core::Presence::Offline
        );
        peer_socket.close(None).await.unwrap();
    }
}
