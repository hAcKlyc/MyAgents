use super::*;

/// Task execution payload sent to the Sidecar's compatibility transport.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronExecutePayload {
    pub task_id: String,
    /// Ordinary SessionEngine queue identity for this concrete Task turn.
    pub queue_id: String,
    pub prompt: String,
    /// Product-owned hidden maintenance marker from Task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_kind: Option<String>,
    /// Whether this dispatch owns SessionStore metadata birth. This is
    /// independent from Sidecar process birth; existing Sessions keep their
    /// own runtime/model/MCP configuration.
    #[serde(default)]
    pub initialize_session: bool,
    /// Session ID whose Task owner prevents Sidecar release during execution.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_can_exit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// PRD 0.2.9: per-task provider id. When set, sidecar live-resolves the
    /// provider env while creating the Task execution Session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_config: Option<serde_json::Value>,
    /// Per-task MCP enable list override. `None` = follow workspace MCP config
    /// (Agent's mcpEnabledServers). `Some([])` = explicitly no MCP.
    /// `Some([...])` = enable only these server ids for this task.
    /// Sidecar `/cron/execute-sync` applies via `setMcpServers()` before
    /// delivering the prompt so the SDK's tool list matches the override.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_enabled_servers: Option<Vec<String>>,
    /// Run mode: "single_session" (keep context) or "new_session" (fresh each time)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_mode: Option<String>,
    /// Task execution interval in minutes (for System Prompt context)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval_minutes: Option<u32>,
    /// Current execution number (1-based, for System Prompt context)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_number: Option<u32>,
    /// Schedule kind for cron reminder metadata ("at" | "every" | "cron").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule_kind: Option<String>,
    /// System-owned envelope derived from a durable command Detector
    /// activation. It is rendered as escaped untrusted data inside CRON_TASK.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activation_event: Option<crate::task_trigger::TaskActivationPayload>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalExecutePayload {
    pub goal_id: String,
    pub objective: String,
    pub session_id: String,
    pub turn_number: u32,
    pub ai_can_exit: bool,
    pub permission_mode: String,
    pub queue_id: String,
    pub expected_control_revision: u64,
}

/// Cron task execution response from Sidecar
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTurnResponse {
    pub success: bool,
    /// Runtime adapter accepted this exact Task queue id.
    #[serde(default)]
    pub turn_dispatched: bool,
    /// The exact runtime turn may still be alive. The scheduler must retain
    /// its queue identity until a later stop request confirms termination.
    #[serde(default)]
    pub termination_unconfirmed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Structured failure classification from SessionEngine. Task policy must
    /// not infer permanence from localized error text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_requested_exit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_text: Option<String>,
    /// True only when the turn originated from an Agent Channel and its
    /// output must be delivered through that channel's durable outbox.
    #[serde(default)]
    pub goal_channel_delivery_expected: bool,
    /// Internal SDK session ID where conversation data is stored
    /// (may differ from the Sidecar session key used for process management)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

pub type CronExecuteResponse = BackgroundTurnResponse;
pub type GoalExecuteResponse = BackgroundTurnResponse;

fn unconfirmed_transport_response(session_id: &str, error: String) -> BackgroundTurnResponse {
    BackgroundTurnResponse {
        success: false,
        turn_dispatched: false,
        termination_unconfirmed: true,
        error: Some(error),
        code: Some("transport_unconfirmed".to_string()),
        status: Some(503),
        ai_requested_exit: None,
        exit_reason: None,
        output_text: None,
        goal_channel_delivery_expected: false,
        session_id: Some(session_id.to_string()),
    }
}

fn runtime_source_from_runtime_config(
    runtime_config: Option<&serde_json::Value>,
) -> Option<String> {
    let source = runtime_config?.as_object()?.get("source")?.as_str()?;
    match source {
        "integrated" | "system-cli" | "managed-provider" => Some(source.to_string()),
        _ => None,
    }
}

enum BackgroundSidecarAccess {
    /// Task reservation already owns the Session metadata-birth lifecycle.
    Reserved(Arc<SessionLifecycleGuard>),
    /// Goal dispatch attached its owner and revalidated state before entering
    /// the shared transport.
    Attached(u16),
}

/// Attach the durable Goal owner before a continuation is eligible to run.
/// The caller must re-read Goal state after this returns because Sidecar boot
/// is blocking and a concurrent pause/cancel may have committed meanwhile.
pub async fn ensure_goal_sidecar_owner<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    workspace_path: &str,
    session_id: &str,
    goal_id: &str,
) -> Result<u16, String> {
    let app_handle = app_handle.clone();
    let manager = manager.clone();
    let workspace_path = workspace_path.to_string();
    let session_id = session_id.to_string();
    let owner = SidecarOwner::Goal(goal_id.to_string());
    ensure_session_sidecar_with_runtime_identity_override_lifecycle(
        app_handle,
        manager,
        session_id,
        PathBuf::from(workspace_path),
        owner,
        None,
        None,
    )
    .await
    .map(|result| result.port)
}

