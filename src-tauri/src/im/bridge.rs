// OpenClaw Channel Plugin Bridge Adapter
//
// Implements ImAdapter + ImStreamAdapter for OpenClaw community channel plugins.
// The Bridge is an independent Bun process that loads the plugin and communicates
// with Rust via HTTP endpoints.

use tauri::Manager;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::Client;
use serde_json::json;
use tokio::sync::{mpsc, Mutex};

use crate::im::adapter::{AdapterResult, ImAdapter, ImStreamAdapter};
use crate::im::types::ImMessage;
use crate::{ulog_debug, ulog_error, ulog_info, ulog_warn};
// Note: ulog_* macros write to BOTH system log AND unified log (~/.myagents/logs/unified-*.log)
// This is critical for bridge stdout/stderr — using log::info! only writes to system log.

// ===== Per-plugin install/prepare mutex =====
//
// Multiple bots can share the same OpenClaw plugin_id (e.g. two Lark
// accounts on `@larksuite/openclaw-lark`). On app startup auto-start
// fans them out concurrently; the periodic monitor likewise restarts
// dead channels in parallel. Their `spawn_plugin_bridge` paths each do:
//   1. Shim integrity check → optional `install_sdk_shim` (rmtree + copy_dir_recursive)
//   2. tsx-runtime resolve → spawn Node bridge
//
// Step 1's `rmtree + copy_dir_recursive` is NOT atomic — two callers
// racing here can corrupt the shim tree (one's rmtree wins midway
// through the other's copy). Codex Critical 3 / Agent A M2 flagged
// this. The same risk applies to `install_plugin` (wizard-driven, but
// nothing prevents the user from kicking off a re-install while a
// bot using the same plugin spawns).
//
// In-process async mutex per `plugin_dir` is enough because:
//   - Tauri single-instance plugin prevents cross-process MyAgents.
//   - We only need to serialize *our own* mutations of `plugin_dir`.
//
// Keyed by canonicalised plugin_dir path so lexically-different paths
// pointing at the same dir share a lock.
fn plugin_install_lock(plugin_dir: &std::path::Path) -> std::sync::Arc<Mutex<()>> {
    use std::sync::{Arc, OnceLock};
    static LOCKS: OnceLock<std::sync::Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let map = LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let key = std::fs::canonicalize(plugin_dir).unwrap_or_else(|_| plugin_dir.to_path_buf());
    let mut guard = map.lock().expect("plugin install lock map poisoned");
    Arc::clone(guard.entry(key).or_insert_with(|| Arc::new(Mutex::new(()))))
}

// ===== Bridge Sender Registry =====
// Lets management API route inbound messages from Bridge → processing loop.

/// Registry entry: sender channel + plugin ID (for uninstall safety check).
struct BridgeSenderEntry {
    tx: mpsc::Sender<ImMessage>,
    plugin_id: String,
}

static BRIDGE_SENDERS: OnceLock<Mutex<HashMap<String, BridgeSenderEntry>>> = OnceLock::new();

const MAX_BRIDGE_LIVENESS_FAILURES: u32 = 3;
const BRIDGE_HEALTH_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const BRIDGE_STOP_REQUEST_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BridgeLivenessObservation {
    Healthy,
    Recovered { prior_failures: u32 },
    Failed { failures: u32, should_stop: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BridgeFunctionalObservation {
    Stable,
    Degraded,
    Recovered,
}

#[derive(Default)]
struct BridgeHealthWatchdog {
    consecutive_liveness_failures: u32,
    functional_degraded: bool,
}

impl BridgeHealthWatchdog {
    fn observe_liveness(&mut self, healthy: bool) -> BridgeLivenessObservation {
        if healthy {
            let prior_failures = std::mem::take(&mut self.consecutive_liveness_failures);
            return if prior_failures > 0 {
                BridgeLivenessObservation::Recovered { prior_failures }
            } else {
                BridgeLivenessObservation::Healthy
            };
        }

        self.consecutive_liveness_failures += 1;
        BridgeLivenessObservation::Failed {
            failures: self.consecutive_liveness_failures,
            should_stop: self.consecutive_liveness_failures >= MAX_BRIDGE_LIVENESS_FAILURES,
        }
    }

    fn observe_functional(&mut self, healthy: bool) -> BridgeFunctionalObservation {
        match (self.functional_degraded, healthy) {
            (false, false) => {
                self.functional_degraded = true;
                BridgeFunctionalObservation::Degraded
            }
            (true, true) => {
                self.functional_degraded = false;
                BridgeFunctionalObservation::Recovered
            }
            _ => BridgeFunctionalObservation::Stable,
        }
    }
}

fn get_registry() -> &'static Mutex<HashMap<String, BridgeSenderEntry>> {
    BRIDGE_SENDERS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub async fn register_bridge_sender(bot_id: &str, plugin_id: &str, tx: mpsc::Sender<ImMessage>) {
    get_registry().lock().await.insert(
        bot_id.to_string(),
        BridgeSenderEntry {
            tx,
            plugin_id: plugin_id.to_string(),
        },
    );
}

pub async fn unregister_bridge_sender(bot_id: &str) {
    get_registry().lock().await.remove(bot_id);
}

pub async fn get_bridge_sender(bot_id: &str) -> Option<mpsc::Sender<ImMessage>> {
    get_registry()
        .lock()
        .await
        .get(bot_id)
        .map(|e| e.tx.clone())
}

/// Check if any running bot uses the given plugin_id.
pub async fn is_plugin_in_use(plugin_id: &str) -> bool {
    get_registry()
        .lock()
        .await
        .values()
        .any(|e| e.plugin_id == plugin_id)
}

/// Return all bot_ids currently using the given plugin_id.
pub async fn get_bot_ids_using_plugin(plugin_id: &str) -> Vec<String> {
    get_registry()
        .lock()
        .await
        .iter()
        .filter(|(_, e)| e.plugin_id == plugin_id)
        .map(|(bot_id, _)| bot_id.clone())
        .collect()
}

// ===== BridgeAdapter =====

pub struct BridgeAdapter {
    plugin_id: String,
    bridge_port: u16,
    client: Client,
    #[allow(dead_code)]
    max_msg_length: usize,
    /// Whether the plugin supports edit_message (from capabilities.edit).
    /// When false, streaming skips draft creation and edit calls entirely.
    supports_edit: bool,
    enabled_tool_groups: Vec<String>,
    /// All tool groups discovered from plugin (before user filtering).
    /// Used to auto-merge new groups into user config.
    all_tool_groups: Vec<String>,
    /// Plugin-registered slash commands (name → description)
    commands: Vec<(String, String)>,
}

impl BridgeAdapter {
    pub fn new(plugin_id: String, bridge_port: u16) -> Self {
        let client = crate::local_http::json_client(Duration::from_secs(30));
        Self {
            plugin_id,
            bridge_port,
            client,
            max_msg_length: 4096,
            supports_edit: true, // assume yes until sync_capabilities proves otherwise
            enabled_tool_groups: Vec::new(),
            all_tool_groups: Vec::new(),
            commands: Vec::new(),
        }
    }

    /// Fetch plugin capabilities from bridge and update outbound metadata.
    /// Called once after bridge is verified healthy.
    pub async fn sync_capabilities(&mut self) {
        match self.client.get(self.url("/capabilities")).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(body) = resp.json::<serde_json::Value>().await {
                    if let Some(limit) = body["textChunkLimit"].as_u64() {
                        self.max_msg_length = limit as usize;
                        ulog_info!("[bridge:{}] textChunkLimit = {}", self.plugin_id, limit);
                    }
                    let caps = &body["capabilities"];
                    // edit capability — when false, streaming skips draft+edit entirely
                    if caps["edit"].as_bool() == Some(false) {
                        self.supports_edit = false;
                        ulog_info!("[bridge:{}] edit not supported — streaming will accumulate and send once", self.plugin_id);
                    }
                    // Plugin commands
                    if let Some(cmds) = caps["commands"].as_array() {
                        self.commands = cmds
                            .iter()
                            .filter_map(|c| {
                                let name = c["name"].as_str()?.to_string();
                                let desc = c["description"].as_str().unwrap_or("").to_string();
                                Some((name, desc))
                            })
                            .collect();
                        if !self.commands.is_empty() {
                            ulog_info!(
                                "[bridge:{}] commands: {:?}",
                                self.plugin_id,
                                self.commands
                                    .iter()
                                    .map(|(n, _)| n.as_str())
                                    .collect::<Vec<_>>()
                            );
                        }
                    }
                    // Tool groups
                    if let Some(groups) = caps["toolGroups"].as_array() {
                        let parsed: Vec<String> = groups
                            .iter()
                            .filter_map(|g| g.as_str().map(String::from))
                            .collect();
                        if !parsed.is_empty() {
                            ulog_info!("[bridge:{}] tool groups: {:?}", self.plugin_id, parsed);
                        }
                        self.all_tool_groups = parsed.clone();
                        self.enabled_tool_groups = parsed;
                    }
                }
            }
            _ => {
                ulog_debug!(
                    "[bridge:{}] Could not fetch capabilities, using defaults",
                    self.plugin_id
                );
            }
        }
    }

    /// All tool groups discovered from plugin (before user filtering).
    pub fn all_tool_groups(&self) -> &[String] {
        &self.all_tool_groups
    }

    /// Override enabled tool groups with user-configured selection.
    /// Called after sync_capabilities() to replace plugin-declared groups
    /// with the user's choices from the channel config UI.
    pub fn set_enabled_tool_groups(&mut self, groups: Vec<String>) {
        ulog_info!(
            "[bridge:{}] user-configured tool groups: {:?}",
            self.plugin_id,
            groups
        );
        self.enabled_tool_groups = groups;
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.bridge_port, path)
    }

    async fn post_reply_operation(
        &self,
        path: &str,
        operation: &str,
        body: &serde_json::Value,
    ) -> AdapterResult<serde_json::Value> {
        let resp = self
            .client
            .post(self.url(path))
            .json(body)
            .send()
            .await
            .map_err(|e| format!("Bridge {} failed: {}", operation, e))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Bridge {} returned {}: {}",
                operation, status, text
            ));
        }
        Ok(resp.json().await.unwrap_or_default())
    }

    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    /// Check if text matches a plugin-registered command. Returns (command_name, args).
    pub fn match_command(&self, text: &str) -> Option<(String, String)> {
        let trimmed = text.trim();
        for (name, _desc) in &self.commands {
            let cmd = format!("/{}", name);
            if trimmed == cmd || trimmed.starts_with(&format!("{} ", cmd)) {
                let args = trimmed.strip_prefix(&cmd).unwrap_or("").trim().to_string();
                return Some((name.clone(), args));
            }
        }
        None
    }

    /// Execute a plugin command via Bridge's /execute-command endpoint.
    pub async fn execute_command(
        &self,
        command: &str,
        args: &str,
        user_id: &str,
        chat_id: &str,
    ) -> AdapterResult<String> {
        let body = serde_json::json!({
            "command": command,
            "args": args,
            "userId": user_id,
            "chatId": chat_id,
        });
        let resp = self
            .client
            .post(self.url("/execute-command"))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Bridge execute-command failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Bridge execute-command returned {}: {}",
                status, text
            ));
        }

        let resp_body: serde_json::Value = resp.json().await.unwrap_or_default();
        if resp_body["ok"].as_bool() != Some(true) {
            return Err(format!(
                "Command error: {}",
                resp_body["error"].as_str().unwrap_or("unknown")
            ));
        }
        Ok(resp_body["result"].as_str().unwrap_or("OK").to_string())
    }

    /// Get registered commands for /help display.
    pub fn get_commands(&self) -> &[(String, String)] {
        &self.commands
    }

    /// Fetch bot display name from bridge's `/identity` endpoint.
    ///
    /// 10s timeout — bridge pre-warms the resolver after `gatewayStarted`,
    /// so cache is usually ready by the time verify_connection polls. Cold
    /// path: lark/qq resolvers do token + info fetches at 3s each (≤6s),
    /// well under the 10s ceiling. Beyond that we give up and return None;
    /// next channel restart will re-resolve.
    async fn fetch_display_name(&self) -> Option<String> {
        let resp = match self
            .client
            .get(self.url("/identity"))
            .timeout(Duration::from_secs(10))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                ulog_warn!(
                    "[bridge:{}] /identity request failed: {} — display name will be unset",
                    self.plugin_id,
                    e
                );
                return None;
            }
        };
        if !resp.status().is_success() {
            ulog_warn!(
                "[bridge:{}] /identity returned HTTP {} — display name will be unset",
                self.plugin_id,
                resp.status()
            );
            return None;
        }
        let body: serde_json::Value = match resp.json().await {
            Ok(b) => b,
            Err(e) => {
                ulog_warn!(
                    "[bridge:{}] /identity JSON parse failed: {}",
                    self.plugin_id,
                    e
                );
                return None;
            }
        };
        let name = body["displayName"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);
        if name.is_none() {
            // displayName: null is the expected response for plugins without a
            // resolver (wecom / weixin) — log at debug, not warn, to avoid
            // noise on every channel start.
            ulog_debug!(
                "[bridge:{}] /identity returned null displayName (no resolver / resolution failed)",
                self.plugin_id
            );
        }
        name
    }
}

