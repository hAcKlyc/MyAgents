use super::*;
use chrono::TimeZone;
use std::sync::Arc;

/// Compatibility facade for the retired Cron product surface. The only data
/// owned here is the immutable startup snapshot of `cron_tasks.json`.
pub struct CronTaskManager {
    legacy_tasks: HashMap<String, CronTask>,
    legacy_load_error: Option<String>,
}

impl CronTaskManager {
    fn new() -> Self {
        let (legacy_tasks, legacy_load_error) = match load_legacy_tasks() {
            Ok(tasks) => (tasks, None),
            Err(error) => {
                ulog_error!(
                    "[legacy-cron] store is invalid and will remain read-only: {}",
                    error
                );
                (HashMap::new(), Some(error))
            }
        };
        Self {
            legacy_tasks,
            legacy_load_error,
        }
    }

    pub async fn get_legacy_tasks(&self) -> Vec<CronTask> {
        self.legacy_tasks.values().cloned().collect()
    }

    pub fn legacy_load_error(&self) -> Option<&str> {
        self.legacy_load_error.as_deref()
    }

    pub async fn get_legacy_task(&self, id: &str) -> Option<CronTask> {
        self.legacy_tasks.get(id).cloned()
    }

    pub async fn get_unmigrated_legacy_tasks(&self) -> Vec<CronTask> {
        let tasks: HashMap<String, crate::task::Task> = match crate::task::get_task_store() {
            Some(store) => store
                .list(crate::task::TaskListFilter {
                    include_managed: Some(true),
                    include_deleted: Some(true),
                    ..Default::default()
                })
                .await
                .into_iter()
                .map(|task| (task.id.clone(), task))
                .collect(),
            None => HashMap::new(),
        };
        self.legacy_tasks
            .values()
            .filter(|legacy| !legacy_row_has_task_authority(legacy, &tasks))
            .cloned()
            .collect()
    }

    pub async fn create_task(&self, config: CronTaskConfig) -> Result<CronTask, String> {
        let input = task_input_from_cron_config(config)?;
        let application = crate::task_application::TaskApplication::from_globals()
            .map_err(|error| error.to_string())?;
        let task = if input.managed_kind.is_some() {
            application
                .create_system_managed_direct(input)
                .await
                .map_err(|error| error.to_string())?
        } else {
            application
                .create_direct(input)
                .await
                .map_err(|error| error.to_string())?
        };
        Ok(task_to_cron(&task))
    }

    pub async fn get_task(&self, id: &str) -> Option<CronTask> {
        let task = crate::task::get_task_store()?.get(id).await?;
        (!task.deleted).then(|| task_to_cron(&task))
    }

    pub async fn get_all_tasks(&self) -> Vec<CronTask> {
        match crate::task::get_task_store() {
            Some(store) => store
                .list(crate::task::TaskListFilter {
                    include_managed: Some(true),
                    ..Default::default()
                })
                .await
                .iter()
                .map(task_to_cron)
                .collect(),
            None => Vec::new(),
        }
    }

    pub async fn get_tasks_for_workspace(&self, workspace_path: &str) -> Vec<CronTask> {
        let target = normalize_path(workspace_path);
        self.get_all_tasks()
            .await
            .into_iter()
            .filter(|task| normalize_path(&task.workspace_path) == target)
            .collect()
    }

    pub async fn get_tasks_for_bot(&self, bot_id: &str) -> Vec<CronTask> {
        self.get_all_tasks()
            .await
            .into_iter()
            .filter(|task| task.source_bot_id.as_deref() == Some(bot_id))
            .collect()
    }

    pub async fn get_active_task_for_session(&self, session_id: &str) -> Option<CronTask> {
        self.get_all_tasks().await.into_iter().find(|task| {
            task.status == TaskStatus::Running
                && (task.session_id == session_id
                    || task.internal_session_id.as_deref() == Some(session_id))
        })
    }

    pub async fn start_task(&self, id: &str) -> Result<CronTask, String> {
        self.start_task_with_origin(
            id,
            crate::task::TransitionActor::System,
            Some(crate::task::TransitionSource::Scheduler),
        )
        .await
    }

