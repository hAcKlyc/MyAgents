// SSE Proxy module - Connects to sidecar SSE and forwards events via Tauri
// This bypasses WebView CORS restrictions entirely
// Supports multiple connections (one per Tab)

use std::collections::HashMap;
use std::error::Error;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

// Timeout constants (in seconds)
//
// SSE_READ_TIMEOUT: Idle timeout for SSE connections
// - Backend sends heartbeat every 15s
// - 60s gives 4x margin to handle network jitter
// - If no data received for 60s, connection is considered dead
//
// HTTP_PROXY_TIMEOUT: Total timeout for HTTP proxy requests
// - 120s (2 minutes) allows for slow API responses
// - Covers model generation time for complex requests
//
// TODO v0.2.0: Make these configurable via Settings
const SSE_READ_TIMEOUT_SECS: u64 = 60;
const HTTP_PROXY_TIMEOUT_SECS: u64 = 120;

/// Single SSE connection for a Tab
struct SseConnection {
    /// Shared running flag - used to gracefully stop the SSE stream
    running: Arc<AtomicBool>,
    /// Task handle for aborting if graceful stop fails
    abort_handle: Option<tokio::task::JoinHandle<()>>,
}

impl SseConnection {
    fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            abort_handle: None,
        }
    }
    
    fn stop(&mut self) {
        // Signal graceful stop first
        self.running.store(false, Ordering::SeqCst);
        // Then abort the task as backup
        if let Some(handle) = self.abort_handle.take() {
            handle.abort();
        }
    }
}

/// State for managing multiple SSE connections (one per Tab)
pub struct SseProxyState {
    /// Tab ID -> SSE connection
    connections: Mutex<HashMap<String, SseConnection>>,
}

impl Default for SseProxyState {
    fn default() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
        }
    }
}

/// Start SSE proxy connection for a specific Tab
#[tauri::command]
pub async fn start_sse_proxy(
    app: AppHandle,
    state: tauri::State<'_, Arc<SseProxyState>>,
    url: String,
    tab_id: Option<String>,
) -> Result<(), String> {
    let tab_id = tab_id.unwrap_or_else(|| "__default__".to_string());
    
    let mut connections = state.connections.lock().await;
    
    // Check if already running for this tab
    if let Some(conn) = connections.get(&tab_id) {
        if conn.running.load(Ordering::SeqCst) {
            log::debug!("[sse-proxy] Tab {} already has an active connection", tab_id);
            return Ok(());
        }
    }
    
    // Stop existing connection if any
    if let Some(mut conn) = connections.remove(&tab_id) {
        conn.stop();
    }
    
    // Create new connection with shared running flag
    let mut conn = SseConnection::new();
    conn.running.store(true, Ordering::SeqCst);
    
    let app_handle = app.clone();
    let tab_id_clone = tab_id.clone();
    // Share the same running flag with the spawned task
    let running = conn.running.clone();
    
    // Spawn async task to handle SSE stream
    let handle = tokio::spawn(async move {
        match connect_sse(&app_handle, &url, &running, &tab_id_clone).await {
            Ok(_) => {
                log::debug!("[sse-proxy] Tab {} connection closed normally", tab_id_clone);
            }
            Err(e) => {
                log::error!("[sse-proxy] Tab {} connection error: {}", tab_id_clone, e);
                // Emit error with tab_id prefix so frontend can filter
                let _ = app_handle.emit(&format!("sse:{}:error", tab_id_clone), e.to_string());
            }
        }
    });
    
    conn.abort_handle = Some(handle);
    connections.insert(tab_id.clone(), conn);
    
    log::info!("[sse-proxy] Started connection for tab {}", tab_id);
    
    Ok(())
}

/// Stop SSE proxy connection for a specific Tab
#[tauri::command]
pub async fn stop_sse_proxy(
    state: tauri::State<'_, Arc<SseProxyState>>,
    tab_id: Option<String>,
) -> Result<(), String> {
    let tab_id = tab_id.unwrap_or_else(|| "__default__".to_string());
    
    let mut connections = state.connections.lock().await;
    
    if let Some(mut conn) = connections.remove(&tab_id) {
        conn.stop();
        log::info!("[sse-proxy] Stopped connection for tab {}", tab_id);
    }

    Ok(())
}

