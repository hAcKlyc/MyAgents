// Internal Management API for Bun Sidecar → Rust IPC
// Provides HTTP endpoints on localhost for cron task management
// Only accessible from 127.0.0.1 (Bun Sidecar processes)

use axum::{
    extract::{DefaultBodyLimit, Query},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tokio::net::TcpListener;

use crate::cron_task::{
    self, CronDelivery, CronSchedule, CronTask, CronTaskConfig, ProviderIntent, TaskProviderEnv,
};
use crate::{ulog_debug, ulog_info, ulog_warn, ulog_error};
use crate::im::{self, ManagedImBots, ManagedAgents};
use crate::im::adapter::{ImAdapter, ImStreamAdapter};
use crate::im::bridge;
use crate::im::types::MediaType;
use crate::task;
use crate::thought;

/// Global management API port (set once at startup)
static MANAGEMENT_PORT: OnceLock<u16> = OnceLock::new();

/// Global IM bots state (set once at startup for wake endpoint)
static IM_BOTS_STATE: OnceLock<ManagedImBots> = OnceLock::new();

/// Global Agent state (set once at startup)
static AGENT_STATE: OnceLock<ManagedAgents> = OnceLock::new();

/// Get the management API port (returns 0 if not started)
pub fn get_management_port() -> u16 {
    MANAGEMENT_PORT.get().copied().unwrap_or(0)
}

/// Set the IM bots state for the management API (called once at startup)
pub fn set_im_bots_state(bots: ManagedImBots) {
    let _ = IM_BOTS_STATE.set(bots);
}

/// Set the Agent state for the management API (called once at startup)
pub fn set_agent_state(agents: ManagedAgents) {
    let _ = AGENT_STATE.set(agents);
}

fn get_im_bots() -> Option<&'static ManagedImBots> {
    IM_BOTS_STATE.get()
}

fn get_agents() -> Option<&'static ManagedAgents> {
    AGENT_STATE.get()
}

/// Global Sidecar manager state (set once at startup)
static SIDECAR_STATE: OnceLock<crate::sidecar::ManagedSidecarManager> = OnceLock::new();

/// Set the SidecarManager state for the management API (called once at startup)
pub fn set_sidecar_state(state: crate::sidecar::ManagedSidecarManager) {
    let _ = SIDECAR_STATE.set(state);
}

#[allow(dead_code)]
fn get_sidecar_state() -> Option<&'static crate::sidecar::ManagedSidecarManager> {
    SIDECAR_STATE.get()
}

/// Start the internal management API server on a random port
/// Returns the port number for injection into Sidecar env vars

/// Write the Management API port to ~/.myagents/management.port so external
/// tools (session consoles, third-party frontends) can discover it.
fn write_management_port_file(port: u16) {
    if let Some(home) = dirs::home_dir() {
        let port_file = home.join(".myagents").join("management.port");
        if let Err(e) = std::fs::write(&port_file, port.to_string()) {
            ulog_warn!("[mgmt-api] Failed to write management.port: {}", e);
        } else {
            ulog_info!("[mgmt-api] Wrote management.port = {}", port);
        }
    }
}

pub async fn start_management_api() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind management API: {}", e))?;

    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get management API address: {}", e))?
        .port();

    MANAGEMENT_PORT
        .set(port)
        .map_err(|_| "Management API already started".to_string())?;

    write_management_port_file(port);

    let app = Router::new()
        .route("/api/cron/create", post(create_cron_handler))
        .route("/api/cron/list", get(list_cron_handler))
        .route("/api/cron/update", post(update_cron_handler))
        .route("/api/cron/delete", post(delete_cron_handler))
        .route("/api/cron/run", post(run_cron_handler))
        .route("/api/cron/trigger", post(trigger_cron_handler))
        .route("/api/cron/runs", get(runs_cron_handler))
        .route("/api/cron/status", get(status_cron_handler))
        .route("/api/im/channels", get(list_im_channels_handler))
        .route("/api/im/wake", post(wake_bot_handler))
        .route("/api/im/send-media", post(send_media_handler))
        .route("/api/im/mirror", post(mirror_to_channel_handler))
        .route("/api/im-bridge/message", post(handle_bridge_message))
        .route("/api/cron/stop", post(stop_cron_handler))
        .route("/api/plugin/list", get(list_plugins_handler))
        .route("/api/plugin/install", post(install_plugin_handler))
        .route("/api/plugin/uninstall", post(uninstall_plugin_handler))
        .route("/api/agent/runtime-status", get(agent_runtime_status_handler))
        // Task Center (v0.1.69) — HTTP surface for the `myagents task` CLI.
        .route("/api/task/list", get(task_list_handler))
        .route("/api/task/get", get(task_get_handler))
        .route("/api/task/create-direct", post(task_create_direct_handler))
        .route(
            "/api/task/create-from-alignment",
            post(task_create_from_alignment_handler),
        )
        .route("/api/task/update", post(task_update_handler))
        .route("/api/task/update-status", post(task_update_status_handler))
        .route("/api/task/append-session", post(task_append_session_handler))
        .route("/api/task/archive", post(task_archive_handler))
        .route("/api/task/delete", post(task_delete_handler))
        .route("/api/task/run", post(task_run_handler))
        .route("/api/task/rerun", post(task_rerun_handler))
        .route("/api/task/read-doc", get(task_read_doc_handler))
        .route("/api/task/write-doc", post(task_write_doc_handler))
        .route("/api/thought/list", get(thought_list_handler))
        .route("/api/thought/create", post(thought_create_handler))
        // Session Inbox cross-sidecar delivery (PRD 0.2.18)
        .route("/api/inbox/deliver", post(inbox_deliver_handler))
        // Bridge messages carry base64-encoded media attachments (images/files).
        // Default axum 2MB limit is too small — raise to 50MB for this API.
        .layer(DefaultBodyLimit::max(50 * 1024 * 1024));

    tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            ulog_error!("[management-api] Server error: {}", e);
        }
    });

    ulog_info!(
        "[management-api] Started on http://127.0.0.1:{}",
        port
    );
    Ok(port)
}