    pub async fn start_task_with_origin(
        &self,
        id: &str,
        actor: crate::task::TransitionActor,
        source: Option<crate::task::TransitionSource>,
    ) -> Result<CronTask, String> {
        let task = crate::task_application::TaskApplication::from_globals()
            .map_err(|error| error.to_string())?
            .start_scheduled_task_with_origin(id, actor, source)
            .await
            .map_err(|error| error.to_string())?;
        Ok(task_to_cron(&task))
    }

    pub async fn stop_task(&self, id: &str, reason: Option<String>) -> Result<CronTask, String> {
        self.stop_task_with_origin(
            id,
            reason,
            crate::task::TransitionActor::User,
            Some(crate::task::TransitionSource::Ui),
        )
        .await
    }

    pub async fn stop_task_with_origin(
        &self,
        id: &str,
        reason: Option<String>,
        actor: crate::task::TransitionActor,
        source: Option<crate::task::TransitionSource>,
    ) -> Result<CronTask, String> {
        let task_control = crate::task_scheduler::acquire_task_control(id).await;
        let store = task_store()?;
        let task = store
            .get(id)
            .await
            .ok_or_else(|| format!("Task not found: {id}"))?;
        if task.status != crate::task::TaskStatus::Running {
            if crate::task_scheduler::get_task_scheduler()
                .is_executing(id)
                .await
            {
                crate::task_scheduler::get_task_scheduler()
                    .stop_with_control_held(id, &task_control)
                    .await?;
            }
            if task.effective_trigger().is_command() {
                store.cancel_pending_activation(id).await?;
            }
            return Ok(task_to_cron(&task));
        }
        let task = store
            .update_status_with_task_control_held(
                crate::task::TaskUpdateStatusInput {
                    id: id.to_string(),
                    status: crate::task::TaskStatus::Stopped,
                    message: reason,
                    actor,
                    source,
                },
                &task_control,
            )
            .await?
            .0;
        Ok(task_to_cron(&task))
    }

    pub async fn delete_task(&self, id: &str) -> Result<(), String> {
        crate::task_application::TaskApplication::from_globals()
            .map_err(|error| error.to_string())?
            .delete_internal(id)
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn update_task_fields(
        &self,
        id: &str,
        patch: serde_json::Value,
    ) -> Result<CronTask, String> {
        let task_control = crate::task_scheduler::acquire_task_control(id).await;
        let store = task_store()?;
        let mut task = store
            .get(id)
            .await
            .ok_or_else(|| format!("Task not found: {id}"))?;
        // Validate the compatibility patch before changing a running task's
        // status. Invalid/empty input must be a zero-side-effect rejection,
        // not a failed update that leaves the scheduler stopped.
        let input = task_update_from_cron_patch(&task, patch)?;
        crate::task::validate_task_update_execution_routing(&task, &input)?;
        let was_running = task.status == crate::task::TaskStatus::Running;
        if was_running {
            store
                .update_status_with_task_control_held(
                    crate::task::TaskUpdateStatusInput {
                        id: id.to_string(),
                        status: crate::task::TaskStatus::Stopped,
                        message: Some("scheduled task settings changed".to_string()),
                        actor: crate::task::TransitionActor::System,
                        source: Some(crate::task::TransitionSource::Scheduler),
                    },
                    &task_control,
                )
                .await?;
        }
        task = store
            .update_with_task_control_held(input, &task_control)
            .await?;
        if was_running {
            task = store
                .update_status_with_task_control_held(
                    crate::task::TaskUpdateStatusInput {
                        id: id.to_string(),
                        status: crate::task::TaskStatus::Todo,
                        message: Some("scheduled task settings saved".to_string()),
                        actor: crate::task::TransitionActor::System,
                        source: Some(crate::task::TransitionSource::Scheduler),
                    },
                    &task_control,
                )
                .await?
                .0;
            let application = crate::task_application::TaskApplication::from_globals()
                .map_err(|error| error.to_string())?;
            let _ = application
                .run_with_control(id, &task_control)
                .await
                .map_err(|error| error.to_string())?;
            task = store.get(id).await.unwrap_or(task);
        }
        Ok(task_to_cron(&task))
    }

    pub async fn trigger_now(&self, id: &str) -> Result<TriggerNowInfo, String> {
        let session_id = crate::task_scheduler::get_task_scheduler()
            .trigger_now(id)
            .await?;
        Ok(TriggerNowInfo {
            task_id: id.to_string(),
            session_id,
            dispatched_at: Utc::now().to_rfc3339(),
        })
    }

    pub async fn is_task_executing(&self, id: &str) -> bool {
        crate::task_scheduler::get_task_scheduler()
            .is_executing(id)
            .await
    }

    pub async fn executing_snapshot(&self) -> HashSet<String> {
        crate::task_scheduler::get_task_scheduler()
            .executing_snapshot()
            .await
    }
}

fn legacy_row_has_task_authority(
    legacy: &CronTask,
    tasks: &HashMap<String, crate::task::Task>,
) -> bool {
    if let Some(task_id) = legacy.legacy_task_id.as_deref() {
        return tasks.contains_key(task_id);
    }
    tasks.get(&legacy.id).is_some_and(|task| {
        task.status_history
            .iter()
            .any(|transition| transition.source == Some(crate::task::TransitionSource::Migration))
            && normalize_path(&task.workspace_path) == normalize_path(&legacy.workspace_path)
    })
}

fn task_store() -> Result<&'static Arc<crate::task::TaskStore>, String> {
    crate::task::get_task_store().ok_or_else(|| "task store not initialized".to_string())
}