/// Execute a Task synchronously through the existing Sidecar transport.
pub async fn execute_cron_task<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    workspace_path: &str,
    payload: CronExecutePayload,
    session_lifecycle: Arc<SessionLifecycleGuard>,
) -> Result<CronExecuteResponse, String> {
    let session_id = payload.session_id.clone().ok_or_else(|| {
        format!(
            "[sidecar] execute_cron_task requires session_id for task {}",
            payload.task_id
        )
    })?;
    let timeout = payload
        .managed_kind
        .as_ref()
        .map(|_| Duration::from_secs(3660));
    let task_id = payload.task_id.clone();
    let owner = SidecarOwner::Task(task_id.clone());
    let runtime_override = payload
        .initialize_session
        .then(|| payload.runtime.clone())
        .flatten();
    let runtime_config = payload
        .initialize_session
        .then(|| payload.runtime_config.clone())
        .flatten();
    execute_background_turn(
        app_handle,
        manager,
        workspace_path,
        &task_id,
        &session_id,
        runtime_override,
        runtime_config,
        "/cron/execute-sync",
        payload,
        owner,
        "task_execute",
        timeout,
        BackgroundSidecarAccess::Reserved(session_lifecycle),
    )
    .await
}

/// Execute one Session-owned Goal continuation through the existing
/// SessionEngine transport. Goal ownership is independent from CronTask and
/// remains represented only by its Task owner token.
pub async fn execute_goal_turn<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    workspace_path: &str,
    port: u16,
    payload: GoalExecutePayload,
) -> Result<GoalExecuteResponse, String> {
    let goal_id = payload.goal_id.clone();
    let session_id = payload.session_id.clone();
    let owner = SidecarOwner::Goal(goal_id.clone());
    execute_background_turn(
        app_handle,
        manager,
        workspace_path,
        &goal_id,
        &session_id,
        None,
        None,
        "/goal/execute-sync",
        payload,
        owner,
        "goal_execute",
        Some(Duration::from_secs(3660)),
        BackgroundSidecarAccess::Attached(port),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn execute_background_turn<R: Runtime, P: serde::Serialize>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    workspace_path: &str,
    execution_id: &str,
    session_id: &str,
    runtime_override: Option<String>,
    runtime_config: Option<serde_json::Value>,
    endpoint: &str,
    payload: P,
    owner: SidecarOwner,
    trace_operation: &'static str,
    timeout: Option<Duration>,
    sidecar_access: BackgroundSidecarAccess,
) -> Result<BackgroundTurnResponse, String> {
    ulog_info!(
        "[sidecar] background turn {} called in workspace {}",
        execution_id,
        workspace_path
    );
    let cron_started = trace_start();
    let execution_id = execution_id.to_string();
    let session_id = session_id.to_string();
    let execution_runtime = normalize_runtime_name(runtime_override.as_deref()).to_string();

    let (port, sidecar_is_new) = match sidecar_access {
        BackgroundSidecarAccess::Attached(port) => (port, false),
        BackgroundSidecarAccess::Reserved(session_lifecycle) => {
            let runtime_source_override =
                runtime_source_from_runtime_config(runtime_config.as_ref());
            let result = ensure_session_sidecar_with_runtime_identity_override_lifecycle_held(
                session_lifecycle,
                app_handle.clone(),
                manager.clone(),
                session_id.clone(),
                PathBuf::from(workspace_path),
                owner,
                runtime_override,
                runtime_source_override,
            )
            .await
            .map_err(|e| {
                let err = format!("ensure_sidecar failed: {}", e);
                emit_perf_trace(
                    PerfTrace::new(PerfTraceName::BackgroundJob, trace_operation)
                        .duration_ms(elapsed_ms(cron_started))
                        .session_id(Some(&session_id))
                        .runtime(Some(&execution_runtime))
                        .status("error")
                        .detail("executionId", &execution_id)
                        .detail("error", &err),
                );
                err
            })
            .map_err(|e| {
                ulog_error!(
                    "[sidecar] ensure_session_sidecar failed for task {}: {}",
                    execution_id,
                    e
                );
                emit_perf_trace(
                    PerfTrace::new(PerfTraceName::BackgroundJob, trace_operation)
                        .duration_ms(elapsed_ms(cron_started))
                        .session_id(Some(&session_id))
                        .runtime(Some(&execution_runtime))
                        .status("error")
                        .detail("executionId", &execution_id)
                        .detail("error", &e),
                );
                e
            })?;
            (result.port, result.is_new)
        }
    };

    ulog_info!(
        "[sidecar] Background Sidecar ready for {} on port {} (isNew={})",
        execution_id,
        port,
        sidecar_is_new
    );
    let url = format!("http://127.0.0.1:{port}{endpoint}");

    ulog_info!(
        "[sidecar] Executing background turn {} via {}",
        execution_id,
        url
    );

    // Ordinary Tasks wait for their owner's terminal/cancel result. Goal and
    // maintenance retain the margin above their existing 60m business deadline.
    let mut builder = crate::local_http::builder()
        .connect_timeout(Duration::from_secs(30))
        .tcp_nodelay(true);
    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }
    let client = builder
        .build()
        .map_err(|e| format!("[sidecar] Failed to create HTTP client: {}", e))?;

    // Send request to Sidecar
    let response = match client.post(&url).json(&payload).send().await {
        Ok(response) => response,
        Err(error) => {
            let message = format!("[sidecar] HTTP request failed: {}", error);
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::BackgroundJob, trace_operation)
                    .duration_ms(elapsed_ms(cron_started))
                    .session_id(Some(&session_id))
                    .runtime(Some(&execution_runtime))
                    .status("error")
                    .detail("executionId", &execution_id)
                    .detail("error", &message),
            );
            if error.is_connect() {
                return Err(message);
            }
            return Ok(unconfirmed_transport_response(&session_id, message));
        }
    };

    let status = response.status();
    let body = match response.text().await {
        Ok(body) => body,
        Err(error) => {
            let message = format!("[sidecar] Failed to read response body: {}", error);
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::BackgroundJob, trace_operation)
                    .duration_ms(elapsed_ms(cron_started))
                    .session_id(Some(&session_id))
                    .runtime(Some(&execution_runtime))
                    .status("error")
                    .detail("executionId", &execution_id)
                    .detail("error", &message),
            );
            return Ok(unconfirmed_transport_response(&session_id, message));
        }
    };

    ulog_info!(
        "[sidecar] Background turn {} response: status={}, body={}",
        execution_id,
        status,
        body.chars().take(500).collect::<String>()
    );

    // Parse response
    let mut result: BackgroundTurnResponse = match serde_json::from_str(&body) {
        Ok(result) => result,
        Err(error) => {
            let message = format!(
                "[sidecar] Failed to parse response JSON: {} (body: {})",
                error, body
            );
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::BackgroundJob, trace_operation)
                    .duration_ms(elapsed_ms(cron_started))
                    .session_id(Some(&session_id))
                    .runtime(Some(&execution_runtime))
                    .status("error")
                    .detail("executionId", &execution_id)
                    .detail("statusCode", status.as_u16())
                    .detail("error", &message),
            );
            return Ok(unconfirmed_transport_response(&session_id, message));
        }
    };
    if result.status.is_none() {
        result.status = Some(status.as_u16());
    }

    ulog_info!(
        "[sidecar] Background turn {} parsed response: success={}, error={:?}, ai_requested_exit={:?}",
        execution_id,
        result.success,
        result.error,
        result.ai_requested_exit
    );
    emit_perf_trace(
        PerfTrace::new(PerfTraceName::BackgroundJob, trace_operation)
            .duration_ms(elapsed_ms(cron_started))
            .session_id(Some(&session_id))
            .runtime(Some(&execution_runtime))
            .status(if result.success { "ok" } else { "error" })
            .detail("executionId", &execution_id)
            .detail("statusCode", status.as_u16())
            .detail("isNewSidecar", sidecar_is_new)
            .detail("aiRequestedExit", result.ai_requested_exit.unwrap_or(false)),
    );

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task_payload(initialize_session: bool) -> CronExecutePayload {
        CronExecutePayload {
            task_id: "task-1".to_string(),
            queue_id: "queue-1".to_string(),
            prompt: "run".to_string(),
            managed_kind: None,
            initialize_session,
            session_id: Some("session-1".to_string()),
            ai_can_exit: Some(true),
            permission_mode: Some("fullAgency".to_string()),
            model: initialize_session.then(|| "model-1".to_string()),
            provider_id: initialize_session.then(|| "provider-1".to_string()),
            runtime: initialize_session.then(|| "codex".to_string()),
            runtime_config: initialize_session
                .then(|| serde_json::json!({ "source": "system-cli" })),
            mcp_enabled_servers: initialize_session.then(|| vec!["mcp-1".to_string()]),
            run_mode: Some("new_session".to_string()),
            interval_minutes: Some(60),
            execution_number: Some(1),
            schedule_kind: Some("every".to_string()),
            activation_event: None,
        }
    }

    #[test]
    fn metadata_creator_carries_task_initialization_fields() {
        let payload = task_payload(true);
        assert!(payload.initialize_session);
        assert_eq!(payload.model.as_deref(), Some("model-1"));
        assert_eq!(payload.provider_id.as_deref(), Some("provider-1"));
        assert_eq!(payload.runtime.as_deref(), Some("codex"));
        assert_eq!(
            payload.mcp_enabled_servers.as_deref(),
            Some(&["mcp-1".to_string()][..])
        );
    }

    #[test]
    fn metadata_adopter_carries_no_session_initialization_fields() {
        let payload = task_payload(false);
        assert!(!payload.initialize_session);
        assert!(payload.model.is_none());
        assert!(payload.provider_id.is_none());
        assert!(payload.runtime.is_none());
        assert!(payload.runtime_config.is_none());
        assert!(payload.mcp_enabled_servers.is_none());
    }

    #[test]
    fn task_sidecar_preserves_integrated_dsh_runtime_source() {
        assert_eq!(
            runtime_source_from_runtime_config(Some(&serde_json::json!({
                "source": "integrated"
            }))),
            Some("integrated".to_string())
        );
    }

    #[test]
    fn post_dispatch_transport_failure_keeps_exact_turn_stop_authority() {
        let response =
            unconfirmed_transport_response("session-1", "response connection closed".to_string());

        assert!(!response.success);
        assert!(response.termination_unconfirmed);
        assert_eq!(response.session_id.as_deref(), Some("session-1"));
        assert_eq!(
            response.error.as_deref(),
            Some("response connection closed")
        );
    }

    #[test]
    fn legacy_background_response_defaults_to_confirmed_termination() {
        let response: BackgroundTurnResponse =
            serde_json::from_str(r#"{"success":false,"error":"failed"}"#).unwrap();

        assert!(!response.termination_unconfirmed);
    }

    #[test]
    fn reserved_task_dispatch_uses_the_held_lifecycle_entrypoint() {
        let source = include_str!("cron_execute.rs");
        let reserved_branch = source
            .split("BackgroundSidecarAccess::Reserved(session_lifecycle) => {")
            .nth(1)
            .expect("reserved Task dispatch branch must exist")
            .split("ulog_info!(\n        \"[sidecar] Background Sidecar ready")
            .next()
            .expect("reserved branch must precede Sidecar readiness logging");

        assert!(reserved_branch
            .contains("ensure_session_sidecar_with_runtime_identity_override_lifecycle_held("));
        assert!(!reserved_branch
            .contains("ensure_session_sidecar_with_runtime_identity_override_lifecycle("));
    }
}