/// Stop all SSE connections (for app cleanup)
#[tauri::command]
pub async fn stop_all_sse_proxies(
    state: tauri::State<'_, Arc<SseProxyState>>,
) -> Result<(), String> {
    let mut connections = state.connections.lock().await;
    
    for (tab_id, mut conn) in connections.drain() {
        conn.stop();
        log::info!("[sse-proxy] Stopped connection for tab {}", tab_id);
    }

    Ok(())
}

/// Connect to SSE endpoint and forward events with Tab prefix
async fn connect_sse(
    app: &AppHandle, 
    url: &str,
    running: &AtomicBool,
    tab_id: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use futures_util::StreamExt;
    use crate::logger;

    logger::info(app, format!("[sse-proxy] Tab {} connecting to {}", tab_id, url));

    // Build client with read_timeout (idle timeout) for SSE long connections
    // IMPORTANT: Do NOT use timeout() which is total request time - SSE connections are meant to be long-lived
    // Use read_timeout instead: if no data received within this time, connection is considered dead
    // Backend sends heartbeat every 15s, so 60s read_timeout gives 4x margin
    // CRITICAL: Enable tcp_nodelay to disable Nagle's algorithm for immediate packet transmission
    // Without this, small SSE events may be buffered and delayed, causing UI to feel unresponsive
    // Force HTTP/1.1 for compatibility with Bun server (HTTP/2 may cause connection issues on Windows)
    // Use short-lived connection pool to balance performance and stability
    // CRITICAL: Disable proxy for localhost - reqwest uses system proxy by default!
    let client = reqwest::Client::builder()
        .read_timeout(std::time::Duration::from_secs(SSE_READ_TIMEOUT_SECS))
        .tcp_nodelay(true)
        .http1_only()  // Force HTTP/1.1 for stability (TODO v0.1.8: test HTTP/2 negotiation)
        .pool_idle_timeout(std::time::Duration::from_secs(5))  // Recycle idle connections after 5s
        .pool_max_idle_per_host(2)  // Keep up to 2 connections for reuse
        .no_proxy()  // Disable proxy for all requests (especially localhost)
        .build()
        .map_err(|e| format!("[sse-proxy] Failed to create HTTP client: {}", e))?;
    
    let response = client
        .get(url)
        .header("Accept", "text/event-stream")
        .send()
        .await?;

    if !response.status().is_success() {
        let err = format!("[sse-proxy] Tab {} connection failed: {}", tab_id, response.status());
        logger::error(app, &err);
        return Err(err.into());
    }

    logger::info(app, format!(
        "[sse-proxy] Tab {} connected, status: {}, read_timeout: {}s (heartbeat interval: 15s)",
        tab_id, response.status(), SSE_READ_TIMEOUT_SECS
    ));

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut chunk_count: u64 = 0;

    while running.load(Ordering::SeqCst) {
        match stream.next().await {
            Some(Ok(chunk)) => {
                chunk_count += 1;
                let text = String::from_utf8_lossy(&chunk);
                
                // Debug log for first few chunks and periodically
                if chunk_count <= 3 || chunk_count % 100 == 0 {
                    logger::debug(app, format!(
                        "[sse-proxy] Tab {} chunk #{}: {} bytes",
                        tab_id, chunk_count, chunk.len()
                    ));
                }
                
                buffer.push_str(&text);

                // Process complete SSE events (end with \n\n)
                while let Some(pos) = buffer.find("\n\n") {
                    let event_str = buffer[..pos].to_string();
                    buffer = buffer[pos + 2..].to_string();

                    // Parse and emit SSE event with Tab prefix
                    if let Some((event_name, data)) = parse_sse_event(&event_str) {
                        // Log critical state-changing events
                        if event_name == "chat:message-complete" || event_name == "chat:message-stopped" || event_name == "chat:message-error" {
                            logger::info(app, format!(
                                "[sse-proxy] Tab {} emitting critical event: {}",
                                tab_id, event_name
                            ));
                        }
                        // Emit with tab_id prefix: sse:tab_id:event_name
                        let prefixed_event = format!("sse:{}:{}", tab_id, event_name);
                        if let Err(e) = app.emit(&prefixed_event, data) {
                            logger::error(app, format!(
                                "[sse-proxy] Tab {} failed to emit {}: {}",
                                tab_id, prefixed_event, e
                            ));
                        }
                    }
                }
            }
            Some(Err(e)) => {
                // Log detailed error information for debugging
                let err_detail = format!("{:?}", e); // Debug format shows more details
                let buffer_preview = if buffer.len() > 200 {
                    format!("{}...(truncated, total {} bytes)", &buffer[..200], buffer.len())
                } else {
                    buffer.clone()
                };

                logger::error(app, format!(
                    "[sse-proxy] Tab {} stream error after {} chunks\n  Error: {}\n  Error detail: {}\n  Buffer preview: {:?}",
                    tab_id, chunk_count, e, err_detail, buffer_preview
                ));

                let err = format!("[sse-proxy] Tab {} stream error after {} chunks: {}", tab_id, chunk_count, e);
                return Err(err.into());
            }
            None => {
                logger::info(app, format!("[sse-proxy] Tab {} stream ended after {} chunks", tab_id, chunk_count));
                break;
            }
        }
    }

    logger::info(app, format!("[sse-proxy] Tab {} connection closed, processed {} chunks", tab_id, chunk_count));
    Ok(())
}