impl ImAdapter for BridgeAdapter {
    async fn verify_connection(&self) -> AdapterResult<String> {
        // Poll /status with retries — loadPlugin() may still be running
        // (health check only verifies HTTP server is up, not that the plugin is loaded)
        let max_attempts = 30; // 30 * 500ms = 15s max wait for plugin load + credential validation
        let mut last_err: Option<String> = None;
        for attempt in 0..max_attempts {
            // Connection-level errors (port not yet bound) MUST be retried, not
            // returned immediately — bridge spawns the HTTP listener after
            // loadPlugin() finishes, so first attempts can hit ECONNREFUSED
            // before the bridge has a chance to listen. (#211)
            let resp = match self.client.get(self.url("/status")).send().await {
                Ok(r) => r,
                Err(e) => {
                    last_err = Some(format!("Bridge status check failed: {}", e));
                    if attempt < max_attempts - 1 {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                    continue;
                }
            };

            if !resp.status().is_success() {
                return Err(format!("Bridge returned status {}", resp.status()));
            }

            let body: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("Bridge status parse error: {}", e))?;

            // If there's a gateway error, fail immediately with the specific message
            if let Some(err_msg) = body["error"].as_str() {
                return Err(format!("Bridge plugin error: {}", err_msg));
            }

            if body["ready"].as_bool() == Some(true) {
                // Don't fall back to pluginName (= npm package name) — that's
                // the bug we're fixing in v0.2.10 (it surfaced as the bot's
                // display name in the channel list, e.g. "wecom/wecom-openclaw-plugin").
                // Pull display name from /identity (resolver-cached on bridge side).
                // Empty / missing means "no display name available" — caller MUST
                // write None to bot_username so any historical dirty value is cleared.
                let display_name = self.fetch_display_name().await.unwrap_or_default();
                return Ok(display_name);
            }

            // Plugin not ready yet — wait and retry
            if attempt < max_attempts - 1 {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }

        Err(last_err.unwrap_or_else(|| "Bridge plugin not ready after 15s (registration or credential validation may have failed)".to_string()))
    }

    async fn register_commands(&self) -> AdapterResult<()> {
        // No-op for bridge plugins
        Ok(())
    }

    async fn listen_loop(&self, mut shutdown_rx: tokio::sync::watch::Receiver<bool>) {
        // Bridge pushes messages to Rust via management API. Process liveness
        // and upstream gateway functionality are orthogonal: only a failed
        // live probe may terminate this owner. Functional degradation is
        // transition-logged while the healthy Bridge process keeps its own
        // plugin/backoff state.
        ulog_info!(
            "[bridge:{}] Listen loop with health watchdog started",
            self.plugin_id
        );
        let mut watchdog = BridgeHealthWatchdog::default();

        loop {
            tokio::select! {
                result = shutdown_rx.changed() => {
                    if result.is_err() || *shutdown_rx.borrow() {
                        break;
                    }
                }
                _ = tokio::time::sleep(Duration::from_secs(30)) => {
                    // `/health/live` is the process watchdog. Older bridge
                    // bundles may only expose the legacy `/health` alias.
                    let (live_endpoint, live_result) = match self.client
                        .get(self.url("/health/live"))
                        .timeout(BRIDGE_HEALTH_REQUEST_TIMEOUT)
                        .send()
                        .await
                    {
                        Ok(response) if response.status() == reqwest::StatusCode::NOT_FOUND => {
                            (
                                "/health",
                                self.client
                                    .get(self.url("/health"))
                                    .timeout(BRIDGE_HEALTH_REQUEST_TIMEOUT)
                                    .send()
                                    .await,
                            )
                        }
                        result => ("/health/live", result),
                    };
                    let live_success = live_result
                        .as_ref()
                        .map(|response| response.status().is_success())
                        .unwrap_or(false);
                    match watchdog.observe_liveness(live_success) {
                        BridgeLivenessObservation::Healthy => {}
                        BridgeLivenessObservation::Recovered { prior_failures } => {
                            ulog_info!("[bridge:{}] Liveness recovered after {} failures", self.plugin_id, prior_failures);
                        }
                        BridgeLivenessObservation::Failed { failures, should_stop } => {
                            match live_result {
                                Ok(response) => ulog_error!(
                                    "[bridge:{}] {} returned {}, liveness failure {}/{}",
                                    self.plugin_id,
                                    live_endpoint,
                                    response.status(),
                                    failures,
                                    MAX_BRIDGE_LIVENESS_FAILURES,
                                ),
                                Err(error) => ulog_error!(
                                    "[bridge:{}] Liveness check failed: {}, failure {}/{}",
                                    self.plugin_id,
                                    error,
                                    failures,
                                    MAX_BRIDGE_LIVENESS_FAILURES,
                                ),
                            }
                            if should_stop {
                                ulog_error!(
                                    "[bridge:{}] Bridge process appears dead ({} consecutive liveness failures), exiting listen loop",
                                    self.plugin_id,
                                    MAX_BRIDGE_LIVENESS_FAILURES,
                                );
                                break;
                            }
                            continue;
                        }
                    }

                    // Functional health is diagnostic only. An upstream outage
                    // must not reset a live plugin process and its backoff state.
                    match self.client
                        .get(self.url("/health/functional"))
                        .timeout(BRIDGE_HEALTH_REQUEST_TIMEOUT)
                        .send()
                        .await
                    {
                        Ok(response) if response.status() == reqwest::StatusCode::NOT_FOUND => {
                            if watchdog.observe_functional(true) == BridgeFunctionalObservation::Recovered {
                                ulog_info!("[bridge:{}] Functional health probe recovered", self.plugin_id);
                            }
                        }
                        Ok(response) if response.status().is_success() => {
                            if watchdog.observe_functional(true) == BridgeFunctionalObservation::Recovered {
                                ulog_info!("[bridge:{}] Functional health recovered", self.plugin_id);
                            }
                        }
                        Ok(response) => {
                            let status = response.status();
                            if watchdog.observe_functional(false) == BridgeFunctionalObservation::Degraded {
                                ulog_warn!(
                                    "[bridge:{}] Functional health degraded: status={}",
                                    self.plugin_id,
                                    status,
                                );
                            }
                        }
                        Err(error) => {
                            if watchdog.observe_functional(false) == BridgeFunctionalObservation::Degraded {
                                ulog_warn!(
                                    "[bridge:{}] Functional health degraded: {}",
                                    self.plugin_id,
                                    error,
                                );
                            }
                        }
                    }
                }
            }
        }
        // Signal bridge to stop (best effort — may already be dead)
        ulog_info!("[bridge:{}] Sending stop to bridge", self.plugin_id);
        let _ = self
            .client
            .post(self.url("/stop"))
            .timeout(BRIDGE_STOP_REQUEST_TIMEOUT)
            .send()
            .await;
    }

    async fn send_message(&self, chat_id: &str, text: &str) -> AdapterResult<()> {
        ulog_info!(
            "[bridge:{}] send_message: chatId={}, textLen={}",
            self.plugin_id,
            chat_id,
            text.len()
        );
        let body = json!({
            "chatId": chat_id,
            "text": text,
        });
        let resp = self
            .client
            .post(self.url("/send-text"))
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                ulog_warn!(
                    "[bridge:{}] send_message request failed: {}",
                    self.plugin_id,
                    e
                );
                format!("Bridge send-text failed: {}", e)
            })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            ulog_warn!(
                "[bridge:{}] send_message returned {}: {}",
                self.plugin_id,
                status,
                text
            );
            return Err(format!("Bridge send-text returned {}: {}", status, text));
        }
        Ok(())
    }

    async fn ack_received(&self, _chat_id: &str, _message_id: &str) {
        // No-op
    }

    async fn ack_processing(&self, _chat_id: &str, _message_id: &str) {
        // No-op
    }

    async fn ack_clear(&self, _chat_id: &str, _message_id: &str) {
        // No-op
    }

    async fn send_typing(&self, _chat_id: &str) {
        // No-op
    }
}