pub(super) fn task_input_from_cron_config(
    config: CronTaskConfig,
) -> Result<crate::task::TaskCreateDirectInput, String> {
    let run_mode = match config.run_mode {
        RunMode::SingleSession => crate::task::TaskRunMode::SingleSession,
        RunMode::NewSession => crate::task::TaskRunMode::NewSession,
    };
    let preselected_session_id = (run_mode == crate::task::TaskRunMode::SingleSession)
        .then(|| config.session_id.trim().to_string())
        .filter(|value| !value.is_empty());
    let (execution_mode, interval, expression, timezone, start_at, window, dispatch_at) =
        match config.schedule.as_ref() {
            Some(CronSchedule::At { at }) => {
                let dispatch_at = DateTime::parse_from_rfc3339(at)
                    .map_err(|error| format!("invalid at schedule: {error}"))?
                    .timestamp_millis();
                (
                    crate::task::TaskExecutionMode::Scheduled,
                    None,
                    None,
                    None,
                    None,
                    None,
                    Some(dispatch_at),
                )
            }
            Some(CronSchedule::Every {
                minutes,
                start_at,
                catch_up_window,
            }) => (
                crate::task::TaskExecutionMode::Recurring,
                Some(*minutes),
                None,
                None,
                start_at.clone(),
                catch_up_window.clone(),
                None,
            ),
            Some(CronSchedule::Cron { expr, tz }) => (
                crate::task::TaskExecutionMode::Recurring,
                None,
                Some(expr.clone()),
                tz.clone(),
                None,
                None,
                None,
            ),
            Some(CronSchedule::Loop) => {
                return Err("Loop scheduling is retired; create a Session Goal".to_string())
            }
            None => (
                crate::task::TaskExecutionMode::Recurring,
                Some(config.interval_minutes.max(5)),
                None,
                None,
                None,
                None,
                None,
            ),
        };

    if config.provider_env.is_some() {
        return Err(
            "Credential snapshots are retired; create the task with providerId".to_string(),
        );
    }
    let provider_id = match config.provider_intent {
        ProviderIntent::Subscription => Some("anthropic-sub".to_string()),
        ProviderIntent::Explicit => {
            return Err("Explicit provider snapshots are retired; use providerId".to_string())
        }
        ProviderIntent::FollowAgent => config.provider_id.clone(),
    };
    let workspace_id = crate::im::read_agent_configs_from_disk()
        .into_iter()
        .find(|agent| {
            normalize_path(&agent.resolved_workspace_path) == normalize_path(&config.workspace_path)
        })
        .map(|agent| agent.id)
        .unwrap_or_else(|| normalize_path(&config.workspace_path));

    Ok(crate::task::TaskCreateDirectInput {
        name: config.name.clone().unwrap_or_else(|| {
            config
                .prompt
                .lines()
                .next()
                .unwrap_or("定时任务")
                .to_string()
        }),
        executor: crate::task::TaskExecutor::Agent,
        description: None,
        workspace_id,
        workspace_path: config.workspace_path,
        task_md_content: config.prompt,
        execution_mode,
        run_mode: Some(run_mode),
        end_conditions: Some(config.end_conditions.into()),
        interval_minutes: interval,
        cron_expression: expression,
        cron_timezone: timezone,
        start_at,
        recurring_window: window,
        dispatch_at,
        trigger: None,
        model: config.model,
        provider_id,
        permission_mode: (!config.permission_mode.is_empty()).then_some(config.permission_mode),
        preselected_session_id,
        runtime: config.runtime,
        runtime_config: config.runtime_config,
        mcp_enabled_servers: config.mcp_enabled_servers,
        managed_kind: config.managed_kind,
        source_record_id: None,
        tags: config
            .source_bot_id
            .into_iter()
            .map(|id| format!("bot:{id}"))
            .collect(),
        notification: Some(crate::task::NotificationConfig {
            desktop: config.notify_enabled,
            bot_channel_id: config.delivery.as_ref().map(|value| value.bot_id.clone()),
            bot_thread: config.delivery.map(|value| value.chat_id),
            events: None,
        }),
    })
}

