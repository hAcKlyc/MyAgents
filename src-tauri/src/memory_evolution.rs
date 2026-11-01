use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::im::types::{HeartbeatConfig, MemoryAutoUpdateConfig};
use crate::task::{
    self, NotificationConfig, TaskCreateDirectInput, TaskEndConditions, TaskExecutionMode,
    TaskExecutor, TaskLastExecution, TaskListFilter, TaskRunMode, TaskStatus, TaskUpdateInput,
    TaskUpdateStatusInput, TransitionActor, TransitionSource, MANAGED_KIND_MEMORY_GARDENER,
    MANAGED_KIND_MEMORY_MOLT,
};

const GARDENER_INTERVAL_MINUTES: u32 = 72 * 60;
const MOLT_INTERVAL_MINUTES: u32 = 14 * 24 * 60;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureMemoryEvolutionTasksRequest {
    pub agent_id: String,
    pub workspace_id: String,
    pub workspace_path: String,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub runtime_config: Option<serde_json::Value>,
    #[serde(default)]
    pub mcp_enabled_servers: Option<Vec<String>>,
    #[serde(default)]
    pub memory_auto_update: Option<MemoryAutoUpdateConfig>,
    #[serde(default)]
    pub heartbeat: Option<HeartbeatConfig>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureMemoryEvolutionTasksResult {
    pub enabled: bool,
    pub gardener_task_id: Option<String>,
    pub molt_task_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEvolutionLastRun {
    pub executed_at: i64,
    pub success: bool,
}

#[tauri::command]
pub async fn cmd_get_memory_evolution_status(
    workspace_path: String,
) -> Result<Option<MemoryEvolutionLastRun>, String> {
    let Some(store) = task::get_task_store() else {
        return Err("task store not initialized".to_string());
    };
    let normalized_workspace = crate::cron_task::normalize_path(&workspace_path);
    let records = store
        .list(TaskListFilter {
            include_deleted: Some(false),
            include_managed: Some(true),
            ..Default::default()
        })
        .await
        .into_iter()
        .filter(|task| {
            matches!(
                task.managed_kind.as_deref(),
                Some(MANAGED_KIND_MEMORY_GARDENER | MANAGED_KIND_MEMORY_MOLT)
            ) && crate::cron_task::normalize_path(&task.workspace_path) == normalized_workspace
        })
        .filter_map(|task| task.last_execution);

    Ok(latest_run(records))
}

fn latest_run(
    records: impl IntoIterator<Item = TaskLastExecution>,
) -> Option<MemoryEvolutionLastRun> {
    records
        .into_iter()
        .max_by_key(|record| record.at)
        .map(|record| MemoryEvolutionLastRun {
            executed_at: record.at,
            success: record.success,
        })
}

fn memory_evolution_notification() -> NotificationConfig {
    NotificationConfig {
        desktop: false,
        im: Some(task::notification::NotificationTarget::Off),
        source: Some("explicit".into()),
        ..Default::default()
    }
}

struct EvoJobSpec {
    managed_kind: &'static str,
    name: &'static str,
    interval_minutes: u32,
    prompt: String,
}

#[tauri::command]
pub async fn cmd_configure_memory_evolution_tasks(
    request: ConfigureMemoryEvolutionTasksRequest,
) -> Result<ConfigureMemoryEvolutionTasksResult, String> {
    configure_memory_evolution_tasks(request).await
}

pub async fn configure_memory_evolution_tasks(
    request: ConfigureMemoryEvolutionTasksRequest,
) -> Result<ConfigureMemoryEvolutionTasksResult, String> {
    let Some(store) = task::get_task_store() else {
        return Err("task store not initialized".to_string());
    };

    if request.enabled {
        crate::workspace_files::memory_rules::ensure_memory_rule_substrate_for_workspace(
            &request.workspace_path,
        )?;
    }

    let gardener = job_spec(
        MANAGED_KIND_MEMORY_GARDENER,
        "Memory Gardener",
        GARDENER_INTERVAL_MINUTES,
        "myagents-memory-gardener",
        &request.workspace_path,
    );
    let molt = job_spec(
        MANAGED_KIND_MEMORY_MOLT,
        "Memory Molt",
        MOLT_INTERVAL_MINUTES,
        "myagents-memory-molt",
        &request.workspace_path,
    );

    if !request.enabled {
        stop_existing_job(store, &request, &gardener).await?;
        stop_existing_job(store, &request, &molt).await?;
        backfill_and_log_system_maintenance_session_markers(&request.workspace_path).await;
        return Ok(ConfigureMemoryEvolutionTasksResult {
            enabled: false,
            gardener_task_id: None,
            molt_task_id: None,
        });
    }

    let gardener_task_id = ensure_job_running(store, &request, &gardener).await?;
    let molt_task_id = ensure_job_running(store, &request, &molt).await?;
    backfill_and_log_system_maintenance_session_markers(&request.workspace_path).await;

    crate::ulog_info!(
        "[memory-evolution] ensured managed tasks for agent {}: gardener={}, molt={}",
        request.agent_id,
        gardener_task_id,
        molt_task_id
    );

    Ok(ConfigureMemoryEvolutionTasksResult {
        enabled: true,
        gardener_task_id: Some(gardener_task_id),
        molt_task_id: Some(molt_task_id),
    })
}

async fn backfill_and_log_system_maintenance_session_markers(workspace_path: &str) {
    match backfill_system_maintenance_session_markers(workspace_path).await {
        Ok(count) if count > 0 => {
            crate::ulog_info!(
                "[memory-evolution] backfilled {} system maintenance session marker(s) for {}",
                count,
                workspace_path
            );
        }
        Ok(_) => {}
        Err(error) => {
            crate::ulog_warn!(
                "[memory-evolution] failed to backfill system maintenance session markers for {}: {}",
                workspace_path,
                error
            );
        }
    }
}

fn job_spec(
    managed_kind: &'static str,
    name: &'static str,
    interval_minutes: u32,
    skill_name: &'static str,
    workspace_path: &str,
) -> EvoJobSpec {
    EvoJobSpec {
        managed_kind,
        name,
        interval_minutes,
        prompt: maintenance_prompt(skill_name, workspace_path),
    }
}

fn maintenance_prompt(skill_name: &str, workspace_path: &str) -> String {
    format!(
        "Use the {} skill to maintain long-term memory for this workspace.\n\nWorkspace: `{}`\n\nConstraints:\n- Only inspect and edit memory-related files unless the skill explicitly requires a small supporting read.\n- If this workspace is a git repository, commit only the memory-related files changed by this run.\n- Do not push.\n- First understand this workspace's existing memory architecture and follow its file roles and paths. Create missing files when necessary for the work, consistent with that architecture; different naming or layering does not require the MyAgents default file set.",
        skill_name, workspace_path
    )
}

/// The managed-task owner refreshes its persisted instructions before a timer
/// can be armed, including startup recovery before renderer reconciliation.
/// Use TaskStore under the scheduler's Task control guard:
/// schedules, execution identity, status and history remain authoritative.
pub(crate) async fn reconcile_prompt_before_start(
    store: &task::TaskStore,
    existing: &task::Task,
    control: &crate::task_scheduler::TaskControlGuard,
) -> Result<(), String> {
    let skill_name = match existing.managed_kind.as_deref() {
        Some(MANAGED_KIND_MEMORY_GARDENER) => "myagents-memory-gardener",
        Some(MANAGED_KIND_MEMORY_MOLT) => "myagents-memory-molt",
        _ => return Ok(()),
    };
    let prompt = maintenance_prompt(skill_name, &existing.workspace_path);
    store
        .sync_managed_prompt_before_start(&existing.id, &prompt, control)
        .await
}

// Reconcile owns a complete target, unlike TaskUpdateInput's partial PATCH.
// Some({}) explicitly replaces stale runtime config; None runtime clears both.
fn desired_runtime_config(request: &ConfigureMemoryEvolutionTasksRequest) -> Option<Value> {
    request.runtime.as_ref().map(|_| {
        request
            .runtime_config
            .clone()
            .unwrap_or_else(|| serde_json::json!({}))
    })
}

async fn ensure_job_running(
    store: &std::sync::Arc<task::TaskStore>,
    request: &ConfigureMemoryEvolutionTasksRequest,
    spec: &EvoJobSpec,
) -> Result<String, String> {
    let task = match find_existing_job(store, request, spec).await {
        Some(task) => reconcile_existing_job(store, request, spec, task).await?,
        None => {
            store
                .create_system_managed_direct(TaskCreateDirectInput {
                    name: spec.name.to_string(),
                    executor: TaskExecutor::Agent,
                    description: Some(
                        "System-managed long-term memory evolution task.".to_string(),
                    ),
                    workspace_id: request.workspace_id.clone(),
                    workspace_path: request.workspace_path.clone(),
                    task_md_content: spec.prompt.clone(),
                    execution_mode: TaskExecutionMode::Recurring,
                    run_mode: Some(TaskRunMode::NewSession),
                    end_conditions: Some(TaskEndConditions::default()),
                    interval_minutes: Some(spec.interval_minutes),
                    cron_expression: None,
                    cron_timezone: None,
                    start_at: Some(first_start_at(
                        spec.interval_minutes,
                        request.memory_auto_update.as_ref(),
                        request.heartbeat.as_ref(),
                    )),
                    recurring_window: Some(recurring_window(
                        request.memory_auto_update.as_ref(),
                        request.heartbeat.as_ref(),
                    )),
                    trigger: None,
                    dispatch_at: None,
                    model: None,
                    provider_id: None,
                    permission_mode: None,
                    preselected_session_id: None,
                    runtime: request.runtime.clone(),
                    runtime_config: desired_runtime_config(request),
                    mcp_enabled_servers: request.mcp_enabled_servers.clone(),
                    managed_kind: Some(spec.managed_kind.to_string()),
                    source_record_id: None,
                    tags: vec![
                        "system".to_string(),
                        "memory".to_string(),
                        "evo".to_string(),
                    ],
                    notification: Some(memory_evolution_notification()),
                })
                .await?
        }
    };

    arm_task_for_scheduler(store, task).await
}

async fn stop_existing_job(
    store: &std::sync::Arc<task::TaskStore>,
    request: &ConfigureMemoryEvolutionTasksRequest,
    spec: &EvoJobSpec,
) -> Result<(), String> {
    let Some(task) = find_existing_job(store, request, spec).await else {
        return Ok(());
    };
    stop_job_for_update(store, &task, "memory evolution disabled").await
}

async fn stop_job_for_update(
    store: &std::sync::Arc<task::TaskStore>,
    task: &task::Task,
    reason: &str,
) -> Result<(), String> {
    let control = crate::task_scheduler::acquire_task_control(&task.id).await;
    stop_job_with_control(store, task, reason, &control).await
}

async fn stop_job_with_control(
    store: &std::sync::Arc<task::TaskStore>,
    task: &task::Task,
    reason: &str,
    control: &crate::task_scheduler::TaskControlGuard,
) -> Result<(), String> {
    if matches!(task.status, TaskStatus::Running | TaskStatus::Verifying) {
        store
            .update_status_with_task_control_held(
                TaskUpdateStatusInput {
                    id: task.id.clone(),
                    status: TaskStatus::Stopped,
                    message: Some(reason.to_string()),
                    actor: TransitionActor::System,
                    source: Some(TransitionSource::Scheduler),
                },
                control,
            )
            .await?;
    } else if crate::task_scheduler::get_task_scheduler()
        .is_executing(&task.id)
        .await
    {
        crate::task_scheduler::get_task_scheduler()
            .stop_with_control_held(&task.id, control)
            .await?;
    }
    Ok(())
}

async fn reconcile_existing_job(
    store: &std::sync::Arc<task::TaskStore>,
    request: &ConfigureMemoryEvolutionTasksRequest,
    spec: &EvoJobSpec,
    existing: task::Task,
) -> Result<task::Task, String> {
    let control = crate::task_scheduler::acquire_task_control(&existing.id).await;
    let existing = store
        .get(&existing.id)
        .await
        .ok_or_else(|| "memory evolution task disappeared during reconcile".to_string())?;
    let desired_window = recurring_window(
        request.memory_auto_update.as_ref(),
        request.heartbeat.as_ref(),
    );
    let existing_window_matches = existing.recurring_window.as_ref() == Some(&desired_window);
    let existing_start_at = existing
        .start_at
        .as_deref()
        .filter(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
        .map(|s| s.trim().to_string());
    let start_at = if existing_window_matches {
        existing_start_at.unwrap_or_else(|| {
            first_start_at(
                spec.interval_minutes,
                request.memory_auto_update.as_ref(),
                request.heartbeat.as_ref(),
            )
        })
    } else {
        first_start_at(
            spec.interval_minutes,
            request.memory_auto_update.as_ref(),
            request.heartbeat.as_ref(),
        )
    };
    let desired_description = "System-managed long-term memory evolution task.";
    let desired_tags = vec![
        "system".to_string(),
        "memory".to_string(),
        "evo".to_string(),
    ];
    let desired_notification = memory_evolution_notification();
    let current_prompt = task::task_docs_dir(&existing.id)
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("task.md")).ok());

    let runtime_drift = existing.runtime != request.runtime
        || existing.runtime_config != desired_runtime_config(request);
    let mcp_drift = existing.mcp_enabled_servers != request.mcp_enabled_servers;
    let drifted = existing.name != spec.name
        || existing.description.as_deref() != Some(desired_description)
        || existing.execution_mode != TaskExecutionMode::Recurring
        || existing.run_mode != Some(TaskRunMode::NewSession)
        || existing.end_conditions != Some(TaskEndConditions::default())
        || existing.interval_minutes != Some(spec.interval_minutes)
        || existing.cron_expression.is_some()
        || existing.cron_timezone.is_some()
        || existing.start_at.as_deref() != Some(start_at.as_str())
        || existing.recurring_window.as_ref() != Some(&desired_window)
        || existing.dispatch_at.is_some()
        || existing.model.is_some()
        || existing.provider_id.is_some()
        || existing.permission_mode.is_some()
        || existing.preselected_session_id.is_some()
        || runtime_drift
        || mcp_drift
        || existing.tags != desired_tags
        || existing.notification.as_ref() != Some(&desired_notification)
        || current_prompt.as_deref() != Some(spec.prompt.as_str());

    if !drifted {
        return Ok(existing);
    }

    let update = TaskUpdateInput {
        id: existing.id.clone(),
        name: Some(spec.name.to_string()),
        executor: None,
        description: Some(desired_description.to_string()),
        workspace_id: None,
        workspace_path: None,
        execution_mode: Some(TaskExecutionMode::Recurring),
        run_mode: Some(TaskRunMode::NewSession),
        end_conditions: Some(TaskEndConditions::default()),
        interval_minutes: Some(spec.interval_minutes),
        cron_expression: Some(String::new()),
        cron_timezone: Some(String::new()),
        start_at: Some(start_at),
        recurring_window: Some(desired_window),
        dispatch_at: None,
        trigger: None,
        clear_trigger: true,
        model: None,
        provider_id: None,
        clear_provider_override: true,
        permission_mode: Some(String::new()),
        preselected_session_id: Some(String::new()),
        runtime: request.runtime.clone(),
        runtime_config: desired_runtime_config(request),
        clear_runtime_override: request.runtime.is_none(),
        mcp_enabled_servers: request.mcp_enabled_servers.clone(),
        clear_mcp_override: request.mcp_enabled_servers.is_none(),
        tags: Some(desired_tags),
        notification: Some(desired_notification),
        notification_patch: None,
        prompt: Some(spec.prompt.clone()),
    };
    task::validate_task_update_execution_routing(&existing, &update)?;
    if matches!(existing.status, TaskStatus::Running | TaskStatus::Verifying) {
        stop_job_with_control(
            store,
            &existing,
            "memory evolution settings changed; re-arming",
            &control,
        )
        .await?;
    }
    store.update_with_task_control_held(update, &control).await
}

async fn backfill_system_maintenance_session_markers(
    workspace_path: &str,
) -> Result<usize, String> {
    let Some(store) = task::get_task_store() else {
        return Ok(0);
    };
    let managed_by_cron_id: HashMap<String, String> = store
        .list(task::TaskListFilter {
            include_managed: Some(true),
            ..Default::default()
        })
        .await
        .into_iter()
        .filter(|task| {
            crate::workspace_path::normalize_workspace_path_identity(&task.workspace_path)
                == crate::workspace_path::normalize_workspace_path_identity(workspace_path)
        })
        .filter_map(|task| {
            let kind = match task.managed_kind.as_deref() {
                Some(task::MANAGED_KIND_MEMORY_GARDENER) => task::MANAGED_KIND_MEMORY_GARDENER,
                Some(task::MANAGED_KIND_MEMORY_MOLT) => task::MANAGED_KIND_MEMORY_MOLT,
                _ => return None,
            };
            Some((task.id, kind.to_string()))
        })
        .collect();
    if managed_by_cron_id.is_empty() {
        return Ok(0);
    }

    let myagents_dir = crate::app_dirs::myagents_data_dir()
        .ok_or_else(|| "无法定位 MyAgents 数据目录".to_string())?;
    let sessions_path = myagents_dir.join("sessions.json");
    let tmp_path = myagents_dir.join("sessions.json.tmp");
    let lock_path = myagents_dir.join("sessions.lock");

    let result = crate::utils::file_lock::with_file_lock(
        &lock_path,
        crate::utils::file_lock::FileLockOptions::default(),
        move || -> Result<usize, crate::utils::file_lock::FileLockError> {
            let content = match std::fs::read_to_string(&sessions_path) {
                Ok(content) => content,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(0),
                Err(err) => return Err(crate::utils::file_lock::FileLockError::Io(err)),
            };
            let mut sessions: Value = serde_json::from_str(crate::utils::bom::strip_bom(&content))
                .map_err(|err| {
                    crate::utils::file_lock::FileLockError::Io(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("parse sessions.json: {}", err),
                    ))
                })?;
            let arr = sessions.as_array_mut().ok_or_else(|| {
                crate::utils::file_lock::FileLockError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "sessions.json must contain a SessionMetadata array",
                ))
            })?;

            let mut changed = 0usize;
            for session in arr.iter_mut() {
                let Some(cron_id) = session.get("cronTaskId").and_then(Value::as_str) else {
                    continue;
                };
                let Some(kind) = managed_by_cron_id.get(cron_id) else {
                    continue;
                };
                let Some(obj) = session.as_object_mut() else {
                    continue;
                };
                if obj.get("systemMaintenanceKind").and_then(Value::as_str) == Some(kind.as_str()) {
                    continue;
                }
                obj.insert(
                    "systemMaintenanceKind".to_string(),
                    Value::String(kind.clone()),
                );
                changed += 1;
            }

            if changed == 0 {
                return Ok(0);
            }

            let new_content = serde_json::to_string_pretty(&sessions).map_err(|err| {
                crate::utils::file_lock::FileLockError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("serialize sessions.json: {}", err),
                ))
            })?;
            std::fs::write(&tmp_path, new_content)
                .map_err(crate::utils::file_lock::FileLockError::Io)?;
            std::fs::rename(&tmp_path, &sessions_path)
                .map_err(crate::utils::file_lock::FileLockError::Io)?;
            Ok(changed)
        },
    )
    .await;

    result.map_err(|err| format!("sessions metadata lock/write failed: {}", err))
}