impl ImStreamAdapter for BridgeAdapter {
    async fn send_message_returning_id(
        &self,
        chat_id: &str,
        text: &str,
    ) -> AdapterResult<Option<String>> {
        ulog_info!(
            "[bridge:{}] send_message_returning_id: chatId={}, textLen={}",
            self.plugin_id,
            chat_id,
            text.len()
        );
        let body = json!({
            "chatId": chat_id,
            "text": text,
        });
        let resp = self
            .client
            .post(self.url("/send-text"))
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                ulog_warn!(
                    "[bridge:{}] send_message_returning_id request failed: {}",
                    self.plugin_id,
                    e
                );
                format!("Bridge send-text failed: {}", e)
            })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            ulog_warn!(
                "[bridge:{}] send_message_returning_id returned {}: {}",
                self.plugin_id,
                status,
                text
            );
            return Err(format!("Bridge send-text returned {}: {}", status, text));
        }

        let resp_body: serde_json::Value = resp.json().await.unwrap_or_default();
        let msg_id = resp_body["messageId"].as_str().map(|s| s.to_string());
        ulog_info!(
            "[bridge:{}] send_message_returning_id ok: messageId={:?}",
            self.plugin_id,
            msg_id
        );
        Ok(msg_id)
    }

    async fn edit_message(&self, chat_id: &str, message_id: &str, text: &str) -> AdapterResult<()> {
        ulog_info!(
            "[bridge:{}] edit_message: chatId={}, messageId={}, textLen={}",
            self.plugin_id,
            chat_id,
            message_id,
            text.len()
        );
        let body = json!({
            "chatId": chat_id,
            "messageId": message_id,
            "text": text,
        });
        let resp = self
            .client
            .post(self.url("/edit-message"))
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                ulog_warn!(
                    "[bridge:{}] edit_message request failed: {}",
                    self.plugin_id,
                    e
                );
                format!("Bridge edit-message failed: {}", e)
            })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            ulog_warn!(
                "[bridge:{}] edit_message returned {}: {}",
                self.plugin_id,
                status,
                text
            );
            // Prefix with "status:<code>:" for structured matching in finalize_message.
            // This avoids fragile substring matching on the error body.
            return Err(format!(
                "status:{}:Bridge edit-message returned {}: {}",
                status.as_u16(),
                status,
                text
            ));
        }
        Ok(())
    }

    async fn delete_message(&self, chat_id: &str, message_id: &str) -> AdapterResult<()> {
        ulog_info!(
            "[bridge:{}] delete_message: chatId={}, messageId={}",
            self.plugin_id,
            chat_id,
            message_id
        );
        let body = json!({
            "chatId": chat_id,
            "messageId": message_id,
        });
        let resp = self
            .client
            .post(self.url("/delete-message"))
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                ulog_warn!(
                    "[bridge:{}] delete_message request failed: {}",
                    self.plugin_id,
                    e
                );
                format!("Bridge delete-message failed: {}", e)
            })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            ulog_warn!(
                "[bridge:{}] delete_message returned {}: {}",
                self.plugin_id,
                status,
                text
            );
            return Err(format!(
                "Bridge delete-message returned {}: {}",
                status, text
            ));
        }
        Ok(())
    }

    fn max_message_length(&self) -> usize {
        self.max_msg_length
    }

    async fn send_approval_card(
        &self,
        _chat_id: &str,
        _request_id: &str,
        _tool_name: &str,
        _tool_input: &str,
    ) -> AdapterResult<Option<String>> {
        // No approval card support for bridge plugins
        Ok(None)
    }

    async fn update_approval_status(
        &self,
        _chat_id: &str,
        _message_id: &str,
        _status: &str,
    ) -> AdapterResult<()> {
        // No-op
        Ok(())
    }

    async fn send_photo(
        &self,
        chat_id: &str,
        data: Vec<u8>,
        filename: &str,
        caption: Option<&str>,
    ) -> AdapterResult<Option<String>> {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
        let body = json!({
            "chatId": chat_id,
            "type": "image",
            "filename": filename,
            "data": b64,
            "caption": caption,
        });
        let resp = self
            .client
            .post(self.url("/send-media"))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Bridge send-media failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Bridge send-media returned {}: {}", status, text));
        }
        let resp_body: serde_json::Value = resp.json().await.unwrap_or_default();
        Ok(resp_body["messageId"].as_str().map(|s| s.to_string()))
    }

    async fn send_file(
        &self,
        chat_id: &str,
        data: Vec<u8>,
        filename: &str,
        mime_type: &str,
        caption: Option<&str>,
    ) -> AdapterResult<Option<String>> {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
        let body = json!({
            "chatId": chat_id,
            "type": "file",
            "filename": filename,
            "mimeType": mime_type,
            "data": b64,
            "caption": caption,
        });
        let resp = self
            .client
            .post(self.url("/send-media"))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Bridge send-media failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Bridge send-media returned {}: {}", status, text));
        }
        let resp_body: serde_json::Value = resp.json().await.unwrap_or_default();
        Ok(resp_body["messageId"].as_str().map(|s| s.to_string()))
    }

    async fn finalize_message(
        &self,
        chat_id: &str,
        message_id: &str,
        text: &str,
    ) -> super::adapter::AdapterResult<()> {
        if !self.supports_edit {
            // Plugin declared edit:false — no draft was created during streaming
            // (supports_edit guards the streaming loop). The message_id here is either
            // a placeholder or doesn't exist. Just send the complete text directly.
            // finalize_block only calls this when draft_id is Some, so clean up the placeholder.
            let _ = self.delete_message(chat_id, message_id).await;
            return self.send_message(chat_id, text).await;
        }
        // Edit-capable plugin: try edit-in-place with the COMPLETE text.
        match self.edit_message(chat_id, message_id, text).await {
            Ok(()) => Ok(()),
            Err(e) if e.starts_with("status:501:") || e.starts_with("status:405:") => {
                // Runtime 501 (capability not detected at startup) — delete fragment + send full text
                ulog_info!(
                    "[bridge:{}] finalize: runtime edit 501, replacing fragment with full message",
                    self.plugin_id
                );
                let _ = self.delete_message(chat_id, message_id).await;
                self.send_message(chat_id, text).await
            }
            Err(e) => Err(e),
        }
    }

    fn use_draft_streaming(&self) -> bool {
        false
    }

    fn supports_edit(&self) -> bool {
        self.supports_edit
    }

    fn preferred_throttle_ms(&self) -> u64 {
        300
    }

    fn bridge_context(&self) -> Option<(u16, String, Vec<String>)> {
        Some((
            self.bridge_port,
            self.plugin_id.clone(),
            self.enabled_tool_groups.clone(),
        ))
    }

    async fn start_reply_dispatch(&self, request_id: &str) -> AdapterResult<()> {
        self.post_reply_operation(
            "/start-dispatch",
            "start-dispatch",
            &json!({ "requestId": request_id }),
        )
        .await?;
        Ok(())
    }

    async fn start_reply_stream(
        &self,
        request_id: &str,
        chat_id: &str,
        initial_text: &str,
    ) -> AdapterResult<String> {
        let body = json!({
            "requestId": request_id,
            "chatId": chat_id,
            "initialContent": initial_text,
        });
        let resp_body = self
            .post_reply_operation("/start-stream", "start-stream", &body)
            .await?;
        Ok(resp_body["streamId"].as_str().unwrap_or("").to_string())
    }

    async fn update_reply_stream(
        &self,
        stream_id: &str,
        text: &str,
        sequence: u32,
        is_thinking: bool,
    ) -> AdapterResult<()> {
        let body = json!({
            "streamId": stream_id,
            "content": text,
            "sequence": sequence,
            "isThinking": is_thinking,
        });
        self.post_reply_operation("/stream-chunk", "stream-chunk", &body)
            .await?;
        Ok(())
    }

    async fn finish_reply_stream_block(&self, stream_id: &str) -> AdapterResult<()> {
        self.post_reply_operation(
            "/finish-stream-block",
            "finish-stream-block",
            &json!({ "streamId": stream_id }),
        )
        .await?;
        Ok(())
    }

    async fn complete_reply_dispatch(
        &self,
        request_id: &str,
        final_payloads: &serde_json::Value,
    ) -> AdapterResult<()> {
        self.post_reply_operation(
            "/complete-dispatch",
            "complete-dispatch",
            &json!({
                "requestId": request_id,
                "finalPayloads": final_payloads,
            }),
        )
        .await?;
        Ok(())
    }

    async fn abort_reply_dispatch(
        &self,
        request_id: &str,
        reason: &str,
        terminal_payload: &serde_json::Value,
    ) -> AdapterResult<()> {
        self.post_reply_operation(
            "/abort-dispatch",
            "abort-dispatch",
            &json!({
                "requestId": request_id,
                "reason": reason,
                "terminalPayload": terminal_payload,
            }),
        )
        .await?;
        Ok(())
    }
}

// ===== QR Login proxy functions =====
// These call the Bridge's /qr-login-start, /qr-login-wait, /restart-gateway
// endpoints. Used by Tauri commands during the channel wizard.

pub async fn qr_login_start(
    bridge_port: u16,
    account_id: Option<&str>,
) -> Result<serde_json::Value, String> {
    let client = crate::local_http::json_client(std::time::Duration::from_secs(30));
    let url = format!("http://127.0.0.1:{}/qr-login-start", bridge_port);
    let mut body = serde_json::json!({});
    if let Some(id) = account_id {
        body["accountId"] = serde_json::json!(id);
    }
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("QR login start request failed: {}", e))?;
    let status = resp.status();
    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("QR login start parse failed: {}", e))?;
    if !status.is_success() {
        return Err(format!("QR login start failed ({}): {}", status, result));
    }
    Ok(result)
}

pub async fn qr_login_wait(
    bridge_port: u16,
    account_id: Option<&str>,
    session_key: Option<&str>,
) -> Result<serde_json::Value, String> {
    // WeChat's internal long-poll is 35s per cycle. Set Rust timeout to 45s (covers one full
    // poll cycle + buffer). Also pass timeoutMs=40000 to the plugin so it exits after one
    // cycle instead of looping internally for 8 minutes.
    let client = crate::local_http::json_client(std::time::Duration::from_secs(45));
    let url = format!("http://127.0.0.1:{}/qr-login-wait", bridge_port);
    let mut body = serde_json::json!({});
    if let Some(id) = account_id {
        body["accountId"] = serde_json::json!(id);
    }
    if let Some(sk) = session_key {
        body["sessionKey"] = serde_json::json!(sk);
    }
    // Limit plugin's internal poll to one cycle (~35s) so it returns control to our frontend loop
    body["timeoutMs"] = serde_json::json!(40000);
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("QR login wait request failed: {}", e))?;
    let status = resp.status();
    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("QR login wait parse failed: {}", e))?;
    if !status.is_success() {
        return Err(format!("QR login wait failed ({}): {}", status, result));
    }
    Ok(result)
}

pub async fn restart_gateway(
    bridge_port: u16,
    account_id: Option<&str>,
) -> Result<serde_json::Value, String> {
    let client = crate::local_http::json_client(std::time::Duration::from_secs(15));
    let url = format!("http://127.0.0.1:{}/restart-gateway", bridge_port);
    let mut body = serde_json::json!({});
    if let Some(id) = account_id {
        body["accountId"] = serde_json::json!(id);
    }
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Restart gateway request failed: {}", e))?;
    let status = resp.status();
    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Restart gateway parse failed: {}", e))?;
    if !status.is_success() {
        return Err(format!("Restart gateway failed ({}): {}", status, result));
    }
    Ok(result)
}

// ===== Bridge Process Management =====

/// Handle to a running bridge process
pub struct BridgeProcess {
    child: crate::process_cmd::ChildTree,
    pub port: u16,
}