/// Parse SSE event format
/// Per SSE spec, the format is:
/// - "event: name\n" (event type)
/// - "data: value\n" (data, can have multiple lines)
/// - "\n" (empty line ends the event)
/// IMPORTANT: Per spec, only ONE space after the colon should be skipped (if present)
fn parse_sse_event(event_str: &str) -> Option<(String, String)> {
    let mut event_name = String::from("message");
    let mut data_lines = Vec::new();

    for line in event_str.lines() {
        if line.starts_with("event:") {
            // Event name can be trimmed
            event_name = line[6..].trim().to_string();
        } else if line.starts_with("data:") {
            // Per SSE spec: skip exactly one space after "data:" if present
            let content = &line[5..];
            let data_value = content.strip_prefix(' ').unwrap_or(content);
            data_lines.push(data_value.to_string());
        }
    }

    if data_lines.is_empty() {
        None
    } else {
        Some((event_name, data_lines.join("\n")))
    }
}

/// Generic HTTP request proxy - bypasses WebView CORS entirely
#[derive(serde::Deserialize)]
pub struct HttpRequest {
    pub url: String,
    pub method: String,
    pub body: Option<String>,
    pub headers: Option<std::collections::HashMap<String, String>>,
}

#[derive(serde::Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
    pub headers: std::collections::HashMap<String, String>,
    /// True if body is base64 encoded (for binary responses)
    pub is_base64: bool,
}

/// Check if content type indicates binary data
fn is_binary_content_type(content_type: &str) -> bool {
    let ct = content_type.to_lowercase();
    ct.starts_with("image/") ||
    ct.starts_with("audio/") ||
    ct.starts_with("video/") ||
    ct.starts_with("application/octet-stream") ||
    ct.starts_with("application/pdf")
}