async fn arm_task_for_scheduler(
    store: &std::sync::Arc<task::TaskStore>,
    task: task::Task,
) -> Result<String, String> {
    if task.status == TaskStatus::Running {
        crate::task_scheduler::get_task_scheduler()
            .start(&task.id)
            .await?;
        return Ok(task.id);
    }

    let current = store
        .get(&task.id)
        .await
        .ok_or_else(|| format!("task {} disappeared while arming", task.id))?;

    if current.status != TaskStatus::Todo {
        store
            .update_status(TaskUpdateStatusInput {
                id: current.id.clone(),
                status: TaskStatus::Todo,
                message: Some("memory evolution enabled".to_string()),
                actor: TransitionActor::System,
                source: Some(TransitionSource::Scheduler),
            })
            .await?;
    }

    let result = crate::task_application::TaskApplication::from_globals()
        .map_err(|error| error.to_string())?
        .run(&task.id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(result.task.id)
}

fn first_start_at(
    interval_minutes: u32,
    memory_auto_update: Option<&MemoryAutoUpdateConfig>,
    heartbeat: Option<&HeartbeatConfig>,
) -> String {
    let base = chrono::Utc::now() + chrono::Duration::minutes(interval_minutes.max(5) as i64);
    align_to_memory_update_window(base, memory_auto_update, heartbeat).to_rfc3339()
}

fn recurring_window(
    memory_auto_update: Option<&MemoryAutoUpdateConfig>,
    heartbeat: Option<&HeartbeatConfig>,
) -> crate::cron_task::RecurringWindow {
    let default_memory_auto_update;
    let memory_auto_update = match memory_auto_update {
        Some(config) => config,
        None => {
            default_memory_auto_update = MemoryAutoUpdateConfig::default();
            &default_memory_auto_update
        }
    };
    let timezone = memory_auto_update
        .update_window_timezone
        .as_deref()
        .or_else(|| {
            heartbeat
                .and_then(|config| config.active_hours.as_ref())
                .map(|hours| hours.timezone.as_str())
        })
        .unwrap_or("Asia/Shanghai")
        .to_string();

    crate::cron_task::RecurringWindow {
        timezone,
        start: memory_auto_update.update_window_start.clone(),
        end: memory_auto_update.update_window_end.clone(),
    }
}

fn align_to_memory_update_window(
    base: chrono::DateTime<chrono::Utc>,
    memory_auto_update: Option<&MemoryAutoUpdateConfig>,
    heartbeat: Option<&HeartbeatConfig>,
) -> chrono::DateTime<chrono::Utc> {
    use chrono::{TimeZone, Timelike};

    let default_memory_auto_update;
    let memory_auto_update = match memory_auto_update {
        Some(config) => config,
        None => {
            default_memory_auto_update = MemoryAutoUpdateConfig::default();
            &default_memory_auto_update
        }
    };

    let tz_name = memory_auto_update
        .update_window_timezone
        .as_deref()
        .or_else(|| {
            heartbeat
                .and_then(|config| config.active_hours.as_ref())
                .map(|hours| hours.timezone.as_str())
        })
        .unwrap_or("Asia/Shanghai");
    let Ok(tz) = tz_name.parse::<chrono_tz::Tz>() else {
        crate::ulog_warn!(
            "[memory-evolution] invalid timezone '{}'; using unaligned first start",
            tz_name
        );
        return base;
    };

    let start = parse_hhmm(&memory_auto_update.update_window_start).unwrap_or(21 * 60);
    let end = parse_hhmm(&memory_auto_update.update_window_end).unwrap_or(9 * 60);
    let local = base.with_timezone(&tz);
    let now_minutes = local.hour() * 60 + local.minute();
    if is_in_window(now_minutes, start, end) {
        return base;
    }

    let target_date = if start <= end {
        if now_minutes < start {
            local.date_naive()
        } else {
            local
                .date_naive()
                .checked_add_days(chrono::Days::new(1))
                .unwrap_or_else(|| local.date_naive())
        }
    } else {
        // Wrapping window (for example 21:00-09:00). Reaching this branch
        // means the base time is between end and start, so today's start is
        // the next valid time.
        local.date_naive()
    };

    let hour = start / 60;
    let minute = start % 60;
    let Some(naive) = target_date.and_hms_opt(hour, minute, 0) else {
        return base;
    };
    let candidate = match tz.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) => Some(dt.with_timezone(&chrono::Utc)),
        chrono::LocalResult::Ambiguous(early, _) => Some(early.with_timezone(&chrono::Utc)),
        chrono::LocalResult::None => (1..=120).find_map(|offset| {
            let adjusted = naive + chrono::Duration::minutes(offset);
            match tz.from_local_datetime(&adjusted) {
                chrono::LocalResult::Single(dt) => Some(dt.with_timezone(&chrono::Utc)),
                chrono::LocalResult::Ambiguous(early, _) => Some(early.with_timezone(&chrono::Utc)),
                chrono::LocalResult::None => None,
            }
        }),
    };

    candidate.filter(|dt| *dt > base).unwrap_or(base)
}