impl BridgeProcess {
    pub fn kill_sync(&mut self) -> Result<(), String> {
        let root_already_exited = match self.child.try_wait() {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(error) => {
                return Err(format!("failed to inspect Plugin Bridge process: {error}"));
            }
        };

        // The command wrapper may exit before one of its descendants. Always
        // terminate the retained process-group / Job authority, even after the
        // direct child has already been reaped.
        if let Err(kill_error) = self.child.kill() {
            return match self.child.try_wait() {
                Ok(Some(_)) => Ok(()),
                Ok(None) => Err(format!("failed to terminate Plugin Bridge process: {kill_error}")),
                Err(wait_error) => Err(format!(
                    "failed to terminate Plugin Bridge process: {kill_error}; status check failed: {wait_error}"
                )),
            };
        }

        if root_already_exited {
            return Ok(());
        }

        self.child
            .wait()
            .map(|_| ())
            .map_err(|error| format!("failed to reap Plugin Bridge process: {error}"))
    }

    pub async fn kill(&mut self) -> Result<(), String> {
        // Use spawn_blocking to avoid blocking the tokio runtime
        // We take ownership issues here, so just do sync kill inline
        // since kill + wait are fast operations on an already-killed process.
        self.kill_sync()
    }
}

/// Find the plugin-bridge script (dev: TS source, prod: bundled JS)
fn find_bridge_script<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) -> Option<PathBuf> {
    // Production: bundled .mjs in resources. Extension is load-bearing —
    // Node treats `.mjs` as ESM unconditionally per spec, which sidesteps
    // a tsx-loader CJS-conversion trap that fired on Windows production
    // installs (no `package.json` above the resources dir, Node defaults
    // to commonjs, tsx transpiles → ERR_REQUIRE_CYCLE_MODULE). See
    // scripts/esbuild-bundle.mjs `bridge` target for the full rationale.
    #[cfg(not(debug_assertions))]
    {
        use crate::sidecar::normalize_external_path;
        if let Ok(resource_dir) = app_handle.path().resource_dir() {
            let bundled: PathBuf = resource_dir.join("plugin-bridge-dist.mjs");
            if bundled.exists() {
                let bundled = normalize_external_path(bundled);
                ulog_info!("[bridge] Using bundled bridge script: {:?}", bundled);
                return Some(bundled);
            }
        }
    }

    // Development: source TS (tsx/esm injected at spawn; see spawn_bridge)
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let project_root = std::path::Path::new(manifest_dir)
        .parent()
        .unwrap_or(std::path::Path::new("."));
    let ts_source = project_root.join("src/server/plugin-bridge/index.ts");
    if ts_source.exists() {
        ulog_info!("[bridge] Using dev bridge script: {:?}", ts_source);
        return Some(ts_source);
    }

    let _ = app_handle;
    ulog_error!("[bridge] Bridge script not found");
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OpenClawBridgeStateEnv {
    state_dir: PathBuf,
    oauth_dir: PathBuf,
    config_path: PathBuf,
}

fn openclaw_bridge_state_env(state_dir: &Path) -> OpenClawBridgeStateEnv {
    OpenClawBridgeStateEnv {
        state_dir: state_dir.to_path_buf(),
        oauth_dir: state_dir.join("credentials"),
        config_path: state_dir.join("openclaw.json"),
    }
}

fn path_env_value(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openclaw_bridge_state_env_scopes_runtime_files_under_channel_dir() {
        let base = std::env::temp_dir()
            .join("myagents-test")
            .join(".myagents")
            .join("agents")
            .join("agent-1")
            .join("channels")
            .join("channel-1")
            .join("openclaw-state");

        let env = openclaw_bridge_state_env(&base);

        assert_eq!(env.state_dir, base);
        assert_eq!(env.config_path, env.state_dir.join("openclaw.json"));
        assert_eq!(env.oauth_dir, env.state_dir.join("credentials"));
        assert!(!path_env_value(&env.state_dir).contains(".openclaw"));
    }

    #[test]
    fn functional_degradation_never_advances_the_process_watchdog() {
        let mut watchdog = BridgeHealthWatchdog::default();

        assert_eq!(
            watchdog.observe_functional(false),
            BridgeFunctionalObservation::Degraded,
        );
        assert_eq!(
            watchdog.observe_functional(false),
            BridgeFunctionalObservation::Stable,
        );
        assert_eq!(watchdog.consecutive_liveness_failures, 0);
        assert_eq!(
            watchdog.observe_liveness(true),
            BridgeLivenessObservation::Healthy,
        );
        assert_eq!(
            watchdog.observe_functional(true),
            BridgeFunctionalObservation::Recovered,
        );
    }

    #[test]
    fn only_three_consecutive_liveness_failures_stop_the_bridge() {
        let mut watchdog = BridgeHealthWatchdog::default();

        assert_eq!(
            watchdog.observe_liveness(false),
            BridgeLivenessObservation::Failed {
                failures: 1,
                should_stop: false,
            },
        );
        assert_eq!(
            watchdog.observe_liveness(false),
            BridgeLivenessObservation::Failed {
                failures: 2,
                should_stop: false,
            },
        );
        assert_eq!(
            watchdog.observe_liveness(true),
            BridgeLivenessObservation::Recovered { prior_failures: 2 },
        );
        for expected in 1..=MAX_BRIDGE_LIVENESS_FAILURES {
            assert_eq!(
                watchdog.observe_liveness(false),
                BridgeLivenessObservation::Failed {
                    failures: expected,
                    should_stop: expected == MAX_BRIDGE_LIVENESS_FAILURES,
                },
            );
        }
    }
}

/// Spawn a plugin bridge Bun process
pub async fn spawn_plugin_bridge<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    plugin_dir: &str,
    bridge_state_dir: &Path,
    port: u16,
    rust_port: u16,
    bot_id: &str,
    plugin_config: Option<&serde_json::Value>,
    _creation_permit: &crate::sidecar::LifecycleSpawnPermit,
) -> Result<BridgeProcess, String> {
    use crate::sidecar::find_node_executable_pub;

    let node_path = find_node_executable_pub(app_handle)
        .ok_or_else(|| "Node executable not found".to_string())?;

    let bridge_script = find_bridge_script(app_handle)
        .ok_or_else(|| "Plugin bridge script not found".to_string())?;

    let config_json = plugin_config
        .map(|v| v.to_string())
        .unwrap_or_else(|| "{}".to_string());

    let state_env = openclaw_bridge_state_env(bridge_state_dir);
    tokio::fs::create_dir_all(&state_env.state_dir)
        .await
        .map_err(|e| {
            format!(
                "Failed to create OpenClaw bridge state dir {}: {}",
                state_env.state_dir.display(),
                e
            )
        })?;
    tokio::fs::create_dir_all(&state_env.oauth_dir)
        .await
        .map_err(|e| {
            format!(
                "Failed to create OpenClaw bridge credentials dir {}: {}",
                state_env.oauth_dir.display(),
                e
            )
        })?;
    ulog_info!(
        "[bridge] OpenClaw runtime state scoped to {}",
        state_env.state_dir.display()
    );

    // ── Shim integrity + freshness check ──
    // 1. If node_modules/openclaw/ is missing → re-install (covers
    //    pre-0.2.0 installs and any plugin tree where the shim got
    //    accidentally cleaned).
    // 2. If node_modules/openclaw/ is the real npm package (not our
    //    shim) → re-install.
    // 3. If shim version doesn't match SHIM_COMPAT_VERSION → re-install
    //    (shim content updated, e.g. compat version bump).
    //
    // tsx is no longer installed per-plugin (was: `install_tsx_into_
    // plugin_dir` would `npm install tsx` here, but its prune step
    // wiped the shim). tsx is now bundled once into
    // `resources/tsx-runtime/` and passed to Node via absolute-path
    // `--import` below — see `find_tsx_runtime_loader`.
    //
    // Concurrency guard (Codex C3 / Agent A M2): hold per-plugin_dir
    // mutex for the duration of the integrity-check + reinstall block.
    // Two bots sharing the same OpenClaw plugin_id (e.g. two Lark
    // accounts) can `spawn_plugin_bridge` in parallel during auto-start
    // or monitor-driven restart, and concurrent `install_sdk_shim`
    // (which `rmtree`s and re-`copy_dir_recursive`s) corrupts the
    // shim tree. Lock serialises ours; we don't hold it across the
    // actual node spawn — bridges run independently after the prep
    // phase.
    let plugin_dir_buf = std::path::PathBuf::from(plugin_dir);
    {
        let lock_arc = plugin_install_lock(&plugin_dir_buf);
        let _lock_guard = lock_arc.lock().await;

        let openclaw_pkg = plugin_dir_buf
            .join("node_modules")
            .join("openclaw")
            .join("package.json");
        let needs_repair = if openclaw_pkg.exists() {
            std::fs::read_to_string(&openclaw_pkg)
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .map(|v| {
                    let version = v.get("version").and_then(|v| v.as_str()).unwrap_or("");
                    // Must be our shim AND match current compat version
                    !version.contains("-shim") || !version.starts_with(SHIM_COMPAT_VERSION)
                })
                .unwrap_or(true)
        } else {
            true // Missing entirely
        };
        if needs_repair {
            ulog_warn!(
                "[bridge] Shim integrity/freshness check failed for {}, re-installing",
                plugin_dir
            );
            if let Err(e) = install_sdk_shim(app_handle, &plugin_dir_buf).await {
                ulog_error!("[bridge] SDK shim re-install FAILED for {}: {} — bridge will fail to load openclaw plugins", plugin_dir, e);
            }
        }
        // _lock_guard drops here, releasing the mutex before Node spawn.
    }

    ulog_info!(
        "[bridge] Spawning bridge: node={:?} script={:?} plugin_dir={} port={} rust_port={}",
        node_path,
        bridge_script,
        plugin_dir,
        port,
        rust_port
    );

    let mut cmd = crate::process_cmd::new(&node_path);
    // Inject tsx via absolute file URL pointing at the bundled
    // `resources/tsx-runtime/` (prod) or the project's own `node_modules/tsx`
    // (dev). The loader has zero side effects on `.js` plugin loads (esbuild's
    // transform path matches on `.ts`/`.tsx`/`.jsx` only), so we can inject
    // it unconditionally — JS-only plugins pay essentially zero cost. Plugins
    // shipping `.ts` source get type-stripping for free.
    //
    // Why absolute file URL instead of bare specifier `tsx/esm`:
    //   - Bare specifier resolution depends on cwd's `node_modules` walk-up.
    //     With `cwd = plugin_dir`, that path doesn't contain tsx anymore
    //     (we no longer install it per-plugin), so a bare specifier would
    //     fail with `Cannot find package 'tsx'`.
    //   - Absolute file URL is location-independent. cwd can be anywhere.
    let plugin_dir_path = std::path::PathBuf::from(plugin_dir);
    if let Some(tsx_loader) = find_tsx_runtime_loader(app_handle) {
        cmd.arg("--import").arg(path_to_file_url(&tsx_loader));
    } else {
        ulog_warn!(
            "[bridge] tsx loader not found — `.ts`-shipped plugins will fail. \
             Run `node scripts/setup-tsx-runtime.mjs <os> <cpu>` and rebuild."
        );
    }
    cmd.arg(bridge_script.to_string_lossy().as_ref())
        // Same marker as regular sidecars — ensures cleanup_stale_sidecars()
        // can find and kill orphaned bridge processes after a crash
        .arg("--myagents-sidecar")
        .arg("--plugin-dir")
        .arg(plugin_dir)
        .arg("--port")
        .arg(port.to_string())
        .arg("--rust-port")
        .arg(rust_port.to_string())
        .arg("--bot-id")
        .arg(bot_id)
        // Pass config via env var to avoid leaking secrets in `ps` process listing
        .env("BRIDGE_PLUGIN_CONFIG", &config_json)
        // Keep plugin runtime state per MyAgents channel. QR-login plugins such
        // as Weixin include local tokens from this state when asking the
        // platform for a QR code; falling back to ~/.openclaw makes separate
        // workspaces look like the same OpenClaw instance.
        //
        // Var names verified against upstream OpenClaw consumers (do not pattern-match):
        //   OPENCLAW_STATE_DIR  → src/utils.ts resolveConfigDir (highest-priority override; drives isolation)
        //   OPENCLAW_CONFIG_PATH → src/utils.ts (explicit config-file pointer; expects a *.json file path)
        //   OPENCLAW_OAUTH_DIR  → src/config/paths.ts
        // (Dropped CLAWDBOT_STATE_DIR — removed upstream in 6b9915a106, now 0 consumers; and the bare
        //  OPENCLAW_CONFIG, which was never read — the consumed name is OPENCLAW_CONFIG_PATH.)
        .env("OPENCLAW_STATE_DIR", path_env_value(&state_env.state_dir))
        .env(
            "OPENCLAW_CONFIG_PATH",
            path_env_value(&state_env.config_path),
        )
        .env("OPENCLAW_OAUTH_DIR", path_env_value(&state_env.oauth_dir));

    // Working directory: prefer the plugin_dir (so Node's ESM resolver
    // walks up from there to find both `node_modules/tsx` AND the plugin's
    // own deps). Pre-fix we used bridge_script's parent — that worked for
    // dev (parent = src/server/plugin-bridge → walk-up to repo node_modules)
    // but in prod the parent is the Tauri install's resources/ dir, which
    // has no node_modules. The bridge_script itself is loaded by absolute
    // path (see `cmd.arg(bridge_script.to_string_lossy().as_ref())` above)
    // so its location doesn't depend on cwd. Fall back to bridge_script
    // parent if plugin_dir doesn't exist (defensive — shouldn't happen).
    if plugin_dir_path.exists() {
        cmd.current_dir(&plugin_dir_path);
        ulog_info!(
            "[bridge] Working directory set to plugin_dir: {:?}",
            plugin_dir_path
        );
    } else if let Some(script_dir) = bridge_script.parent() {
        cmd.current_dir(script_dir);
        ulog_info!(
            "[bridge] Working directory fallback (plugin_dir missing): {:?}",
            script_dir
        );
    }

    // Inject proxy env vars — reuse shared helper (pit-of-success: single source of truth)
    apply_proxy_env(&mut cmd);

    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = crate::process_cmd::spawn_tree(&mut cmd)
        .map_err(|e| format!("Failed to spawn bridge process: {}", e))?;

    // Pipe stdout/stderr to unified log
    {
        use std::io::{BufRead, BufReader};
        if let Some(stdout) = child.stdout.take() {
            let bot_id_clone = bot_id.to_string();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines().flatten() {
                    // Skip high-frequency heartbeat noise (sent/ACK every ~40s per plugin).
                    // Only log heartbeat anomalies (timeout, disconnect, error).
                    if line.contains("Heartbeat sent")
                        || line.contains("Heartbeat ACK")
                        || line.contains("Received op=11")
                    {
                        continue;
                    }
                    ulog_info!("[bridge-out][{}] {}", bot_id_clone, line);
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            let bot_id_clone = bot_id.to_string();
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().flatten() {
                    // Same classification as sidecar stderr — plugin-bridge
                    // shares the sdk-shim warnings, log-retention audit, etc.
                    // See `crate::sidecar::classify_sidecar_stderr`.
                    match crate::sidecar::classify_sidecar_stderr(&line) {
                        crate::sidecar::SidecarStderrLevel::Info => {
                            ulog_info!("[bridge-err][{}] {}", bot_id_clone, line)
                        }
                        crate::sidecar::SidecarStderrLevel::Warn => {
                            ulog_warn!("[bridge-err][{}] {}", bot_id_clone, line)
                        }
                        crate::sidecar::SidecarStderrLevel::Error => {
                            ulog_error!("[bridge-err][{}] {}", bot_id_clone, line)
                        }
                    }
                }
            });
        }
    }

    // Wait for health check
    let client = crate::local_http::json_client(Duration::from_secs(5));
    let health_url = format!("http://127.0.0.1:{}/health", port);
    let mut healthy = false;

    for attempt in 0..30 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        match client.get(&health_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                ulog_info!(
                    "[bridge] Health check passed after {} attempts",
                    attempt + 1
                );
                healthy = true;
                break;
            }
            _ => {
                if attempt % 5 == 4 {
                    ulog_debug!(
                        "[bridge] Health check attempt {} failed, retrying...",
                        attempt + 1
                    );
                }
            }
        }
    }

    if !healthy {
        // Kill the orphaned child process before returning error
        let _ = child.kill();
        let _ = child.wait();
        return Err("Bridge process did not become healthy within 15s".to_string());
    }

    Ok(BridgeProcess { child, port })
}