fn task_update_from_cron_patch(
    task: &crate::task::Task,
    patch: serde_json::Value,
) -> Result<crate::task::TaskUpdateInput, String> {
    let source = patch
        .as_object()
        .ok_or_else(|| "patch must be an object".to_string())?;
    for key in [
        "name",
        "model",
        "providerId",
        "permissionMode",
        "runtime",
        "runtimeConfig",
        "mcpEnabledServers",
        "intervalMinutes",
        "prompt",
        "endConditions",
        "schedule",
        "notifyEnabled",
        "delivery",
        "clearDelivery",
    ] {
        if source.get(key).is_some_and(serde_json::Value::is_null) {
            return Err(format!("{key} must not be null"));
        }
    }
    let mut target = serde_json::Map::new();
    target.insert("id".to_string(), serde_json::Value::String(task.id.clone()));

    for key in [
        "name",
        "model",
        "providerId",
        "permissionMode",
        "runtime",
        "runtimeConfig",
        "mcpEnabledServers",
    ] {
        if let Some(value) = source.get(key) {
            target.insert(key.to_string(), value.clone());
        }
    }
    if !source.contains_key("schedule") {
        if let Some(value) = source.get("intervalMinutes") {
            target.insert("intervalMinutes".to_string(), value.clone());
        }
    }
    if let Some(value) = source.get("prompt") {
        let prompt = value
            .as_str()
            .ok_or_else(|| "prompt must be a string".to_string())?;
        if prompt.trim().is_empty() {
            return Err("prompt is empty".to_string());
        }
        target.insert("prompt".to_string(), value.clone());
    }
    if let Some(value) = source.get("endConditions") {
        let cron: EndConditions = serde_json::from_value(value.clone())
            .map_err(|error| format!("invalid endConditions: {error}"))?;
        target.insert(
            "endConditions".to_string(),
            serde_json::to_value(crate::task::TaskEndConditions::from(cron))
                .map_err(|error| error.to_string())?,
        );
    }
    if let Some(value) = source.get("schedule") {
        let schedule: CronSchedule = serde_json::from_value(value.clone())
            .map_err(|error| format!("invalid schedule: {error}"))?;
        match schedule {
            CronSchedule::At { at } => {
                target.insert("executionMode".to_string(), serde_json::json!("scheduled"));
                let timestamp = DateTime::parse_from_rfc3339(&at)
                    .map_err(|error| format!("invalid at schedule: {error}"))?
                    .timestamp_millis();
                target.insert("dispatchAt".to_string(), serde_json::json!(timestamp));
            }
            CronSchedule::Every {
                minutes,
                start_at,
                catch_up_window,
            } => {
                target.insert("executionMode".to_string(), serde_json::json!("recurring"));
                target.insert("intervalMinutes".to_string(), serde_json::json!(minutes));
                target.insert("cronExpression".to_string(), serde_json::json!(""));
                target.insert("cronTimezone".to_string(), serde_json::json!(""));
                if let Some(value) = start_at {
                    target.insert("startAt".to_string(), serde_json::json!(value));
                }
                if let Some(value) = catch_up_window {
                    target.insert(
                        "recurringWindow".to_string(),
                        serde_json::to_value(value).map_err(|error| error.to_string())?,
                    );
                }
            }
            CronSchedule::Cron { expr, tz } => {
                target.insert("executionMode".to_string(), serde_json::json!("recurring"));
                target.insert("cronExpression".to_string(), serde_json::json!(expr));
                if let Some(value) = tz {
                    target.insert("cronTimezone".to_string(), serde_json::json!(value));
                }
            }
            CronSchedule::Loop => return Err("Loop scheduling is retired".to_string()),
        }
    }
    let notify_enabled = source
        .get("notifyEnabled")
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "notifyEnabled must be a boolean".to_string())
        })
        .transpose()?;
    let clear_delivery = source
        .get("clearDelivery")
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "clearDelivery must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    if notify_enabled.is_some() || source.contains_key("delivery") || clear_delivery {
        let desktop = notify_enabled
            .or_else(|| task.notification.as_ref().map(|value| value.desktop))
            .unwrap_or(true);
        let (bot_channel_id, bot_thread) = if clear_delivery {
            (None, None)
        } else if let Some(value) = source.get("delivery") {
            let delivery = serde_json::from_value::<CronDelivery>(value.clone())
                .map_err(|error| format!("invalid delivery: {error}"))?;
            (Some(delivery.bot_id), Some(delivery.chat_id))
        } else {
            task.notification
                .as_ref()
                .map(|notification| {
                    (
                        notification.bot_channel_id.clone(),
                        notification.bot_thread.clone(),
                    )
                })
                .unwrap_or((None, None))
        };
        target.insert(
            "notification".to_string(),
            serde_json::to_value(crate::task::NotificationConfig {
                desktop,
                bot_channel_id,
                bot_thread,
                events: None,
            })
            .map_err(|error| error.to_string())?,
        );
    }

    if target.len() == 1 {
        return Err("patch must contain at least one supported update field".to_string());
    }

    serde_json::from_value(serde_json::Value::Object(target))
        .map_err(|error| format!("invalid Task update: {error}"))
}