/// Proxy an HTTP request through Rust - completely bypasses WebView CORS
#[tauri::command]
pub async fn proxy_http_request(app: AppHandle, request: HttpRequest) -> Result<HttpResponse, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
    use crate::logger;
    
    logger::info(&app, format!("[proxy] {} {} - Starting", request.method, request.url));
    
    // Build client with configurable timeout
    // Enable tcp_nodelay to disable Nagle's algorithm for faster response times
    // Force HTTP/1.1 for compatibility with Bun server (HTTP/2 may cause connection issues on Windows)
    // Use short-lived connection pool to balance performance and stability
    // CRITICAL: Disable proxy for localhost - reqwest uses system proxy by default!
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(HTTP_PROXY_TIMEOUT_SECS))
        .tcp_nodelay(true)
        .http1_only()  // Force HTTP/1.1 for stability (TODO v0.1.8: test HTTP/2 negotiation)
        .pool_idle_timeout(std::time::Duration::from_secs(5))  // Recycle idle connections after 5s
        .pool_max_idle_per_host(2)  // Keep up to 2 connections for reuse
        .no_proxy()  // Disable proxy for all requests (especially localhost)
        .build()
        .map_err(|e| {
            let err = format!("[proxy] Failed to create client: {}", e);
            logger::error(&app, &err);
            err
        })?;
    
    let mut req_builder = match request.method.to_uppercase().as_str() {
        "GET" => client.get(&request.url),
        "POST" => client.post(&request.url),
        "PUT" => client.put(&request.url),
        "DELETE" => client.delete(&request.url),
        _ => {
            let err = format!("[proxy] Unsupported method: {}", request.method);
            logger::error(&app, &err);
            return Err(err);
        }
    };

    // Add headers
    if let Some(headers) = request.headers {
        for (key, value) in headers {
            req_builder = req_builder.header(&key, &value);
        }
    }

    // Add body for POST/PUT
    if let Some(ref body) = request.body {
        logger::debug(&app, format!("[proxy] Request body length: {} bytes", body.len()));
        req_builder = req_builder.header("Content-Type", "application/json");
        req_builder = req_builder.body(body.clone());
    }

    logger::info(&app, format!("[proxy] {} {} - Sending request...", request.method, request.url));
    
    // Send request with detailed error logging
    let response = req_builder.send().await.map_err(|e| {
        let mut err = format!("[proxy] Request failed: {}", e);

        // Add detailed error information for debugging
        if e.is_connect() {
            err.push_str(" (Connection error - cannot establish connection)");
        }
        if e.is_timeout() {
            err.push_str(" (Timeout error - request took too long)");
        }
        if e.is_request() {
            err.push_str(" (Request error - invalid request)");
        }
        if e.is_body() {
            err.push_str(" (Body error - failed to read response body)");
        }

        // Try to get the source error
        if let Some(source) = e.source() {
            err.push_str(&format!(" | Source: {}", source));
        }

        logger::error(&app, &err);
        e.to_string()
    })?;
    
    let status = response.status().as_u16();
    
    // Collect response headers
    let mut resp_headers = std::collections::HashMap::new();
    for (key, value) in response.headers() {
        if let Ok(v) = value.to_str() {
            resp_headers.insert(key.to_string(), v.to_string());
        }
    }
    
    // Check if this is binary content
    let content_type = resp_headers.get("content-type")
        .map(|s| s.as_str())
        .unwrap_or("");
    
    let is_binary = is_binary_content_type(content_type);
    
    // Get response body - encode as base64 if binary
    let (body, is_base64) = if is_binary {
        let bytes = response.bytes().await.map_err(|e| {
            let err = format!("[proxy] Failed to read binary body: {}", e);
            logger::error(&app, &err);
            e.to_string()
        })?;
        logger::debug(&app, format!("[proxy] Binary response: {} bytes", bytes.len()));
        (BASE64.encode(&bytes), true)
    } else {
        let text = response.text().await.map_err(|e| {
            let err = format!("[proxy] Failed to read text body: {}", e);
            logger::error(&app, &err);
            e.to_string()
        })?;
        logger::debug(&app, format!("[proxy] Text response: {} bytes", text.len()));
        (text, false)
    };
    
    logger::info(&app, format!("[proxy] {} {} - Complete (status: {}, body: {} bytes)", 
        request.method, request.url, status, body.len()));
    
    Ok(HttpResponse {
        status,
        body,
        headers: resp_headers,
        is_base64,
    })
}