/// Apply MyAgents proxy policy to a child `Command`.
/// Delegates to the centralized `proxy_config::apply_to_subprocess()` (pit-of-success).
fn apply_proxy_env(cmd: &mut std::process::Command) {
    crate::proxy_config::apply_to_subprocess(cmd);
}

/// Locate bundled Node.js binary and npm-cli.js for plugin installation.
/// Dual-runtime principle: social ecosystem packages use Node.js (not Bun) to avoid
/// Bun's npm compatibility issues on Windows.
///
/// Layout:
/// - macOS prod:  Contents/Resources/nodejs/bin/node + ../lib/node_modules/npm/bin/npm-cli.js
/// - macOS dev:   src-tauri/resources/nodejs/bin/node + ../lib/node_modules/npm/bin/npm-cli.js
/// - Windows prod: <install_dir>/nodejs/node.exe + node_modules/npm/bin/npm-cli.js
/// - Windows dev:  src-tauri/resources/nodejs/node.exe + node_modules/npm/bin/npm-cli.js
fn find_bundled_node_npm<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
) -> Option<(PathBuf, PathBuf)> {
    use crate::sidecar::normalize_external_path;

    let check = |nodejs_dir: &Path| -> Option<(PathBuf, PathBuf)> {
        #[cfg(target_os = "windows")]
        let node_bin = nodejs_dir.join("node.exe");
        #[cfg(not(target_os = "windows"))]
        let node_bin = nodejs_dir.join("bin").join("node");

        // Windows npm layout: nodejs/node_modules/npm/... (flat, no lib/)
        // macOS/Linux npm layout: nodejs/lib/node_modules/npm/... (standard Unix)
        #[cfg(target_os = "windows")]
        let npm_cli = nodejs_dir
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js");
        #[cfg(not(target_os = "windows"))]
        let npm_cli = nodejs_dir
            .join("lib")
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js");

        if node_bin.exists() && npm_cli.exists() {
            // On Windows, strip \\?\ extended-length prefix that Tauri's resource_dir() produces.
            // Node.js/npm cannot handle it (causes "EISDIR: lstat 'C:'" error).
            let node_bin = normalize_external_path(node_bin);
            let npm_cli = normalize_external_path(npm_cli);
            ulog_info!(
                "[bridge] Bundled Node.js found: node={:?}, npm-cli={:?}",
                node_bin,
                npm_cli
            );
            Some((node_bin, npm_cli))
        } else {
            None
        }
    };

    // Production: nodejs/ inside resource_dir
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        let resource_dir: PathBuf = resource_dir;
        let prod_dir = resource_dir.join("nodejs");
        if let Some(result) = check(&prod_dir) {
            return Some(result);
        }
        // Windows: resource_dir parent might be the install dir
        #[cfg(target_os = "windows")]
        if let Some(parent) = resource_dir.parent() {
            let parent_dir = parent.join("nodejs");
            if let Some(result) = check(&parent_dir) {
                return Some(result);
            }
        }
    }

    // Development: walk up to find src-tauri/resources/nodejs/
    if cfg!(debug_assertions) {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let dev_dir = manifest_dir.join("resources").join("nodejs");
        if let Some(result) = check(&dev_dir) {
            return Some(result);
        }
    }

    ulog_warn!("[bridge] Bundled Node.js not found, falling back to Bun for plugin install");
    None
}

/// Write a minimal package.json if it doesn't exist.
/// Uses serde_json to avoid JSON injection from untrusted plugin_id.
async fn ensure_package_json(base_dir: &std::path::Path, plugin_id: &str) -> Result<(), String> {
    let pkg_json = base_dir.join("package.json");
    if !pkg_json.exists() {
        let content = json!({
            "name": plugin_id,
            "version": "1.0.0",
            "private": true,
        });
        tokio::fs::write(&pkg_json, content.to_string())
            .await
            .map_err(|e| format!("Failed to write package.json: {}", e))?;
    }
    Ok(())
}

/// Sanitize user input that may contain a full command like
/// `npx -y @scope/pkg@latest install` into just `@scope/pkg@latest`.
///
/// Users often paste official install commands verbatim. This function strips
/// known package-manager prefixes (npx, npm, bun, pnpm, yarn), flags (-y, --save, etc.),
/// and trailing action tokens (install, add) to extract the bare npm spec.
fn sanitize_npm_spec(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return trimmed.to_string();
    }

    let tokens: Vec<&str> = trimmed.split_whitespace().collect();

    // Known package-manager commands, actions, and flag tokens — never a package name
    let is_noise = |t: &str| -> bool {
        let lower = t.to_ascii_lowercase();
        matches!(
            lower.as_str(),
            "npx"
                | "npm"
                | "bun"
                | "bunx"
                | "pnpm"
                | "yarn"
                | "install"
                | "add"
                | "i"
                | "exec"
                | "run"
                | "x"
                | "dlx"
        )
    };

    // First token that is not a flag (starts with '-') and not a noise word = package spec
    for token in &tokens {
        if token.starts_with('-') {
            continue;
        }
        if is_noise(token) {
            continue;
        }
        return token.to_string();
    }

    // All tokens were noise/flags — return empty to fail fast at validation
    String::new()
}