pub(crate) fn task_to_cron(task: &crate::task::Task) -> CronTask {
    let timestamp = |value: i64| {
        Utc.timestamp_millis_opt(value)
            .single()
            .unwrap_or_else(Utc::now)
    };
    let schedule = match task.execution_mode {
        crate::task::TaskExecutionMode::Once => None,
        crate::task::TaskExecutionMode::Scheduled => {
            task.dispatch_at.map(|value| CronSchedule::At {
                at: timestamp(value).to_rfc3339(),
            })
        }
        crate::task::TaskExecutionMode::Recurring => Some(
            if let Some(expr) = task
                .cron_expression
                .clone()
                .filter(|value| !value.trim().is_empty())
            {
                CronSchedule::Cron {
                    expr,
                    tz: task.cron_timezone.clone(),
                }
            } else {
                CronSchedule::Every {
                    minutes: task.interval_minutes.unwrap_or(60),
                    start_at: task.start_at.clone(),
                    catch_up_window: task.recurring_window.clone(),
                }
            },
        ),
        crate::task::TaskExecutionMode::Loop => Some(CronSchedule::Loop),
    };
    let run = task.last_execution.as_ref();
    let session_id = task_session_id(task);
    let prompt = crate::task::task_docs_dir(&task.id)
        .ok()
        .and_then(|dir| fs::read_to_string(dir.join("task.md")).ok())
        .unwrap_or_default();
    CronTask {
        id: task.id.clone(),
        workspace_path: task.workspace_path.clone(),
        session_id: session_id.clone(),
        prompt,
        interval_minutes: task.interval_minutes.unwrap_or(60),
        end_conditions: task.end_conditions.clone().unwrap_or_default().into(),
        run_mode: match task
            .run_mode
            .unwrap_or(crate::task::TaskRunMode::NewSession)
        {
            crate::task::TaskRunMode::SingleSession => RunMode::SingleSession,
            crate::task::TaskRunMode::NewSession => RunMode::NewSession,
        },
        status: if task.status == crate::task::TaskStatus::Running {
            TaskStatus::Running
        } else {
            TaskStatus::Stopped
        },
        execution_count: task.execution_count,
        created_at: timestamp(task.created_at),
        last_executed_at: task.last_executed_at.map(timestamp),
        notify_enabled: task
            .notification
            .as_ref()
            .map(|value| value.desktop)
            .unwrap_or(true),
        tab_id: None,
        exit_reason: task
            .status_history
            .last()
            .and_then(|transition| transition.message.clone()),
        permission_mode: task.permission_mode.clone().unwrap_or_default(),
        model: task.model.clone(),
        provider_env: None,
        provider_id: task.provider_id.clone(),
        provider_intent: if task.provider_id.as_deref() == Some("anthropic-sub") {
            ProviderIntent::Subscription
        } else {
            ProviderIntent::FollowAgent
        },
        runtime: task.runtime.clone(),
        runtime_config: task.runtime_config.clone(),
        mcp_enabled_servers: task.mcp_enabled_servers.clone(),
        managed_kind: task.managed_kind.clone(),
        last_error: run.and_then(|value| value.error.clone()),
        last_run_ok: run.map(|value| value.success),
        last_run_duration_ms: run.map(|value| value.duration_ms),
        source_bot_id: task
            .tags
            .iter()
            .find_map(|tag| tag.strip_prefix("bot:").map(str::to_string)),
        delivery: task.notification.as_ref().and_then(|notification| {
            notification
                .bot_channel_id
                .as_ref()
                .map(|bot_id| CronDelivery {
                    bot_id: bot_id.clone(),
                    chat_id: notification
                        .bot_thread
                        .clone()
                        .unwrap_or_else(|| "_auto_".to_string()),
                    platform: "task-center".to_string(),
                })
        }),
        schedule,
        name: Some(task.name.clone()),
        next_execution_at: crate::task_scheduler::next_execution_at(task)
            .ok()
            .flatten()
            .map(|value| value.to_rfc3339()),
        internal_session_id: (!session_id.is_empty()).then_some(session_id),
        updated_at: timestamp(task.updated_at),
        legacy_task_id: None,
    }
}