// ===== Request / Response types =====

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCronRequest {
    name: Option<String>,
    schedule: Option<CronSchedule>,
    message: String,
    session_target: Option<String>, // "new_session" | "single_session"
    source_bot_id: Option<String>,
    delivery: Option<CronDelivery>,
    workspace_path: String,
    model: Option<String>,
    permission_mode: Option<String>,
    provider_env: Option<TaskProviderEnv>,
    /// PRD 0.2.9 — Per-cron provider id. Preferred over `provider_env` for
    /// all new callers; sidecar live-resolves env on every tick. Mutually
    /// exclusive with `provider_env` (an explicit-snapshot legacy path that
    /// still works for tasks persisted in 0.2.8 and earlier).
    provider_id: Option<String>,
    /// PRD #119: explicit routing intent. Frontend / IM Bot / CLI callers
    /// that know what they want should set this to `Subscription` or
    /// `Explicit`. Absent → `FollowAgent` (legacy snapshot semantics).
    /// PRD 0.2.9 — when `provider_id` is set, intent is ignored.
    provider_intent: Option<ProviderIntent>,
    runtime: Option<String>,
    runtime_config: Option<serde_json::Value>,
    /// Fallback interval if no schedule provided
    interval_minutes: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct CreateCronResponse {
    task_id: String,
    status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListCronQuery {
    source_bot_id: Option<String>,
    workspace_path: Option<String>,
}

// ListCronResponse removed — list_cron_handler now returns serde_json::Value
// with explicit { "ok": true, "tasks": [...] } for Admin API forwarding compatibility.

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CronTaskSummary {
    id: String,
    name: Option<String>,
    prompt: String,
    status: String,
    schedule: Option<CronSchedule>,
    interval_minutes: u32,
    execution_count: u32,
    last_executed_at: Option<String>,
    created_at: String,
    /// Computed next-fire time (Rust enriches at read; never persisted).
    /// PRD 0.2.5 R6 — exposed for `cron list` Next column.
    #[serde(skip_serializing_if = "Option::is_none")]
    next_execution_at: Option<String>,
    /// Last run success flag — denormalized from `cron_runs/<id>.jsonl`.
    /// PRD 0.2.5 R6.
    #[serde(skip_serializing_if = "Option::is_none")]
    last_run_ok: Option<bool>,
    /// Last run duration in milliseconds — same denormalization as above.
    /// PRD 0.2.5 R6.
    #[serde(skip_serializing_if = "Option::is_none")]
    last_run_duration_ms: Option<u64>,
    /// PRD 0.2.5 R9 — transient flag: a tick (scheduled or run-now) is
    /// firing this very instant. Distinct from `status`: a task can be
    /// `status: Running` (scheduler enabled, not currently firing) or
    /// `status: Running, currently_executing: true` (scheduler enabled
    /// AND a tick is in flight). Populated by the list handler from
    /// `executing_tasks`; not persisted. Default false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    currently_executing: bool,
}

impl From<CronTask> for CronTaskSummary {
    fn from(t: CronTask) -> Self {
        // Status field carries the raw `TaskStatus` enum name
        // ("Running" / "Stopped") — matches enum, persistence, Tauri IPC,
        // and frontend. The persistent state and the transient
        // "currently executing" state are SEPARATE concepts; the latter
        // is surfaced via `currently_executing` populated by the list
        // handler (PRD 0.2.5 R9 — vocabulary clarification).
        Self {
            id: t.id,
            name: t.name,
            prompt: t.prompt,
            status: serde_json::to_value(&t.status)
                .ok()
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .unwrap_or_else(|| "unknown".to_string()),
            schedule: t.schedule,
            interval_minutes: t.interval_minutes,
            execution_count: t.execution_count,
            last_executed_at: t.last_executed_at.map(|dt| dt.to_rfc3339()),
            created_at: t.created_at.to_rfc3339(),
            next_execution_at: t.next_execution_at,
            last_run_ok: t.last_run_ok,
            last_run_duration_ms: t.last_run_duration_ms,
            // Default false — list_cron_handler post-processes to set true
            // for ids in the executing snapshot. Single-task projections
            // (e.g. /api/cron/run) don't need this.
            currently_executing: false,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCronRequest {
    task_id: String,
    patch: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskIdRequest {
    task_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ===== Handlers =====

async fn create_cron_handler(
    Json(req): Json<CreateCronRequest>,
) -> Json<serde_json::Value> {
    let manager = cron_task::get_cron_task_manager();

    let is_loop = matches!(&req.schedule, Some(CronSchedule::Loop));
    let run_mode = if is_loop {
        cron_task::RunMode::SingleSession // Loop always uses single_session
    } else {
        match req.session_target.as_deref() {
            Some("single_session") => cron_task::RunMode::SingleSession,
            _ => cron_task::RunMode::NewSession,
        }
    };

    let interval_minutes = match &req.schedule {
        Some(CronSchedule::Every { minutes, .. }) => *minutes,
        Some(CronSchedule::At { .. }) => 60, // placeholder, not used for one-shot
        Some(CronSchedule::Cron { .. }) => 60, // placeholder, calculated by cron expression
        Some(CronSchedule::Loop) => 0, // not used, Loop is completion-triggered
        None => req.interval_minutes.unwrap_or(30),
    };

    let session_id = uuid::Uuid::new_v4().to_string();

    let config = CronTaskConfig {
        workspace_path: req.workspace_path,
        session_id,
        prompt: req.message,
        interval_minutes: interval_minutes.max(5),
        end_conditions: Default::default(),
        run_mode,
        notify_enabled: true,
        tab_id: None,
        // PRD 0.2.5 R2/R3 — empty string is the sentinel for "user didn't pick →
        // resolve to runtime max at execute time". Pre-v0.2.5 this field
        // silently defaulted to "auto", which the cron resolver respects
        // literally as acceptEdits and breaks unattended runs.
        permission_mode: req.permission_mode.unwrap_or_default(),
        model: req.model,
        provider_env: req.provider_env,
        provider_id: req.provider_id,
        provider_intent: req.provider_intent.unwrap_or_default(),
        runtime: req.runtime,
        runtime_config: req.runtime_config,
        // Direct cron creation (legacy IM Bot path) doesn't carry a Task
        // parent — MCP override stays None (= follow workspace).
        mcp_enabled_servers: None,
        source_bot_id: req.source_bot_id,
        delivery: req.delivery,
        schedule: req.schedule,
        name: req.name,
        task_id: None,
    };

    match manager.create_task(config).await {
        Ok(task) => {
            // Auto-start the task
            let task_id = task.id.clone();
            if let Err(e) = manager.start_task(&task_id).await {
                ulog_warn!("[management-api] Created task {} but failed to start: {}", task_id, e);
            } else if let Err(e) = manager.start_task_scheduler(&task_id).await {
                ulog_warn!("[management-api] Started task {} but failed to start scheduler: {}", task_id, e);
            }

            // Fetch enriched task to get computed nextExecutionAt
            let next_exec = manager.get_task(&task_id).await
                .and_then(|t| t.next_execution_at);

            Json(serde_json::json!({
                "ok": true,
                "taskId": task.id,
                "status": "running",
                "nextExecutionAt": next_exec
            }))
        }
        Err(e) => Json(serde_json::json!({
            "ok": false,
            "error": e
        })),
    }
}

async fn list_cron_handler(
    Query(query): Query<ListCronQuery>,
) -> Json<serde_json::Value> {
    let manager = cron_task::get_cron_task_manager();

    let tasks = if let Some(bot_id) = &query.source_bot_id {
        manager.get_tasks_for_bot(bot_id).await
    } else if let Some(workspace) = &query.workspace_path {
        manager.get_tasks_for_workspace(workspace).await
    } else {
        manager.get_all_tasks().await
    };

    // PRD 0.2.5 R9 — single snapshot of "currently executing" set, applied
    // to all summaries. Avoids N separate lock acquisitions; correct for
    // a moment-in-time read (the field is transient by design).
    let executing = manager.executing_snapshot().await;
    let summaries: Vec<CronTaskSummary> = tasks
        .into_iter()
        .map(|t| {
            let is_executing = executing.contains(&t.id);
            let mut summary = CronTaskSummary::from(t);
            summary.currently_executing = is_executing;
            summary
        })
        .collect();
    Json(serde_json::json!({ "ok": true, "tasks": summaries }))
}

async fn update_cron_handler(
    Json(req): Json<UpdateCronRequest>,
) -> Json<serde_json::Value> {
    let manager = cron_task::get_cron_task_manager();

    match manager.update_task_fields(&req.task_id, req.patch).await {
        Ok(updated) => {
            // Issue #115 — return the enriched task so callers can echo
            // the post-update `nextExecutionAt` + tz. CLI uses this to
            // print "next fire: <local time>" right after `✓ update`,
            // which prevents the strict-after-now confusion users hit
            // when reading the bare UTC value in a later `cron list`.
            let enriched = cron_task::enrich_for_summary(updated);
            let summary = CronTaskSummary::from(enriched);
            Json(serde_json::json!({
                "ok": true,
                "task": summary,
            }))
        }
        Err(e) => Json(serde_json::json!({
            "ok": false,
            "error": e,
        })),
    }
}

async fn delete_cron_handler(
    Json(req): Json<TaskIdRequest>,
) -> Json<ApiResponse> {
    let manager = cron_task::get_cron_task_manager();

    // Stop first if running
    let _ = manager.stop_task(&req.task_id, Some("Deleted via management API".to_string())).await;

    match manager.delete_task(&req.task_id).await {
        Ok(()) => Json(ApiResponse { ok: true, error: None }),
        Err(e) => Json(ApiResponse {
            ok: false,
            error: Some(e),
        }),
    }
}

async fn run_cron_handler(
    Json(req): Json<TaskIdRequest>,
) -> Json<ApiResponse> {
    let manager = cron_task::get_cron_task_manager();

    // Check task exists
    let task = match manager.get_task(&req.task_id).await {
        Some(t) => t,
        None => {
            return Json(ApiResponse {
                ok: false,
                error: Some(format!("Task not found: {}", req.task_id)),
            });
        }
    };

    // If task is stopped, start it first
    if task.status == cron_task::TaskStatus::Stopped {
        if let Err(e) = manager.start_task(&req.task_id).await {
            return Json(ApiResponse {
                ok: false,
                error: Some(format!("Failed to start task: {}", e)),
            });
        }
        if let Err(e) = manager.start_task_scheduler(&req.task_id).await {
            return Json(ApiResponse {
                ok: false,
                error: Some(format!("Failed to start scheduler: {}", e)),
            });
        }
    }

    Json(ApiResponse { ok: true, error: None })
}

/// PRD 0.2.5 R4 — POST /api/cron/trigger
/// Fire one immediate execution of an existing cron task without modifying
/// its schedule or status. Fire-and-forget: returns as soon as the dispatch
/// kicks off (does NOT wait for the AI to finish).
async fn trigger_cron_handler(
    Json(req): Json<TaskIdRequest>,
) -> Json<serde_json::Value> {
    let manager = cron_task::get_cron_task_manager();
    match manager.trigger_now(&req.task_id).await {
        Ok(info) => Json(serde_json::json!({
            "ok": true,
            "taskId": info.task_id,
            "sessionId": info.session_id,
            "dispatchedAt": info.dispatched_at,
        })),
        Err(e) => {
            let is_conflict = e.contains("currently executing");
            // 409 semantics for "task busy"; 404/500 fall through to the
            // generic ApiResponse shape consumers already understand.
            if is_conflict {
                Json(serde_json::json!({
                    "ok": false,
                    "error": e,
                    "code": "task_busy",
                }))
            } else {
                Json(serde_json::json!({
                    "ok": false,
                    "error": e,
                }))
            }
        }
    }
}

// ===== Runs / Status / Wake handlers =====

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunsQuery {
    task_id: String,
    limit: Option<usize>,
}

async fn runs_cron_handler(
    Query(params): Query<RunsQuery>,
) -> Json<serde_json::Value> {
    let limit = params.limit.unwrap_or(20);
    let runs = cron_task::read_cron_runs(&params.task_id, limit);
    Json(serde_json::json!({ "ok": true, "runs": runs }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusQuery {
    bot_id: Option<String>,
    workspace_path: Option<String>,
}

async fn status_cron_handler(
    Query(params): Query<StatusQuery>,
) -> Json<serde_json::Value> {
    let manager = cron_task::get_cron_task_manager();
    let tasks = if let Some(bot_id) = &params.bot_id {
        manager.get_tasks_for_bot(bot_id).await
    } else if let Some(workspace) = &params.workspace_path {
        manager.get_tasks_for_workspace(workspace).await
    } else {
        manager.get_all_tasks().await
    };

    let total = tasks.len();
    let running = tasks.iter().filter(|t| t.status == cron_task::TaskStatus::Running).count();
    let last_executed = tasks.iter().filter_map(|t| t.last_executed_at).max();
    let next_execution = tasks.iter().filter_map(|t| t.next_execution_at.clone()).min();

    Json(serde_json::json!({
        "ok": true,
        "totalTasks": total,
        "runningTasks": running,
        "lastExecutedAt": last_executed,
        "nextExecutionAt": next_execution,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WakeRequest {
    bot_id: String,
    text: Option<String>,
}

/// Look up a bot instance by ID — checks ManagedAgents first (primary path), then
/// falls back to ManagedImBots (legacy compatibility, usually empty after migration).
/// Returns (router Arc, heartbeat wake_tx) with locks already dropped.
async fn find_bot_refs(bot_id: &str) -> Option<(
    std::sync::Arc<tokio::sync::Mutex<im::router::SessionRouter>>,
    Option<tokio::sync::mpsc::Sender<im::types::WakeReason>>,
)> {
    // Check agent channels first (primary path after v0.1.41 migration)
    if let Some(agents) = get_agents() {
        let agents_guard = agents.lock().await;
        for agent in agents_guard.values() {
            if let Some(ch_inst) = agent.channels.get(bot_id) {
                return Some((
                    std::sync::Arc::clone(&ch_inst.bot_instance.router),
                    ch_inst.bot_instance.heartbeat_wake_tx.clone(),
                ));
            }
        }
    }
    // Legacy fallback: ManagedImBots (for backward compatibility — usually empty)
    if let Some(bots) = get_im_bots() {
        let bots_guard = bots.lock().await;
        if let Some(instance) = bots_guard.get(bot_id) {
            return Some((
                std::sync::Arc::clone(&instance.router),
                instance.heartbeat_wake_tx.clone(),
            ));
        }
    }
    None
}

/// Look up a bot's adapter by ID — checks ManagedAgents first, then legacy ManagedImBots.
async fn find_bot_adapter(bot_id: &str) -> Option<std::sync::Arc<im::AnyAdapter>> {
    // Check agent channels first (primary path)
    if let Some(agents) = get_agents() {
        let agents_guard = agents.lock().await;
        for agent in agents_guard.values() {
            if let Some(ch_inst) = agent.channels.get(bot_id) {
                return Some(std::sync::Arc::clone(&ch_inst.bot_instance.adapter));
            }
        }
    }
    // Legacy fallback
    if let Some(bots) = get_im_bots() {
        let bots_guard = bots.lock().await;
        if let Some(instance) = bots_guard.get(bot_id) {
            return Some(std::sync::Arc::clone(&instance.adapter));
        }
    }
    None
}

/// Snapshot of channel metadata extracted under lock, resolved after lock is dropped.
struct ChannelSnapshot {
    bot_id: String,
    platform_str: String,
    name: String,
    agent_name: Option<String>,
    health: std::sync::Arc<im::health::HealthManager>,
}

/// GET /api/im/channels — List all configured IM channels for cron delivery target discovery.
/// Returns channel botId, platform, name, parent agent name, and runtime status.
/// Uses snapshot-then-await pattern to avoid holding ManagedAgents/ManagedImBots lock across awaits.
async fn list_im_channels_handler() -> Json<serde_json::Value> {
    let mut snapshots: Vec<ChannelSnapshot> = Vec::new();

    // Snapshot from ManagedAgents (primary path after v0.1.41) — lock dropped before await
    if let Some(agents) = get_agents() {
        let agents_guard = agents.lock().await;
        for agent in agents_guard.values() {
            for (ch_id, ch_inst) in &agent.channels {
                let platform_str = serde_json::to_value(&ch_inst.bot_instance.platform)
                    .and_then(|v| serde_json::from_value::<String>(v))
                    .unwrap_or_else(|_| "unknown".to_string());
                let name = ch_inst.bot_instance.config.name.clone()
                    .unwrap_or_else(|| ch_id.clone());
                snapshots.push(ChannelSnapshot {
                    bot_id: ch_id.clone(),
                    platform_str,
                    name,
                    agent_name: Some(agent.config.name.clone()),
                    health: std::sync::Arc::clone(&ch_inst.bot_instance.health),
                });
            }
        }
    } // agents_guard dropped here

    // Snapshot from legacy ManagedImBots — lock dropped before await
    if let Some(bots) = get_im_bots() {
        let bots_guard = bots.lock().await;
        for (bot_id, instance) in bots_guard.iter() {
            // Skip if already collected from agent channels
            if snapshots.iter().any(|s| s.bot_id == *bot_id) {
                continue;
            }
            let platform_str = serde_json::to_value(&instance.platform)
                .and_then(|v| serde_json::from_value::<String>(v))
                .unwrap_or_else(|_| "unknown".to_string());
            let name = instance.config.name.clone()
                .unwrap_or_else(|| bot_id.clone());
            snapshots.push(ChannelSnapshot {
                bot_id: bot_id.clone(),
                platform_str,
                name,
                agent_name: None,
                health: std::sync::Arc::clone(&instance.health),
            });
        }
    } // bots_guard dropped here

    // Now resolve health states without holding any lock
    let mut channels = Vec::with_capacity(snapshots.len());
    for snap in snapshots {
        let health_state = snap.health.get_state().await;
        let status_str = serde_json::to_value(&health_state.status)
            .and_then(|v| serde_json::from_value::<String>(v))
            .unwrap_or_else(|_| "unknown".to_string());
        channels.push(serde_json::json!({
            "botId": snap.bot_id,
            "platform": snap.platform_str,
            "name": snap.name,
            "agentName": snap.agent_name,
            "status": status_str,
        }));
    }

    Json(serde_json::json!({ "ok": true, "channels": channels }))
}

async fn wake_bot_handler(
    Json(payload): Json<WakeRequest>,
) -> Json<serde_json::Value> {
    let (router, wake_tx) = match find_bot_refs(&payload.bot_id).await {
        Some(refs) => refs,
        None => return Json(serde_json::json!({ "ok": false, "error": "Bot not found" })),
    };

    // Step 1: If text provided, try to POST system event to Bot Sidecar
    if let Some(ref text) = payload.text {
        let port = {
            let router_guard = router.lock().await;
            router_guard.find_any_active_session().map(|(p, _, _)| p)
        };

        if let Some(port) = port {
            let client = crate::local_http::builder().build().unwrap_or_default();
            let body = serde_json::json!({
                "event": "manual_wake",
                "content": text,
            });
            let _ = client
                .post(format!("http://127.0.0.1:{}/api/im/system-event", port))
                .json(&body)
                .send()
                .await;
        }
    }

    // Step 2: Send WakeReason::Manual to heartbeat runner
    if let Some(ref wake_tx) = wake_tx {
        match wake_tx.send(im::types::WakeReason::Manual).await {
            Ok(_) => Json(serde_json::json!({ "ok": true })),
            Err(e) => Json(serde_json::json!({ "ok": false, "error": format!("Wake failed: {}", e) })),
        }
    } else {
        Json(serde_json::json!({ "ok": false, "error": "Heartbeat not configured for this bot" }))
    }
}

// ===== Send Media handler =====

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct SendMediaRequest {
    bot_id: String,
    chat_id: String,
    platform: String,
    file_path: String,
    caption: Option<String>,
}

async fn send_media_handler(
    Json(req): Json<SendMediaRequest>,
) -> Json<serde_json::Value> {
    // Get adapter from the bot instance (checks legacy IM bots, then agent channels)
    let adapter: std::sync::Arc<im::AnyAdapter> = match find_bot_adapter(&req.bot_id).await {
        Some(a) => a,
        None => return Json(serde_json::json!({
            "ok": false, "error": format!("Bot not found: {}", req.bot_id)
        })),
    };

    // Read the file
    let path = std::path::Path::new(&req.file_path);
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    let data = match tokio::fs::read(&req.file_path).await {
        Ok(d) => d,
        Err(e) => return Json(serde_json::json!({
            "ok": false, "error": format!("File not found or unreadable: {}", e)
        })),
    };

    let data_len = data.len() as u64;
    let media_type = MediaType::from_extension(ext);

    match media_type {
        MediaType::Image => {
            let size_limit: u64 = 10 * 1024 * 1024;
            if data_len > size_limit {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": format!("Image too large: {:.1} MB (max 10 MB)", data_len as f64 / (1024.0 * 1024.0))
                }));
            }
            ulog_info!("[send-media] Sending image: {} ({} bytes) to {}", filename, data_len, req.chat_id);
            match adapter.send_photo(&req.chat_id, data, &filename, req.caption.as_deref()).await {
                Ok(_) => Json(serde_json::json!({
                    "ok": true, "fileName": filename, "fileSize": data_len
                })),
                Err(e) => Json(serde_json::json!({
                    "ok": false, "error": format!("Failed to send photo: {}", e)
                })),
            }
        }
        MediaType::File => {
            let size_limit: u64 = 50 * 1024 * 1024;
            if data_len > size_limit {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": format!("File too large: {:.1} MB (max 50 MB)", data_len as f64 / (1024.0 * 1024.0))
                }));
            }
            let mime = match ext.to_lowercase().as_str() {
                "pdf" => "application/pdf",
                "doc" | "docx" => "application/msword",
                "xls" | "xlsx" => "application/vnd.ms-excel",
                "ppt" | "pptx" => "application/vnd.ms-powerpoint",
                "mp4" => "video/mp4",
                "mp3" => "audio/mpeg",
                "zip" => "application/zip",
                "csv" => "text/csv",
                "json" => "application/json",
                "xml" => "application/xml",
                "html" => "text/html",
                "txt" => "text/plain",
                _ => "application/octet-stream",
            };
            ulog_info!("[send-media] Sending file: {} ({} bytes, {}) to {}", filename, data_len, mime, req.chat_id);
            match adapter.send_file(&req.chat_id, data, &filename, mime, req.caption.as_deref()).await {
                Ok(_) => Json(serde_json::json!({
                    "ok": true, "fileName": filename, "fileSize": data_len
                })),
                Err(e) => Json(serde_json::json!({
                    "ok": false, "error": format!("Failed to send file: {}", e)
                })),
            }
        }
        MediaType::NonMedia => {
            Json(serde_json::json!({
                "ok": false,
                "error": format!("Unsupported file type: .{} — only images, documents, media, and archives can be sent", ext)
            }))
        }
    }
}

// ===== Cron Stop handler =====

async fn stop_cron_handler(Json(req): Json<TaskIdRequest>) -> Json<ApiResponse> {
    let manager = cron_task::get_cron_task_manager();
    match manager.stop_task(&req.task_id, Some("Stopped via admin CLI".to_string())).await {
        Ok(_) => Json(ApiResponse { ok: true, error: None }),
        Err(e) => Json(ApiResponse { ok: false, error: Some(e) }),
    }
}

// ===== Plugin Management handlers =====

async fn list_plugins_handler() -> Json<serde_json::Value> {
    match bridge::list_openclaw_plugins().await {
        Ok(plugins) => Json(serde_json::json!({ "ok": true, "plugins": plugins })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallPluginRequest {
    npm_spec: String,
}

async fn install_plugin_handler(Json(req): Json<InstallPluginRequest>) -> Json<serde_json::Value> {
    // install_openclaw_plugin requires AppHandle, but Management API doesn't have it.
    // Use the global app handle from logger module.
    let app_handle = match crate::logger::get_app_handle() {
        Some(h) => h,
        None => return Json(serde_json::json!({ "ok": false, "error": "App not initialized" })),
    };
    match bridge::install_openclaw_plugin(app_handle, &req.npm_spec).await {
        Ok(metadata) => Json(serde_json::json!({ "ok": true, "plugin": metadata })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UninstallPluginRequest {
    plugin_id: String,
}

async fn uninstall_plugin_handler(Json(req): Json<UninstallPluginRequest>) -> Json<serde_json::Value> {
    match bridge::uninstall_openclaw_plugin(&req.plugin_id).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

// ===== Agent Runtime Status handler =====

async fn agent_runtime_status_handler() -> Json<serde_json::Value> {
    let agents = match get_agents() {
        Some(a) => a,
        None => return Json(serde_json::json!({ "ok": true, "agents": {} })),
    };

    let agents_guard = agents.lock().await;

    // Snapshot data under lock, then drop lock before awaiting health states
    struct AgentSnapshot {
        agent_id: String,
        agent_name: String,
        enabled: bool,
        channels: Vec<ChannelRuntimeSnapshot>,
    }
    struct ChannelRuntimeSnapshot {
        channel_id: String,
        platform_str: String,
        health: std::sync::Arc<im::health::HealthManager>,
    }

    let mut snapshots: Vec<AgentSnapshot> = Vec::new();
    for (agent_id, agent) in agents_guard.iter() {
        let mut ch_snapshots = Vec::new();
        for (ch_id, ch) in &agent.channels {
            let platform_str = serde_json::to_value(&ch.bot_instance.platform)
                .and_then(|v| serde_json::from_value::<String>(v))
                .unwrap_or_else(|_| "unknown".to_string());
            ch_snapshots.push(ChannelRuntimeSnapshot {
                channel_id: ch_id.clone(),
                platform_str,
                health: std::sync::Arc::clone(&ch.bot_instance.health),
            });
        }
        snapshots.push(AgentSnapshot {
            agent_id: agent_id.clone(),
            agent_name: agent.config.name.clone(),
            enabled: agent.config.enabled,
            channels: ch_snapshots,
        });
    }
    drop(agents_guard);

    // Now resolve health states without holding the lock
    let mut result = serde_json::Map::new();
    for snap in snapshots {
        let mut channels = Vec::new();
        for ch in &snap.channels {
            let health_state = ch.health.get_state().await;
            let status_str = serde_json::to_value(&health_state.status)
                .and_then(|v| serde_json::from_value::<String>(v))
                .unwrap_or_else(|_| "unknown".to_string());
            channels.push(serde_json::json!({
                "channelId": ch.channel_id,
                "channelType": ch.platform_str,
                "status": status_str,
                "uptimeSeconds": health_state.uptime_seconds,
                "lastMessageAt": health_state.last_message_at,
                "errorMessage": health_state.error_message,
                "activeSessions": health_state.active_sessions.len(),
                "restartCount": health_state.restart_count,
            }));
        }
        result.insert(snap.agent_id.clone(), serde_json::json!({
            "agentId": snap.agent_id,
            "agentName": snap.agent_name,
            "enabled": snap.enabled,
            "channels": channels,
        }));
    }

    Json(serde_json::json!({ "ok": true, "agents": result }))
}

// ===== Bridge Message handler (OpenClaw Channel Plugin → Rust) =====

/// Media attachment from Plugin Bridge (base64-encoded).
/// Classified by the Bridge shim based on MIME type:
///   - "image" → ImAttachmentType::Image (Claude Vision API)
///   - "file"  → ImAttachmentType::File (save to workspace + @path reference)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeAttachment {
    file_name: String,
    mime_type: String,
    /// base64-encoded file content
    data: String,
    /// "image" | "file"
    attachment_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeMessagePayload {
    bot_id: String,
    plugin_id: String,
    sender_id: String,
    sender_name: Option<String>,
    text: String,
    chat_type: String,       // "direct" | "group"
    chat_id: String,
    message_id: Option<String>,
    #[allow(dead_code)]
    group_id: Option<String>,
    is_mention: Option<bool>,
    /// Human-readable group name from plugin (e.g. GroupSubject in OpenClaw Feishu)
    #[serde(default)]
    group_name: Option<String>,
    /// Thread ID for threaded replies (MessageThreadId in OpenClaw)
    #[serde(default)]
    #[allow(dead_code)]
    thread_id: Option<String>,
    /// Quoted reply text content (ReplyToBody in OpenClaw)
    #[serde(default)]
    reply_to_body: Option<String>,
    /// Group-level custom system prompt from plugin config
    #[serde(default)]
    group_system_prompt: Option<String>,
    /// Media attachments from OpenClaw plugin (images, files, voice, video)
    #[serde(default)]
    attachments: Vec<BridgeAttachment>,
}

async fn handle_bridge_message(
    Json(payload): Json<BridgeMessagePayload>,
) -> (axum::http::StatusCode, Json<serde_json::Value>) {
    use crate::im::bridge;
    use crate::im::types::{ImAttachment, ImAttachmentType, ImMessage, ImPlatform, ImSourceType};

    // Validate plugin_id: reject empty, path separators, and colons.
    // Note: built-in platform names ("feishu" etc.) are allowed because OpenClaw plugins
    // may legitimately use them as channel IDs (e.g. official Feishu plugin = "feishu").
    // Bridge routing uses botId (UUID), not pluginId, so there's no collision.
    let plugin_id = payload.plugin_id.trim().to_string();
    if plugin_id.is_empty()
        || plugin_id.contains('/')
        || plugin_id.contains('\\')
        || plugin_id.contains(':')
    {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "ok": false,
                "error": format!("Invalid plugin_id: '{}'", plugin_id)
            })),
        );
    }

    let sender = match bridge::get_bridge_sender(&payload.bot_id).await {
        Some(tx) => tx,
        None => {
            return (
                axum::http::StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "ok": false,
                    "error": format!("No bridge sender registered for bot_id={}", payload.bot_id)
                })),
            );
        }
    };

    let source_type = if payload.chat_type == "group" {
        ImSourceType::Group
    } else {
        ImSourceType::Private
    };
    // Default: private=true (directed at bot), group=false (only if explicitly flagged)
    let is_mention = payload.is_mention.unwrap_or(source_type == ImSourceType::Private);

    // Decode base64 media attachments from Bridge
    let mut im_attachments: Vec<ImAttachment> = Vec::new();
    for att in &payload.attachments {
        use base64::Engine;
        match base64::engine::general_purpose::STANDARD.decode(&att.data) {
            Ok(data) => {
                let attachment_type = if att.attachment_type == "image" {
                    ImAttachmentType::Image
                } else {
                    ImAttachmentType::File
                };
                crate::ulog_info!(
                    "[im-bridge] Decoded {} attachment: {} ({}, {} bytes)",
                    att.attachment_type,
                    att.file_name,
                    att.mime_type,
                    data.len()
                );
                im_attachments.push(ImAttachment {
                    file_name: att.file_name.clone(),
                    mime_type: att.mime_type.clone(),
                    data,
                    attachment_type,
                });
            }
            Err(e) => {
                crate::ulog_error!(
                    "[im-bridge] Failed to decode base64 for {}: {}",
                    att.file_name,
                    e
                );
            }
        }
    }

    let msg = ImMessage {
        chat_id: payload.chat_id,
        message_id: payload.message_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        text: payload.text,
        sender_id: payload.sender_id,
        sender_name: payload.sender_name,
        source_type,
        platform: ImPlatform::OpenClaw(plugin_id),
        timestamp: chrono::Utc::now(),
        attachments: im_attachments,
        media_group_id: None,
        is_mention,
        reply_to_bot: false,
        hint_group_name: payload.group_name,
        reply_to_body: payload.reply_to_body,
        group_system_prompt: payload.group_system_prompt,
        request_id: String::new(),
    };

    match sender.send(msg).await {
        Ok(_) => (
            axum::http::StatusCode::OK,
            Json(serde_json::json!({ "ok": true })),
        ),
        Err(e) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "ok": false,
                "error": format!("Failed to send message to processing loop: {}", e)
            })),
        ),
    }
}

// ========================================================================
// Task Center handlers (v0.1.69)
// ========================================================================
//
// These endpoints are called by the Bun Admin API (admin-api.ts), which in
// turn is called by the `myagents task` CLI. The CLI is the **entry point of
// trust inference** for `actor` / `source` (PRD §10.2.1 caller-inference table):
//
// - `MYAGENTS_PORT` env var set → AI sub-process → `actor=agent, source=cli`
// - Otherwise (user terminal reading `~/.myagents/sidecar.port`) →
//   `actor=user, source=cli`
//
// That inference happens in the CLI script itself (knows its own env) and is
// forwarded to the Bun Admin API, which forwards here. We take the caller's
// word for actor/source: the CLI process running inside an SDK subprocess is
// inside a trust boundary already (the whole host is the user's machine).
// For UI transitions the Tauri command layer stamps `user/ui` authoritatively
// without ever reaching this path.

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskListQuery {
    workspace_id: Option<String>,
    status: Option<String>,
    tag: Option<String>,
    include_deleted: Option<bool>,
}

async fn task_list_handler(
    Query(q): Query<TaskListQuery>,
) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    let filter = task::TaskListFilter {
        workspace_id: q.workspace_id,
        status: q.status.and_then(|s| parse_status_filter(&s)),
        tag: q.tag,
        include_deleted: q.include_deleted,
    };
    let tasks = store.list(filter).await;
    Json(serde_json::json!({ "ok": true, "tasks": tasks }))
}

fn parse_status_filter(raw: &str) -> Option<task::StatusFilter> {
    if raw.contains(',') {
        let list: Vec<task::TaskStatus> = raw
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .filter_map(|s| serde_json::from_str(&format!("\"{}\"", s)).ok())
            .collect();
        if list.is_empty() {
            None
        } else {
            Some(task::StatusFilter::Many(list))
        }
    } else {
        serde_json::from_str::<task::TaskStatus>(&format!("\"{}\"", raw.trim()))
            .ok()
            .map(task::StatusFilter::One)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskGetQuery {
    id: String,
}

async fn task_get_handler(
    Query(q): Query<TaskGetQuery>,
) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    match store.get(&q.id).await {
        Some(t) => {
            // Attach task.docs (four absolute paths) so the AI / CLI
            // reading this response knows where task.md / verify.md /
            // progress.md / alignment.md live without having to
            // re-derive the layout from convention. See
            // `task::build_task_docs` for semantics of the optional
            // fields (only existing files are surfaced).
            let docs = match task::build_task_docs(&t.id) {
                Ok(d) => d,
                Err(e) => {
                    return Json(serde_json::json!({
                        "ok": false,
                        "error": format!("failed to build docs paths: {}", e)
                    }));
                }
            };
            Json(serde_json::json!({ "ok": true, "task": task::TaskWithDocs { task: t, docs } }))
        }
        None => Json(serde_json::json!({
            "ok": false,
            "error": "not_found"
        })),
    }
}

async fn task_create_direct_handler(
    Json(input): Json<task::TaskCreateDirectInput>,
) -> Json<serde_json::Value> {
    let Some(task_store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    let source_thought = input.source_thought_id.clone();
    match task_store.create_direct(input).await {
        Ok(t) => {
            // Best-effort bidirectional link (same as Tauri command layer).
            if let (Some(thought_id), Some(thoughts)) =
                (source_thought, thought::get_thought_store())
            {
                let _ = thoughts.link_task(&thought_id, &t.id).await;
            }
            Json(serde_json::json!({ "ok": true, "task": t }))
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

async fn task_update_handler(
    Json(input): Json<task::TaskUpdateInput>,
) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    // Reuses `TaskStore::update`, which:
    //   * rejects updates on Running/Verifying tasks (state-machine guard),
    //   * applies mode-transition hygiene (clearing recurring fields when
    //     `executionMode` flips to Once etc.),
    //   * projects schedule/notification/override changes back to the linked
    //     CronTask via `update_task_fields`, so a CLI patch like
    //     `--intervalMinutes 180` actually re-arms the scheduler.
    match store.update(input).await {
        Ok(task) => {
            let docs = match task::build_task_docs(&task.id) {
                Ok(d) => d,
                // Doc dir absence is non-fatal — surface the task without
                // docs paths so the caller still sees the update result.
                Err(_) => task::TaskDocs {
                    dir: String::new(),
                    task_md: String::new(),
                    verify_md: None,
                    progress_md: None,
                    alignment_md: None,
                },
            };
            Json(serde_json::json!({
                "ok": true,
                "task": task::TaskWithDocs { task, docs },
            }))
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskUpdateStatusApiRequest {
    id: String,
    status: task::TaskStatus,
    #[serde(default)]
    message: Option<String>,
    /// Caller-declared actor. CLI from AI subprocess → "agent"; user terminal → "user".
    actor: task::TransitionActor,
    /// Caller-declared source. Usually "cli" from this endpoint; scheduler /
    /// watchdog / crash paths don't use HTTP.
    #[serde(default)]
    source: Option<task::TransitionSource>,
}

async fn task_update_status_handler(
    Json(req): Json<TaskUpdateStatusApiRequest>,
) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    match store
        .update_status(task::TaskUpdateStatusInput {
            id: req.id,
            status: req.status,
            message: req.message,
            actor: req.actor,
            source: req.source.or(Some(task::TransitionSource::Cli)),
        })
        .await
    {
        Ok((task, transition)) => Json(serde_json::json!({
            "ok": true,
            "task": task,
            "transition": transition
        })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskAppendSessionApiRequest {
    id: String,
    session_id: String,
}

async fn task_append_session_handler(
    Json(req): Json<TaskAppendSessionApiRequest>,
) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    match store.append_session(&req.id, &req.session_id).await {
        Ok(t) => Json(serde_json::json!({ "ok": true, "task": t })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskArchiveApiRequest {
    id: String,
    #[serde(default)]
    message: Option<String>,
}

async fn task_archive_handler(
    Json(req): Json<TaskArchiveApiRequest>,
) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    match store.archive(&req.id, req.message).await {
        Ok(t) => Json(serde_json::json!({ "ok": true, "task": t })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskDeleteApiRequest {
    id: String,
}

async fn task_delete_handler(
    Json(req): Json<TaskDeleteApiRequest>,
) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    let source_thought = store.get(&req.id).await.and_then(|t| t.source_thought_id);
    match store.delete(&req.id).await {
        Ok(()) => {
            if let (Some(thought_id), Some(thoughts)) =
                (source_thought, thought::get_thought_store())
            {
                let _ = thoughts.unlink_task(&thought_id, &req.id).await;
            }
            Json(serde_json::json!({ "ok": true }))
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThoughtListQuery {
    tag: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
    /// `active` (default) / `archived` / `all`. CLI parity with v0.2.16
    /// archive feature so `myagents thought list --archived` works.
    archived: Option<String>,
}

async fn thought_list_handler(
    Query(q): Query<ThoughtListQuery>,
) -> Json<serde_json::Value> {
    let Some(store) = thought::get_thought_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "thought store not initialized"
        }));
    };
    let archive_mode = match q.archived.as_deref() {
        Some("archived") => Some(thought::ThoughtArchiveFilter::Archived),
        Some("all") => Some(thought::ThoughtArchiveFilter::All),
        // Missing or "active" → default Active behavior; anything else
        // we ignore rather than 400 so a typo doesn't surface as a hard
        // CLI failure.
        _ => Some(thought::ThoughtArchiveFilter::Active),
    };
    let thoughts = store
        .list(thought::ThoughtListFilter {
            tag: q.tag,
            query: q.query,
            limit: q.limit,
            archived: archive_mode,
        })
        .await;
    Json(serde_json::json!({ "ok": true, "thoughts": thoughts }))
}

async fn thought_create_handler(
    Json(input): Json<thought::ThoughtCreateInput>,
) -> Json<serde_json::Value> {
    let Some(store) = thought::get_thought_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "thought store not initialized"
        }));
    };
    match store.create(input).await {
        Ok(t) => Json(serde_json::json!({ "ok": true, "thought": t })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

// ========================================================================
// Task Center execution handlers (v0.1.69)
// ========================================================================

async fn task_create_from_alignment_handler(
    Json(input): Json<task::TaskCreateFromAlignmentInput>,
) -> Json<serde_json::Value> {
    let Some(task_store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    match task_store.create_from_alignment(input).await {
        Ok(t) => {
            // Resolve thought→task linkage from the created task's record,
            // not the raw input — `source_thought_id` may have been
            // auto-inherited from alignment metadata.json and thus absent
            // on the input. Reading from `t` covers both code paths
            // uniformly.
            if let (Some(thought_id), Some(thoughts)) =
                (t.source_thought_id.clone(), thought::get_thought_store())
            {
                let _ = thoughts.link_task(&thought_id, &t.id).await;
            }
            Json(serde_json::json!({ "ok": true, "task": t }))
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

/// PRD §10.2.2 `POST /api/task/run` — trigger execution of an existing Task.
///
/// Behavior:
/// - Bridges the Task to a CronTask (the unified execution primitive, §11.1):
///   creates one with `task_id` reverse pointer if none exists, starts it,
///   and kicks the scheduler. The scheduler's first tick calls
///   `execute_cron_task()` which builds the first-message prompt dynamically
///   from `dispatchOrigin` + `~/.myagents/tasks/<id>/task.md` (PRD §9.3.1).
/// - On successful dispatch transitions `todo → running` via TaskStore.
/// - For `executionMode = 'once'` the CronTask is `At { at: now }` so it fires
///   once and stays stopped after.
/// - For scheduled/recurring/loop the CronTask schedule mirrors the Task.
async fn task_run_handler(
    Json(req): Json<TaskIdApiRequest>,
) -> Json<serde_json::Value> {
    let Some(task_store) = task::get_task_store() else {
        return Json(serde_json::json!({ "ok": false, "error": "task store not initialized" }));
    };
    let Some(ta) = task_store.get(&req.id).await else {
        return Json(serde_json::json!({ "ok": false, "error": "task not found" }));
    };

    // Legal-transition guard: `run` is only meaningful from `todo`. Other
    // states require the user to hit `rerun` (which resets first).
    if ta.status != task::TaskStatus::Todo {
        return Json(serde_json::json!({
            "ok": false,
            "error": format!("task is in state '{}'; use 'myagents task rerun {}' to re-dispatch it", ta.status.as_str(), ta.id)
        }));
    }

    match ensure_cron_for_task(&ta).await {
        Ok(cron_id) => {
            // Write back the CronTask back-pointer so the detail Overlay
            // can show "下次触发时间" derived from CronTask.next_execution_at.
            let _ = task_store
                .set_cron_task_id(&ta.id, Some(cron_id.clone()))
                .await;

            // Mark Task as running. `system / ui` — the invocation came from
            // UI button or CLI `task run`, the actor-inference table treats
            // both as system in this row.
            match task_store
                .update_status(task::TaskUpdateStatusInput {
                    id: ta.id.clone(),
                    status: task::TaskStatus::Running,
                    message: Some("dispatched".to_string()),
                    actor: task::TransitionActor::System,
                    source: Some(task::TransitionSource::Scheduler),
                })
                .await
            {
                Ok((t, _)) => Json(serde_json::json!({
                    "ok": true,
                    "task": t,
                    "cronTaskId": cron_id,
                })),
                Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
            }
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

/// PRD §10.2.2 `POST /api/task/rerun` — reset the status back to `todo` (via
/// a proper audited transition) then invoke the `run` flow. Used when a task
/// is stuck in `blocked` / `stopped` / `done` / `archived` and the user wants
/// to try again from scratch.
async fn task_rerun_handler(
    Json(req): Json<TaskIdApiRequest>,
) -> Json<serde_json::Value> {
    let Some(task_store) = task::get_task_store() else {
        return Json(serde_json::json!({ "ok": false, "error": "task store not initialized" }));
    };
    let Some(ta) = task_store.get(&req.id).await else {
        return Json(serde_json::json!({ "ok": false, "error": "task not found" }));
    };

    if !matches!(
        ta.status,
        task::TaskStatus::Blocked
            | task::TaskStatus::Stopped
            | task::TaskStatus::Done
            | task::TaskStatus::Archived
    ) {
        return Json(serde_json::json!({
            "ok": false,
            "error": format!("rerun only valid from blocked/stopped/done/archived; current = '{}'", ta.status.as_str())
        }));
    }

    // Step 1: reset → todo with source=rerun (PRD §10.2.1 caller-inference
    // table row "rerun").
    if let Err(e) = task_store
        .update_status(task::TaskUpdateStatusInput {
            id: ta.id.clone(),
            status: task::TaskStatus::Todo,
            message: Some("rerun requested".to_string()),
            actor: task::TransitionActor::System,
            source: Some(task::TransitionSource::Rerun),
        })
        .await
    {
        return Json(serde_json::json!({ "ok": false, "error": format!("reset failed: {}", e) }));
    }

    // Drop any stale CronTask back-pointer so `ensure_cron_for_task` sees a
    // clean slate (particularly important if the previous CronTask has
    // exhausted endConditions).
    if let Some(stale) = ta.cron_task_id.as_deref() {
        let _ = cron_task::get_cron_task_manager()
            .delete_task(stale)
            .await;
        let _ = task_store.set_cron_task_id(&ta.id, None).await;
    }

    // Step 2: defer to the same path as `task/run`. Re-fetch to pick up the
    // fresh `todo` status.
    let req_next = TaskIdApiRequest { id: ta.id.clone() };
    task_run_handler(Json(req_next)).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskReadDocQuery {
    id: String,
    /// `task` | `verify` | `progress` — the md filename stem.
    doc: String,
}

/// `GET /api/task/read-doc?id=&doc=` — used by the `myagents task show-doc`
/// CLI so Agents running in a workspace can read a Task's markdown without
/// hardcoding the filesystem path (task docs live in the user profile dir
/// after v0.1.69, not in the workspace).
async fn task_read_doc_handler(
    axum::extract::Query(q): axum::extract::Query<TaskReadDocQuery>,
) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({ "ok": false, "error": "task store not initialized" }));
    };
    let Some(ta) = store.get(&q.id).await else {
        return Json(serde_json::json!({ "ok": false, "error": "task not found" }));
    };
    // Delegate to `task::task_doc_filename` so the Management API, Tauri
    // IPC, and any future doc-reading surface all share one whitelist —
    // preventing the v0.1.69 drift where Management accepted `alignment`
    // but Tauri IPC rejected it.
    let filename = match task::task_doc_filename(&q.doc) {
        Ok(f) => f,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
    };
    let dir = match task::task_docs_dir(&ta.id) {
        Ok(p) => p,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
    };
    let path = dir.join(filename);
    match std::fs::read_to_string(&path) {
        Ok(content) => Json(serde_json::json!({ "ok": true, "content": content })),
        // Missing file is not an error for the CLI — it means "no doc yet".
        // We still 200 and return empty content so scripting is idempotent.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Json(serde_json::json!({ "ok": true, "content": "" }))
        }
        Err(e) => Json(serde_json::json!({
            "ok": false,
            "error": format!("read {}: {}", filename, e),
        })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskWriteDocRequest {
    id: String,
    /// `task` | `verify` — `progress` is agent-only and rejected here.
    doc: String,
    content: String,
}

/// `POST /api/task/write-doc` — write `task.md` or `verify.md` for a Task.
/// Delegates to `TaskStore::write_doc`, which enforces the running/verifying
/// lock atomically with the file write (PRD §9.4). `progress.md` is
/// explicitly rejected here — only the runtime agent appends to it.
async fn task_write_doc_handler(
    Json(req): Json<TaskWriteDocRequest>,
) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({ "ok": false, "error": "task store not initialized" }));
    };
    // Central whitelist via `task::task_doc_filename` — same contract as
    // read-doc. Then refuse writing progress.md / alignment.md (the Tauri
    // `cmd_task_write_doc` enforces the same rule, keeping both entry
    // points aligned).
    let filename = match task::task_doc_filename(&req.doc) {
        Ok(f) => f,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
    };
    if filename == "progress.md" || filename == "alignment.md" {
        return Json(serde_json::json!({
            "ok": false,
            "error": format!(
                "{} is not writable via this API (progress=agent-appended, alignment=skill-written)",
                filename
            ),
        }));
    }
    match store.write_doc(&req.id, filename, &req.content).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

/// Ensure a CronTask exists for this Task; create one if missing. Returns the
/// CronTask id (newly created or existing). Starts + schedules the CronTask
/// so the next scheduler tick picks it up.
///
/// Reuse is gated on **schedule compatibility** (CC review C4): if the
/// existing CronTask's schedule / runMode / endConditions diverge from what
/// the Task now wants (user edited the task via a path other than `update()`
/// or a legacy CronTask predates the change), tear down the stale one and
/// mint a fresh CronTask. This keeps `ensure_cron_for_task` the single source
/// of truth for schedule compatibility rather than trusting callers.
async fn ensure_cron_for_task(ta: &task::Task) -> Result<String, String> {
    let manager = cron_task::get_cron_task_manager();
    // Scheduled mode without an explicit `dispatch_at` (or legacy
    // `endConditions.deadline`) returns None — we refuse to coin a synthetic
    // timestamp because doing so would force a CronTask rebuild on every
    // subsequent call (see the `schedules_equivalent` string-compare at the
    // top of this file) and wipe `executionCount`.
    let desired = schedule_from_task(ta).ok_or_else(|| {
        if matches!(ta.execution_mode, task::TaskExecutionMode::Scheduled) {
            "定时模式需要设置执行时间（dispatchAt），请在编辑面板中填写。".to_string()
        } else {
            format!("task {} has no resolvable schedule", ta.id)
        }
    })?;
    let desired_run_mode = resolve_run_mode(ta);
    let desired_end_conditions = ta
        .end_conditions
        .clone()
        .map(cron_task::EndConditions::from)
        .unwrap_or_default();
    let desired_model = ta.model.clone();
    // PRD 0.2.5 R2 — unset = empty sentinel; the cron exec path (Node
    // resolveCronPermissionMode) maps that to the runtime-specific MAX
    // mode (builtin: fullAgency, cc: bypassPermissions, codex:
    // no-restrictions, gemini: yolo). Hardcoding "fullAgency" here was
    // wrong for Codex/Gemini — those runtimes don't recognize
    // "fullAgency" and fell through to interactive defaults.
    let desired_permission_mode = ta
        .permission_mode
        .clone()
        .unwrap_or_default();

    // Candidate IDs: the Task's own cached `cron_task_id`, and any other
    // CronTask that carries this Task's id as a back-pointer (defensive —
    // covers the "cached id got lost but the CronTask is still around" case).
    let mut candidates: Vec<String> = Vec::new();
    if let Some(id) = ta.cron_task_id.clone() {
        candidates.push(id);
    }
    if let Some(existing) = manager.find_by_task_id(&ta.id).await {
        if !candidates.iter().any(|x| x == &existing.id) {
            candidates.push(existing.id);
        }
    }

    for id in candidates {
        let Some(existing) = manager.get_task(&id).await else {
            continue;
        };
        // Compatibility check — schedule/runMode/endConditions are the
        // invariants that force a rebuild; model/permissionMode/delivery
        // are projected via `update_task_fields` and don't invalidate the
        // CronTask identity (executionCount / cron_runs preserved).
        let compatible = schedules_equivalent(&existing.schedule, &desired)
            && existing.run_mode == desired_run_mode
            && existing.end_conditions == desired_end_conditions;
        if compatible {
            // Idempotent start: the CronTask may already be Running —
            // e.g. if the app recovered from a crash where this Task
            // was mid-execution, `recover_running_tasks` restarts the
            // CronTask back to Running while the Task row may still be
            // Todo (from a stale migration, or because the user is
            // about to hit "立即执行" to re-bind). `start_task` errors
            // on "already running", which surfaces as a misleading
            // 执行失败 toast to the user. Skip the redundant
            // start_task call when the cron is already live; the
            // scheduler start call below is independently idempotent
            // (see `start_task_scheduler`'s early-return).
            if existing.status != cron_task::TaskStatus::Running {
                manager
                    .start_task(&id)
                    .await
                    .map_err(|e| format!("start_task: {}", e))?;
            }
            manager
                .start_task_scheduler(&id)
                .await
                .map_err(|e| format!("start_task_scheduler: {}", e))?;
            return Ok(id);
        }
        // Mismatch — drop the stale CronTask and fall through to create a
        // fresh one.
        ulog_info!(
            "[management-api] CronTask {} schedule mismatches Task {} — recreating",
            id,
            ta.id
        );
        let _ = manager.delete_task(&id).await;
    }

    // Build a CronTask config. `prompt` is a stored fallback — the actual
    // prompt the sidecar receives is built dynamically on each tick from
    // task.md (see `cron_task::execute_task_directly` + `task::build_dispatch_prompt`).
    let schedule = desired;
    let interval_minutes = match &schedule {
        cron_task::CronSchedule::Every { minutes, .. } => (*minutes).max(5),
        _ => 60, // placeholder for At/Cron/Loop — scheduler ignores for these variants
    };
    let run_mode = desired_run_mode;
    let end_conditions = desired_end_conditions;

    // `single-session` run mode may reuse an explicit pre-selected session
    // (e.g. "continue the chat the user already has open"); otherwise each
    // dispatch mints a fresh Sidecar session id.
    let session_id = ta
        .preselected_session_id
        .clone()
        .filter(|s| !s.trim().is_empty() && matches!(run_mode, cron_task::RunMode::SingleSession))
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Forward Task.notification.botChannelId → CronTask.delivery so
    // scheduler tick can push the result to the configured IM bot
    // (`deliver_cron_result_to_bot` at the cron_task.rs execution loop
    // reads `task.delivery`). Prior rev hardcoded `None` here, which
    // silently broke every Task-Center recurring task that had an IM
    // channel configured — the AI would run, write output, and nothing
    // would ever reach the bot.
    //
    // `platform = "task-center"` is a diagnostic-only marker; routing is
    // by `bot_id` through ManagedAgents / ManagedImBots, not platform.
    // `chat_id = "_auto_"` when `bot_thread` is unset — matches the
    // legacy TaskCreateModal convention (`useDeliveryChannels.tsx` uses
    // the same sentinel) so the bot router picks its default target.
    let delivery = ta
        .notification
        .as_ref()
        .and_then(|n| n.bot_channel_id.as_deref())
        .filter(|s| !s.is_empty())
        .map(|bot_id| cron_task::CronDelivery {
            bot_id: bot_id.to_string(),
            chat_id: ta
                .notification
                .as_ref()
                .and_then(|n| n.bot_thread.as_deref())
                .filter(|s| !s.is_empty())
                .unwrap_or("_auto_")
                .to_string(),
            platform: "task-center".to_string(),
        });

    let config = cron_task::CronTaskConfig {
        workspace_path: ta.workspace_path.clone(),
        session_id,
        prompt: format!("(dynamic — built from ~/.myagents/tasks/{}/task.md at dispatch)", ta.id),
        interval_minutes,
        end_conditions,
        run_mode,
        notify_enabled: ta.notification.as_ref().map(|n| n.desktop).unwrap_or(true),
        tab_id: None,
        permission_mode: desired_permission_mode,
        model: desired_model,
        provider_env: None,
        // PRD 0.2.9 — Task Center dispatch threads the Task's per-task
        // `provider_id` through to the linked CronTask. Sidecar live-resolves
        // env on every tick, so credential rotation propagates without a
        // re-save. `None` keeps FollowAgent (snapshot tracking).
        provider_id: ta.provider_id.clone(),
        // PRD #119 — intent is now subordinate to provider_id; sidecar
        // ignores intent when provider_id is set. We still emit `FollowAgent`
        // as the intent for the `provider_id == None` path so legacy crons
        // (without provider_id) keep their pre-0.2.9 semantics.
        provider_intent: ProviderIntent::FollowAgent,
        runtime: ta.runtime.clone(),
        runtime_config: ta.runtime_config.clone(),
        // PRD 0.2.4 §需求 4 — per-task MCP override flows through here so
        // the dispatch payload (built in cron_task.rs::execute_task_directly)
        // carries the override to /cron/execute-sync, which applies it via
        // setMcpServers before delivering the prompt.
        mcp_enabled_servers: ta.mcp_enabled_servers.clone(),
        source_bot_id: None,
        delivery,
        schedule: Some(schedule),
        name: Some(ta.name.clone()),
        task_id: Some(ta.id.clone()),
    };

    let created = manager
        .create_task(config)
        .await
        .map_err(|e| format!("create_task: {}", e))?;
    manager
        .start_task(&created.id)
        .await
        .map_err(|e| format!("start_task: {}", e))?;
    manager
        .start_task_scheduler(&created.id)
        .await
        .map_err(|e| format!("start_task_scheduler: {}", e))?;
    Ok(created.id)
}

/// Translate a Task's scheduling intent into the underlying `CronSchedule`.
///
/// Reads the v0.1.69 scheduling-detail fields in priority order:
///   * `Scheduled`  → explicit `dispatch_at`; falls back to legacy
///     `endConditions.deadline` for rows migrated before the split. Returns
///     `None` when neither is set — callers surface that as a user-visible
///     validation error instead of silently coining a "now + 1 minute"
///     schedule that varies per call and would thrash
///     `schedules_equivalent` into a rebuild-and-lose-executionCount loop.
///   * `Recurring`  → `cron_expression` (advanced mode) wins over
///     `interval_minutes` (simple mode); defaults to every 60 minutes.
///   * `Loop`       → `CronSchedule::Loop` (no knobs).
///   * `Once`       → fire in 2 s to survive clock jitter, then stop. Still
///     non-deterministic per call, but safe because Once tasks only invoke
///     this path at dispatch time (not via projection), so there's no
///     rebuild loop.
///
/// Exposed to `task::TaskStore::update` so it can project an updated Task
/// back into the linked CronTask without duplicating the mapping logic.
pub(crate) fn schedule_from_task(ta: &task::Task) -> Option<cron_task::CronSchedule> {
    match ta.execution_mode {
        task::TaskExecutionMode::Once => {
            let when = chrono::Utc::now() + chrono::Duration::seconds(2);
            Some(cron_task::CronSchedule::At {
                at: when.to_rfc3339(),
            })
        }
        task::TaskExecutionMode::Scheduled => ta
            .dispatch_at
            .or_else(|| ta.end_conditions.as_ref().and_then(|ec| ec.deadline))
            .and_then(|ms| chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms))
            .map(|when| cron_task::CronSchedule::At {
                at: when.to_rfc3339(),
            }),
        task::TaskExecutionMode::Recurring => Some(
            if let Some(expr) = ta
                .cron_expression
                .as_ref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
            {
                cron_task::CronSchedule::Cron {
                    expr,
                    tz: ta
                        .cron_timezone
                        .as_ref()
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty()),
                }
            } else {
                cron_task::CronSchedule::Every {
                    minutes: ta.interval_minutes.unwrap_or(60).max(5),
                    start_at: None,
                }
            },
        ),
        task::TaskExecutionMode::Loop => Some(cron_task::CronSchedule::Loop),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskIdApiRequest {
    id: String,
}

/// Derive the cron RunMode from a Task, honoring the PRD §9.2 default matrix
/// (loop → single-session, recurring/others → new-session) unless the user
/// explicitly set `runMode`.
fn resolve_run_mode(ta: &task::Task) -> cron_task::RunMode {
    match ta.run_mode {
        Some(task::TaskRunMode::NewSession) => cron_task::RunMode::NewSession,
        Some(task::TaskRunMode::SingleSession) => cron_task::RunMode::SingleSession,
        None => {
            if matches!(ta.execution_mode, task::TaskExecutionMode::Loop) {
                cron_task::RunMode::SingleSession
            } else {
                cron_task::RunMode::NewSession
            }
        }
    }
}

/// Compare two `CronSchedule`s for equivalence. `At` variants compare the
/// stored RFC3339 string exactly (we never re-compute `At` timestamps, so an
/// identical string means the schedule hasn't drifted). Returns `false` if
/// the stored schedule is `None` and the desired one is any concrete variant.
fn schedules_equivalent(
    a: &Option<cron_task::CronSchedule>,
    b: &cron_task::CronSchedule,
) -> bool {
    let Some(a) = a else { return false };
    use cron_task::CronSchedule::*;
    match (a, b) {
        (At { at: x }, At { at: y }) => x == y,
        (
            Every {
                minutes: m1,
                start_at: s1,
            },
            Every {
                minutes: m2,
                start_at: s2,
            },
        ) => m1 == m2 && s1 == s2,
        (Cron { expr: e1, tz: t1 }, Cron { expr: e2, tz: t2 }) => e1 == e2 && t1 == t2,
        (Loop, Loop) => true,
        _ => false,
    }
}

// ============================================================================
// IM Mirror — fan out desktop-driven session activity to a bound IM channel
// (PRD 0.2.14 Phase C).
//
// Sidecar calls this AFTER persisting a desktop user message and AFTER each
// AI text block completes. Rust looks up which IM channel currently binds
// `sessionId` (via `peer_sessions[*].session_id == sessionId`) and forwards
// the text (with `👤 桌面端用户消息` prefix for `role: user`, plain for
// `role: assistant`) plus any inline images.
//
// Tool calls / canUseTool / partial chunks are NOT mirrored (the Sidecar
// caller filters those out — see `agent-session.ts::mirrorIfChannelBound`).
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MirrorRequest {
    session_id: String,
    /// "user" | "assistant"
    role: String,
    text: Option<String>,
    /// Optional inline images (base64 PNG/JPG). Sent after the text body.
    /// Each entry: { mimeType: "image/png" | "image/jpeg", dataBase64 }.
    images: Option<Vec<MirrorImage>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MirrorImage {
    mime_type: String,
    data_base64: String,
}

const DESKTOP_USER_PREFIX: &str = "[From: 桌面端用户消息]";
const MIRROR_IMAGE_MAX_BYTES: usize = 5 * 1024 * 1024;

/// Find the channel currently bound to `session_id`. Scans agent channels'
/// `peer_sessions`. Returns `(adapter, chat_id, channel_id)` of the first
/// match — by invariant only one channel binds a given session_id at a time.
async fn find_channel_for_session(
    session_id: &str,
) -> Option<(std::sync::Arc<im::AnyAdapter>, String, String)> {
    let agents = get_agents()?;
    let agents_guard = agents.lock().await;
    for agent in agents_guard.values() {
        for (channel_id, ch) in &agent.channels {
            let router = ch.bot_instance.router.lock().await;
            for ps in router.peer_sessions_iter() {
                if ps.session_id == session_id {
                    return Some((
                        std::sync::Arc::clone(&ch.bot_instance.adapter),
                        ps.source_id.clone(),
                        channel_id.clone(),
                    ));
                }
            }
        }
    }
    None
}

async fn mirror_to_channel_handler(
    Json(req): Json<MirrorRequest>,
) -> Json<serde_json::Value> {
    let resolved = match find_channel_for_session(&req.session_id).await {
        Some(t) => t,
        None => {
            // Session has no channel binding — silent no-op (this is the
            // common case for pure-desktop sessions; we don't want noisy logs).
            return Json(serde_json::json!({ "mirrored": false }));
        }
    };
    let (adapter, chat_id, channel_id) = resolved;

    // ----- Body text (with prefix for user role) -----
    //
    // PRD 0.2.14 — visual parity with native IM AI replies:
    //   * assistant role → `push_text_preferring_stream`. Adapters whose
    //     channels have a streaming protocol (Bridge plugins with
    //     `streaming: true` like OpenClaw Lark CardKit, Dingtalk AI Card)
    //     deliver the mirror via `start_stream → finalize_stream`, landing
    //     on the SAME visual surface as a live AI reply (CardKit /
    //     interactive card on Feishu via Bridge, AI Card on Dingtalk).
    //     Adapters that don't support streaming fall through to
    //     `send_message` (post-type bubble on native Feishu, plain text on
    //     Telegram). This is the helper documented at adapter.rs:244-289
    //     specifically for "out-of-band pushes that should match live
    //     reply style."
    //   * user role → plain `send_message`. The user-mirror has a `[From: …]`
    //     prefix and is conceptually a "system note about an external user
    //     event" — landing as a plain bubble is the desired visual
    //     (confirmed by dogfood: the user said the user-mirror bubble was
    //     correct, only the assistant-mirror needed CardKit treatment).
    let body = req.text.unwrap_or_default();
    let mut text_failed = false;
    let mut sent_text = false;
    if !body.is_empty() {
        let result = match req.role.as_str() {
            "user" => {
                let payload = format!("{}\n{}", DESKTOP_USER_PREFIX, body);
                adapter.send_message(&chat_id, &payload).await
            }
            _ => {
                im::adapter::push_text_preferring_stream(adapter.as_ref(), &chat_id, &body).await
            }
        };
        match result {
            Ok(_) => sent_text = true,
            Err(e) => {
                ulog_warn!(
                    "[mirror] send_message failed channel={} session={}: {}",
                    channel_id,
                    &req.session_id[..8.min(req.session_id.len())],
                    e
                );
                text_failed = true;
            }
        }
    }

    // ----- Optional images (PNG/JPG only, 5MB cap each) -----
    //
    // Pre-decode size guard (review-by-codex M2): a 50MB base64 string
    // decodes to ~37.5MB binary which is rejected by `MIRROR_IMAGE_MAX_BYTES`
    // — but only AFTER we've already done the expensive `base64::decode`
    // allocation. Cap on the *encoded* length first so an attacker can't
    // amplify ~7x memory before being rejected.
    //
    // Formula: padded base64 inflates to `4 * ceil(bytes / 3)` chars.
    // MUST stay byte-for-byte equivalent to the Node-side
    // `MIRROR_IMAGE_MAX_BASE64_CHARS` in agent-session.ts:toMirrorImages
    // — otherwise the boundary 5 MiB image is accepted on one side and
    // rejected on the other (review-by-codex F4).
    const MIRROR_IMAGE_MAX_BASE64_LEN: usize =
        ((MIRROR_IMAGE_MAX_BYTES + 2) / 3) * 4 + 64;

    let mut sent_images = 0usize;
    let mut skipped_images = 0usize;
    if let Some(images) = req.images {
        // Capture total before consuming — needed so the break-on-error
        // path below can attribute the remaining unprocessed images to
        // `skipped_images` (review-by-codex F5). Without this, an early
        // break leaves the response's `imagesSkipped` undercounting and
        // hides "we silently dropped half the upload" from observability.
        let total_images = images.len();
        for (idx, img) in images.into_iter().enumerate() {
            // Whitelist MIME — the spec said PNG/JPG only.
            let (ext, ok_mime) = match img.mime_type.as_str() {
                "image/png" => ("png", true),
                "image/jpeg" | "image/jpg" => ("jpg", true),
                _ => ("bin", false),
            };
            if !ok_mime {
                skipped_images += 1;
                continue;
            }
            // Cheap encoded-size check BEFORE the decode allocation.
            if img.data_base64.len() > MIRROR_IMAGE_MAX_BASE64_LEN {
                ulog_debug!(
                    "[mirror] skip oversize image[{}] base64Len={}",
                    idx,
                    img.data_base64.len()
                );
                skipped_images += 1;
                continue;
            }
            let bytes = match base64_decode(&img.data_base64) {
                Some(b) => b,
                None => {
                    skipped_images += 1;
                    continue;
                }
            };
            if bytes.len() > MIRROR_IMAGE_MAX_BYTES {
                skipped_images += 1;
                continue;
            }
            let filename = format!("desktop-mirror-{}.{}", idx, ext);
            // Caption only on first image when paired with user text — keeps
            // the prefix visible alongside the visual.
            let caption = if req.role == "user" && !sent_text && idx == 0 {
                Some(DESKTOP_USER_PREFIX.to_string())
            } else {
                None
            };
            match adapter
                .send_photo(&chat_id, bytes, &filename, caption.as_deref())
                .await
            {
                Ok(_) => sent_images += 1,
                Err(e) => {
                    let remaining = total_images.saturating_sub(idx + 1);
                    ulog_warn!(
                        "[mirror] send_photo[{}] failed channel={}: {} — aborting, attributing {} remaining as skipped",
                        idx,
                        channel_id,
                        e,
                        remaining,
                    );
                    skipped_images += 1 + remaining;
                    // Break-on-transport-error (review-by-codex M4):
                    // adapter.send_photo failures are dominated by transport-
                    // class problems (network drop, expired auth, rate limit).
                    // Continuing the loop hammers the same dead leg N more
                    // times; better to surface what we sent and let the caller
                    // (or user) retry. Format-class errors are already
                    // filtered upstream by MIME whitelist + size cap, so
                    // here the failure is almost always transport. Remaining
                    // images counted into `skipped_images` so the response's
                    // `imagesSkipped` field stays observability-accurate.
                    break;
                }
            }
        }
    }

    Json(serde_json::json!({
        "mirrored": sent_text || sent_images > 0,
        "textSent": sent_text,
        "textFailed": text_failed,
        "imagesSent": sent_images,
        "imagesSkipped": skipped_images,
    }))
}

/// Standalone base64 decoder — keeps mirror handler dependency-free of any
/// crate not already pulled in by management_api.
fn base64_decode(s: &str) -> Option<Vec<u8>> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.decode(s.trim()).ok()
}

// ========================================================================
// Session Inbox handlers (PRD 0.2.18)
// ========================================================================

/// Request body for `POST /api/inbox/deliver`. Wraps a `PendingInboxMessage`
/// plus optional `resume_workspace_path` for dead-session resume.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InboxDeliverRequest {
    message: crate::inbox::PendingInboxMessage,
    /// Optional workspace path (absolute) — when provided AND target session
    /// has no live sidecar, the target sidecar will be spawned with
    /// `resumeSessionId=<target_session_id>`. Caller sidecar (Node) reads
    /// this from its own SessionStore before invoking the management API.
    #[serde(default)]
    resume_workspace_path: Option<String>,
}

/// `POST /api/inbox/deliver` — sidecar-callable entry point for session inbox.
///
/// Invoked by:
///   - Caller sidecar's admin handler (POST /api/session/inbox) for request delivery
///   - Target sidecar's turn-end hook for reply pushback
///
/// Body: `{ message: PendingInboxMessage, resume_workspace_path?: string }`
async fn inbox_deliver_handler(
    Json(req): Json<InboxDeliverRequest>,
) -> Json<serde_json::Value> {
    let Some(manager) = get_sidecar_state() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "sidecar manager not initialized"
        }));
    };

    let resume_path = req.resume_workspace_path.as_ref().map(std::path::PathBuf::from);

    let outcome = if resume_path.is_some() {
        let Some(app_handle) = crate::logger::get_app_handle() else {
            return Json(serde_json::json!({
                "ok": false,
                "error": "global AppHandle not initialized — cannot resume dead session"
            }));
        };
        crate::inbox::deliver::deliver_with_resume(app_handle, manager, req.message, resume_path)
            .await
    } else {
        crate::inbox::deliver::deliver_inbox_message(manager, req.message).await
    };

    Json(serde_json::json!({
        "ok": true,
        "outcome": outcome,
    }))
}