/// Install an OpenClaw plugin from npm.
/// Priority: system npm → bundled npm → bun add.
/// System npm is preferred (user-maintained, most reliable); bundled npm is fallback
/// for users without Node.js; bun add is last resort.
pub async fn install_openclaw_plugin<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    npm_spec: &str,
) -> Result<serde_json::Value, String> {
    // Sanitize: users may paste full commands like `npx -y @scope/pkg@latest install`
    let trimmed = sanitize_npm_spec(npm_spec);
    let trimmed = trimmed.as_str();
    // Reject non-registry specs: paths, protocols, GitHub shorthand (owner/repo)
    // Scoped packages (@scope/name) are allowed — they start with '@'
    let has_unscoped_slash = trimmed.contains('/') && !trimmed.starts_with('@');
    if trimmed.is_empty()
        || trimmed.contains("..")
        || trimmed.starts_with('/')
        || trimmed.starts_with('.')
        || trimmed.contains("file:")
        || trimmed.contains("git:")
        || trimmed.contains("git+")
        || trimmed.contains("github:")
        || trimmed.contains("http:")
        || trimmed.contains("https:")
        || has_unscoped_slash
    {
        return Err(format!(
            "Invalid npm spec '{}': only npm package names are allowed",
            npm_spec
        ));
    }

    // Derive plugin ID from npm spec (e.g. "@openclaw/channel-qqbot" → "channel-qqbot")
    let plugin_id = trimmed
        .split('/')
        .last()
        .unwrap_or(trimmed)
        .split('@')
        .next()
        .unwrap_or(trimmed)
        .to_string();

    // Validate derived plugin_id (no path separators, no empty)
    if plugin_id.is_empty()
        || plugin_id.contains('/')
        || plugin_id.contains('\\')
        || plugin_id.contains("..")
    {
        return Err(format!(
            "Invalid plugin ID derived from '{}': '{}'",
            npm_spec, plugin_id
        ));
    }

    let base_dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".myagents")
        .join("openclaw-plugins")
        .join(&plugin_id);

    // Create directory
    tokio::fs::create_dir_all(&base_dir)
        .await
        .map_err(|e| format!("Failed to create plugin dir: {}", e))?;

    // Concurrency guard: serialise installs against a per-plugin_dir mutex
    // shared with `spawn_plugin_bridge`'s shim integrity check. Without
    // this lock, a wizard-driven re-install racing with an auto-start
    // bot's spawn-time shim repair could interleave `rmtree` + `npm
    // install` + `copy_dir_recursive` and corrupt `node_modules/`.
    // Lock is held for the rest of the install body; dropped on return.
    let _install_guard_arc = plugin_install_lock(&base_dir);
    let _install_guard = _install_guard_arc.lock().await;

    if trimmed != npm_spec.trim() {
        ulog_info!(
            "[bridge] Sanitized npm spec: '{}' → '{}'",
            npm_spec.trim(),
            trimmed
        );
    }

    // Ensure spec always resolves to latest when no version is pinned.
    // Without @latest, npm may honor an existing package-lock.json and skip the upgrade.
    // Scoped packages: @scope/name → @scope/name@latest
    // Versioned:       @scope/name@1.2.3 → keep as-is
    let install_spec = if trimmed.contains('@') {
        // Check if the last '@' is a version separator (not the scope prefix)
        let last_at = trimmed.rfind('@').unwrap_or(0);
        if last_at == 0 || (trimmed.starts_with('@') && trimmed[1..].find('@').is_none()) {
            // No version suffix — append @latest
            format!("{}@latest", trimmed)
        } else {
            trimmed.to_string() // Already has version
        }
    } else {
        format!("{}@latest", trimmed) // Unscoped, no version
    };

    ulog_info!(
        "[bridge] Installing plugin {} (spec: {}) into {:?}",
        trimmed,
        install_spec,
        base_dir
    );

    // Write package.json upfront (shared by both npm and bun paths).
    ensure_package_json(&base_dir, &plugin_id).await?;

    // --- Try system npm first (user-maintained, most reliable) ---
    let mut npm_succeeded = false;

    if let Some(system_npm) = crate::system_binary::find("npm") {
        ulog_info!("[bridge] Using system npm: {:?}", system_npm);
        let sys_npm = system_npm;
        let base_for_sys = base_dir.clone();
        let spec_for_sys = install_spec.clone();
        let sys_result = tokio::task::spawn_blocking(move || {
            let mut cmd = crate::process_cmd::new(&sys_npm);
            // --omit=peer: openclaw 插件声明 peerDependencies: { openclaw: '*' }，
            // npm 会自动安装原始 openclaw 包的 400+ 传递依赖（larksuite、playwright-core、aws-sdk 等）。
            // --omit=peer 阻止这一行为，节省安装时间/体积/安全攻击面。
            //
            // --no-experimental-require-module fixes Node.js v24 CJS/ESM crash on Windows.
            cmd.args(["install", spec_for_sys.as_str(), "--omit=peer"])
                .current_dir(&base_for_sys)
                .env("NODE_OPTIONS", "--no-experimental-require-module");
            apply_proxy_env(&mut cmd);
            cmd.output()
        })
        .await;

        match sys_result {
            Ok(Ok(output)) if output.status.success() => {
                ulog_info!("[bridge] System npm install {} succeeded", npm_spec);
                npm_succeeded = true;
            }
            Ok(Ok(output)) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                ulog_error!(
                    "[bridge] System npm install {} failed: {}",
                    npm_spec,
                    stderr.trim()
                );
            }
            Ok(Err(e)) => {
                ulog_error!("[bridge] System npm spawn failed: {}", e);
            }
            Err(e) => {
                ulog_error!("[bridge] System npm spawn_blocking failed: {}", e);
            }
        }
    } else {
        ulog_info!("[bridge] System npm not found in PATH, skipping");
    }

    // --- Bundled npm fallback: if system npm failed or unavailable ---
    if !npm_succeeded {
        if let Some((node_bin, npm_cli)) = find_bundled_node_npm(app_handle) {
            // Diagnostic: log node + npm version for troubleshooting
            let node_ver = crate::process_cmd::new(&node_bin)
                .args(["--version"])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_else(|e| format!("error: {}", e));
            let npm_ver = crate::process_cmd::new(&node_bin)
                .args([npm_cli.to_str().unwrap_or(""), "--version"])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_else(|e| format!("error: {}", e));
            ulog_info!(
                "[bridge] Bundled npm install: node={}, npm={}, cli={:?}",
                node_ver,
                npm_ver,
                npm_cli
            );

            let npm_cli_str = npm_cli
                .to_str()
                .ok_or_else(|| format!("npm-cli.js path contains invalid UTF-8: {:?}", npm_cli))?
                .to_string();

            // Prepend node binary's directory to PATH so postinstall scripts can find `node`.
            let node_dir_for_path = node_bin
                .parent()
                .map(|d| d.to_string_lossy().to_string())
                .unwrap_or_default();
            let augmented_path = {
                let system_path = std::env::var("PATH").unwrap_or_default();
                #[cfg(target_os = "windows")]
                {
                    format!("{};{}", node_dir_for_path, system_path)
                }
                #[cfg(not(target_os = "windows"))]
                {
                    format!("{}:{}", node_dir_for_path, system_path)
                }
            };

            let node_for_add = node_bin;
            let cli_str_add = npm_cli_str;
            let base_for_add = base_dir.clone();
            let npm_spec_owned = install_spec.clone();
            let path_for_add = augmented_path;
            let add_result = tokio::task::spawn_blocking(move || {
                let mut cmd = crate::process_cmd::new(&node_for_add);
                // --omit=peer: same rationale as system npm above.
                // --no-experimental-require-module: Node.js v24 CJS/ESM crash fix.
                cmd.args([
                    cli_str_add.as_str(),
                    "install",
                    npm_spec_owned.as_str(),
                    "--omit=peer",
                ])
                .current_dir(&base_for_add)
                .env("PATH", &path_for_add)
                .env("NODE_OPTIONS", "--no-experimental-require-module");
                apply_proxy_env(&mut cmd);
                cmd.output()
            })
            .await;

            match add_result {
                Ok(Ok(output)) if output.status.success() => {
                    ulog_info!("[bridge] Bundled npm install {} succeeded", npm_spec);
                    npm_succeeded = true;
                }
                Ok(Ok(output)) => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    ulog_error!(
                        "[bridge] Bundled npm install {} failed (exit {}): {}",
                        npm_spec,
                        output.status,
                        stderr.trim()
                    );
                }
                Ok(Err(e)) => {
                    ulog_error!(
                        "[bridge] Bundled npm install {} — process spawn failed: {}",
                        npm_spec,
                        e
                    );
                }
                Err(e) => {
                    ulog_error!(
                        "[bridge] Bundled npm install {} — spawn_blocking failed: {}",
                        npm_spec,
                        e
                    );
                }
            }
        } else {
            ulog_warn!("[bridge] Bundled Node.js/npm not found, skipping bundled npm install");
        }
    }

    // Both system npm and bundled npm failed — there is no further fallback.
    // (The pre-0.2.0 "Bun fallback" branch ran `node add` / `node install`,
    // which are not valid Node subcommands; with Bun removed it could never
    // succeed.)
    if !npm_succeeded {
        return Err(format!(
            "Plugin install failed for {}: bundled npm unavailable and system npm not found in PATH. \
             Install Node.js, or reinstall MyAgents to restore the bundled runtime.",
            npm_spec
        ));
    }

    // Dependency repair + shim install (order matters: repair FIRST, shim LAST).
    //
    // The shim replaces node_modules/openclaw/ with our custom exports. But npm/bun
    // may overwrite it during dependency resolution (lockfile reconciliation, peer dep
    // auto-install). To guarantee the shim survives:
    //   1. Run `npm install --ignore-scripts` to fix transitive deps (e.g., zod)
    //   2. THEN install shim as the FINAL step (last-write-wins)
    {
        let repair_dir = base_dir.clone();
        if let Some((node_path, npm_cli)) = find_bundled_node_npm(app_handle) {
            let node_dir = node_path.parent().map(|p| p.to_path_buf());
            match tokio::task::spawn_blocking(move || {
                let mut cmd = crate::process_cmd::new(&node_path);
                cmd.args([
                    npm_cli.to_str().unwrap_or(""),
                    "install",
                    "--ignore-scripts",
                    "--omit=peer",
                ])
                .current_dir(&repair_dir)
                .env("NODE_OPTIONS", "--no-experimental-require-module");
                if let Some(ref nd) = node_dir {
                    if let Some(path) = std::env::var_os("PATH") {
                        let mut paths = std::env::split_paths(&path).collect::<Vec<_>>();
                        paths.insert(0, nd.clone());
                        cmd.env("PATH", std::env::join_paths(&paths).unwrap_or(path));
                    }
                }
                apply_proxy_env(&mut cmd);
                cmd.output()
            })
            .await
            {
                Ok(Ok(output)) if output.status.success() => {
                    ulog_info!("[bridge] Dependency repair succeeded");
                }
                Ok(Ok(output)) => {
                    ulog_warn!(
                        "[bridge] Dependency repair failed (exit {}): {}",
                        output.status,
                        String::from_utf8_lossy(&output.stderr).trim()
                    );
                }
                _ => {
                    ulog_warn!("[bridge] Dependency repair: spawn failed");
                }
            }
        } else {
            // No bundled npm — initial plugin install above must have used system
            // npm; rely on that path's transitive dep resolution. No fallback runner.
            ulog_warn!("[bridge] Skipping dependency repair: bundled npm unavailable");
        }
    }

    // Install plugin-sdk shim as the FINAL step (after dependency repair).
    // This MUST be last — npm/bun install above may overwrite
    // `node_modules/openclaw/` with the real package from the registry.
    // tsx is no longer installed per-plugin (it's bundled in
    // `resources/tsx-runtime/` and reached via absolute-path `--import`),
    // so npm's prune step no longer touches our shim. Our shim simply
    // wins as the last writer to `node_modules/openclaw/`.
    install_sdk_shim(app_handle, &base_dir).await?;

    // Try to read plugin manifest
    let manifest = read_plugin_manifest(&base_dir, trimmed).await;

    // Extract required config fields from plugin source (isConfigured pattern)
    // read_plugin_manifest already resolved the package name; reuse the same logic
    // to locate the package directory inside node_modules.
    let npm_pkg_name = resolve_npm_pkg_name(trimmed);
    let npm_pkg_dir = base_dir.join("node_modules").join(&npm_pkg_name);
    let required_fields = extract_required_fields(&npm_pkg_dir).await;

    // Read installed package version from node_modules/{npmSpec}/package.json
    let dep_pkg_path = npm_pkg_dir.join("package.json");
    let package_version = if let Ok(content) = tokio::fs::read_to_string(&dep_pkg_path).await {
        serde_json::from_str::<serde_json::Value>(&content)
            .ok()
            .and_then(|v| v.get("version").cloned())
    } else {
        None
    };

    // Detect QR login support by scanning plugin source for loginWithQrStart
    let supports_qr_login = detect_qr_login_support(&npm_pkg_dir).await;

    // Post-install compatibility check: verify plugin's peerDependencies.openclaw
    // against our shim's declared compat version (2026.3.25-shim).
    // Plugins with peerDeps exceeding our shim version may crash at runtime.
    let compat_warning = check_plugin_compat(&dep_pkg_path).await;
    if let Some(ref warning) = compat_warning {
        ulog_warn!("[bridge] {}", warning);
    }

    ulog_info!(
        "[bridge] Plugin {} installed successfully (qrLogin={}, compat={})",
        plugin_id,
        supports_qr_login,
        if compat_warning.is_some() {
            "warn"
        } else {
            "ok"
        }
    );

    Ok(json!({
        "pluginId": plugin_id,
        "installDir": base_dir.to_string_lossy(),
        "npmSpec": trimmed,
        "manifest": manifest,
        "packageVersion": package_version,
        "requiredFields": required_fields,
        "supportsQrLogin": supports_qr_login,
        "compatWarning": compat_warning,
    }))
}