fn task_session_id(task: &crate::task::Task) -> String {
    let latest = || task.session_ids.last().cloned();
    match task
        .run_mode
        .unwrap_or(crate::task::TaskRunMode::NewSession)
    {
        crate::task::TaskRunMode::SingleSession => task
            .preselected_session_id
            .clone()
            .or_else(latest)
            .unwrap_or_default(),
        crate::task::TaskRunMode::NewSession => latest()
            .or_else(|| task.preselected_session_id.clone())
            .unwrap_or_default(),
    }
}

fn load_legacy_tasks() -> Result<HashMap<String, CronTask>, String> {
    let path = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(crate::app_dirs::APP_DATA_DIR_NAME)
        .join("cron_tasks.json");
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(format!("read {}: {}", path.display(), error)),
    };
    let value = serde_json::from_str::<serde_json::Value>(strip_bom(&content))
        .map_err(|error| format!("parse {}: {}", path.display(), error))?;
    let rows = value
        .get("tasks")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| format!("{} has no tasks array", path.display()))?;
    let mut tasks = HashMap::new();
    for row in rows {
        if row.get("goalStatus").is_some() || row.get("goal_status").is_some() {
            continue;
        }
        let task = serde_json::from_value::<CronTask>(row.clone()).map_err(|error| {
            format!(
                "{} contains invalid row id={}: {}",
                path.display(),
                row.get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown"),
                error
            )
        })?;
        if tasks.insert(task.id.clone(), task).is_some() {
            return Err(format!("{} contains duplicate cron ids", path.display()));
        }
    }
    Ok(tasks)
}