fn is_in_window(minutes: u32, start: u32, end: u32) -> bool {
    if start <= end {
        minutes >= start && minutes < end
    } else {
        minutes >= start || minutes < end
    }
}

fn parse_hhmm(s: &str) -> Option<u32> {
    let (hour, minute) = s.split_once(':')?;
    let hour: u32 = hour.parse().ok()?;
    let minute: u32 = minute.parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some(hour * 60 + minute)
}

async fn find_existing_job(
    store: &std::sync::Arc<task::TaskStore>,
    request: &ConfigureMemoryEvolutionTasksRequest,
    spec: &EvoJobSpec,
) -> Option<task::Task> {
    store
        .list(TaskListFilter {
            workspace_id: None,
            status: None,
            tag: None,
            include_deleted: Some(false),
            include_managed: Some(true),
        })
        .await
        .into_iter()
        .find(|task| {
            task.managed_kind.as_deref() == Some(spec.managed_kind)
                && (task.workspace_id == request.workspace_id
                    || task.workspace_id == request.agent_id)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reconcile_replaces_legacy_execution_identity_in_place() {
        task::ensure_test_docs_root();
        for kind in [MANAGED_KIND_MEMORY_GARDENER, MANAGED_KIND_MEMORY_MOLT] {
            for runtime in [Some("builtin"), Some("codex"), Some("claude-code"), None] {
                let dir = tempfile::tempdir().unwrap();
                let id = uuid::Uuid::new_v4().to_string();
                let legacy: task::Task = serde_json::from_value(serde_json::json!({
                    "id": id, "name": "legacy", "executor": "agent",
                    "workspaceId": "workspace", "workspacePath": dir.path(),
                    "executionMode": "recurring", "runMode": "new-session",
                    "status": "stopped", "createdAt": 1, "updatedAt": 1,
                    "dispatchOrigin": "direct", "managedKind": kind,
                    "runtime": "codex", "runtimeConfig": {"source": "managed-provider"},
                    "sessionIds": ["historical-session"], "lastExecution": {
                        "at": 100, "trigger": "scheduled", "success": true, "durationMs": 10
                    }
                }))
                .unwrap();
                std::fs::write(
                    dir.path().join("tasks.jsonl"),
                    format!("{}\n", serde_json::to_string(&legacy).unwrap()),
                )
                .unwrap();
                let store = std::sync::Arc::new(task::TaskStore::new(dir.path().to_path_buf()));
                let request = ConfigureMemoryEvolutionTasksRequest {
                    agent_id: "agent".into(),
                    workspace_id: "workspace".into(),
                    workspace_path: dir.path().to_string_lossy().into_owned(),
                    runtime: runtime.map(str::to_string),
                    runtime_config: None,
                    mcp_enabled_servers: None,
                    memory_auto_update: None,
                    heartbeat: None,
                    enabled: true,
                };
                let spec = job_spec(
                    kind,
                    "Memory job",
                    4320,
                    "memory-skill",
                    &request.workspace_path,
                );
                let updated = reconcile_existing_job(&store, &request, &spec, legacy.clone())
                    .await
                    .unwrap();
                assert_eq!(updated.id, legacy.id);
                assert_eq!(updated.created_at, legacy.created_at);
                assert_eq!(updated.session_ids, legacy.session_ids);
                assert_eq!(updated.last_execution.as_ref().unwrap().at, 100);
                assert_eq!(updated.status_history.len(), legacy.status_history.len());
                assert_eq!(updated.runtime, request.runtime);
                assert_eq!(
                    updated.runtime_config,
                    runtime.map(|_| serde_json::json!({}))
                );
                let again = reconcile_existing_job(&store, &request, &spec, updated.clone())
                    .await
                    .unwrap();
                assert_eq!(
                    serde_json::to_value(&again).unwrap(),
                    serde_json::to_value(&updated).unwrap()
                );
                let persisted = task::TaskStore::new(dir.path().to_path_buf())
                    .get(&id)
                    .await
                    .unwrap();
                assert_eq!(persisted.runtime_config, updated.runtime_config);
                // Reconciliation must not bypass validation or stop/change the old job on rejection.
                let invalid = ConfigureMemoryEvolutionTasksRequest {
                    runtime: Some("builtin".into()),
                    runtime_config: Some(serde_json::json!({"source": "managed-provider"})),
                    ..request
                };
                assert!(
                    reconcile_existing_job(&store, &invalid, &spec, updated.clone())
                        .await
                        .is_err()
                );
                assert_eq!(
                    serde_json::to_value(store.get(&id).await.unwrap()).unwrap(),
                    serde_json::to_value(updated).unwrap()
                );
            }
        }
    }

    #[tokio::test]
    async fn recovered_prompts_refresh_in_place_before_admission() {
        task::ensure_test_docs_root();
        for kind in [
            Some(MANAGED_KIND_MEMORY_GARDENER),
            Some(MANAGED_KIND_MEMORY_MOLT),
            None,
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let id = uuid::Uuid::new_v4().to_string();
            let existing: task::Task = serde_json::from_value(serde_json::json!({
                "id": id, "name": "historical", "executor": "agent",
                "workspaceId": "workspace", "workspacePath": tmp.path(),
                "executionMode": "recurring", "runMode": "new-session",
                "status": "running", "createdAt": 1, "updatedAt": 2,
                "dispatchOrigin": "direct", "managedKind": kind,
                "intervalMinutes": 4320, "runtime": "codex", "sessionIds": ["past"],
                "executionCount": 7, "lastExecutedAt": 123, "lastScheduledAt": 123
            }))
            .unwrap();
            std::fs::write(
                tmp.path().join("tasks.jsonl"),
                serde_json::to_string(&existing).unwrap(),
            )
            .unwrap();
            let store = task::TaskStore::new(tmp.path().to_path_buf());
            let docs = task::task_docs_dir(&id).unwrap();
            std::fs::create_dir_all(&docs).unwrap();
            let path = docs.join("task.md");
            let old = "If required memory substrate files are missing, create them from the MyAgents defaults before continuing.";
            std::fs::write(&path, old).unwrap();
            let control = crate::task_scheduler::acquire_task_control(&id).await;
            reconcile_prompt_before_start(&store, &existing, &control)
                .await
                .unwrap();
            let current = std::fs::read_to_string(&path).unwrap();
            if let Some(kind) = kind {
                let skill = if kind == MANAGED_KIND_MEMORY_GARDENER {
                    "myagents-memory-gardener"
                } else {
                    "myagents-memory-molt"
                };
                assert_eq!(current, maintenance_prompt(skill, &existing.workspace_path));
                assert!(current.contains("Create missing files when necessary"));
                assert!(!current.contains("create them from the MyAgents defaults"));
            } else {
                assert_eq!(current, old);
                assert!(store
                    .sync_managed_prompt_before_start(&id, "replacement", &control)
                    .await
                    .is_err());
            }
            let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
            reconcile_prompt_before_start(&store, &existing, &control)
                .await
                .unwrap();
            assert_eq!(
                std::fs::metadata(&path).unwrap().modified().unwrap(),
                modified
            );
            assert_eq!(
                serde_json::to_value(store.get(&id).await.unwrap()).unwrap(),
                serde_json::to_value(&existing).unwrap()
            );
            assert_eq!(
                serde_json::to_value(
                    task::TaskStore::new(tmp.path().to_path_buf())
                        .get(&id)
                        .await
                        .unwrap()
                )
                .unwrap(),
                serde_json::to_value(&existing).unwrap()
            );
            if kind.is_some() {
                std::fs::remove_file(&path).unwrap();
                // Missing generated prompt is restored through the same owner.
                reconcile_prompt_before_start(&store, &existing, &control)
                    .await
                    .unwrap();
                assert_eq!(std::fs::read_to_string(&path).unwrap(), current);
                std::fs::remove_file(&path).unwrap();
                std::fs::create_dir(&path).unwrap();
                assert!(reconcile_prompt_before_start(&store, &existing, &control)
                    .await
                    .is_err());
            }
            std::fs::remove_dir_all(docs).unwrap();
        }
    }

    fn run(at: i64, success: bool) -> TaskLastExecution {
        TaskLastExecution {
            at,
            trigger: crate::task::TaskExecutionTrigger::Scheduled,
            success,
            duration_ms: 1,
            session_id: None,
            error: (!success).then(|| "failed".to_string()),
            notification: None,
        }
    }

    #[test]
    fn latest_memory_evolution_run_uses_the_newest_job_record() {
        assert_eq!(
            latest_run([run(100, true), run(300, false), run(200, true)]),
            Some(MemoryEvolutionLastRun {
                executed_at: 300,
                success: false,
            })
        );
    }

    #[test]
    fn memory_evolution_tasks_disable_desktop_notifications() {
        assert!(!memory_evolution_notification().desktop);
    }
}