/// Our shim's OpenClaw compat version. Must match sdk-shim/package.json and compat-runtime.ts.
const SHIM_COMPAT_VERSION: &str = "2026.9.6";

/// Check if installed plugin's peerDependencies.openclaw is compatible with our shim.
/// Returns a warning message if incompatible, None if OK.
async fn check_plugin_compat(pkg_json_path: &std::path::Path) -> Option<String> {
    let content = tokio::fs::read_to_string(pkg_json_path).await.ok()?;
    let pkg: serde_json::Value = serde_json::from_str(&content).ok()?;
    let peer_deps = pkg.get("peerDependencies")?.as_object()?;
    let required = peer_deps.get("openclaw")?.as_str()?;

    // Parse requirement like ">=2026.3.25" or "*"
    if required == "*" || required.is_empty() {
        return None; // Any version — compatible
    }

    // Extract version number from semver-like constraint (e.g., ">=2026.3.25" → "2026.3.25")
    let required_ver = required
        .trim_start_matches(|c: char| !c.is_ascii_digit())
        .split('-')
        .next()
        .unwrap_or("");

    if required_ver.is_empty() {
        return None; // Can't parse — assume compatible
    }

    // Simple date-version comparison (YYYY.M.DD format)
    let shim_base = SHIM_COMPAT_VERSION
        .split('-')
        .next()
        .unwrap_or(SHIM_COMPAT_VERSION);
    let parse_ver = |s: &str| -> (u32, u32, u32) {
        let parts: Vec<u32> = s.split('.').filter_map(|p| p.parse().ok()).collect();
        (
            parts.first().copied().unwrap_or(0),
            parts.get(1).copied().unwrap_or(0),
            parts.get(2).copied().unwrap_or(0),
        )
    };

    let shim = parse_ver(shim_base);
    let req = parse_ver(required_ver);

    if req > shim {
        Some(format!(
            "Plugin requires openclaw >={} but MyAgents shim supports {}. Some features may not work.",
            required_ver, SHIM_COMPAT_VERSION,
        ))
    } else {
        None
    }
}

/// Locate the absolute filesystem path to tsx's ESM loader entrypoint.
///
/// Bundled at build time (`scripts/setup-tsx-runtime.mjs <os> <cpu>`)
/// into `src-tauri/resources/tsx-runtime/node_modules/tsx/dist/esm/index.mjs`,
/// with a per-platform `@esbuild/<triple>/bin/esbuild[.exe]` next to it
/// so esbuild's transpile API works without requiring host=target.
///
/// Plugin Bridge passes this path to Node via `--import file://<...>`,
/// letting OpenClaw plugins shipping `.ts` source (lark / qqbot / weixin
/// — `openclaw.extensions` points at `index.ts`) load without per-plugin
/// `npm install tsx`. Pre-fix: `install_tsx_into_plugin_dir` ran npm
/// install in each plugin's directory, which (despite `--no-save`)
/// reconciled `node_modules/` against the plugin's `package.json` and
/// pruned away our manually-copied `node_modules/openclaw/` SDK shim.
/// Plugin then failed to load with `Cannot find package 'openclaw'`.
/// Bundling tsx once kills that whole class of failure.
fn find_tsx_runtime_loader<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) -> Option<PathBuf> {
    use crate::sidecar::normalize_external_path;

    // Result is fed to Node via `--import file:///<path>` — must be free of
    // Windows' `\\?\` extended-length prefix, otherwise `fileURLToPath`
    // rejects with `ERR_INVALID_FILE_URL_PATH: must be absolute` and Plugin
    // Bridge dies before serving its first health check (verified on a real
    // 0.2.0 Windows build). Both prod and dev branches funnel through the
    // same normalize call so neither path can regress.

    // Production: bundled in resources/tsx-runtime/
    #[cfg(not(debug_assertions))]
    {
        if let Ok(resource_dir) = app_handle.path().resource_dir() {
            let p = resource_dir
                .join("tsx-runtime")
                .join("node_modules")
                .join("tsx")
                .join("dist")
                .join("esm")
                .join("index.mjs");
            if p.exists() {
                return Some(normalize_external_path(p));
            }
        }
    }

    // Development: load from the project's own node_modules (tsx is a
    // dev dependency in package.json, present after `npm install`).
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let project_root = std::path::Path::new(manifest_dir)
        .parent()
        .unwrap_or(std::path::Path::new("."));
    let dev_path = project_root
        .join("node_modules")
        .join("tsx")
        .join("dist")
        .join("esm")
        .join("index.mjs");
    if dev_path.exists() {
        return Some(normalize_external_path(dev_path));
    }

    let _ = app_handle;
    None
}

/// Convert an absolute `Path` to a `file://` URL string suitable for Node's
/// `--import` flag. On Windows we must replace `\` with `/` and prepend the
/// extra `/` so the URL parses correctly (`file:///C:/...`).
///
/// Precondition: `path` must already have any platform-specific prefixes
/// (notably Windows' `\\?\`) stripped. Use `sidecar::normalize_external_path`
/// at the path's source. We don't strip here so this stays a pure URL
/// formatter — keeping the platform-quirk logic in one helper instead of
/// reimplementing it at every URL call site.
fn path_to_file_url(path: &std::path::Path) -> String {
    let s = path.display().to_string();
    #[cfg(windows)]
    {
        // Windows paths look like `C:\Users\...`; URL form is `file:///C:/Users/...`.
        format!("file:///{}", s.replace('\\', "/"))
    }
    #[cfg(not(windows))]
    {
        // Unix paths already start with `/`.
        format!("file://{}", s)
    }
}

/// Find the SDK shim source directory (dev: source tree, prod: bundled resource)
fn find_sdk_shim_dir<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) -> Option<PathBuf> {
    // Production: bundled in resources
    #[cfg(not(debug_assertions))]
    {
        if let Ok(resource_dir) = app_handle.path().resource_dir() {
            let bundled: PathBuf = resource_dir.join("plugin-bridge-sdk-shim");
            if bundled.exists() {
                return Some(bundled);
            }
        }
    }

    // Development: source tree
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let project_root = std::path::Path::new(manifest_dir)
        .parent()
        .unwrap_or(std::path::Path::new("."));
    let dev_path = project_root.join("src/server/plugin-bridge/sdk-shim");
    if dev_path.exists() {
        return Some(dev_path);
    }

    let _ = app_handle;
    None
}

/// Recursively copy a directory
async fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    tokio::fs::create_dir_all(dst)
        .await
        .map_err(|e| format!("Failed to create dir {:?}: {}", dst, e))?;

    let mut entries = tokio::fs::read_dir(src)
        .await
        .map_err(|e| format!("Failed to read dir {:?}: {}", src, e))?;

    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("Failed to read entry in {:?}: {}", src, e))?
    {
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        let file_type = entry
            .file_type()
            .await
            .map_err(|e| format!("Failed to get file type for {:?}: {}", src_path, e))?;

        if file_type.is_dir() {
            Box::pin(copy_dir_recursive(&src_path, &dst_path)).await?;
        } else {
            tokio::fs::copy(&src_path, &dst_path)
                .await
                .map_err(|e| format!("Failed to copy {:?} → {:?}: {}", src_path, dst_path, e))?;
        }
    }

    Ok(())
}

/// Install the openclaw/plugin-sdk shim into the plugin's node_modules.
/// Copies from bundled resource files instead of hardcoded strings.
async fn install_sdk_shim<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    plugin_dir: &std::path::Path,
) -> Result<(), String> {
    let shim_src = find_sdk_shim_dir(app_handle)
        .ok_or_else(|| "SDK shim source directory not found".to_string())?;

    let shim_dst = plugin_dir.join("node_modules").join("openclaw");

    // Remove existing shim if present (ensure clean state)
    if shim_dst.exists() {
        let _ = tokio::fs::remove_dir_all(&shim_dst).await;
    }

    copy_dir_recursive(&shim_src, &shim_dst).await?;

    ulog_info!(
        "[bridge] SDK shim installed from {:?} → {:?}",
        shim_src,
        shim_dst
    );

    // Patch @larksuiteoapi/node-sdk to use a fetch-based axios adapter.
    // Originally added (pre-0.2.0) for Bun, where the default axios http
    // adapter silently closed socket connections and produced 30s hangs.
    // The patch (252ms vs 30278ms) is also strictly faster on Node — fetch
    // routes through undici's connection pool instead of axios's
    // per-request Node http connection — so we keep it. Function renamed
    // from `..._for_bun` to drop the misleading runtime-specific suffix.
    patch_lark_sdk_use_fetch_adapter(plugin_dir).await;

    Ok(())
}