static CRON_TASK_MANAGER: std::sync::OnceLock<CronTaskManager> = std::sync::OnceLock::new();

pub fn get_cron_task_manager() -> &'static CronTaskManager {
    CRON_TASK_MANAGER.get_or_init(CronTaskManager::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(run_mode: &str, schedule: serde_json::Value) -> CronTaskConfig {
        serde_json::from_value(serde_json::json!({
            "workspacePath": "/tmp/workspace",
            "sessionId": "placeholder-session",
            "prompt": "do work",
            "intervalMinutes": 60,
            "runMode": run_mode,
            "schedule": schedule
        }))
        .unwrap()
    }

    fn task() -> crate::task::Task {
        serde_json::from_value(serde_json::json!({
            "id": "task-1",
            "name": "scheduled task",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp/workspace",
            "executionMode": "recurring",
            "intervalMinutes": 60,
            "sessionIds": [],
            "status": "stopped",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct",
            "notification": {
                "desktop": true,
                "botChannelId": "bot-1",
                "botThread": "chat-1"
            }
        }))
        .unwrap()
    }

    #[test]
    fn compatibility_patch_maps_interval_and_clear_delivery() {
        let update = task_update_from_cron_patch(
            &task(),
            serde_json::json!({
                "intervalMinutes": 30,
                "clearDelivery": true
            }),
        )
        .unwrap();

        assert_eq!(update.interval_minutes, Some(30));
        let notification = update.notification.unwrap();
        assert!(notification.desktop);
        assert_eq!(notification.bot_channel_id, None);
        assert_eq!(notification.bot_thread, None);
    }

    #[test]
    fn compatibility_patch_maps_prompt() {
        let update = task_update_from_cron_patch(
            &task(),
            serde_json::json!({ "prompt": "updated from file" }),
        )
        .unwrap();

        assert_eq!(update.prompt.as_deref(), Some("updated from file"));
    }

    #[test]
    fn compatibility_patch_rejects_updates_without_an_effective_value() {
        for patch in [
            serde_json::json!({}),
            serde_json::json!({ "unsupportedField": "ignored" }),
            serde_json::json!({ "clearDelivery": false }),
        ] {
            assert_eq!(
                task_update_from_cron_patch(&task(), patch).unwrap_err(),
                "patch must contain at least one supported update field"
            );
        }
    }

    #[test]
    fn compatibility_patch_rejects_invalid_prompt_before_task_state_changes() {
        for (patch, expected) in [
            (
                serde_json::json!({ "prompt": null }),
                "prompt must not be null",
            ),
            (
                serde_json::json!({ "prompt": 42 }),
                "prompt must be a string",
            ),
            (serde_json::json!({ "prompt": " \n\t" }), "prompt is empty"),
        ] {
            assert_eq!(
                task_update_from_cron_patch(&task(), patch).unwrap_err(),
                expected
            );
        }
    }

    #[test]
    fn compatibility_routing_patch_is_rejected_before_running_state_changes() {
        let mut running = task();
        running.status = crate::task::TaskStatus::Running;
        let missing_model = task_update_from_cron_patch(
            &running,
            serde_json::json!({ "providerId": "provider-1" }),
        )
        .unwrap();
        assert!(
            crate::task::validate_task_update_execution_routing(&running, &missing_model,)
                .unwrap_err()
                .contains("model")
        );
        assert_eq!(running.status, crate::task::TaskStatus::Running);

        running.runtime = Some("claude-code".to_string());
        let stale_managed_source = task_update_from_cron_patch(
            &running,
            serde_json::json!({
                "runtimeConfig": {
                    "source": "managed-provider",
                    "model": "gpt-5.6-sol"
                }
            }),
        )
        .unwrap();
        assert!(crate::task::validate_task_update_execution_routing(
            &running,
            &stale_managed_source,
        )
        .unwrap_err()
        .contains("requires runtime=codex"));
        assert_eq!(running.status, crate::task::TaskStatus::Running);
    }

    #[test]
    fn compatibility_cron_schedule_patch_drops_stale_interval() {
        let update = task_update_from_cron_patch(
            &task(),
            serde_json::json!({
                "schedule": { "kind": "cron", "expr": "30 6 * * *", "tz": "Asia/Shanghai" },
                "intervalMinutes": 60
            }),
        )
        .unwrap();

        assert_eq!(
            update.execution_mode,
            Some(crate::task::TaskExecutionMode::Recurring)
        );
        assert_eq!(update.cron_expression.as_deref(), Some("30 6 * * *"));
        assert_eq!(update.cron_timezone.as_deref(), Some("Asia/Shanghai"));
        assert_eq!(update.interval_minutes, None);
    }

    #[test]
    fn compatibility_every_schedule_patch_owns_interval() {
        let update = task_update_from_cron_patch(
            &task(),
            serde_json::json!({
                "schedule": { "kind": "every", "minutes": 15 },
                "intervalMinutes": 60
            }),
        )
        .unwrap();

        assert_eq!(
            update.execution_mode,
            Some(crate::task::TaskExecutionMode::Recurring)
        );
        assert_eq!(update.interval_minutes, Some(15));
        assert_eq!(update.cron_expression.as_deref(), Some(""));
        assert_eq!(update.cron_timezone.as_deref(), Some(""));
    }

    #[test]
    fn compatibility_notification_patch_preserves_existing_delivery() {
        let update =
            task_update_from_cron_patch(&task(), serde_json::json!({ "notifyEnabled": false }))
                .unwrap();

        let notification = update.notification.unwrap();
        assert!(!notification.desktop);
        assert_eq!(notification.bot_channel_id.as_deref(), Some("bot-1"));
        assert_eq!(notification.bot_thread.as_deref(), Some("chat-1"));
    }

    #[test]
    fn new_session_projection_prefers_the_latest_execution_session() {
        let mut task = task();
        task.run_mode = Some(crate::task::TaskRunMode::NewSession);
        task.preselected_session_id = Some("unused-placeholder".to_string());
        task.session_ids = vec!["run-1".to_string(), "run-2".to_string()];

        assert_eq!(task_session_id(&task), "run-2");
    }

    #[test]
    fn new_session_creation_does_not_persist_a_placeholder_preselection() {
        let input = task_input_from_cron_config(config(
            "new_session",
            serde_json::json!({ "kind": "every", "minutes": 60 }),
        ))
        .unwrap();

        assert_eq!(input.preselected_session_id, None);
    }

    #[test]
    fn compatibility_create_rejects_an_invalid_at_schedule() {
        let error = task_input_from_cron_config(config(
            "single_session",
            serde_json::json!({ "kind": "at", "at": "not-a-date" }),
        ))
        .expect_err("invalid one-shot timestamps must fail at ingress");

        assert!(error.contains("invalid at schedule"), "got: {error}");
    }

    #[test]
    fn deleted_migrated_task_remains_legacy_authority_tombstone() {
        let mut migrated = task();
        migrated.deleted = true;
        migrated.status_history.push(crate::task::StatusTransition {
            from: Some(crate::task::TaskStatus::Stopped),
            to: crate::task::TaskStatus::Stopped,
            at: 2,
            actor: crate::task::TransitionActor::System,
            message: Some("migrated".to_string()),
            source: Some(crate::task::TransitionSource::Migration),
        });
        let legacy = task_to_cron(&migrated);
        let tasks = HashMap::from([(migrated.id.clone(), migrated)]);

        assert!(legacy_row_has_task_authority(&legacy, &tasks));
    }

    #[test]
    fn task_compatibility_projection_reads_authoritative_last_execution() {
        let mut source = task();
        source.last_execution = Some(crate::task::TaskLastExecution {
            at: 100,
            trigger: crate::task::TaskExecutionTrigger::Scheduled,
            success: false,
            duration_ms: 321,
            session_id: Some("session-1".to_string()),
            error: Some("provider configuration failed".to_string()),
        });

        let projected = task_to_cron(&source);
        assert_eq!(projected.last_run_ok, Some(false));
        assert_eq!(projected.last_run_duration_ms, Some(321));
        assert_eq!(
            projected.last_error.as_deref(),
            Some("provider configuration failed")
        );
    }
}