/// Replace `@larksuiteoapi/node-sdk`'s default axios HTTP adapter with a
/// fetch-based one. Originally a Bun-incompatibility workaround
/// (`patch_lark_sdk_for_bun`); kept on Node because the fetch adapter is
/// also a 100× latency win on the cold-handshake path.
async fn patch_lark_sdk_use_fetch_adapter(plugin_dir: &std::path::Path) {
    let sdk_file = plugin_dir
        .join("node_modules")
        .join("@larksuiteoapi")
        .join("node-sdk")
        .join("lib")
        .join("index.js");

    if !sdk_file.exists() {
        return; // Not a Lark SDK plugin, skip
    }

    let code = match tokio::fs::read_to_string(&sdk_file).await {
        Ok(c) => c,
        Err(_) => return,
    };

    let target = r#"const defaultHttpInstance = axios__default["default"].create();"#;
    if !code.contains(target) {
        return; // Already patched or different SDK version
    }

    // Minimal fetch-based adapter that replaces axios's Node.js http adapter
    let adapter = concat!(
        "function bunFetchAdapter(c){return new Promise(async(r,j)=>{try{",
        "let u=c.baseURL?c.baseURL+c.url:c.url;",
        "let h={};if(c.headers)for(let[k,v]of Object.entries(c.headers))if(v!=null)h[k]=String(v);",
        "if(c.params){let q=new URLSearchParams();for(let[k,v]of Object.entries(c.params)){",
        "if(Array.isArray(v))v.forEach(i=>q.append(k,String(i)));",
        "else if(v!=null)q.append(k,String(v))}",
        "let s=q.toString();if(s)u+=(u.includes('?')?'&':'?')+s}",
        "let m=(c.method||'get').toUpperCase();",
        "let opts={method:m,headers:h};",
        "if(c.data&&m!=='GET'&&m!=='HEAD'&&m!=='OPTIONS'){",
        "opts.body=typeof c.data==='string'?c.data:JSON.stringify(c.data)}",
        "let resp=await fetch(u,opts);",
        "let d;try{d=await resp.json()}catch{d=await resp.text()}",
        "r({data:d,status:resp.status,statusText:resp.statusText,",
        "headers:Object.fromEntries(resp.headers.entries()),config:c,request:{}})",
        "}catch(e){j(e)}})}",
    );

    let replacement = format!(
        "{}; const defaultHttpInstance = axios__default[\"default\"].create({{adapter: bunFetchAdapter}});",
        adapter
    );

    let patched = code.replace(target, &replacement);
    if let Err(e) = tokio::fs::write(&sdk_file, patched).await {
        ulog_warn!("[bridge] Failed to patch Lark SDK for Bun: {}", e);
    } else {
        ulog_info!(
            "[bridge] Patched @larksuiteoapi/node-sdk with fetch adapter for Bun compatibility"
        );
    }
}

/// Resolve npm spec to the package directory name in node_modules.
/// e.g. "@sliverp/qqbot" → "@sliverp/qqbot", "foo@1.2.3" → "foo",
/// "@scope/name@1.0.0" → "@scope/name"
fn resolve_npm_pkg_name(npm_spec: &str) -> String {
    let first = npm_spec.split('@').next().unwrap_or(npm_spec);
    if first.is_empty() && npm_spec.starts_with('@') {
        // Scoped: "@scope/name" or "@scope/name@version"
        let parts: Vec<&str> = npm_spec.splitn(3, '@').collect();
        if parts.len() >= 3 {
            // "@scope/name@version" → splitn(3,'@') = ["", "scope/name", "version"]
            format!("@{}", parts[1])
        } else {
            // "@scope/name" (no version) → splitn(3,'@') = ["", "scope/name"]
            npm_spec.to_string()
        }
    } else {
        first.to_string()
    }
}

/// Try to read plugin manifest from node_modules
async fn read_plugin_manifest(plugin_dir: &std::path::Path, npm_spec: &str) -> serde_json::Value {
    let pkg_name = resolve_npm_pkg_name(npm_spec);

    // Try reading openclaw.plugin.json
    let manifest_path = plugin_dir
        .join("node_modules")
        .join(&pkg_name)
        .join("openclaw.plugin.json");

    if let Ok(content) = tokio::fs::read_to_string(&manifest_path).await {
        if let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&content) {
            return manifest;
        }
    }

    // Try reading package.json for openclaw metadata
    let pkg_path = plugin_dir
        .join("node_modules")
        .join(&pkg_name)
        .join("package.json");

    if let Ok(content) = tokio::fs::read_to_string(&pkg_path).await {
        if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) {
            return json!({
                "name": pkg["name"],
                "version": pkg["version"],
                "description": pkg["description"],
                "openclaw": pkg["openclaw"],
            });
        }
    }

    json!({ "name": pkg_name })
}

/// Uninstall an OpenClaw plugin by removing its directory.
/// Returns error if any running bot depends on the plugin.
pub async fn uninstall_openclaw_plugin(plugin_id: &str) -> Result<(), String> {
    // Validate plugin_id to prevent path traversal
    if plugin_id.is_empty()
        || plugin_id.contains('/')
        || plugin_id.contains('\\')
        || plugin_id.contains("..")
        || plugin_id.starts_with('.')
    {
        return Err(format!("Invalid plugin ID: '{}'", plugin_id));
    }

    let plugins_dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".myagents")
        .join("openclaw-plugins")
        .join(plugin_id);

    if !plugins_dir.exists() {
        return Err(format!("Plugin '{}' not found", plugin_id));
    }

    // Check if any running bot uses this plugin
    if is_plugin_in_use(plugin_id).await {
        return Err(format!(
            "Cannot uninstall '{}': a running bot depends on it. Stop the bot first.",
            plugin_id
        ));
    }

    tokio::fs::remove_dir_all(&plugins_dir)
        .await
        .map_err(|e| format!("Failed to remove plugin directory: {}", e))?;

    ulog_info!("[bridge] Plugin '{}' uninstalled successfully", plugin_id);
    Ok(())
}

/// List all installed OpenClaw plugins
pub async fn list_openclaw_plugins() -> Result<Vec<serde_json::Value>, String> {
    let plugins_dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".myagents")
        .join("openclaw-plugins");

    if !plugins_dir.exists() {
        return Ok(vec![]);
    }

    let mut plugins = Vec::new();
    let mut entries = tokio::fs::read_dir(&plugins_dir)
        .await
        .map_err(|e| format!("Failed to read plugins dir: {}", e))?;

    while let Some(entry) = entries.next_entry().await.map_err(|e| format!("{}", e))? {
        if !entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }

        let plugin_id = entry.file_name().to_string_lossy().to_string();
        let plugin_dir = entry.path();

        // Read project package.json to find the installed npm dependency
        let pkg_json_path = plugin_dir.join("package.json");
        let mut npm_spec = String::new();

        if let Ok(content) = tokio::fs::read_to_string(&pkg_json_path).await {
            if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(deps) = pkg["dependencies"].as_object() {
                    if let Some((name, _)) = deps.iter().next() {
                        npm_spec = name.clone();
                    }
                }
            }
        }

        if npm_spec.is_empty() {
            continue;
        }

        // Read the actual npm package's info
        let dep_pkg_path = plugin_dir
            .join("node_modules")
            .join(&npm_spec)
            .join("package.json");
        let pkg_info = if let Ok(content) = tokio::fs::read_to_string(&dep_pkg_path).await {
            serde_json::from_str::<serde_json::Value>(&content).unwrap_or_default()
        } else {
            serde_json::Value::Null
        };

        // Read openclaw.plugin.json manifest
        let manifest_path = plugin_dir
            .join("node_modules")
            .join(&npm_spec)
            .join("openclaw.plugin.json");
        let manifest = if let Ok(content) = tokio::fs::read_to_string(&manifest_path).await {
            serde_json::from_str::<serde_json::Value>(&content).unwrap_or_default()
        } else {
            serde_json::Value::Null
        };

        // Extract required config fields from channel source (isConfigured pattern)
        let pkg_dir = plugin_dir.join("node_modules").join(&npm_spec);
        let required_fields = extract_required_fields(&pkg_dir).await;
        let supports_qr_login = detect_qr_login_support(&pkg_dir).await;

        plugins.push(json!({
            "pluginId": plugin_id,
            "installDir": plugin_dir.to_string_lossy(),
            "npmSpec": npm_spec,
            "manifest": manifest,
            "packageVersion": pkg_info.get("version"),
            "homepage": pkg_info.get("homepage"),
            "requiredFields": required_fields,
            "supportsQrLogin": supports_qr_login,
        }));
    }

    Ok(plugins)
}

/// Extract required config field names from the channel plugin source.
/// Looks for `isConfigured: (account) => Boolean(account?.fieldA && account?.fieldB)`
/// and extracts ["fieldA", "fieldB"].
async fn extract_required_fields(pkg_dir: &std::path::Path) -> Vec<String> {
    let candidates = [
        pkg_dir.join("src").join("channel.ts"),
        pkg_dir.join("dist").join("channel.js"),
        pkg_dir.join("channel.ts"),
        pkg_dir.join("channel.js"),
    ];

    for path in &candidates {
        if let Ok(content) = tokio::fs::read_to_string(path).await {
            if let Some(pos) = content.find("isConfigured") {
                // Only look at the single expression line — stop at first newline or `,\n`
                let rest = &content[pos..std::cmp::min(pos + 300, content.len())];
                let line_end = rest.find('\n').unwrap_or(rest.len());
                let snippet = &rest[..line_end];

                // Extract unique field names from "account?.fieldName" patterns
                let mut seen = std::collections::HashSet::new();
                let mut fields = Vec::new();
                let needle = "account?.";
                let mut search_from = 0;
                while let Some(idx) = snippet[search_from..].find(needle) {
                    let start = search_from + idx + needle.len();
                    let end = snippet[start..]
                        .find(|c: char| !c.is_alphanumeric() && c != '_')
                        .map(|i| start + i)
                        .unwrap_or(snippet.len());
                    let field = &snippet[start..end];
                    if !field.is_empty() && seen.insert(field.to_string()) {
                        fields.push(field.to_string());
                    }
                    search_from = end;
                }
                if !fields.is_empty() {
                    return fields;
                }
            }
        }
    }

    vec![]
}

/// Detect whether a plugin supports QR code login by scanning its source
/// for `loginWithQrStart` in the channel definition.
async fn detect_qr_login_support(pkg_dir: &std::path::Path) -> bool {
    let candidates = [
        pkg_dir.join("src").join("channel.ts"),
        pkg_dir.join("dist").join("channel.js"),
        pkg_dir.join("channel.ts"),
        pkg_dir.join("channel.js"),
        pkg_dir.join("src").join("index.ts"),
        pkg_dir.join("dist").join("index.js"),
        pkg_dir.join("index.ts"),
        pkg_dir.join("index.js"),
    ];
    for path in &candidates {
        if let Ok(content) = tokio::fs::read_to_string(path).await {
            if content.contains("loginWithQrStart") {
                return true;
            }
        }
    }
    false
}
