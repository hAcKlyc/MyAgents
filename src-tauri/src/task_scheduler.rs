use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, TimeZone, Utc};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::RwLock;

use crate::cron_task::CronRunRecord;
use crate::task::task_protects_session_identity;
use crate::task::{
    task_protected_session_ids, Task, TaskExecutionMode, TaskExecutionSettlement,
    TaskExecutionTerminalTransition, TaskExecutionTrigger, TaskListFilter, TaskStatus,
    TaskUpdateStatusInput, TransitionActor, TransitionSource,
};
use crate::task_trigger::{
    DetectorCancellation, DetectorInvocationCause, DetectorRunRequest, PendingTaskActivation,
    TaskActivationPayload, TriggerCommitDisposition,
};
use crate::{ulog_error, ulog_info, ulog_warn};

pub struct TaskSchedulerController {
    handles: Arc<RwLock<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    wakeups: Arc<RwLock<HashMap<String, Arc<tokio::sync::Notify>>>>,
    executions: ActiveExecutions,
    app_handle: Arc<RwLock<Option<AppHandle>>>,
    shutting_down: Arc<AtomicBool>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskTriggerCheckNowResult {
    pub outcome: Option<crate::task_trigger::TaskTriggerRuntimeOutcome>,
    pub state: crate::task_trigger::TaskTriggerRuntimeState,
}

#[derive(Debug)]
struct ActiveTaskExecution {
    queue_id: String,
    canceled: bool,
    session_id: Option<String>,
    pending_session_birth: Option<PendingSessionBirth>,
    state: TaskExecutionState,
    error: Option<String>,
    detector: Option<DetectorExecutionLifecycle>,
}

#[derive(Debug, Clone)]
struct DetectorExecutionLifecycle {
    cancellation: DetectorCancellation,
    done: Arc<AtomicBool>,
    notify: Arc<tokio::sync::Notify>,
}

impl DetectorExecutionLifecycle {
    fn new() -> Self {
        Self {
            cancellation: DetectorCancellation::new(),
            done: Arc::new(AtomicBool::new(false)),
            notify: Arc::new(tokio::sync::Notify::new()),
        }
    }

    fn finish(&self) {
        self.done.store(true, Ordering::SeqCst);
        // `notify_one` stores a permit when no waiter is registered. This
        // closes the done-check/notified-registration race in wait_finished;
        // there is only one lifecycle waiter per exact execution claim.
        self.notify.notify_one();
    }

    async fn wait_finished(&self) -> bool {
        loop {
            if self.done.load(Ordering::SeqCst) {
                return true;
            }
            if tokio::time::timeout(Duration::from_secs(8), self.notify.notified())
                .await
                .is_err()
            {
                return self.done.load(Ordering::SeqCst);
            }
        }
    }
}

/// Cancels a test-only Detector when the HTTP/Tauri request future disappears.
/// The detached worker still owns process settlement and exact-claim cleanup;
/// this guard only connects caller lifetime to the worker's cancellation token.
struct DetectorRequestCancellationGuard {
    cancellation: DetectorCancellation,
    armed: bool,
}

impl DetectorRequestCancellationGuard {
    fn new(cancellation: DetectorCancellation) -> Self {
        Self {
            cancellation,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for DetectorRequestCancellationGuard {
    fn drop(&mut self) {
        if self.armed {
            self.cancellation.cancel();
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskExecutionState {
    Checking,
    Running,
    Stopping,
    StopFailed,
}

impl TaskExecutionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Checking => "checking",
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::StopFailed => "stop_failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskExecutionProjection {
    pub state: TaskExecutionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct ReservedExecutionSession {
    session_id: String,
    initialize_session: bool,
    // Hold birth authority until exact Runtime admission or metadata publication
    // lets another owner adopt this identity; never wait for a healthy disk.
    birth_lifecycle: Arc<crate::sidecar::SessionLifecycleGuard>,
}

struct PendingSessionBirth {
    session_id: String,
    _lifecycle: Arc<crate::sidecar::SessionLifecycleGuard>,
}

impl std::fmt::Debug for PendingSessionBirth {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PendingSessionBirth")
            .field("session_id", &self.session_id)
            .finish_non_exhaustive()
    }
}

type ActiveExecutions = Arc<RwLock<HashMap<String, ActiveTaskExecution>>>;

pub(crate) type TaskControlGuard = crate::keyed_lifecycle::KeyedLifecycleGuard;

static TASK_CONTROL_LIFECYCLES: std::sync::OnceLock<
    crate::keyed_lifecycle::KeyedLifecycleRegistry,
> = std::sync::OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartupPendingRecoveryPlan {
    Scheduler,
    ManualOneShot,
    None,
}

fn pending_execution_trigger(
    pending: &PendingTaskActivation,
) -> Result<TaskExecutionTrigger, String> {
    match pending.invocation_cause {
        DetectorInvocationCause::Scheduled => Ok(TaskExecutionTrigger::Scheduled),
        DetectorInvocationCause::CheckNow => Ok(TaskExecutionTrigger::Manual),
        DetectorInvocationCause::Test => {
            Err("test Detector invocation cannot own a pending Activation Event".to_string())
        }
    }
}

fn startup_pending_recovery_plan(
    task: &Task,
    pending: &PendingTaskActivation,
) -> StartupPendingRecoveryPlan {
    if task.deleted {
        return StartupPendingRecoveryPlan::None;
    }
    if task.status == TaskStatus::Running {
        return StartupPendingRecoveryPlan::Scheduler;
    }
    if pending.invocation_cause == DetectorInvocationCause::CheckNow
        && matches!(task.status, TaskStatus::Stopped | TaskStatus::Blocked)
    {
        return StartupPendingRecoveryPlan::ManualOneShot;
    }
    StartupPendingRecoveryPlan::None
}

fn detector_test_checkpoint_snapshot(
    state: &crate::task_trigger::TaskTriggerRuntimeState,
    checkpoint_override: Option<Option<serde_json::Map<String, serde_json::Value>>>,
) -> (
    u64,
    Option<serde_json::Map<String, serde_json::Value>>,
    Option<i64>,
) {
    match checkpoint_override {
        Some(checkpoint) => (0, checkpoint, None),
        None => (
            state.checkpoint_revision,
            state.checkpoint.clone(),
            state.checkpoint_updated_at,
        ),
    }
}

async fn ensure_run_now_outbox_clear(
    store: &crate::task::TaskStore,
    task: &Task,
) -> Result<(), String> {
    if task.effective_trigger().is_command()
        && store
            .read_trigger_state(&task.id)
            .await?
            .pending_activation
            .is_some()
    {
        return Err(
            "run-now is unavailable while an Activation Event is pending; wait for it to settle or stop the Task"
                .to_string(),
        );
    }
    Ok(())
}

pub(crate) async fn acquire_task_control(task_id: &str) -> TaskControlGuard {
    TASK_CONTROL_LIFECYCLES
        .get_or_init(crate::keyed_lifecycle::KeyedLifecycleRegistry::new)
        .acquire(&[task_id])
        .await
}

pub(crate) async fn try_acquire_task_control(task_id: &str) -> Option<TaskControlGuard> {
    TASK_CONTROL_LIFECYCLES
        .get_or_init(crate::keyed_lifecycle::KeyedLifecycleRegistry::new)
        .try_acquire(task_id)
        .await
}

impl TaskSchedulerController {
    fn new() -> Self {
        Self {
            handles: Arc::new(RwLock::new(HashMap::new())),
            wakeups: Arc::new(RwLock::new(HashMap::new())),
            executions: Arc::new(RwLock::new(HashMap::new())),
            app_handle: Arc::new(RwLock::new(None)),
            shutting_down: Arc::new(AtomicBool::new(false)),
        }
    }

    pub async fn initialize(&self, handle: AppHandle) {
        *self.app_handle.write().await = Some(handle.clone());
        let Some(store) = crate::task::get_task_store() else {
            ulog_error!("[task-scheduler] TaskStore is not initialized");
            return;
        };
        let tasks = store
            .list(TaskListFilter {
                include_managed: Some(true),
                ..Default::default()
            })
            .await;

        for task in tasks {
            // Task outcome and Trigger outbox are two crash-durable files. A
            // matching receipt proves this event already entered a terminal
            // Runtime turn and its Task accounting committed; only the outbox
            // cleanup was interrupted. Reconcile it before arming any timer so
            // startup cannot re-admit the same event.
            let mut pending_activation = None;
            if task.effective_trigger().is_command() {
                match store.read_trigger_state(&task.id).await {
                    Ok(state) => {
                        if let Some(pending) = state.pending_activation.as_ref() {
                            if task.last_activation_event_id.as_deref()
                                == Some(pending.event.id.as_str())
                            {
                                if let Err(error) = store
                                    .settle_pending_activation(&task.id, &pending.event.id)
                                    .await
                                {
                                    ulog_error!(
                                        "[task-scheduler] failed to reconcile activation receipt task={}: {}",
                                        task.id,
                                        error
                                    );
                                    if task.status == TaskStatus::Running {
                                        let _ = block_task(
                                            store,
                                            &task,
                                            format!(
                                                "Activation Event recovery failed; retry required: {error}"
                                            ),
                                        )
                                        .await;
                                    }
                                    continue;
                                }
                            } else {
                                pending_activation = Some(pending.clone());
                            }
                        }
                    }
                    Err(error) => {
                        ulog_error!(
                            "[task-scheduler] failed to read trigger recovery state task={}: {}",
                            task.id,
                            error
                        );
                        if task.status == TaskStatus::Running {
                            let _ = block_task(
                                store,
                                &task,
                                format!("Trigger recovery state is unreadable: {error}"),
                            )
                            .await;
                        }
                        continue;
                    }
                }
            }
            if let Some(pending) = pending_activation {
                match startup_pending_recovery_plan(&task, &pending) {
                    StartupPendingRecoveryPlan::ManualOneShot => {
                        let task = task.clone();
                        let executions = Arc::clone(&self.executions);
                        let app_handle = Arc::clone(&self.app_handle);
                        let shutting_down = Arc::clone(&self.shutting_down);
                        tauri::async_runtime::spawn(async move {
                            if let Err(error) = dispatch_pending_activation(
                                &task,
                                pending,
                                &executions,
                                &app_handle,
                                shutting_down.as_ref(),
                                TaskExecutionTrigger::Manual,
                            )
                            .await
                            {
                                // Keep the durable outbox entry intact. A later
                                // restart or an explicit Stop can recover/cancel
                                // this one-shot without arming a timer or changing
                                // the stopped/blocked Task status.
                                ulog_error!(
                                    "[task-scheduler] check-now activation recovery failed task={}: {}",
                                    task.id,
                                    error
                                );
                            }
                        });
                        continue;
                    }
                    StartupPendingRecoveryPlan::Scheduler | StartupPendingRecoveryPlan::None => {}
                }
            }
            if task.status != TaskStatus::Running {
                continue;
            }
            if task.execution_mode == TaskExecutionMode::Loop {
                let _ = store
                    .update_status(TaskUpdateStatusInput {
                        id: task.id,
                        status: TaskStatus::Stopped,
                        message: Some("Legacy Loop tasks are retired".to_string()),
                        actor: TransitionActor::System,
                        source: Some(TransitionSource::Migration),
                    })
                    .await;
                continue;
            }
            if let Err(error) = self.start(&task.id).await {
                ulog_error!(
                    "[task-scheduler] failed to restore task {}: {}",
                    task.id,
                    error
                );
                let _ = block_task(
                    store,
                    &task,
                    format!("Task scheduler recovery failed: {error}"),
                )
                .await;
            }
        }
        let _ = handle.emit("task:scheduler-ready", serde_json::json!({}));
    }

    pub async fn start(&self, task_id: &str) -> Result<(), String> {
        let control = acquire_task_control(task_id).await;
        self.start_with_control_held(task_id, &control).await
    }

    pub(crate) async fn start_with_control_held(
        &self,
        task_id: &str,
        _control: &TaskControlGuard,
    ) -> Result<(), String> {
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err("Task scheduler is shutting down".to_string());
        }
        let store = crate::task::get_task_store()
            .ok_or_else(|| "task store not initialized".to_string())?;
        let task = store
            .get(task_id)
            .await
            .ok_or_else(|| format!("task not found: {task_id}"))?;
        if task.deleted || task.status != TaskStatus::Running {
            return Err(format!("task {task_id} is not running"));
        }
        validate_task_schedule(&task)?;

        let mut handles = self.handles.write().await;
        let execution = self.execution_projection(task_id).await;
        if execution.as_ref().is_some_and(|execution| {
            matches!(
                execution.state,
                TaskExecutionState::Stopping | TaskExecutionState::StopFailed
            )
        }) {
            let state = execution.expect("checked above").state;
            return Err(format!(
                "task {task_id} has an unresolved {} execution",
                state.as_str()
            ));
        }

        if let Some(existing) = handles.get(task_id) {
            if !existing.inner().is_finished() {
                return Ok(());
            }
            handles.remove(task_id);
        }
        if let Some(execution) = execution {
            return Err(format!(
                "task {task_id} has an unresolved {} execution",
                execution.state.as_str()
            ));
        }

        let task_id_owned = task_id.to_string();
        let executions = Arc::clone(&self.executions);
        let app_handle = Arc::clone(&self.app_handle);
        let shutting_down = Arc::clone(&self.shutting_down);
        let wakeup = Arc::new(tokio::sync::Notify::new());
        self.wakeups
            .write()
            .await
            .insert(task_id.to_string(), Arc::clone(&wakeup));
        let handle = tauri::async_runtime::spawn(async move {
            run_scheduler_loop(
                task_id_owned.clone(),
                executions,
                app_handle,
                shutting_down,
                wakeup,
            )
            .await;
            ulog_info!("[task-scheduler] loop exited task={}", task_id_owned);
        });
        handles.insert(task_id.to_string(), handle);
        drop(handles);
        emit_cron_ui_event(
            &self.app_handle,
            "cron:scheduler-started",
            serde_json::json!({
                "taskId": task.id,
                "intervalMinutes": task.interval_minutes.unwrap_or(0),
                "executionCount": task.execution_count,
            }),
        )
        .await;
        ulog_info!("[task-scheduler] armed task={}", task_id);
        Ok(())
    }

    pub async fn stop(&self, task_id: &str) -> Result<(), String> {
        let control = acquire_task_control(task_id).await;
        self.stop_with_control_held(task_id, &control).await?;
        if let Some(store) = crate::task::get_task_store() {
            if store
                .get(task_id)
                .await
                .is_some_and(|task| task.effective_trigger().is_command())
            {
                store.cancel_pending_activation(task_id).await?;
            }
        }
        Ok(())
    }

    /// App-exit owner: close scheduler admission, cancel every exact active
    /// Detector/turn, and wait for process-tree settlement without canceling
    /// durable pending Activation Events needed after restart.
    pub async fn shutdown_all(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let task_ids: Vec<String> = self.executions.read().await.keys().cloned().collect();
        for task_id in task_ids {
            let control = acquire_task_control(&task_id).await;
            if let Err(error) = self.stop_with_control_held(&task_id, &control).await {
                ulog_error!(
                    "[task-scheduler] shutdown failed task={}: {}",
                    task_id,
                    error
                );
            }
        }
        let mut handles = self.handles.write().await;
        for (_, handle) in handles.drain() {
            handle.abort();
        }
        self.wakeups.write().await.clear();
    }

    /// Interrupt only currently executing tasks through the existing explicit
    /// Stop transition. Idle schedules remain armed if installation fails.
    pub(crate) async fn interrupt_for_update(&self) -> Result<(), String> {
        let task_ids: Vec<String> = self.executions.read().await.keys().cloned().collect();
        for task_id in task_ids {
            let control = acquire_task_control(&task_id).await;
            let store = crate::task::get_task_store();
            if let Some(store) = store {
                if store.get(&task_id).await.is_some_and(|task| task.status == TaskStatus::Running) {
                    store.update_status_with_task_control_held(TaskUpdateStatusInput {
                        id: task_id,
                        status: TaskStatus::Stopped,
                        message: Some("Stopped by user-confirmed app update; unfinished work can be resumed after restart".into()),
                        actor: TransitionActor::User,
                        source: Some(TransitionSource::Ui),
                    }, &control).await?;
                    continue;
                }
            }
            // Draft Detector requests have no durable Task row.
            self.stop_with_control_held(&task_id, &control).await?;
        }
        Ok(())
    }

    pub(crate) async fn stop_with_control_held(
        &self,
        task_id: &str,
        _control: &TaskControlGuard,
    ) -> Result<(), String> {
        let active = {
            let mut executions = self.executions.write().await;
            executions.get_mut(task_id).map(|execution| {
                execution.canceled = true;
                execution.state = TaskExecutionState::Stopping;
                execution.error = None;
                if let Some(detector) = execution.detector.as_ref() {
                    detector.cancellation.cancel();
                }
                (
                    execution.queue_id.clone(),
                    execution.session_id.clone(),
                    execution.detector.clone(),
                )
            })
        };
        if active.is_some() {
            self.emit_execution_state(task_id).await;
        }
        let scheduler_handle = self.handles.write().await.remove(task_id);
        if let Some(wakeup) = self.wakeups.write().await.remove(task_id) {
            wakeup.notify_waiters();
        }
        // The timer loop must stop immediately. Its claimed execution is a
        // detached worker and is stopped below by exact queue identity.
        if let Some(handle) = scheduler_handle {
            handle.abort();
        }
        let task = match crate::task::get_task_store() {
            Some(store) => store.get(task_id).await,
            None => None,
        };
        let app_handle = self.app_handle.read().await.clone();
        let detector_stopped = match active
            .as_ref()
            .and_then(|(_, _, detector)| detector.as_ref())
        {
            Some(detector) => detector.wait_finished().await,
            None => true,
        };
        let stop_result = if !detector_stopped {
            Err("Detector process tree did not confirm termination within 8 seconds".to_string())
        } else {
            match (&active, app_handle.as_ref(), task.as_ref()) {
                (Some((queue_id, active_session, _)), Some(handle), Some(task)) => {
                    let stopped = crate::task_execution::stop_task_turn(
                        handle,
                        task,
                        active_session.as_deref(),
                        queue_id,
                    )
                    .await;
                    if stopped.is_ok() {
                        crate::task_execution::release_task_sessions(
                            handle,
                            task,
                            active_session.as_deref(),
                        )
                        .await;
                    }
                    stopped
                }
                // Draft/spec Detector tests deliberately have no TaskStore
                // row, but they are registered in the same exact lifecycle
                // map so App shutdown can cancel and join them.
                (Some((_, _, Some(_))), _, None) => Ok(()),
                (Some(_), None, _) => Err("Task scheduler app handle is unavailable".to_string()),
                (Some(_), _, None) => Err(format!("task not found while stopping: {task_id}")),
                (None, Some(handle), Some(task)) => {
                    crate::task_execution::release_task_sessions(handle, task, None).await;
                    Ok(())
                }
                (None, _, _) => Ok(()),
            }
        };

        if let Err(error) = stop_result {
            let message = format!(
                "Task schedule is stopped, but the current turn could not be confirmed stopped: {error}"
            );
            let mut executions = self.executions.write().await;
            if let Some((queue_id, _, _)) = active.as_ref() {
                if let Some(execution) = executions
                    .get_mut(task_id)
                    .filter(|execution| execution.queue_id == *queue_id)
                {
                    execution.state = TaskExecutionState::StopFailed;
                    execution.error = Some(message.clone());
                }
            }
            drop(executions);
            self.emit_execution_state(task_id).await;
            ulog_error!("[task-scheduler] task={} {}", task_id, message);
            return Err(message);
        }

        if let Some((queue_id, _, _)) = active {
            release_execution(&self.executions, task_id, &queue_id).await;
            self.emit_execution_state(task_id).await;
        }
        if let Some(handle) = app_handle {
            let _ = handle.emit(
                "cron:task-stopped",
                serde_json::json!({ "taskId": task_id }),
            );
        }
        Ok(())
    }

    pub async fn trigger_now(&self, task_id: &str) -> Result<String, String> {
        let store = crate::task::get_task_store()
            .ok_or_else(|| "task store not initialized".to_string())?;
        self.trigger_now_with_store(task_id, store).await
    }

    async fn trigger_now_with_store(
        &self,
        task_id: &str,
        store: &crate::task::TaskStore,
    ) -> Result<String, String> {
        let control = try_acquire_task_control(task_id).await.ok_or_else(|| {
            format!(
                "task {task_id} is stopping or changing scheduler state; retry after it settles"
            )
        })?;
        let task = store
            .get(task_id)
            .await
            .ok_or_else(|| format!("task not found: {task_id}"))?;
        if task.deleted {
            return Err(format!("task {task_id} is deleted"));
        }
        if !matches!(task.status, TaskStatus::Running | TaskStatus::Stopped) {
            return Err(format!(
                "task {task_id} is {}; run-now only supports running or stopped tasks",
                task.status.as_str()
            ));
        }
        ensure_run_now_outbox_clear(store, &task).await?;
        if self.app_handle.read().await.is_none() {
            return Err("task scheduler app handle is unavailable".to_string());
        }
        let queue_id =
            claim_execution_if_open(&self.executions, &self.shutting_down, task_id).await?;
        let reserved_session = match reserve_claimed_execution_session(
            &self.executions,
            store,
            &task,
            &queue_id,
            session_sidecars(&self.app_handle).await.as_ref(),
        )
        .await
        {
            Ok(Some(reserved_session)) => reserved_session,
            Ok(None) => {
                release_execution(&self.executions, task_id, &queue_id).await;
                return Err(format!("task {task_id} does not execute in a Session"));
            }
            Err(error) => {
                release_execution(&self.executions, task_id, &queue_id).await;
                return Err(error);
            }
        };
        self.emit_execution_state(task_id).await;

        let executions = Arc::clone(&self.executions);
        let app_handle = Arc::clone(&self.app_handle);
        let task_id = task.id;
        let session_id = reserved_session.session_id.clone();
        drop(control);
        tauri::async_runtime::spawn(async move {
            let claim = ExecutionClaimGuard::new(
                Arc::clone(&executions),
                Arc::clone(&app_handle),
                task_id.clone(),
                queue_id.clone(),
            );
            if let Err(error) = run_one_claimed(
                &task_id,
                &queue_id,
                &executions,
                &app_handle,
                TaskExecutionTrigger::Manual,
                Some(reserved_session),
                None,
            )
            .await
            {
                ulog_error!(
                    "[task-scheduler] immediate run failed task={}: {}",
                    task_id,
                    error
                );
            }
            claim.settle().await;
        });
        Ok(session_id)
    }

    /// Run a real command Detector check and commit its state. Activate enters
    /// the ordinary Task/SessionEngine path; unlike run-now this never bypasses
    /// the Detector and never moves the recurring timer anchor.
    pub async fn check_now(&self, task_id: &str) -> Result<TaskTriggerCheckNowResult, String> {
        let control = try_acquire_task_control(task_id).await.ok_or_else(|| {
            format!(
                "task {task_id} is stopping or changing scheduler state; retry after it settles"
            )
        })?;
        let store = crate::task::get_task_store()
            .ok_or_else(|| "task store not initialized".to_string())?;
        let task = store
            .get(task_id)
            .await
            .ok_or_else(|| format!("task not found: {task_id}"))?;
        if task.deleted {
            return Err(format!("task {task_id} is deleted"));
        }
        if !task.effective_trigger().is_command() {
            return Err(
                "check-now requires a command Detector; use run-now for always".to_string(),
            );
        }
        if !matches!(
            task.status,
            TaskStatus::Running | TaskStatus::Stopped | TaskStatus::Blocked
        ) {
            return Err(format!(
                "task {task_id} is {}; check-now supports running, stopped, or blocked tasks",
                task.status.as_str()
            ));
        }
        if task.status == TaskStatus::Running && end_condition_reached(&task) {
            store
                .update_status_with_task_control_held(
                    TaskUpdateStatusInput {
                        id: task.id.clone(),
                        status: TaskStatus::Done,
                        message: Some("Task end condition reached before check-now".to_string()),
                        actor: TransitionActor::System,
                        source: Some(TransitionSource::EndCondition),
                    },
                    &control,
                )
                .await?;
            return Err(format!(
                "task {task_id} has reached its end condition and was completed"
            ));
        }
        let current_state = store.read_trigger_state(task_id).await?;
        if current_state.pending_activation.is_some() {
            return Err(
                "check-now requires a fresh Detector invocation; settle or stop the pending Activation Event first"
                    .to_string(),
            );
        }
        let schedule_wakeup = self.wakeups.read().await.get(task_id).cloned();
        let (queue_id, detector) =
            claim_detector_invocation(&self.executions, &self.shutting_down, task_id).await?;

        let task_id_owned = task_id.to_string();
        let queue_id_owned = queue_id.clone();
        let store_for_worker = Arc::clone(store);
        let executions = Arc::clone(&self.executions);
        let app_handle = Arc::clone(&self.app_handle);
        let worker_wakeup = schedule_wakeup.clone();
        let worker = tauri::async_runtime::spawn(async move {
            let claim = ExecutionClaimGuard::new(
                Arc::clone(&executions),
                Arc::clone(&app_handle),
                task_id_owned.clone(),
                queue_id_owned.clone(),
            );
            emit_execution_state_event(&executions, &app_handle, &task_id_owned).await;
            let result = run_command_check_claimed(
                &task_id_owned,
                &queue_id_owned,
                &store_for_worker,
                &executions,
                &app_handle,
                CommandCheckInvocation {
                    cause: DetectorInvocationCause::CheckNow,
                    scheduled_at: None,
                    detector_lifecycle: detector,
                    detach_activation: true,
                    schedule_wakeup,
                    #[cfg(test)]
                    detector_result_override: None,
                },
            )
            .await;
            if result
                .as_ref()
                .is_ok_and(|result| result.activation_detached)
            {
                claim.transfer();
            } else {
                claim.settle().await;
                if let Some(wakeup) = worker_wakeup {
                    wakeup.notify_one();
                }
            }
            result
        });
        drop(control);
        worker
            .await
            .map_err(|error| format!("check-now worker failed: {error}"))??;
        let state = store.read_trigger_state(task_id).await?;
        Ok(TaskTriggerCheckNowResult {
            outcome: state.last_outcome,
            state,
        })
    }

    /// Execute a Task's command Detector with a read-only checkpoint snapshot.
    /// No Task/Trigger state, counter, Activation Event, Session, or AI turn is
    /// committed by this path.
    pub async fn test_trigger(
        &self,
        task_id: &str,
        checkpoint_override: Option<Option<serde_json::Map<String, serde_json::Value>>>,
    ) -> crate::task_trigger::DetectorRunResult {
        let control = match try_acquire_task_control(task_id).await {
            Some(control) => control,
            None => {
                return Err(crate::task_trigger::DetectorRunFailure::from_message(
                    "detector_busy",
                    format!("task {task_id} is busy"),
                ));
            }
        };
        let Some(store) = crate::task::get_task_store() else {
            return Err(crate::task_trigger::DetectorRunFailure::from_message(
                "task_store_unavailable",
                "task store not initialized",
            ));
        };
        let Some(task) = store.get(task_id).await else {
            return Err(crate::task_trigger::DetectorRunFailure::from_message(
                "task_not_found",
                format!("task not found: {task_id}"),
            ));
        };
        if task.deleted {
            return Err(crate::task_trigger::DetectorRunFailure::from_message(
                "task_deleted",
                format!("task {task_id} is deleted"),
            ));
        }
        if !task.effective_trigger().is_command() {
            return Err(crate::task_trigger::DetectorRunFailure::from_message(
                "detector_not_command",
                "test requires a command Detector",
            ));
        }
        let state = match store.read_trigger_state(task_id).await {
            Ok(state) => state,
            Err(error) => {
                return Err(crate::task_trigger::DetectorRunFailure::from_message(
                    "trigger_state_read_failed",
                    error,
                ));
            }
        };
        let Some(handle) = self.app_handle.read().await.clone() else {
            return Err(crate::task_trigger::DetectorRunFailure::from_message(
                "scheduler_unavailable",
                "task scheduler app handle is unavailable",
            ));
        };
        let (checkpoint_revision, checkpoint, checkpoint_updated_at) =
            detector_test_checkpoint_snapshot(&state, checkpoint_override);
        let request = DetectorRunRequest {
            task_id: task.id.clone(),
            workspace_path: task.workspace_path.clone(),
            trigger: task.effective_trigger(),
            cause: DetectorInvocationCause::Test,
            scheduled_at: None,
            checkpoint,
            checkpoint_revision,
            checkpoint_updated_at,
        };
        let (queue_id, detector) =
            match claim_detector_invocation(&self.executions, &self.shutting_down, task_id).await {
                Ok(value) => value,
                Err(error) => {
                    return Err(crate::task_trigger::DetectorRunFailure::from_message(
                        "detector_busy",
                        error,
                    ));
                }
            };
        let mut request_guard =
            DetectorRequestCancellationGuard::new(detector.cancellation.clone());
        let worker = tauri::async_runtime::spawn(run_test_detector_claimed(
            task_id.to_string(),
            queue_id,
            Arc::clone(&self.executions),
            Arc::clone(&self.app_handle),
            handle,
            request,
            detector,
        ));
        drop(control);
        match worker.await {
            Ok(result) => {
                request_guard.disarm();
                result
            }
            Err(error) => Err(crate::task_trigger::DetectorRunFailure::from_message(
                "detector_worker_failed",
                format!("Detector test worker failed: {error}"),
            )),
        }
    }

    pub async fn test_trigger_spec(
        &self,
        owner_task_id: Option<String>,
        trigger: crate::task_trigger::TaskTrigger,
        workspace_path: String,
        checkpoint: Option<serde_json::Map<String, serde_json::Value>>,
        checkpoint_revision: u64,
        checkpoint_updated_at: Option<i64>,
    ) -> crate::task_trigger::DetectorRunResult {
        if let Err(error) = crate::task_trigger::validate_task_trigger(&trigger) {
            return Err(crate::task_trigger::DetectorRunFailure::from_message(
                "detector_spec_invalid",
                error,
            ));
        }
        if !trigger.is_command() {
            return Err(crate::task_trigger::DetectorRunFailure::from_message(
                "detector_not_command",
                "test requires a command Detector",
            ));
        }
        let task_control = if let Some(task_id) = owner_task_id.as_deref() {
            let Some(control) = try_acquire_task_control(task_id).await else {
                return Err(crate::task_trigger::DetectorRunFailure::from_message(
                    "detector_busy",
                    format!("task {task_id} is busy"),
                ));
            };
            let Some(store) = crate::task::get_task_store() else {
                return Err(crate::task_trigger::DetectorRunFailure::from_message(
                    "task_store_unavailable",
                    "task store not initialized",
                ));
            };
            let Some(task) = store.get(task_id).await else {
                return Err(crate::task_trigger::DetectorRunFailure::from_message(
                    "task_not_found",
                    format!("task not found: {task_id}"),
                ));
            };
            if task.deleted {
                return Err(crate::task_trigger::DetectorRunFailure::from_message(
                    "task_deleted",
                    format!("task {task_id} is deleted"),
                ));
            }
            Some(control)
        } else {
            None
        };
        let Some(handle) = self.app_handle.read().await.clone() else {
            return Err(crate::task_trigger::DetectorRunFailure::from_message(
                "scheduler_unavailable",
                "task scheduler app handle is unavailable",
            ));
        };
        let owner_id =
            owner_task_id.unwrap_or_else(|| format!("detector-spec-test:{}", uuid::Uuid::new_v4()));
        let (queue_id, detector) =
            match claim_detector_invocation(&self.executions, &self.shutting_down, &owner_id).await
            {
                Ok(claim) => claim,
                Err(error) => {
                    return Err(crate::task_trigger::DetectorRunFailure::from_message(
                        "detector_unavailable",
                        error,
                    ));
                }
            };
        let mut request_guard =
            DetectorRequestCancellationGuard::new(detector.cancellation.clone());
        let worker = tauri::async_runtime::spawn(run_test_detector_claimed(
            owner_id.clone(),
            queue_id,
            Arc::clone(&self.executions),
            Arc::clone(&self.app_handle),
            handle,
            DetectorRunRequest {
                task_id: owner_id,
                workspace_path,
                trigger,
                cause: DetectorInvocationCause::Test,
                scheduled_at: None,
                checkpoint,
                checkpoint_revision,
                checkpoint_updated_at,
            },
            detector,
        ));
        drop(task_control);
        match worker.await {
            Ok(result) => {
                request_guard.disarm();
                result
            }
            Err(error) => Err(crate::task_trigger::DetectorRunFailure::from_message(
                "detector_worker_failed",
                format!("Detector spec test worker failed: {error}"),
            )),
        }
    }

    pub async fn reset_checkpoint(
        &self,
        task_id: &str,
    ) -> Result<crate::task_trigger::TaskTriggerRuntimeState, String> {
        let _control = try_acquire_task_control(task_id).await.ok_or_else(|| {
            format!("task {task_id} is stopping or changing Trigger state; retry after it settles")
        })?;
        if self.execution_projection(task_id).await.is_some() {
            return Err(format!(
                "task {task_id} has an unresolved execution; stop it before resetting checkpoint"
            ));
        }
        let store = crate::task::get_task_store()
            .ok_or_else(|| "task store not initialized".to_string())?;
        let task = store
            .get(task_id)
            .await
            .ok_or_else(|| format!("task not found: {task_id}"))?;
        if task.deleted {
            return Err(format!("task {task_id} is deleted"));
        }
        if !task.effective_trigger().is_command() {
            return Err("reset-checkpoint requires a command Detector".to_string());
        }
        let state = store.read_trigger_state(task_id).await?;
        if state.pending_activation.is_some() {
            return Err(
                "pending Activation Event must settle or be stopped before reset".to_string(),
            );
        }
        store.reset_trigger_checkpoint(task_id).await
    }

    pub async fn is_executing(&self, task_id: &str) -> bool {
        self.executions.read().await.contains_key(task_id)
    }

    pub async fn executing_snapshot(&self) -> HashSet<String> {
        self.executions.read().await.keys().cloned().collect()
    }

    pub async fn execution_projection(&self, task_id: &str) -> Option<TaskExecutionProjection> {
        self.executions
            .read()
            .await
            .get(task_id)
            .map(|execution| TaskExecutionProjection {
                state: execution.state,
                error: execution.error.clone(),
            })
    }

    pub async fn execution_projections_snapshot(&self) -> HashMap<String, TaskExecutionProjection> {
        self.executions
            .read()
            .await
            .iter()
            .map(|(task_id, execution)| {
                (
                    task_id.clone(),
                    TaskExecutionProjection {
                        state: execution.state,
                        error: execution.error.clone(),
                    },
                )
            })
            .collect()
    }

    #[cfg(test)]
    pub(crate) async fn claim_execution_for_test(&self, task_id: &str) -> Result<String, String> {
        claim_execution(&self.executions, task_id).await
    }

    #[cfg(test)]
    pub(crate) async fn release_execution_for_test(&self, task_id: &str, queue_id: &str) {
        release_execution(&self.executions, task_id, queue_id).await;
    }

    pub async fn authorize_dispatch(&self, task_id: &str, queue_id: &str) -> bool {
        execution_is_authorized(&self.executions, task_id, queue_id).await
    }

    /// Commit an ordinary Task↔Session relation only after the exact Runtime
    /// queue accepted its first Task turn, then flush comments that were
    /// waiting for the first usable execution Session.
    pub async fn confirm_turn_admitted(
        &self,
        task_id: &str,
        queue_id: &str,
        session_id: &str,
    ) -> Result<bool, String> {
        let _control = acquire_task_control(task_id).await;
        let exact = self
            .executions
            .read()
            .await
            .get(task_id)
            .is_some_and(|execution| {
                execution.queue_id == queue_id
                    && !execution.canceled
                    && execution.session_id.as_deref() == Some(session_id)
            });
        if !exact {
            return Ok(false);
        }
        let store = crate::task::get_task_store()
            .ok_or_else(|| "task store not initialized".to_string())?;
        // The exact Runtime admission confirms in-memory SessionStore birth.
        // Release before TaskStore/Inbox acquire this same lifecycle. Active
        // execution ownership continues to protect the Session from deletion.
        clear_pending_session_birth(&self.executions, task_id, queue_id, session_id).await;
        let (_, claimed_comments) = store
            .append_session_and_claim_pending_comments(task_id, session_id)
            .await?;
        if let Some(handle) = self.app_handle.read().await.clone() {
            if let Some(manager) = handle.try_state::<crate::sidecar::ManagedSidecarManager>() {
                crate::task_application::TaskApplication::new(store.as_ref(), None)
                    .deliver_claimed_comments(
                        &handle,
                        manager.inner(),
                        task_id,
                        session_id,
                        claimed_comments,
                    )
                    .await
                    .map_err(|error| error.to_string())?;
            }
        }
        Ok(true)
    }

    /// Publish the concrete Session currently used by a local managed Task
    /// batch. Exact queue authority gates the write, so a stop that wins first
    /// prevents later Session dispatch; once published, `/task/stop` can target
    /// the active SessionEngine turn.
    pub(crate) async fn bind_execution_session(
        &self,
        task_id: &str,
        queue_id: &str,
        session_id: &str,
    ) -> bool {
        let mut active = self.executions.write().await;
        let Some(execution) = active.get_mut(task_id) else {
            return false;
        };
        if execution.queue_id != queue_id || execution.canceled {
            return false;
        }
        execution.session_id = Some(session_id.to_string());
        true
    }

    #[cfg(test)]
    async fn cancel_execution(&self, task_id: &str) {
        if let Some(execution) = self.executions.write().await.get_mut(task_id) {
            execution.canceled = true;
            execution.state = TaskExecutionState::Stopping;
        }
    }

    async fn emit_execution_state(&self, task_id: &str) {
        emit_execution_state_event(&self.executions, &self.app_handle, task_id).await;
    }

    #[cfg(test)]
    async fn wake_task_schedule(&self, task_id: &str) {
        if let Some(wakeup) = self.wakeups.read().await.get(task_id).cloned() {
            wakeup.notify_one();
        }
    }
}

#[cfg(test)]
async fn claim_execution(executions: &ActiveExecutions, task_id: &str) -> Result<String, String> {
    let mut active = executions.write().await;
    if active.contains_key(task_id) {
        return Err(format!("task {task_id} is already executing"));
    }
    let queue_id = uuid::Uuid::new_v4().to_string();
    active.insert(
        task_id.to_string(),
        ActiveTaskExecution {
            queue_id: queue_id.clone(),
            canceled: false,
            session_id: None,
            pending_session_birth: None,
            state: TaskExecutionState::Running,
            error: None,
            detector: None,
        },
    );
    Ok(queue_id)
}

async fn claim_execution_if_open(
    executions: &ActiveExecutions,
    shutting_down: &AtomicBool,
    task_id: &str,
) -> Result<String, String> {
    let mut active = executions.write().await;
    // The existing app lifecycle gate linearizes this actual execution birth
    // with updater admission; scheduled-but-idle Task rows remain untouched.
    let _update_admission = crate::sidecar::begin_lifecycle_spawn_permit()?;
    if shutting_down.load(Ordering::SeqCst) {
        return Err("Task scheduler is shutting down".to_string());
    }
    if active.contains_key(task_id) {
        return Err(format!("task {task_id} is already executing"));
    }
    let queue_id = uuid::Uuid::new_v4().to_string();
    active.insert(
        task_id.to_string(),
        ActiveTaskExecution {
            queue_id: queue_id.clone(),
            canceled: false,
            session_id: None,
            pending_session_birth: None,
            state: TaskExecutionState::Running,
            error: None,
            detector: None,
        },
    );
    Ok(queue_id)
}

async fn claim_detector_invocation(
    executions: &ActiveExecutions,
    shutting_down: &AtomicBool,
    task_id: &str,
) -> Result<(String, DetectorExecutionLifecycle), String> {
    let mut active = executions.write().await;
    // The existing app lifecycle gate linearizes this actual execution birth
    // with updater admission; scheduled-but-idle Task rows remain untouched.
    let _update_admission = crate::sidecar::begin_lifecycle_spawn_permit()?;
    if shutting_down.load(Ordering::SeqCst) {
        return Err("Task scheduler is shutting down".to_string());
    }
    if active.contains_key(task_id) {
        return Err(format!("task {task_id} is already executing"));
    }
    let queue_id = uuid::Uuid::new_v4().to_string();
    let detector = DetectorExecutionLifecycle::new();
    active.insert(
        task_id.to_string(),
        ActiveTaskExecution {
            queue_id: queue_id.clone(),
            canceled: false,
            session_id: None,
            pending_session_birth: None,
            state: TaskExecutionState::Checking,
            error: None,
            detector: Some(detector.clone()),
        },
    );
    Ok((queue_id, detector))
}

async fn claim_pending_activation(
    executions: &ActiveExecutions,
    shutting_down: &AtomicBool,
    task_id: &str,
    persisted_queue_id: Option<&str>,
) -> Result<PendingActivationClaim, String> {
    let mut active = executions.write().await;
    // The existing app lifecycle gate linearizes this actual execution birth
    // with updater admission; scheduled-but-idle Task rows remain untouched.
    let _update_admission = crate::sidecar::begin_lifecycle_spawn_permit()?;
    if shutting_down.load(Ordering::SeqCst) {
        return Err("Task scheduler is shutting down".to_string());
    }
    if let Some(existing) = active.get(task_id) {
        if persisted_queue_id == Some(existing.queue_id.as_str()) {
            return Ok(PendingActivationClaim::AlreadyOwned(
                existing.queue_id.clone(),
            ));
        }
        return Err(format!("task {task_id} is already executing"));
    }
    let queue_id = persisted_queue_id
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    active.insert(
        task_id.to_string(),
        ActiveTaskExecution {
            queue_id: queue_id.clone(),
            canceled: false,
            session_id: None,
            pending_session_birth: None,
            state: TaskExecutionState::Running,
            error: None,
            detector: None,
        },
    );
    Ok(PendingActivationClaim::Claimed(queue_id))
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PendingActivationClaim {
    Claimed(String),
    /// The durable outbox queue is the exact same generation already owned by
    /// a detached check-now worker. Recovery must wait, never redispatch or
    /// treat this ordinary in-flight state as corruption.
    AlreadyOwned(String),
}

async fn wait_for_exact_execution_settlement(
    executions: &ActiveExecutions,
    shutting_down: &AtomicBool,
    task_id: &str,
    queue_id: &str,
) -> bool {
    loop {
        if shutting_down.load(Ordering::SeqCst) {
            return false;
        }
        let still_owned = executions
            .read()
            .await
            .get(task_id)
            .is_some_and(|execution| execution.queue_id == queue_id);
        if !still_owned {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn promote_detector_to_execution(
    executions: &ActiveExecutions,
    task_id: &str,
    queue_id: &str,
) -> Result<(), String> {
    let mut active = executions.write().await;
    let execution = active
        .get_mut(task_id)
        .filter(|execution| execution.queue_id == queue_id && !execution.canceled)
        .ok_or_else(|| "Detector invocation was canceled before activation dispatch".to_string())?;
    execution.detector = None;
    execution.state = TaskExecutionState::Running;
    Ok(())
}

async fn execution_is_authorized(
    executions: &ActiveExecutions,
    task_id: &str,
    queue_id: &str,
) -> bool {
    executions
        .read()
        .await
        .get(task_id)
        .is_some_and(|active| active.queue_id == queue_id && !active.canceled)
}

async fn session_sidecars(
    app_handle: &RwLock<Option<AppHandle>>,
) -> Option<crate::sidecar::ManagedSidecarManager> {
    app_handle
        .read()
        .await
        .as_ref()?
        .try_state::<crate::sidecar::ManagedSidecarManager>()
        .map(|manager| manager.inner().clone())
}

async fn reserve_claimed_execution_session(
    executions: &ActiveExecutions,
    store: &crate::task::TaskStore,
    task: &Task,
    queue_id: &str,
    manager: Option<&crate::sidecar::ManagedSidecarManager>,
) -> Result<Option<ReservedExecutionSession>, String> {
    if !crate::task_execution::uses_session_engine(task) {
        return Ok(None);
    }
    let selected_session_id = crate::task_execution::select_execution_session(task);
    // Deletion takes this same guard before checking durable/transient owners.
    // Hold it from the moment the execution publishes its Session identity,
    // through the durable Task binding and any required Session metadata
    // birth. `execute_task_with_reservation` releases it at that exact point.
    let selected_lifecycle =
        crate::sidecar::acquire_session_lifecycle(&[&selected_session_id]).await;
    let selected_materialized = if let Some(manager) = manager {
        crate::sidecar::session_lifecycle::session_exists_for_continuation(
            manager,
            &selected_session_id,
        )
    } else {
        session_metadata_exists(&selected_session_id).await
    };
    let selected_was_bound = crate::task::task_bound_session_ids(task)
        .iter()
        .any(|session_id| session_id == &selected_session_id);

    let (session_id, lifecycle, initialize_session) =
        if selected_was_bound && !selected_materialized {
            // A persisted binding whose SessionStore row was deleted is
            // historical identity, not permission to resurrect that UUID.
            // Rebind to a fresh identity while both old and new lifecycles are
            // fenced. The fresh UUID cannot already be visible to another
            // owner, so nested acquisition cannot invert an existing lock
            // order.
            let replacement_session_id = uuid::Uuid::new_v4().to_string();
            let replacement_lifecycle =
                crate::sidecar::acquire_session_lifecycle(&[&replacement_session_id]).await;
            store
                .rebind_missing_single_session_with_lifecycle_held(
                    &task.id,
                    &selected_session_id,
                    &replacement_session_id,
                )
                .await?
                .ok_or_else(|| {
                    "Task Session binding changed while reserving its replacement".to_string()
                })?;
            drop(selected_lifecycle);
            (replacement_session_id, replacement_lifecycle, true)
        } else {
            // An explicitly preselected Session is already a user-confirmed
            // relation. A freshly minted ordinary execution Session remains
            // transient until Runtime dispatch acceptance.
            if !selected_was_bound
                && task.preselected_session_id.as_deref() == Some(selected_session_id.as_str())
            {
                store
                    .append_session_with_lifecycle_held(&task.id, &selected_session_id)
                    .await?;
            }
            (
                selected_session_id,
                selected_lifecycle,
                !selected_materialized,
            )
        };
    let birth_lifecycle = Arc::new(lifecycle);
    {
        let mut active = executions.write().await;
        let Some(execution) = active.get_mut(&task.id) else {
            return Err("Task execution was canceled before Session dispatch".to_string());
        };
        if execution.queue_id != queue_id || execution.canceled {
            return Err("Task execution was canceled before Session dispatch".to_string());
        }
        execution.session_id = Some(session_id.clone());
        if initialize_session {
            // The exact execution generation, not its worker future, owns the
            // fail-closed metadata-birth authority. Worker abort/panic may
            // mark this generation StopFailed but cannot release the lease.
            execution.pending_session_birth = Some(PendingSessionBirth {
                session_id: session_id.clone(),
                _lifecycle: Arc::clone(&birth_lifecycle),
            });
        }
    }
    if initialize_session {
        observe_reserved_session_birth(
            Arc::clone(executions),
            task.id.clone(),
            queue_id.to_string(),
            session_id.clone(),
        );
    }
    Ok(Some(ReservedExecutionSession {
        session_id,
        initialize_session,
        birth_lifecycle,
    }))
}

async fn session_metadata_exists(session_id: &str) -> bool {
    let session_id = session_id.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sidecar::runtime_identity::resolve_session_runtime_identity_full(&session_id)
            .is_some()
    })
    .await
    .unwrap_or(false)
}

async fn clear_pending_session_birth(
    executions: &ActiveExecutions,
    task_id: &str,
    queue_id: &str,
    session_id: &str,
) -> bool {
    let mut active = executions.write().await;
    let Some(execution) = active
        .get_mut(task_id)
        .filter(|execution| execution.queue_id == queue_id)
    else {
        return false;
    };
    if execution
        .pending_session_birth
        .as_ref()
        .is_some_and(|pending| pending.session_id == session_id)
    {
        execution.pending_session_birth = None;
        true
    } else {
        false
    }
}

fn observe_reserved_session_birth(
    executions: ActiveExecutions,
    task_id: String,
    queue_id: String,
    session_id: String,
) {
    tauri::async_runtime::spawn(async move {
        let mut polls = 0_u32;
        loop {
            if session_metadata_exists(&session_id).await {
                clear_pending_session_birth(&executions, &task_id, &queue_id, &session_id).await;
                return;
            }
            let exact_generation_still_owns_birth = executions
                .read()
                .await
                .get(&task_id)
                .filter(|execution| execution.queue_id == queue_id)
                .and_then(|execution| execution.pending_session_birth.as_ref())
                .is_some_and(|pending| pending.session_id == session_id);
            if !exact_generation_still_owns_birth {
                return;
            }
            polls = polls.saturating_add(1);
            let delay_ms = if polls <= 50 { 20 } else { 250 };
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        }
    });
}

async fn execute_task_with_reservation(
    handle: &AppHandle,
    task: &Task,
    queue_id: &str,
    executions: &ActiveExecutions,
    reservation: Option<ReservedExecutionSession>,
    activation: Option<TaskActivationPayload>,
) -> Result<crate::task_execution::TaskExecutionOutcome, crate::task_execution::TaskExecutionFailure>
{
    let Some(reservation) = reservation else {
        return crate::task_execution::execute_managed_task(handle, task, queue_id).await;
    };
    let ReservedExecutionSession {
        session_id,
        initialize_session,
        birth_lifecycle,
    } = reservation;
    let result = crate::task_execution::execute_task(
        handle,
        task,
        queue_id,
        session_id.clone(),
        initialize_session,
        birth_lifecycle,
        activation,
    )
    .await;
    if !result
        .as_ref()
        .is_ok_and(|outcome| outcome.termination_unconfirmed)
    {
        // Confirmed failure can retry as a new creator. Successful turns have
        // already materialized; clearing here is an idempotent fast path for
        // the observer. Ambiguous transport remains owned by the exact active
        // execution until metadata birth or confirmed stop removes it.
        clear_pending_session_birth(executions, &task.id, queue_id, &session_id).await;
    }
    result
}

/// Cleanup uses the reservation's existing identity decision, not the health of
/// the product index or the acceptance of only the most recent request.
fn should_retain_task_owner_after_attempt(
    task: &Task,
    session_id: Option<&str>,
    termination_unconfirmed: bool,
    turn_dispatched: bool,
    session_was_continuation: bool,
) -> bool {
    if termination_unconfirmed {
        return true;
    }
    let session_materialized = session_id.is_some_and(|value| {
        session_was_continuation
            || turn_dispatched
            || crate::sidecar::runtime_identity::resolve_session_runtime_identity_full(value)
                .is_some()
    });
    crate::task_execution::retain_owner_between_runs(task, session_materialized)
}

async fn release_task_owner_after_attempt(
    handle: &AppHandle,
    task: &Task,
    session_id: Option<&str>,
    termination_unconfirmed: bool,
    turn_dispatched: bool,
    session_was_continuation: bool,
) {
    if !should_retain_task_owner_after_attempt(
        task,
        session_id,
        termination_unconfirmed,
        turn_dispatched,
        session_was_continuation,
    ) {
        crate::task_execution::release_task_sessions(handle, task, session_id).await;
    }
}

async fn release_execution(executions: &ActiveExecutions, task_id: &str, queue_id: &str) {
    let mut active = executions.write().await;
    if active
        .get(task_id)
        .is_some_and(|execution| execution.queue_id == queue_id)
    {
        active.remove(task_id);
    }
}

async fn retain_unconfirmed_execution(
    executions: &ActiveExecutions,
    task_id: &str,
    queue_id: &str,
    error: String,
) {
    let mut active = executions.write().await;
    if let Some(execution) = active
        .get_mut(task_id)
        .filter(|execution| execution.queue_id == queue_id)
    {
        execution.canceled = true;
        execution.state = TaskExecutionState::StopFailed;
        execution.error = Some(error);
    }
}

fn execution_authorizes_terminal_settlement(
    execution: &ActiveTaskExecution,
    queue_id: &str,
    termination_unconfirmed: bool,
) -> bool {
    execution.queue_id == queue_id
        && (!execution.canceled
            || (termination_unconfirmed && execution.state == TaskExecutionState::StopFailed))
}

fn activation_turn_was_admitted(
    activation: Option<&PendingTaskActivation>,
    outcome: Option<&crate::task_execution::TaskExecutionOutcome>,
) -> bool {
    activation.is_some() && outcome.is_some_and(|value| value.turn_dispatched)
}

async fn emit_execution_state_event(
    executions: &ActiveExecutions,
    app_handle: &RwLock<Option<AppHandle>>,
    task_id: &str,
) {
    let projection =
        executions
            .read()
            .await
            .get(task_id)
            .map(|execution| TaskExecutionProjection {
                state: execution.state,
                error: execution.error.clone(),
            });
    if let Some(handle) = app_handle.read().await.as_ref() {
        let _ = handle.emit(
            "cron:execution-state-changed",
            serde_json::json!({
                "taskId": task_id,
                "state": projection.as_ref().map(|value| value.state),
                "error": projection.and_then(|value| value.error),
            }),
        );
    }
}

struct ExecutionClaimGuard {
    executions: ActiveExecutions,
    app_handle: Arc<RwLock<Option<AppHandle>>>,
    task_id: String,
    queue_id: String,
    settled: bool,
}

impl ExecutionClaimGuard {
    fn new(
        executions: ActiveExecutions,
        app_handle: Arc<RwLock<Option<AppHandle>>>,
        task_id: String,
        queue_id: String,
    ) -> Self {
        Self {
            executions,
            app_handle,
            task_id,
            queue_id,
            settled: false,
        }
    }

    async fn settle(mut self) {
        let mut active = self.executions.write().await;
        let keep_for_stop_confirmation = active
            .get(&self.task_id)
            .filter(|execution| execution.queue_id == self.queue_id)
            .is_some_and(|execution| {
                matches!(
                    execution.state,
                    TaskExecutionState::Stopping | TaskExecutionState::StopFailed
                )
            });
        if !keep_for_stop_confirmation
            && active
                .get(&self.task_id)
                .is_some_and(|execution| execution.queue_id == self.queue_id)
        {
            active.remove(&self.task_id);
        }
        drop(active);
        emit_execution_state_event(&self.executions, &self.app_handle, &self.task_id).await;
        self.settled = true;
    }

    /// Transfer exact-generation settlement to another guard created before
    /// this one leaves scope (used when check-now admits an AI turn but returns
    /// to the caller without waiting for Runtime terminal).
    fn transfer(mut self) {
        self.settled = true;
    }
}

impl Drop for ExecutionClaimGuard {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        let executions = Arc::clone(&self.executions);
        let app_handle = Arc::clone(&self.app_handle);
        let task_id = self.task_id.clone();
        let queue_id = self.queue_id.clone();
        tauri::async_runtime::spawn(async move {
            let mut active = executions.write().await;
            if let Some(execution) = active
                .get_mut(&task_id)
                .filter(|execution| execution.queue_id == queue_id)
            {
                execution.canceled = true;
                execution.state = TaskExecutionState::StopFailed;
                execution.error = Some(
                    "Task execution worker ended before lifecycle settlement; stop it before rerunning"
                        .to_string(),
                );
            }
            drop(active);
            emit_execution_state_event(&executions, &app_handle, &task_id).await;
        });
    }
}

async fn run_test_detector_claimed<R: tauri::Runtime>(
    owner_id: String,
    queue_id: String,
    executions: ActiveExecutions,
    app_handle: Arc<RwLock<Option<AppHandle>>>,
    handle: AppHandle<R>,
    request: DetectorRunRequest,
    detector: DetectorExecutionLifecycle,
) -> crate::task_trigger::DetectorRunResult {
    let claim = ExecutionClaimGuard::new(
        Arc::clone(&executions),
        Arc::clone(&app_handle),
        owner_id.clone(),
        queue_id,
    );
    emit_execution_state_event(&executions, &app_handle, &owner_id).await;
    let result =
        crate::task_trigger::run_command_detector(&handle, request, detector.cancellation.clone())
            .await;
    detector.finish();
    claim.settle().await;
    result
}

async fn run_scheduler_loop(
    task_id: String,
    executions: ActiveExecutions,
    app_handle: Arc<RwLock<Option<AppHandle>>>,
    shutting_down: Arc<AtomicBool>,
    wakeup: Arc<tokio::sync::Notify>,
) {
    loop {
        if shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let Some(store) = crate::task::get_task_store() else {
            return;
        };
        let Some(task) = store.get(&task_id).await else {
            return;
        };
        if task.deleted || task.status != TaskStatus::Running {
            return;
        }
        if task.effective_trigger().is_command() {
            match store.read_trigger_state(&task.id).await {
                Ok(state) => {
                    if let Some(pending) = state.pending_activation {
                        let execution_trigger = match pending_execution_trigger(&pending) {
                            Ok(trigger) => trigger,
                            Err(error) => {
                                let transition = block_task(
                                    store,
                                    &task,
                                    format!("Trigger recovery state is invalid: {error}"),
                                )
                                .await;
                                if retry_running_scheduler_after_transition_failure(
                                    store, &task_id, &wakeup, transition,
                                )
                                .await
                                {
                                    continue;
                                }
                                return;
                            }
                        };
                        match dispatch_pending_activation(
                            &task,
                            pending,
                            &executions,
                            &app_handle,
                            &shutting_down,
                            execution_trigger,
                        )
                        .await
                        {
                            Ok(RunDisposition::Continue) => continue,
                            Ok(RunDisposition::Stop) => return,
                            Err(error) if error == "UPDATE_SHUTDOWN_IN_PROGRESS" => {
                                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                                continue;
                            }
                            Err(error) => {
                                let transition = block_task(
                                    store,
                                    &task,
                                    format!("Pending Activation Event recovery failed: {error}"),
                                )
                                .await;
                                if retry_running_scheduler_after_transition_failure(
                                    store, &task_id, &wakeup, transition,
                                )
                                .await
                                {
                                    continue;
                                }
                                return;
                            }
                        }
                    }
                }
                Err(error) => {
                    let transition = block_task(
                        store,
                        &task,
                        format!("Trigger state recovery failed: {error}"),
                    )
                    .await;
                    if retry_running_scheduler_after_transition_failure(
                        store, &task_id, &wakeup, transition,
                    )
                    .await
                    {
                        continue;
                    }
                    return;
                }
            }
        }
        if end_condition_reached(&task) {
            let transition = finish_task(
                store,
                &task,
                "Task end condition reached",
                TransitionSource::EndCondition,
            )
            .await;
            if retry_running_scheduler_after_transition_failure(
                store, &task_id, &wakeup, transition,
            )
            .await
            {
                continue;
            }
            return;
        }
        let mut target = match next_execution_at(&task) {
            Ok(Some(target)) => target,
            Ok(None) => return,
            Err(error) => {
                let transition = block_task(store, &task, error).await;
                if retry_running_scheduler_after_transition_failure(
                    store, &task_id, &wakeup, transition,
                )
                .await
                {
                    continue;
                }
                return;
            }
        };
        if task.effective_trigger().is_command() {
            if let Ok(state) = store.read_trigger_state(&task.id).await {
                if let Some(backoff_until) = state
                    .backoff_until
                    .and_then(|value| Utc.timestamp_millis_opt(value).single())
                {
                    target = target.max(backoff_until);
                }
            }
        }
        if !sleep_until_wallclock_or_wakeup(target, &wakeup).await {
            continue;
        }

        let result = run_one(
            &task_id,
            &executions,
            &app_handle,
            &shutting_down,
            target.timestamp_millis(),
        )
        .await;
        match result {
            Ok(RunDisposition::Continue) => {}
            Ok(RunDisposition::Stop) => return,
            Err(error) if error == "UPDATE_SHUTDOWN_IN_PROGRESS" => {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                continue;
            }
            Err(error) => {
                ulog_error!("[task-scheduler] task={} run failed: {}", task_id, error);
                let transition = if let Some(current) = store
                    .get(&task_id)
                    .await
                    .filter(|current| current.status == TaskStatus::Running)
                {
                    block_task(
                        store,
                        &current,
                        format!("Task scheduler execution failed: {error}"),
                    )
                    .await
                } else {
                    Ok(())
                };
                if retry_running_scheduler_after_transition_failure(
                    store, &task_id, &wakeup, transition,
                )
                .await
                {
                    continue;
                }
                return;
            }
        }
    }
}

/// Keep this timer generation alive when a terminal status write failed and
/// the authoritative Task row is therefore still Running.
async fn retry_running_scheduler_after_transition_failure(
    store: &crate::task::TaskStore,
    task_id: &str,
    wakeup: &tokio::sync::Notify,
    transition: Result<(), String>,
) -> bool {
    let Err(error) = transition else {
        return false;
    };
    ulog_error!(
        "[task-scheduler] task={} terminal transition failed: {}",
        task_id,
        error
    );
    if !store
        .get(task_id)
        .await
        .is_some_and(|task| task.status == TaskStatus::Running)
    {
        return false;
    }
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_secs(5)) => {}
        _ = wakeup.notified() => {}
    }
    true
}

enum RunDisposition {
    Continue,
    Stop,
}

struct CommandCheckResult {
    disposition: RunDisposition,
    /// The Detector claim was promoted and its exact queue ownership moved to
    /// a background AI-turn worker. The caller must not settle that claim.
    activation_detached: bool,
}

struct CommandCheckInvocation {
    cause: DetectorInvocationCause,
    scheduled_at: Option<i64>,
    detector_lifecycle: DetectorExecutionLifecycle,
    detach_activation: bool,
    /// The currently armed timer generation, when check-now is invoked for a
    /// running Task. Detached activation and every pre-detach exit both wake
    /// this exact scheduler without depending on the request future.
    schedule_wakeup: Option<Arc<tokio::sync::Notify>>,
    #[cfg(test)]
    detector_result_override: Option<crate::task_trigger::DetectorRunResult>,
}

impl CommandCheckResult {
    fn settled(disposition: RunDisposition) -> Self {
        Self {
            disposition,
            activation_detached: false,
        }
    }
}

async fn run_one(
    task_id: &str,
    executions: &ActiveExecutions,
    app_handle: &Arc<RwLock<Option<AppHandle>>>,
    shutting_down: &AtomicBool,
    scheduled_at: i64,
) -> Result<RunDisposition, String> {
    let control = acquire_task_control(task_id).await;
    let Some(store) = crate::task::get_task_store() else {
        return Err("task store not initialized".to_string());
    };
    let Some(task) = store.get(task_id).await else {
        return Ok(RunDisposition::Stop);
    };
    if task.deleted || task.status != TaskStatus::Running {
        return Ok(RunDisposition::Stop);
    }
    if task.effective_trigger().is_command() {
        let state = store.read_trigger_state(task_id).await?;
        if state
            .backoff_until
            .is_some_and(|backoff_until| backoff_until > Utc::now().timestamp_millis())
        {
            return Ok(RunDisposition::Continue);
        }
        if let Some(pending) = state.pending_activation {
            let execution_trigger = pending_execution_trigger(&pending)?;
            drop(control);
            return dispatch_pending_activation(
                &task,
                pending,
                executions,
                app_handle,
                shutting_down,
                execution_trigger,
            )
            .await;
        }
    }

    if task.effective_trigger().is_command() {
        let (queue_id, detector) =
            match claim_detector_invocation(executions, shutting_down, task_id).await {
                Ok(claim) => claim,
                Err(_) => {
                    ulog_warn!("[task-scheduler] detector overlap skipped task={}", task_id);
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    return Ok(RunDisposition::Continue);
                }
            };
        emit_execution_state_event(executions, app_handle, task_id).await;
        drop(control);

        let task_id_owned = task_id.to_string();
        let queue_id_owned = queue_id.clone();
        let store_for_worker = Arc::clone(store);
        let executions = Arc::clone(executions);
        let app_handle = Arc::clone(app_handle);
        let worker = tauri::async_runtime::spawn(async move {
            let claim = ExecutionClaimGuard::new(
                Arc::clone(&executions),
                Arc::clone(&app_handle),
                task_id_owned.clone(),
                queue_id_owned.clone(),
            );
            let result = run_command_check_claimed(
                &task_id_owned,
                &queue_id_owned,
                &store_for_worker,
                &executions,
                &app_handle,
                CommandCheckInvocation {
                    cause: DetectorInvocationCause::Scheduled,
                    scheduled_at: Some(scheduled_at),
                    detector_lifecycle: detector,
                    detach_activation: false,
                    schedule_wakeup: None,
                    #[cfg(test)]
                    detector_result_override: None,
                },
            )
            .await;
            claim.settle().await;
            result.map(|result| result.disposition)
        });
        return worker
            .await
            .map_err(|error| format!("Detector worker failed: {error}"))?;
    }

    let queue_id = match claim_execution_if_open(executions, shutting_down, task_id).await {
        Ok(queue_id) => queue_id,
        Err(_) => {
            ulog_warn!("[task-scheduler] overlap skipped task={}", task_id);
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            return Ok(RunDisposition::Continue);
        }
    };
    let reserved_session = match reserve_claimed_execution_session(
        executions,
        store,
        &task,
        &queue_id,
        session_sidecars(app_handle).await.as_ref(),
    )
    .await
    {
        Ok(reservation) => reservation,
        Err(error) => {
            release_execution(executions, task_id, &queue_id).await;
            return Err(error);
        }
    };
    emit_execution_state_event(executions, app_handle, task_id).await;
    drop(control);

    let task_id_owned = task_id.to_string();
    let queue_id_owned = queue_id.clone();
    let executions = Arc::clone(executions);
    let app_handle = Arc::clone(app_handle);
    let worker = tauri::async_runtime::spawn(async move {
        let claim = ExecutionClaimGuard::new(
            Arc::clone(&executions),
            Arc::clone(&app_handle),
            task_id_owned.clone(),
            queue_id_owned.clone(),
        );
        let result = run_one_claimed(
            &task_id_owned,
            &queue_id_owned,
            &executions,
            &app_handle,
            TaskExecutionTrigger::Scheduled,
            reserved_session,
            None,
        )
        .await;
        claim.settle().await;
        result
    });
    worker
        .await
        .map_err(|error| format!("task execution worker failed: {error}"))?
}

async fn run_command_check_claimed(
    task_id: &str,
    queue_id: &str,
    store: &crate::task::TaskStore,
    executions: &ActiveExecutions,
    app_handle: &Arc<RwLock<Option<AppHandle>>>,
    invocation: CommandCheckInvocation,
) -> Result<CommandCheckResult, String> {
    let CommandCheckInvocation {
        cause,
        scheduled_at,
        detector_lifecycle,
        detach_activation,
        schedule_wakeup,
        #[cfg(test)]
        detector_result_override,
    } = invocation;
    let Some(task) = store.get(task_id).await else {
        detector_lifecycle.finish();
        return Ok(CommandCheckResult::settled(RunDisposition::Stop));
    };
    let state = match store.read_trigger_state(task_id).await {
        Ok(state) => state,
        Err(error) => {
            detector_lifecycle.finish();
            return Err(error);
        }
    };
    #[cfg(test)]
    let run = if let Some(result) = detector_result_override {
        result
    } else {
        let handle = match app_handle.read().await.clone() {
            Some(handle) => handle,
            None => {
                detector_lifecycle.finish();
                return Err("task scheduler app handle is unavailable".to_string());
            }
        };
        crate::task_trigger::run_command_detector(
            &handle,
            DetectorRunRequest {
                task_id: task.id.clone(),
                workspace_path: task.workspace_path.clone(),
                trigger: task.effective_trigger(),
                cause,
                scheduled_at,
                checkpoint: state.checkpoint,
                checkpoint_revision: state.checkpoint_revision,
                checkpoint_updated_at: state.checkpoint_updated_at,
            },
            detector_lifecycle.cancellation.clone(),
        )
        .await
    };
    #[cfg(not(test))]
    let run = {
        let handle = match app_handle.read().await.clone() {
            Some(handle) => handle,
            None => {
                detector_lifecycle.finish();
                return Err("task scheduler app handle is unavailable".to_string());
            }
        };
        crate::task_trigger::run_command_detector(
            &handle,
            DetectorRunRequest {
                task_id: task.id.clone(),
                workspace_path: task.workspace_path.clone(),
                trigger: task.effective_trigger(),
                cause,
                scheduled_at,
                checkpoint: state.checkpoint,
                checkpoint_revision: state.checkpoint_revision,
                checkpoint_updated_at: state.checkpoint_updated_at,
            },
            detector_lifecycle.cancellation.clone(),
        )
        .await
    };
    // Stop/Delete wait for actual subprocess-tree shutdown, not for the later
    // TaskStore commit. Exact queue authorization fences that commit.
    detector_lifecycle.finish();

    let task_control = acquire_task_control(task_id).await;
    if !execution_is_authorized(executions, task_id, queue_id).await {
        return Ok(CommandCheckResult::settled(RunDisposition::Stop));
    }
    let Some(task) = store.get(task_id).await else {
        return Ok(CommandCheckResult::settled(RunDisposition::Stop));
    };
    if task.deleted
        || (cause == DetectorInvocationCause::Scheduled && task.status != TaskStatus::Running)
    {
        return Ok(CommandCheckResult::settled(RunDisposition::Stop));
    }

    match run {
        Ok(success) => {
            let committed = match store.commit_detector_success(&task, &success, cause).await {
                Ok(committed) => committed,
                Err(error) => {
                    if cause == DetectorInvocationCause::Scheduled {
                        let _ = block_task_with_control_held(
                            store,
                            &task,
                            format!("Detector state commit failed: {error}"),
                            &task_control,
                        )
                        .await;
                    }
                    return Err(error);
                }
            };
            emit_cron_ui_event(
                app_handle,
                "task:trigger-checked",
                serde_json::json!({
                    "taskId": task_id,
                    "outcome": committed.state.last_outcome,
                    "checkCount": committed.state.check_count,
                }),
            )
            .await;
            match committed.disposition {
                TriggerCommitDisposition::Quiet | TriggerCommitDisposition::Deduplicated => {
                    let mut updated = task.clone();
                    if cause == DetectorInvocationCause::Scheduled {
                        updated = match store
                            .record_scheduled_check_if_status(task_id, task.status)
                            .await?
                        {
                            Some(updated) => updated,
                            None => {
                                return Ok(CommandCheckResult::settled(RunDisposition::Stop));
                            }
                        };
                    }
                    if cause == DetectorInvocationCause::Scheduled
                        && detector_scheduled_terminal_status(
                            updated.execution_mode,
                            DetectorScheduledOutcome::QuietOrDeduplicated,
                        ) == Some(TaskStatus::Done)
                    {
                        finish_task_with_control_held(
                            store,
                            &updated,
                            "Task check completed without activation",
                            TransitionSource::EndCondition,
                            &task_control,
                        )
                        .await?;
                        return Ok(CommandCheckResult::settled(RunDisposition::Stop));
                    }
                    Ok(CommandCheckResult::settled(RunDisposition::Continue))
                }
                TriggerCommitDisposition::Activate => {
                    let pending = committed.pending_activation.ok_or_else(|| {
                        "activate commit did not return pending Activation Event".to_string()
                    })?;
                    store
                        .bind_pending_activation_queue(task_id, &pending.event.id, queue_id)
                        .await?;
                    promote_detector_to_execution(executions, task_id, queue_id).await?;
                    let reserved_session = match reserve_claimed_execution_session(
                        executions,
                        store,
                        &task,
                        queue_id,
                        session_sidecars(app_handle).await.as_ref(),
                    )
                    .await
                    {
                        Ok(reservation) => reservation,
                        Err(error) => {
                            if cause == DetectorInvocationCause::Scheduled {
                                let _ = block_task_with_control_held(
                                    store,
                                    &task,
                                    format!("Activation dispatch reservation failed: {error}"),
                                    &task_control,
                                )
                                .await;
                            }
                            return Err(error);
                        }
                    };
                    emit_execution_state_event(executions, app_handle, task_id).await;
                    drop(task_control);
                    let execution_trigger = if cause == DetectorInvocationCause::Scheduled {
                        TaskExecutionTrigger::Scheduled
                    } else {
                        TaskExecutionTrigger::Manual
                    };
                    if detach_activation {
                        let task_id_owned = task_id.to_string();
                        let queue_id_owned = queue_id.to_string();
                        let executions = Arc::clone(executions);
                        let app_handle = Arc::clone(app_handle);
                        // Establish the replacement owner before transferring the
                        // caller's claim. If the spawned future is cancelled before
                        // its first poll, Drop still surfaces the unsettled execution.
                        let claim = ExecutionClaimGuard::new(
                            Arc::clone(&executions),
                            Arc::clone(&app_handle),
                            task_id_owned.clone(),
                            queue_id_owned.clone(),
                        );
                        tauri::async_runtime::spawn(async move {
                            let result = run_one_claimed(
                                &task_id_owned,
                                &queue_id_owned,
                                &executions,
                                &app_handle,
                                execution_trigger,
                                reserved_session,
                                Some(pending),
                            )
                            .await;
                            if let Err(error) = result.as_ref() {
                                ulog_error!(
                                    "[task-scheduler] check-now activation failed task={}: {}",
                                    task_id_owned,
                                    error
                                );
                            }
                            claim.settle().await;
                            // The ordinary timer loop may be asleep at a
                            // distant target. Every detached activation result
                            // invalidates that sleep generation: terminal
                            // outcomes must retire it before rerun, successful
                            // recurring outcomes must recalculate the next
                            // target, and errors may leave a durable pending
                            // event for the loop to recover.
                            if let Some(wakeup) = schedule_wakeup {
                                wakeup.notify_one();
                            }
                        });
                        Ok(CommandCheckResult {
                            disposition: RunDisposition::Continue,
                            activation_detached: true,
                        })
                    } else {
                        run_one_claimed(
                            task_id,
                            queue_id,
                            executions,
                            app_handle,
                            execution_trigger,
                            reserved_session,
                            Some(pending),
                        )
                        .await
                        .map(CommandCheckResult::settled)
                    }
                }
            }
        }
        Err(failure) => {
            let state = match store
                .commit_detector_failure(task_id, (*failure.error).clone())
                .await
            {
                Ok(state) => state,
                Err(error) => {
                    if cause == DetectorInvocationCause::Scheduled {
                        let _ = block_task_with_control_held(
                            store,
                            &task,
                            format!("Detector failure state commit failed: {error}"),
                            &task_control,
                        )
                        .await;
                    }
                    return Err(error);
                }
            };
            let mut updated = task.clone();
            if cause == DetectorInvocationCause::Scheduled {
                updated = match store
                    .record_scheduled_check_if_status(task_id, task.status)
                    .await?
                {
                    Some(updated) => updated,
                    None => return Ok(CommandCheckResult::settled(RunDisposition::Stop)),
                };
            }
            emit_cron_ui_event(
                app_handle,
                "task:trigger-error",
                serde_json::json!({
                    "taskId": task_id,
                    "error": &failure.error,
                    "consecutiveFailures": state.consecutive_failures,
                    "backoffUntil": state.backoff_until,
                }),
            )
            .await;
            let terminal_failure = cause == DetectorInvocationCause::Scheduled
                && detector_scheduled_terminal_status(
                    updated.execution_mode,
                    DetectorScheduledOutcome::Failure {
                        consecutive_failures: state.consecutive_failures,
                    },
                ) == Some(TaskStatus::Blocked);
            if terminal_failure {
                block_task_with_control_held(
                    store,
                    &updated,
                    failure.error.message.clone(),
                    &task_control,
                )
                .await?;
                Ok(CommandCheckResult::settled(RunDisposition::Stop))
            } else {
                Ok(CommandCheckResult::settled(RunDisposition::Continue))
            }
        }
    }
}

async fn dispatch_pending_activation(
    task: &Task,
    pending: PendingTaskActivation,
    executions: &ActiveExecutions,
    app_handle: &Arc<RwLock<Option<AppHandle>>>,
    shutting_down: &AtomicBool,
    execution_trigger: TaskExecutionTrigger,
) -> Result<RunDisposition, String> {
    let control = acquire_task_control(&task.id).await;
    let Some(store) = crate::task::get_task_store() else {
        return Err("task store not initialized".to_string());
    };
    let Some(current_task) = store.get(&task.id).await else {
        return Ok(RunDisposition::Stop);
    };
    if current_task.deleted
        || (execution_trigger == TaskExecutionTrigger::Scheduled
            && current_task.status != TaskStatus::Running)
    {
        return Ok(RunDisposition::Stop);
    }
    let current_state = store.read_trigger_state(&task.id).await?;
    let Some(current_pending) = current_state
        .pending_activation
        .filter(|value| value.event.id == pending.event.id)
    else {
        return Ok(RunDisposition::Continue);
    };
    if current_task.last_activation_event_id.as_deref() == Some(current_pending.event.id.as_str()) {
        store
            .settle_pending_activation(&task.id, &current_pending.event.id)
            .await?;
        return Ok(if current_task.status == TaskStatus::Running {
            RunDisposition::Continue
        } else {
            RunDisposition::Stop
        });
    }
    let queue_id = match claim_pending_activation(
        executions,
        shutting_down,
        &task.id,
        current_pending.queue_id.as_deref(),
    )
    .await?
    {
        PendingActivationClaim::Claimed(queue_id) => queue_id,
        PendingActivationClaim::AlreadyOwned(queue_id) => {
            drop(control);
            return Ok(
                if wait_for_exact_execution_settlement(
                    executions,
                    shutting_down,
                    &task.id,
                    &queue_id,
                )
                .await
                {
                    RunDisposition::Continue
                } else {
                    RunDisposition::Stop
                },
            );
        }
    };
    let pending = match store
        .bind_pending_activation_queue(&task.id, &current_pending.event.id, &queue_id)
        .await
    {
        Ok(pending) => pending,
        Err(error) => {
            release_execution(executions, &task.id, &queue_id).await;
            return Err(error);
        }
    };
    let reserved = match reserve_claimed_execution_session(
        executions,
        store,
        &current_task,
        &queue_id,
        session_sidecars(app_handle).await.as_ref(),
    )
    .await
    {
        Ok(reserved) => reserved,
        Err(error) => {
            release_execution(executions, &task.id, &queue_id).await;
            return Err(error);
        }
    };
    emit_execution_state_event(executions, app_handle, &task.id).await;
    drop(control);

    let task_id = task.id.clone();
    let queue_id_owned = queue_id.clone();
    let executions = Arc::clone(executions);
    let app_handle = Arc::clone(app_handle);
    let worker = tauri::async_runtime::spawn(async move {
        let claim = ExecutionClaimGuard::new(
            Arc::clone(&executions),
            Arc::clone(&app_handle),
            task_id.clone(),
            queue_id_owned.clone(),
        );
        let result = run_one_claimed(
            &task_id,
            &queue_id_owned,
            &executions,
            &app_handle,
            execution_trigger,
            reserved,
            Some(pending),
        )
        .await;
        claim.settle().await;
        result
    });
    worker
        .await
        .map_err(|error| format!("pending Activation Event worker failed: {error}"))?
}

async fn run_one_claimed(
    task_id: &str,
    queue_id: &str,
    executions: &ActiveExecutions,
    app_handle: &RwLock<Option<AppHandle>>,
    trigger: TaskExecutionTrigger,
    reserved_session: Option<ReservedExecutionSession>,
    activation: Option<PendingTaskActivation>,
) -> Result<RunDisposition, String> {
    if !execution_is_authorized(executions, task_id, queue_id).await {
        return Ok(RunDisposition::Stop);
    }
    let Some(store) = crate::task::get_task_store() else {
        return Err("task store not initialized".to_string());
    };
    let Some(task) = store.get(task_id).await else {
        return Ok(RunDisposition::Stop);
    };
    if task.deleted
        || (trigger == TaskExecutionTrigger::Scheduled && task.status != TaskStatus::Running)
    {
        return Ok(RunDisposition::Stop);
    }
    let started = Instant::now();
    let handle = app_handle
        .read()
        .await
        .clone()
        .ok_or_else(|| "task scheduler app handle is unavailable".to_string());
    emit_cron_ui_event(
        app_handle,
        "cron:execution-starting",
        serde_json::json!({
            "taskId": task_id,
            "executionNumber": task.execution_count.saturating_add(1),
            "trigger": if trigger == TaskExecutionTrigger::Manual { "manual" } else { "scheduled" },
        }),
    )
    .await;
    // This reservation already resolved creation vs continuation under the
    // Session lifecycle. A later rejected request cannot undo that identity.
    let session_was_continuation = reserved_session
        .as_ref()
        .is_some_and(|reservation| !reservation.initialize_session);
    let execution = match handle.as_ref() {
        Ok(handle) => {
            execute_task_with_reservation(
                handle,
                &task,
                queue_id,
                executions,
                reserved_session,
                activation.as_ref().map(TaskActivationPayload::from),
            )
            .await
        }
        Err(error) => Err(crate::task_execution::TaskExecutionFailure {
            message: error.clone(),
            retryable: false,
        }),
    };

    let (record, outcome, preflight_failure_retryable) = match execution {
        Ok(outcome) => (
            CronRunRecord {
                ts: Utc::now().timestamp_millis(),
                ok: outcome.success,
                duration_ms: outcome.duration_ms,
                content: outcome.output_text.clone(),
                error: outcome.error.clone(),
            },
            Some(outcome),
            None,
        ),
        Err(failure) => (
            CronRunRecord {
                ts: Utc::now().timestamp_millis(),
                ok: false,
                duration_ms: started.elapsed().as_millis() as u64,
                content: None,
                error: Some(failure.message),
            },
            None,
            Some(failure.retryable),
        ),
    };

    // Terminal transport response is the idempotent compensation path when
    // Node's immediate admitted callback was lost after Runtime acceptance.
    if let Some(outcome) = outcome.as_ref().filter(|outcome| outcome.turn_dispatched) {
        if let Some(session_id) = outcome.session_id.as_deref() {
            if let Err(error) = get_task_scheduler()
                .confirm_turn_admitted(task_id, queue_id, session_id)
                .await
            {
                ulog_warn!(
                    "[task-comment] terminal admission compensation failed task={} queue={} session={}: {}",
                    task_id,
                    queue_id,
                    session_id,
                    error
                );
            }
        }
    }

    let termination_unconfirmed = outcome
        .as_ref()
        .is_some_and(|outcome| outcome.termination_unconfirmed);
    if let Some(outcome) = outcome
        .as_ref()
        .filter(|outcome| outcome.termination_unconfirmed)
    {
        retain_unconfirmed_execution(
            executions,
            task_id,
            queue_id,
            outcome.error.clone().unwrap_or_else(|| {
                "Task turn termination was not confirmed; retry stop before rerunning".to_string()
            }),
        )
        .await;
        emit_execution_state_event(executions, app_handle, task_id).await;
    }
    // The outcome commit and every externally visible consequence share the
    // same per-Task control epoch as Stop/Rerun. If control won first, the
    // exact queue check below rejects this worker. If this worker won first,
    // Stop/Rerun waits until history, notifications, and any terminal status
    // transition all belong to this generation before creating the next one.
    let task_control = acquire_task_control(task_id).await;
    let active = executions.read().await;
    let authorized = active.get(task_id).is_some_and(|execution| {
        execution_authorizes_terminal_settlement(execution, queue_id, termination_unconfirmed)
    });
    let active_session_id = active
        .get(task_id)
        .and_then(|execution| execution.session_id.clone());
    if !authorized {
        return Ok(RunDisposition::Stop);
    }
    // Runtime admission, not Detector activation, consumes the durable
    // Activation Event. A pre-admission failure still settles the Task attempt
    // through the shared retry policy, but leaves the outbox entry available
    // for the next scheduled recovery.
    let activation_admitted = activation_turn_was_admitted(activation.as_ref(), outcome.as_ref());
    let terminal = execution_terminal_transition(
        &task,
        trigger,
        activation.as_ref().map(|value| value.invocation_cause),
        &record,
        outcome.as_ref(),
        preflight_failure_retryable,
    );
    let execution_commit = store
        .settle_execution_if_status(
            task_id,
            activation
                .as_ref()
                .filter(|_| activation_admitted)
                .map(|value| value.event.id.as_str()),
            trigger,
            task.status,
            TaskExecutionSettlement {
                success: record.ok,
                duration_ms: record.duration_ms,
                session_id: outcome.as_ref().and_then(|value| value.session_id.clone()),
                error: record.error.clone(),
            },
            terminal,
        )
        .await;
    let updated = match execution_commit {
        Ok(Some(updated)) => updated,
        Ok(None) => return Ok(RunDisposition::Stop),
        Err(error) => {
            drop(active);
            if trigger == TaskExecutionTrigger::Scheduled {
                let _ = block_task_with_control_held(
                    store,
                    &task,
                    format!("Task execution commit failed; scheduler stopped: {error}"),
                    &task_control,
                )
                .await;
            }
            if let (Ok(handle), Some(current)) = (handle.as_ref(), store.get(task_id).await) {
                release_task_owner_after_attempt(
                    handle,
                    &current,
                    outcome
                        .as_ref()
                        .and_then(|value| value.session_id.as_deref())
                        .or(active_session_id.as_deref()),
                    outcome
                        .as_ref()
                        .is_some_and(|value| value.termination_unconfirmed),
                    outcome.as_ref().is_some_and(|value| value.turn_dispatched),
                    session_was_continuation,
                )
                .await;
            }
            return Err(format!("task execution commit failed: {error}"));
        }
    };
    drop(active);
    if let Some(activation) = activation.as_ref().filter(|_| activation_admitted) {
        if let Err(error) = store
            .settle_pending_activation(task_id, &activation.event.id)
            .await
        {
            // The Task row already carries the durable event receipt and
            // authoritative outcome. Startup/next check can retry clearing
            // the trigger outbox; this projection failure cannot rewrite the
            // completed Task turn.
            ulog_warn!(
                "[task-scheduler] Activation Event outbox settlement deferred task={} event={}: {}",
                task_id,
                activation.event.id,
                error
            );
        }
    }
    if let Err(error) = crate::cron_task::record_cron_run(task_id, &record).await {
        ulog_warn!(
            "[task-scheduler] run history write failed task={}: {}",
            task_id,
            error
        );
    }

    emit_cron_ui_event(
        app_handle,
        "cron:execution-complete",
        serde_json::json!({
            "taskId": task_id,
            "success": record.ok,
            "executionCount": updated.execution_count,
        }),
    )
    .await;
    if let Some(error) = record.error.as_deref() {
        emit_cron_ui_event(
            app_handle,
            "cron:execution-error",
            serde_json::json!({ "taskId": task_id, "error": error }),
        )
        .await;
    }

    if let (Ok(handle), Some(outcome)) = (handle.as_ref(), outcome.as_ref()) {
        crate::task_execution::deliver_task_result(handle, &task, outcome).await;
    }

    // Task settlement is now authoritative. Session/Browser retirement is a
    // post-commit lifecycle effect and cannot rewrite the outcome above.
    if let Ok(handle) = handle.as_ref() {
        let session_id = outcome
            .as_ref()
            .and_then(|value| value.session_id.as_deref())
            .or(active_session_id.as_deref());
        let termination_unconfirmed = outcome
            .as_ref()
            .is_some_and(|value| value.termination_unconfirmed);
        release_task_owner_after_attempt(
            handle,
            &updated,
            session_id,
            termination_unconfirmed,
            outcome.as_ref().is_some_and(|value| value.turn_dispatched),
            session_was_continuation,
        )
        .await;
    }

    if updated.status == TaskStatus::Running {
        Ok(RunDisposition::Continue)
    } else {
        Ok(RunDisposition::Stop)
    }
}

async fn emit_cron_ui_event(
    app_handle: &RwLock<Option<AppHandle>>,
    event: &str,
    payload: serde_json::Value,
) {
    if let Some(handle) = app_handle.read().await.as_ref() {
        let _ = handle.emit(event, payload);
    }
}

async fn finish_task(
    store: &crate::task::TaskStore,
    task: &Task,
    message: &str,
    source: TransitionSource,
) -> Result<(), String> {
    store
        .update_status(TaskUpdateStatusInput {
            id: task.id.clone(),
            status: TaskStatus::Done,
            message: Some(message.to_string()),
            actor: TransitionActor::System,
            source: Some(source),
        })
        .await
        .map(|_| ())
}

async fn finish_task_with_control_held(
    store: &crate::task::TaskStore,
    task: &Task,
    message: &str,
    source: TransitionSource,
    task_control: &TaskControlGuard,
) -> Result<(), String> {
    store
        .update_status_with_task_control_held(
            TaskUpdateStatusInput {
                id: task.id.clone(),
                status: TaskStatus::Done,
                message: Some(message.to_string()),
                actor: TransitionActor::System,
                source: Some(source),
            },
            task_control,
        )
        .await
        .map(|_| ())
}

async fn block_task(
    store: &crate::task::TaskStore,
    task: &Task,
    message: String,
) -> Result<(), String> {
    store
        .update_status(TaskUpdateStatusInput {
            id: task.id.clone(),
            status: TaskStatus::Blocked,
            message: Some(message),
            actor: TransitionActor::System,
            source: Some(TransitionSource::Scheduler),
        })
        .await
        .map(|_| ())
}

async fn block_task_with_control_held(
    store: &crate::task::TaskStore,
    task: &Task,
    message: String,
    task_control: &TaskControlGuard,
) -> Result<(), String> {
    store
        .update_status_with_task_control_held(
            TaskUpdateStatusInput {
                id: task.id.clone(),
                status: TaskStatus::Blocked,
                message: Some(message),
                actor: TransitionActor::System,
                source: Some(TransitionSource::Scheduler),
            },
            task_control,
        )
        .await
        .map(|_| ())
}

fn end_condition_reached(task: &Task) -> bool {
    let Some(conditions) = task.end_conditions.as_ref() else {
        return false;
    };
    conditions
        .deadline
        .is_some_and(|deadline| Utc::now().timestamp_millis() >= deadline)
        || conditions
            .max_executions
            .is_some_and(|max| task.execution_count >= max)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DetectorScheduledOutcome {
    QuietOrDeduplicated,
    Failure { consecutive_failures: u32 },
}

const RECURRING_FAILURE_BLOCK_THRESHOLD: u32 = 5;

/// Decide only the Task-level effect of a scheduled Detector result that did
/// not activate AI. Activate enters the durable AI execution path, whose
/// terminal transition is decided separately below.
fn detector_scheduled_terminal_status(
    mode: TaskExecutionMode,
    outcome: DetectorScheduledOutcome,
) -> Option<TaskStatus> {
    match outcome {
        DetectorScheduledOutcome::QuietOrDeduplicated
            if matches!(mode, TaskExecutionMode::Once | TaskExecutionMode::Scheduled) =>
        {
            Some(TaskStatus::Done)
        }
        DetectorScheduledOutcome::Failure { .. }
            if matches!(mode, TaskExecutionMode::Once | TaskExecutionMode::Scheduled) =>
        {
            Some(TaskStatus::Blocked)
        }
        DetectorScheduledOutcome::Failure {
            consecutive_failures,
        } if mode == TaskExecutionMode::Recurring
            && consecutive_failures >= RECURRING_FAILURE_BLOCK_THRESHOLD =>
        {
            Some(TaskStatus::Blocked)
        }
        DetectorScheduledOutcome::QuietOrDeduplicated
        | DetectorScheduledOutcome::Failure { .. } => None,
    }
}

fn execution_terminal_transition(
    task: &Task,
    trigger: TaskExecutionTrigger,
    invocation_cause: Option<DetectorInvocationCause>,
    record: &CronRunRecord,
    outcome: Option<&crate::task_execution::TaskExecutionOutcome>,
    preflight_failure_retryable: Option<bool>,
) -> Option<TaskExecutionTerminalTransition> {
    // Run-now remains observational. Check-now is different: when its
    // Activation Event belongs to a Running Task it is a real AI execution and
    // must honor maxExecutions/AI-exit/provider terminal semantics. For a
    // Stopped or Blocked Task, check-now remains a one-shot diagnostic and must
    // preserve the user's status choice.
    if trigger == TaskExecutionTrigger::Manual
        && (invocation_cause != Some(DetectorInvocationCause::CheckNow)
            || task.status != TaskStatus::Running)
    {
        return None;
    }
    let failure_retryable = outcome
        .map(|value| value.failure_retryable)
        .or(preflight_failure_retryable)
        .unwrap_or(true);
    let termination_unconfirmed = outcome.is_some_and(|value| value.termination_unconfirmed);
    if !record.ok
        && (termination_unconfirmed
            || !failure_retryable
            || matches!(
                task.execution_mode,
                TaskExecutionMode::Once | TaskExecutionMode::Scheduled
            )
            || task.consecutive_execution_failures.saturating_add(1)
                >= RECURRING_FAILURE_BLOCK_THRESHOLD)
    {
        return Some(TaskExecutionTerminalTransition {
            status: TaskStatus::Blocked,
            message: record
                .error
                .clone()
                .unwrap_or_else(|| "Task execution failed".to_string()),
            source: TransitionSource::Scheduler,
        });
    }
    if !record.ok {
        return None;
    }
    if let Some(reason) = outcome.and_then(|value| value.ai_exit_reason.as_ref()) {
        return Some(TaskExecutionTerminalTransition {
            status: TaskStatus::Done,
            message: reason.clone(),
            source: TransitionSource::EndCondition,
        });
    }
    let mut after_execution = task.clone();
    after_execution.execution_count = after_execution.execution_count.saturating_add(1);
    if matches!(
        task.execution_mode,
        TaskExecutionMode::Once | TaskExecutionMode::Scheduled
    ) || end_condition_reached(&after_execution)
    {
        return Some(TaskExecutionTerminalTransition {
            status: TaskStatus::Done,
            message: "Task execution completed".to_string(),
            source: TransitionSource::EndCondition,
        });
    }
    None
}

pub fn validate_task_schedule(task: &Task) -> Result<(), String> {
    match task.execution_mode {
        TaskExecutionMode::Once => Ok(()),
        TaskExecutionMode::Scheduled if task.dispatch_at.is_none() => {
            Err("Scheduled task requires dispatchAt".to_string())
        }
        TaskExecutionMode::Scheduled => Ok(()),
        TaskExecutionMode::Recurring => {
            if let Some(expression) = task.cron_expression.as_deref() {
                crate::cron_task::validate_cron_expression(
                    expression,
                    task.cron_timezone.as_deref(),
                )?;
            }
            Ok(())
        }
        TaskExecutionMode::Loop => Err("Legacy Loop tasks are retired".to_string()),
    }
}

pub fn next_execution_at(task: &Task) -> Result<Option<DateTime<Utc>>, String> {
    if task.deleted || task.status != TaskStatus::Running {
        return Ok(None);
    }
    validate_task_schedule(task)?;
    let now = Utc::now();
    let clamp = |candidate: DateTime<Utc>, seconds: i64| {
        let minimum = now + chrono::Duration::seconds(seconds);
        if candidate > minimum {
            candidate
        } else {
            minimum
        }
    };

    match task.execution_mode {
        TaskExecutionMode::Once => Ok(Some(now + chrono::Duration::seconds(2))),
        TaskExecutionMode::Scheduled => Ok(task
            .dispatch_at
            .and_then(|timestamp| Utc.timestamp_millis_opt(timestamp).single())
            .map(|target| clamp(target, 2))),
        TaskExecutionMode::Recurring => {
            if let Some(expression) = task
                .cron_expression
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return crate::cron_task::validation::next_cron_fire_time(
                    expression,
                    task.cron_timezone.as_deref(),
                )
                .map(Some);
            }

            let interval_secs = task.interval_minutes.unwrap_or(60).max(5) as i64 * 60;
            let catch_up = task.recurring_window.as_ref();
            if task.last_scheduled_at.is_none() {
                if let Some(start_at) = task.start_at.as_deref() {
                    let target = DateTime::parse_from_rfc3339(start_at)
                        .map_err(|error| format!("invalid startAt: {error}"))?
                        .with_timezone(&Utc);
                    return Ok(Some(
                        crate::cron_task::schedule::resolve_missed_interval_target(
                            target,
                            interval_secs,
                            now,
                            catch_up,
                            2,
                        ),
                    ));
                }
                return Ok(Some(now + chrono::Duration::seconds(2)));
            }
            let base = task
                .last_scheduled_at
                .and_then(|timestamp| Utc.timestamp_millis_opt(timestamp).single())
                .unwrap_or(now);
            Ok(Some(
                crate::cron_task::schedule::resolve_missed_interval_target(
                    base + chrono::Duration::seconds(interval_secs),
                    interval_secs,
                    now,
                    catch_up,
                    5,
                ),
            ))
        }
        TaskExecutionMode::Loop => Ok(None),
    }
}

/// Return `false` when a manual state change invalidated the previously
/// calculated target (for example check-now cleared a stale backoff).
async fn sleep_until_wallclock_or_wakeup(
    target: DateTime<Utc>,
    wakeup: &tokio::sync::Notify,
) -> bool {
    loop {
        let now = Utc::now();
        if now >= target {
            return true;
        }
        let seconds = (target - now).num_seconds().clamp(1, 30) as u64;
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(seconds)) => {}
            _ = wakeup.notified() => return false,
        }
    }
}

static TASK_SCHEDULER: std::sync::OnceLock<TaskSchedulerController> = std::sync::OnceLock::new();

pub fn get_task_scheduler() -> &'static TaskSchedulerController {
    TASK_SCHEDULER.get_or_init(TaskSchedulerController::new)
}

/// Exact Task-side projection of the identities rejected by Session deletion.
/// Includes transient executions plus every durable Task shape recognized by
/// `task_protected_session_ids`, including managed and legacy Tasks.
pub async fn persistent_task_session_ids() -> Vec<String> {
    let mut session_ids = get_task_scheduler()
        .executions
        .read()
        .await
        .values()
        .filter_map(|execution| execution.session_id.clone())
        .collect::<std::collections::HashSet<_>>();
    let Some(store) = crate::task::get_task_store() else {
        let mut session_ids = session_ids.into_iter().collect::<Vec<_>>();
        session_ids.sort();
        return session_ids;
    };
    for task in store
        .list(TaskListFilter {
            include_managed: Some(true),
            ..Default::default()
        })
        .await
    {
        session_ids.extend(task_protected_session_ids(&task));
    }
    let mut session_ids = session_ids.into_iter().collect::<Vec<_>>();
    session_ids.sort();
    session_ids
}

pub async fn has_persistent_task_for_session(session_id: &str) -> bool {
    if active_execution_protects_session(&get_task_scheduler().executions, session_id).await {
        return true;
    }
    let Some(store) = crate::task::get_task_store() else {
        return false;
    };
    store
        .list(TaskListFilter {
            include_managed: Some(true),
            ..Default::default()
        })
        .await
        .iter()
        .any(|task| task_protects_session_identity(task, session_id))
}

async fn active_execution_protects_session(
    executions: &ActiveExecutions,
    session_id: &str,
) -> bool {
    executions
        .read()
        .await
        .values()
        .any(|execution| execution.session_id.as_deref() == Some(session_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with_task(task: &Task) -> (tempfile::TempDir, crate::task::TaskStore) {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::write(
            data_dir.join("tasks.jsonl"),
            format!("{}\n", serde_json::to_string(task).unwrap()),
        )
        .unwrap();
        let store = crate::task::TaskStore::new(data_dir);
        (dir, store)
    }

    #[tokio::test]
    async fn update_interruption_preserves_future_idle_schedules() {
        let controller = TaskSchedulerController::new();
        let wake = Arc::new(tokio::sync::Notify::new());
        let waiter = wake.clone();
        let (send, received) = tokio::sync::oneshot::channel();
        let handle = tauri::async_runtime::spawn(async move { waiter.notified().await; let _ = send.send(()); });
        controller.handles.write().await.insert("update-idle-schedule".into(), handle);
        controller.wakeups.write().await.insert("update-idle-schedule".into(), wake.clone());
        controller.interrupt_for_update().await.unwrap();
        assert!(!controller.shutting_down.load(Ordering::SeqCst));
        assert!(controller.handles.read().await.contains_key("update-idle-schedule"));
        assert!(controller.wakeups.read().await.contains_key("update-idle-schedule"));
        wake.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(1), received).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn admitted_single_session_continues_and_accepts_comments_without_product_publication() {
        let mut task = matrix_task(TaskExecutionMode::Recurring);
        task.id = format!("unpublished-task-{}", uuid::Uuid::new_v4());
        task.run_mode = Some(crate::task::TaskRunMode::SingleSession);
        let session_id = format!("unpublished-session-{}", uuid::Uuid::new_v4());
        task.session_ids = vec![session_id.clone()];
        let (_dir, store) = store_with_task(&task);
        let manager = Arc::new(std::sync::Mutex::new(crate::sidecar::SidecarManager::new()));
        manager.lock().unwrap().insert_test_ready_frontend_sidecar(
            &session_id,
            1234,
            crate::sidecar::SidecarOwner::Task(task.id.clone()),
        );
        assert!(!session_metadata_exists(&session_id).await);
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let queue_id = claim_execution(&executions, &task.id).await.unwrap();
        let reservation = reserve_claimed_execution_session(
            &executions,
            &store,
            &task,
            &queue_id,
            Some(&manager),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(reservation.session_id, session_id);
        assert!(
            !reservation.initialize_session,
            "accepted identity must not be born twice"
        );
        drop(reservation);
        let comment = store
            .create_user_comment_with_session_probe(&task.id, "Continue here", None, |sid| {
                crate::sidecar::session_lifecycle::session_exists_for_continuation(&manager, sid)
            })
            .await
            .unwrap();
        assert_eq!(
            comment.conversation_session_id.as_deref(),
            Some(session_id.as_str())
        );
        assert_eq!(
            store.get(&task.id).await.unwrap().session_ids,
            vec![session_id]
        );
        release_execution(&executions, &task.id, &queue_id).await;
    }

    #[tokio::test]
    async fn rejected_continuation_preserves_previously_admitted_unpublished_session() {
        let mut task = matrix_task(TaskExecutionMode::Recurring);
        task.id = format!("unpublished-retry-{}", uuid::Uuid::new_v4());
        task.run_mode = Some(crate::task::TaskRunMode::SingleSession);
        let (_dir, store) = store_with_task(&task);
        let manager = Arc::new(std::sync::Mutex::new(crate::sidecar::SidecarManager::new()));
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let first_queue = claim_execution(&executions, &task.id).await.unwrap();
        let first = reserve_claimed_execution_session(
            &executions,
            &store,
            &task,
            &first_queue,
            Some(&manager),
        )
        .await
        .unwrap()
        .unwrap();
        let session_id = first.session_id.clone();
        assert!(first.initialize_session);
        assert!(
            !should_retain_task_owner_after_attempt(
                &task,
                Some(&session_id),
                false,
                false,
                !first.initialize_session,
            ),
            "a genuinely unadmitted birth still releases its owner"
        );
        manager.lock().unwrap().insert_test_ready_frontend_sidecar(
            &session_id,
            1234,
            crate::sidecar::SidecarOwner::Task(task.id.clone()),
        );
        drop(first);
        assert!(
            clear_pending_session_birth(&executions, &task.id, &first_queue, &session_id).await
        );
        // The exact admission path persists the relation independently of the product index.
        store
            .append_session_and_claim_pending_comments(&task.id, &session_id)
            .await
            .unwrap();
        assert!(should_retain_task_owner_after_attempt(
            &task,
            Some(&session_id),
            false,
            true,
            false,
        ));
        release_execution(&executions, &task.id, &first_queue).await;

        task = store.get(&task.id).await.unwrap();
        for _ in 0..2 {
            let queue_id = claim_execution(&executions, &task.id).await.unwrap();
            let continuation = reserve_claimed_execution_session(
                &executions,
                &store,
                &task,
                &queue_id,
                Some(&manager),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(continuation.session_id, session_id);
            assert!(!continuation.initialize_session);
            assert!(!session_metadata_exists(&session_id).await);
            assert!(
                should_retain_task_owner_after_attempt(
                    &task,
                    Some(&session_id),
                    false,
                    false,
                    !continuation.initialize_session,
                ),
                "a rejected later attempt cannot retire an established Session"
            );
            drop(continuation);
            release_execution(&executions, &task.id, &queue_id).await;
        }
        task.status = TaskStatus::Stopped;
        assert!(
            !should_retain_task_owner_after_attempt(&task, Some(&session_id), false, false, true,),
            "terminal Task lifecycle still retires its owner"
        );
    }

    #[tokio::test]
    async fn terminal_status_write_failures_remain_retryable() {
        let mut task = matrix_task(TaskExecutionMode::Recurring);
        task.id = format!("task-transition-retry-{}", uuid::Uuid::new_v4());
        let (dir, store) = store_with_task(&task);
        let data_dir = dir.path().join("data");
        std::fs::remove_dir_all(&data_dir).unwrap();
        std::fs::write(&data_dir, "not-a-directory").unwrap();
        let control = acquire_task_control(&task.id).await;

        assert!(finish_task_with_control_held(
            &store,
            &task,
            "done",
            TransitionSource::EndCondition,
            &control,
        )
        .await
        .is_err());
        assert_eq!(
            store.get(&task.id).await.unwrap().status,
            TaskStatus::Running
        );

        assert!(
            block_task_with_control_held(&store, &task, "blocked".to_string(), &control,)
                .await
                .is_err()
        );
        assert_eq!(
            store.get(&task.id).await.unwrap().status,
            TaskStatus::Running
        );

        let wakeup = tokio::sync::Notify::new();
        wakeup.notify_one();
        assert!(
            retry_running_scheduler_after_transition_failure(
                &store,
                &task.id,
                &wakeup,
                Err("persist failed".to_string()),
            )
            .await
        );
    }

    #[tokio::test]
    async fn stop_fences_a_claimed_execution_before_runtime_dispatch() {
        let controller = TaskSchedulerController::new();
        let queue_id = claim_execution(&controller.executions, "task-1")
            .await
            .expect("claim execution");

        assert!(controller.authorize_dispatch("task-1", &queue_id).await);
        controller.cancel_execution("task-1").await;
        assert!(!controller.authorize_dispatch("task-1", &queue_id).await);

        release_execution(&controller.executions, "task-1", &queue_id).await;
        assert!(!controller.is_executing("task-1").await);
    }

    #[tokio::test]
    async fn shutdown_gate_rejects_every_new_execution_kind() {
        let controller = TaskSchedulerController::new();
        controller.shutting_down.store(true, Ordering::SeqCst);

        assert!(claim_execution_if_open(
            &controller.executions,
            &controller.shutting_down,
            "run-now"
        )
        .await
        .is_err());
        assert!(claim_detector_invocation(
            &controller.executions,
            &controller.shutting_down,
            "detector"
        )
        .await
        .is_err());
        assert!(claim_pending_activation(
            &controller.executions,
            &controller.shutting_down,
            "pending",
            None
        )
        .await
        .is_err());
        assert!(controller.executions.read().await.is_empty());
    }

    #[tokio::test]
    async fn detector_finish_before_wait_is_observed_without_timeout() {
        let lifecycle = DetectorExecutionLifecycle::new();
        lifecycle.finish();

        assert!(
            tokio::time::timeout(Duration::from_millis(50), lifecycle.wait_finished())
                .await
                .expect("a completed Detector lifecycle must not wait for the 8s fallback")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_cancels_a_draft_detector_test_owned_by_the_task() {
        let app = tauri::test::mock_app();
        let controller = TaskSchedulerController::new();
        let task_id = "draft-detector-owner";
        let control = try_acquire_task_control(task_id).await.unwrap();
        let (queue_id, detector) =
            claim_detector_invocation(&controller.executions, &controller.shutting_down, task_id)
                .await
                .unwrap();
        let worker = tauri::async_runtime::spawn(run_test_detector_claimed(
            task_id.to_string(),
            queue_id,
            Arc::clone(&controller.executions),
            Arc::clone(&controller.app_handle),
            app.handle().clone(),
            DetectorRunRequest {
                task_id: task_id.to_string(),
                workspace_path: "/tmp".to_string(),
                trigger: crate::task_trigger::TaskTrigger {
                    source: crate::task_trigger::TaskTriggerSource::Time,
                    detector: crate::task_trigger::TaskTriggerDetector::Command {
                        command: crate::task_trigger::TaskTriggerCommand {
                            executable: "/bin/sh".to_string(),
                            args: vec!["-c".to_string(), "sleep 30".to_string()],
                            cwd: Some("/tmp".to_string()),
                        },
                        timeout_ms: Some(30_000),
                    },
                },
                cause: DetectorInvocationCause::Test,
                scheduled_at: None,
                checkpoint: None,
                checkpoint_revision: 0,
                checkpoint_updated_at: None,
            },
            detector,
        ));
        drop(control);

        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if controller.is_executing(task_id).await {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let stop_control = acquire_task_control(task_id).await;
        controller
            .stop_with_control_held(task_id, &stop_control)
            .await
            .unwrap();
        let result = worker.await.unwrap();

        assert!(result.is_err());
        assert!(!controller.is_executing(task_id).await);
    }

    #[test]
    fn detector_test_checkpoint_sources_are_explicit_and_read_only() {
        let current_checkpoint =
            serde_json::Map::from_iter([("cursor".to_string(), serde_json::json!(41))]);
        let state = crate::task_trigger::TaskTriggerRuntimeState {
            checkpoint: Some(current_checkpoint.clone()),
            checkpoint_revision: 7,
            checkpoint_updated_at: Some(1_722_656_400_000),
            ..Default::default()
        };

        assert_eq!(
            detector_test_checkpoint_snapshot(&state, None),
            (7, Some(current_checkpoint.clone()), Some(1_722_656_400_000)),
            "task-id tests read the Task's current durable checkpoint"
        );

        let fixture = serde_json::Map::from_iter([("cursor".to_string(), serde_json::json!(99))]);
        assert_eq!(
            detector_test_checkpoint_snapshot(&state, Some(Some(fixture.clone()))),
            (0, Some(fixture), None),
            "an explicit CLI fixture is an isolated revision-zero snapshot"
        );
        assert_eq!(
            detector_test_checkpoint_snapshot(&state, Some(None)),
            (0, None, None),
            "a spec-file test starts from an explicit null checkpoint"
        );
        assert_eq!(state.checkpoint, Some(current_checkpoint));
        assert_eq!(state.checkpoint_revision, 7);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn aborting_a_detector_test_request_cancels_the_tree_and_releases_its_claim() {
        let app = tauri::test::mock_app();
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let app_handle: Arc<RwLock<Option<AppHandle>>> = Arc::new(RwLock::new(None));
        let shutting_down = Arc::new(AtomicBool::new(false));
        let owner_id = "detector-request-abort".to_string();
        let (queue_id, detector) =
            claim_detector_invocation(&executions, &shutting_down, &owner_id)
                .await
                .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let child_pid_path = dir.path().join("test-request-child.pid");
        let trigger = crate::task_trigger::TaskTrigger {
            source: crate::task_trigger::TaskTriggerSource::Time,
            detector: crate::task_trigger::TaskTriggerDetector::Command {
                command: crate::task_trigger::TaskTriggerCommand {
                    executable: "/bin/sh".to_string(),
                    args: vec![
                        "-c".to_string(),
                        "sleep 30 & echo $! > \"$1\"; wait".to_string(),
                        "detector".to_string(),
                        child_pid_path.to_string_lossy().into_owned(),
                    ],
                    cwd: Some(dir.path().to_string_lossy().into_owned()),
                },
                timeout_ms: Some(30_000),
            },
        };
        let workspace_path = dir.path().to_string_lossy().into_owned();
        let executions_for_request = Arc::clone(&executions);
        let app_handle_for_request = Arc::clone(&app_handle);
        let mock_handle = app.handle().clone();
        let request = tauri::async_runtime::spawn(async move {
            let mut request_guard =
                DetectorRequestCancellationGuard::new(detector.cancellation.clone());
            let worker = tauri::async_runtime::spawn(run_test_detector_claimed(
                owner_id,
                queue_id,
                executions_for_request,
                app_handle_for_request,
                mock_handle,
                DetectorRunRequest {
                    task_id: "detector-request-abort".to_string(),
                    workspace_path,
                    trigger,
                    cause: DetectorInvocationCause::Test,
                    scheduled_at: None,
                    checkpoint: None,
                    checkpoint_revision: 0,
                    checkpoint_updated_at: None,
                },
                detector,
            ));
            let result = worker.await.expect("Detector worker must not panic");
            request_guard.disarm();
            result
        });

        let child_pid = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Ok(value) = std::fs::read_to_string(&child_pid_path) {
                    if let Ok(pid) = value.trim().parse::<u32>() {
                        break pid;
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("Detector descendant must become observable before request abort");

        request.abort();
        assert!(request.await.is_err(), "the request future must be aborted");
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if executions.read().await.is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the detached worker must settle and release its exact claim");

        let still_alive = crate::process_cmd::new("/bin/sh")
            .args(["-c", &format!("kill -0 {child_pid} 2>/dev/null")])
            .status()
            .expect("probe Detector descendant")
            .success();
        assert!(
            !still_alive,
            "Detector descendant {child_pid} survived request cancellation"
        );

        let quiet = r#"{"protocolVersion":1,"control":{"decision":"quiet","reason":{"code":"request_recovered","message":"recovered"}}}"#;
        let (next_queue_id, next_detector) =
            claim_detector_invocation(&executions, &shutting_down, "detector-request-abort")
                .await
                .expect("a later test must be admitted after exact cleanup");
        let next_result = run_test_detector_claimed(
            "detector-request-abort".to_string(),
            next_queue_id,
            Arc::clone(&executions),
            Arc::clone(&app_handle),
            app.handle().clone(),
            DetectorRunRequest {
                task_id: "detector-request-abort".to_string(),
                workspace_path: dir.path().to_string_lossy().into_owned(),
                trigger: crate::task_trigger::TaskTrigger {
                    source: crate::task_trigger::TaskTriggerSource::Time,
                    detector: crate::task_trigger::TaskTriggerDetector::Command {
                        command: crate::task_trigger::TaskTriggerCommand {
                            executable: "/bin/sh".to_string(),
                            args: vec!["-c".to_string(), format!("printf '%s' '{quiet}'")],
                            cwd: Some(dir.path().to_string_lossy().into_owned()),
                        },
                        timeout_ms: Some(5_000),
                    },
                },
                cause: DetectorInvocationCause::Test,
                scheduled_at: None,
                checkpoint: None,
                checkpoint_revision: 0,
                checkpoint_updated_at: None,
            },
            next_detector,
        )
        .await
        .expect("a later Detector process must complete after cleanup");
        assert_eq!(
            next_result.decision,
            crate::task_trigger::DetectorDecision::Quiet
        );
    }

    #[tokio::test]
    async fn detached_check_now_pending_queue_is_waited_not_redispatched() {
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let shutting_down = Arc::new(AtomicBool::new(false));
        let queue_id = match claim_pending_activation(
            &executions,
            &shutting_down,
            "task-detached-check",
            Some("queue-check-now"),
        )
        .await
        .unwrap()
        {
            PendingActivationClaim::Claimed(queue_id) => queue_id,
            PendingActivationClaim::AlreadyOwned(_) => panic!("first owner must claim"),
        };
        assert_eq!(queue_id, "queue-check-now");
        assert_eq!(
            claim_pending_activation(
                &executions,
                &shutting_down,
                "task-detached-check",
                Some("queue-check-now"),
            )
            .await
            .unwrap(),
            PendingActivationClaim::AlreadyOwned(queue_id.clone())
        );

        let waiter_executions = Arc::clone(&executions);
        let waiter_shutdown = Arc::clone(&shutting_down);
        let waiter_queue = queue_id.clone();
        let mut waiter = tauri::async_runtime::spawn(async move {
            wait_for_exact_execution_settlement(
                &waiter_executions,
                &waiter_shutdown,
                "task-detached-check",
                &waiter_queue,
            )
            .await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut waiter)
                .await
                .is_err(),
            "recovery must wait for the live exact owner"
        );
        release_execution(&executions, "task-detached-check", &queue_id).await;
        assert!(tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("waiter should observe exact settlement")
            .expect("waiter should not panic"));
        assert!(executions.read().await.is_empty());
    }

    #[tokio::test]
    async fn scheduler_sleep_reloads_a_rerun_that_follows_terminal_check_now() {
        let controller = TaskSchedulerController::new();
        let wakeup = Arc::new(tokio::sync::Notify::new());
        let waiter_wakeup = Arc::clone(&wakeup);
        let authoritative_status = Arc::new(RwLock::new(TaskStatus::Done));
        let waiter_status = Arc::clone(&authoritative_status);
        controller
            .wakeups
            .write()
            .await
            .insert("task-check-now".to_string(), wakeup);
        let waiter = tauri::async_runtime::spawn(async move {
            let reached_deadline = sleep_until_wallclock_or_wakeup(
                Utc::now() + chrono::Duration::minutes(5),
                &waiter_wakeup,
            )
            .await;
            (reached_deadline, *waiter_status.read().await)
        });
        tokio::task::yield_now().await;
        *authoritative_status.write().await = TaskStatus::Running;
        controller.wake_task_schedule("task-check-now").await;
        let (reached_deadline, observed_status) =
            tokio::time::timeout(Duration::from_secs(1), waiter)
                .await
                .expect("manual wake should not wait for the stale deadline")
                .expect("waiter should not panic");
        assert!(!reached_deadline);
        assert_eq!(
            observed_status,
            TaskStatus::Running,
            "the awakened scheduler must reload a rerun committed after check-now terminalized"
        );
    }

    #[tokio::test]
    async fn stale_execution_generation_cannot_authorize_after_rerun_claims() {
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let first_queue = claim_execution(&executions, "task-rerun").await.unwrap();
        release_execution(&executions, "task-rerun", &first_queue).await;
        let second_queue = claim_execution(&executions, "task-rerun").await.unwrap();

        assert_ne!(first_queue, second_queue);
        assert!(!execution_is_authorized(&executions, "task-rerun", &first_queue).await);
        assert!(execution_is_authorized(&executions, "task-rerun", &second_queue).await);

        release_execution(&executions, "task-rerun", &second_queue).await;
    }

    #[tokio::test]
    async fn managed_batch_session_binding_requires_the_exact_live_claim() {
        let controller = TaskSchedulerController::new();
        let queue_id = claim_execution(&controller.executions, "managed-task")
            .await
            .unwrap();

        assert!(
            controller
                .bind_execution_session("managed-task", &queue_id, "session-a")
                .await
        );
        assert_eq!(
            controller
                .executions
                .read()
                .await
                .get("managed-task")
                .and_then(|execution| execution.session_id.as_deref()),
            Some("session-a")
        );
        assert!(
            !controller
                .bind_execution_session("managed-task", "stale-queue", "session-b")
                .await
        );
        controller.cancel_execution("managed-task").await;
        assert!(
            !controller
                .bind_execution_session("managed-task", &queue_id, "session-b")
                .await
        );

        release_execution(&controller.executions, "managed-task", &queue_id).await;
    }

    #[tokio::test]
    async fn task_control_serializes_only_the_same_task() {
        let first_task = format!("task-control-first-{}", uuid::Uuid::new_v4());
        let other_task = format!("task-control-other-{}", uuid::Uuid::new_v4());
        let guard = acquire_task_control(&first_task).await;

        assert!(try_acquire_task_control(&first_task).await.is_none());
        assert!(try_acquire_task_control(&other_task).await.is_some());

        drop(guard);
        assert!(try_acquire_task_control(&first_task).await.is_some());
    }

    #[tokio::test]
    async fn run_now_reservation_keeps_a_new_session_transient_until_runtime_admission() {
        let task: Task = serde_json::from_value(serde_json::json!({
            "id": "task-run-now",
            "name": "run now",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp/workspace",
            "executionMode": "recurring",
            "runMode": "new-session",
            "intervalMinutes": 60,
            "sessionIds": ["previous-run"],
            "status": "stopped",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();
        let (_dir, store) = store_with_task(&task);
        let task = store.get("task-run-now").await.unwrap();
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let queue_id = claim_execution(&executions, &task.id).await.unwrap();

        let returned_session =
            reserve_claimed_execution_session(&executions, &store, &task, &queue_id, None)
                .await
                .unwrap()
                .expect("ordinary Task execution must reserve a Session");

        let bound_session = executions
            .read()
            .await
            .get(&task.id)
            .and_then(|execution| execution.session_id.clone());
        let persisted = store.get(&task.id).await.unwrap();
        assert_ne!(returned_session.session_id, "previous-run");
        assert_eq!(
            bound_session.as_deref(),
            Some(returned_session.session_id.as_str())
        );
        assert_eq!(
            persisted.session_ids.last().map(String::as_str),
            Some("previous-run"),
            "new-session relation is persisted only by the Runtime admission callback"
        );

        drop(returned_session);
        release_execution(&executions, &task.id, &queue_id).await;
    }

    #[tokio::test]
    async fn metadata_birth_releases_lifecycle_while_execution_remains_active() {
        let session_id = format!("shared-session-{}", uuid::Uuid::new_v4());
        let task: Task = serde_json::from_value(serde_json::json!({
            "id": "task-shared-session",
            "name": "shared session",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp/workspace",
            "executionMode": "recurring",
            "runMode": "single-session",
            "preselectedSessionId": session_id.clone(),
            "intervalMinutes": 60,
            "sessionIds": [],
            "status": "running",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();
        let (_dir, store) = store_with_task(&task);
        let task = store.get(&task.id).await.unwrap();
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let queue_id = claim_execution(&executions, &task.id).await.unwrap();
        let reservation =
            reserve_claimed_execution_session(&executions, &store, &task, &queue_id, None)
                .await
                .unwrap()
                .expect("ordinary Task execution must reserve a Session");
        assert_ne!(reservation.session_id, session_id);
        assert!(reservation.initialize_session);
        let rebound = store.get(&task.id).await.unwrap();
        assert_eq!(
            rebound.preselected_session_id.as_deref(),
            Some(reservation.session_id.as_str())
        );
        assert!(!rebound.session_ids.iter().any(|value| value == &session_id));
        assert!(rebound
            .session_ids
            .iter()
            .any(|value| value == &reservation.session_id));

        let (acquired_tx, mut acquired_rx) = tokio::sync::mpsc::unbounded_channel();
        let session_for_waiter = reservation.session_id.clone();
        let waiter = tauri::async_runtime::spawn(async move {
            let _guard = crate::sidecar::acquire_session_lifecycle(&[&session_for_waiter]).await;
            let _ = acquired_tx.send(());
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), acquired_rx.recv())
                .await
                .is_err(),
            "a Starting joiner must remain behind the creator's metadata-birth boundary"
        );

        let reservation_session_id = reservation.session_id.clone();
        let dispatch_lifecycle = Arc::clone(&reservation.birth_lifecycle);
        drop(reservation);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), acquired_rx.recv())
                .await
                .is_err(),
            "dispatch must share the reservation's existing lifecycle acquisition"
        );
        drop(dispatch_lifecycle);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), acquired_rx.recv())
                .await
                .is_err(),
            "dropping the worker-side leases must not release exact-generation birth authority"
        );
        assert!(
            clear_pending_session_birth(&executions, &task.id, &queue_id, &reservation_session_id)
                .await,
            "metadata birth must clear only the exact generation's long-lived lease"
        );
        assert!(
            executions.read().await.contains_key(&task.id),
            "the AI turn remains active after Session metadata is born"
        );
        tokio::time::timeout(std::time::Duration::from_secs(2), acquired_rx.recv())
            .await
            .expect("joiner should acquire after metadata birth, before the AI turn completes")
            .expect("joiner should report its acquisition");
        tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
            .await
            .expect("joiner should resume after metadata birth")
            .expect("joiner task should not panic");
        release_execution(&executions, &task.id, &queue_id).await;
    }

    #[tokio::test]
    async fn abandoned_worker_keeps_birth_lifecycle_until_metadata_observer_clears_it() {
        let task_id = "task-abandoned-birth";
        let session_id = format!("abandoned-birth-{}", uuid::Uuid::new_v4());
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let queue_id = claim_execution(&executions, task_id).await.unwrap();
        let lifecycle = Arc::new(crate::sidecar::acquire_session_lifecycle(&[&session_id]).await);
        {
            let mut active = executions.write().await;
            let execution = active.get_mut(task_id).unwrap();
            execution.session_id = Some(session_id.clone());
            execution.pending_session_birth = Some(PendingSessionBirth {
                session_id: session_id.clone(),
                _lifecycle: Arc::clone(&lifecycle),
            });
        }
        drop(lifecycle);
        let claim = ExecutionClaimGuard::new(
            Arc::clone(&executions),
            Arc::new(RwLock::new(None)),
            task_id.to_string(),
            queue_id.clone(),
        );
        drop(claim);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if executions
                    .read()
                    .await
                    .get(task_id)
                    .is_some_and(|execution| execution.state == TaskExecutionState::StopFailed)
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("abandoned worker should become a visible StopFailed generation");

        let (acquired_tx, mut acquired_rx) = tokio::sync::mpsc::unbounded_channel();
        let session_for_waiter = session_id.clone();
        let waiter = tauri::async_runtime::spawn(async move {
            let _guard = crate::sidecar::acquire_session_lifecycle(&[&session_for_waiter]).await;
            let _ = acquired_tx.send(());
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(75), acquired_rx.recv())
                .await
                .is_err(),
            "worker loss must not release exact-generation birth authority"
        );

        assert!(clear_pending_session_birth(&executions, task_id, &queue_id, &session_id).await);
        tokio::time::timeout(std::time::Duration::from_secs(2), acquired_rx.recv())
            .await
            .expect("metadata birth should release the exact generation's lease")
            .expect("next creator should report its acquisition");
        tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
            .await
            .expect("next creator should finish after metadata birth")
            .expect("next creator should not panic");
        release_execution(&executions, task_id, &queue_id).await;
    }

    #[tokio::test]
    async fn managed_batch_reservation_does_not_bind_or_persist_a_session() {
        let task: Task = serde_json::from_value(serde_json::json!({
            "id": "managed-batch",
            "name": "memory batch",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp/workspace",
            "executionMode": "recurring",
            "runMode": "new-session",
            "intervalMinutes": 60,
            "managedKind": "memory_auto_update_batch",
            "sessionIds": [],
            "status": "stopped",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();
        let (_dir, store) = store_with_task(&task);
        let task = store.get("managed-batch").await.unwrap();
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let queue_id = claim_execution(&executions, &task.id).await.unwrap();

        let reserved =
            reserve_claimed_execution_session(&executions, &store, &task, &queue_id, None)
                .await
                .unwrap();

        let bound_session = executions
            .read()
            .await
            .get(&task.id)
            .and_then(|execution| execution.session_id.clone());
        let persisted = store.get(&task.id).await.unwrap();
        assert!(reserved.is_none());
        assert_eq!(bound_session, None);
        assert!(persisted.session_ids.is_empty());

        release_execution(&executions, &task.id, &queue_id).await;
    }

    #[tokio::test]
    async fn active_execution_protects_its_reserved_session_until_release() {
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        executions.write().await.insert(
            "task-1".to_string(),
            ActiveTaskExecution {
                queue_id: "queue-1".to_string(),
                canceled: false,
                session_id: Some("session-1".to_string()),
                pending_session_birth: None,
                state: TaskExecutionState::Running,
                error: None,
                detector: None,
            },
        );

        assert!(active_execution_protects_session(&executions, "session-1").await);
        release_execution(&executions, "task-1", "queue-1").await;
        assert!(!active_execution_protects_session(&executions, "session-1").await);
    }

    #[tokio::test]
    async fn abandoned_worker_claim_becomes_visible_stop_failure() {
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let app_handle = Arc::new(RwLock::new(None));
        let queue_id = claim_execution(&executions, "task-abandoned")
            .await
            .unwrap();
        let claim = ExecutionClaimGuard::new(
            Arc::clone(&executions),
            app_handle,
            "task-abandoned".to_string(),
            queue_id,
        );

        drop(claim);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let state = executions
                    .read()
                    .await
                    .get("task-abandoned")
                    .map(|execution| execution.state);
                if state == Some(TaskExecutionState::StopFailed) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("Drop cleanup should surface an unsettled worker");
    }

    #[tokio::test]
    async fn worker_settlement_does_not_clear_an_unconfirmed_stop() {
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let app_handle = Arc::new(RwLock::new(None));
        let queue_id = claim_execution(&executions, "task-stop-failed")
            .await
            .unwrap();
        {
            let mut active = executions.write().await;
            let execution = active.get_mut("task-stop-failed").unwrap();
            execution.canceled = true;
            execution.state = TaskExecutionState::StopFailed;
            execution.error = Some("stop not confirmed".to_string());
        }
        let claim = ExecutionClaimGuard::new(
            Arc::clone(&executions),
            app_handle,
            "task-stop-failed".to_string(),
            queue_id.clone(),
        );

        claim.settle().await;

        let active = executions.read().await;
        let execution = active.get("task-stop-failed").unwrap();
        assert_eq!(execution.queue_id, queue_id);
        assert_eq!(execution.state, TaskExecutionState::StopFailed);
    }

    #[tokio::test]
    async fn runtime_termination_ambiguity_keeps_the_exact_execution_retryable() {
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let app_handle = Arc::new(RwLock::new(None));
        let queue_id = claim_execution(&executions, "task-orphan").await.unwrap();
        retain_unconfirmed_execution(
            &executions,
            "task-orphan",
            &queue_id,
            "runtime process may still be alive".to_string(),
        )
        .await;
        let claim = ExecutionClaimGuard::new(
            Arc::clone(&executions),
            app_handle,
            "task-orphan".to_string(),
            queue_id.clone(),
        );

        claim.settle().await;

        let active = executions.read().await;
        let execution = active.get("task-orphan").unwrap();
        assert_eq!(execution.queue_id, queue_id);
        assert!(execution.canceled);
        assert_eq!(execution.state, TaskExecutionState::StopFailed);
        assert_eq!(
            execution.error.as_deref(),
            Some("runtime process may still be alive")
        );
    }

    #[tokio::test]
    async fn runtime_termination_ambiguity_still_authorizes_terminal_settlement() {
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let queue_id = claim_execution(&executions, "task-orphan-settlement")
            .await
            .unwrap();
        retain_unconfirmed_execution(
            &executions,
            "task-orphan-settlement",
            &queue_id,
            "runtime process may still be alive".to_string(),
        )
        .await;

        let active = executions.read().await;
        let execution = active.get("task-orphan-settlement").unwrap();
        assert!(execution_authorizes_terminal_settlement(
            execution, &queue_id, true,
        ));
        assert!(!execution_authorizes_terminal_settlement(
            execution,
            "another-generation",
            true,
        ));
        assert!(!execution_authorizes_terminal_settlement(
            execution, &queue_id, false,
        ));
    }

    #[test]
    fn attached_task_protects_its_session_until_terminal_completion() {
        let mut task: Task = serde_json::from_value(serde_json::json!({
            "id": "attached-task",
            "name": "Space issue",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp/workspace",
            "executionMode": "once",
            "sessionIds": ["session-1"],
            "status": "running",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "attached-session"
        }))
        .unwrap();

        for status in [
            TaskStatus::Todo,
            TaskStatus::Running,
            TaskStatus::Verifying,
            TaskStatus::Blocked,
            TaskStatus::Stopped,
        ] {
            task.status = status;
            assert!(task_protects_session_identity(&task, "session-1"));
        }
        for status in [TaskStatus::Done, TaskStatus::Archived, TaskStatus::Deleted] {
            task.status = status;
            assert!(!task_protects_session_identity(&task, "session-1"));
        }
        task.status = TaskStatus::Running;
        task.deleted = true;
        assert!(!task_protects_session_identity(&task, "session-1"));
    }

    #[test]
    fn only_running_direct_single_session_tasks_protect_idle_identity() {
        let mut task: Task = serde_json::from_value(serde_json::json!({
            "id": "direct-task",
            "name": "Direct",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp/workspace",
            "executionMode": "recurring",
            "runMode": "single-session",
            "preselectedSessionId": "session-1",
            "sessionIds": [],
            "status": "running",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();

        assert!(task_protects_session_identity(&task, "session-1"));
        task.status = TaskStatus::Stopped;
        assert!(!task_protects_session_identity(&task, "session-1"));
        task.status = TaskStatus::Running;
        task.run_mode = Some(crate::task::TaskRunMode::NewSession);
        assert!(!task_protects_session_identity(&task, "session-1"));
    }

    #[test]
    fn loop_is_not_a_valid_task_schedule() {
        let mut task: Task = serde_json::from_value(serde_json::json!({
            "id": "task-1",
            "name": "test",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp/workspace",
            "executionMode": "loop",
            "sessionIds": [],
            "status": "running",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();
        task.execution_mode = TaskExecutionMode::Loop;
        assert!(validate_task_schedule(&task).is_err());
    }

    #[test]
    fn recurring_start_at_is_the_first_trigger_anchor() {
        let task: Task = serde_json::from_value(serde_json::json!({
            "id": "task-start-at",
            "name": "Memory Gardener",
            "executor": "agent",
            "workspaceId": "ws",
            "workspacePath": "/tmp/ws",
            "executionMode": "recurring",
            "intervalMinutes": 4320,
            "startAt": "2099-07-08T00:00:00Z",
            "sessionIds": [],
            "status": "running",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .expect("task json");

        assert_eq!(
            next_execution_at(&task).unwrap().unwrap().to_rfc3339(),
            "2099-07-08T00:00:00+00:00"
        );
    }

    #[test]
    fn manual_history_does_not_skip_the_first_scheduled_anchor() {
        let task: Task = serde_json::from_value(serde_json::json!({
            "id": "task-manual-first",
            "name": "Memory Gardener",
            "executor": "agent",
            "workspaceId": "ws",
            "workspacePath": "/tmp/ws",
            "executionMode": "recurring",
            "intervalMinutes": 4320,
            "startAt": "2099-07-08T00:00:00Z",
            "sessionIds": [],
            "status": "running",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "lastExecutedAt": 2,
            "executionCount": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();

        assert_eq!(
            next_execution_at(&task).unwrap().unwrap().to_rfc3339(),
            "2099-07-08T00:00:00+00:00"
        );
    }

    #[test]
    fn recurring_schedule_uses_the_last_timer_run_not_run_now() {
        let now = Utc::now();
        let scheduled = now - chrono::Duration::minutes(10);
        let manual = now - chrono::Duration::minutes(1);
        let task: Task = serde_json::from_value(serde_json::json!({
            "id": "task-anchor",
            "name": "anchored",
            "executor": "agent",
            "workspaceId": "ws",
            "workspacePath": "/tmp/ws",
            "executionMode": "recurring",
            "intervalMinutes": 60,
            "sessionIds": [],
            "status": "running",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "lastExecutedAt": manual.timestamp_millis(),
            "lastScheduledAt": scheduled.timestamp_millis(),
            "executionCount": 2,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();

        let next = next_execution_at(&task).unwrap().unwrap();
        let expected = scheduled + chrono::Duration::minutes(60);
        assert!((next - expected).num_seconds().abs() <= 1);
    }

    fn matrix_task(mode: TaskExecutionMode) -> Task {
        let mut task: Task = serde_json::from_value(serde_json::json!({
            "id": "task-detector-matrix",
            "name": "detector matrix",
            "executor": "agent",
            "workspaceId": "ws",
            "workspacePath": "/tmp/ws",
            "executionMode": "once",
            "sessionIds": [],
            "status": "running",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "executionCount": 0,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();
        task.execution_mode = mode;
        task
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn quiet_detector_check_never_reserves_or_persists_a_session() {
        let workspace = tempfile::tempdir().unwrap();
        let mut task = matrix_task(TaskExecutionMode::Recurring);
        task.id = format!("task-quiet-no-session-{}", uuid::Uuid::new_v4());
        task.workspace_path = workspace.path().to_string_lossy().into_owned();
        task.run_mode = Some(crate::task::TaskRunMode::NewSession);
        task.preselected_session_id = None;
        task.session_ids.clear();
        let quiet = r#"{"protocolVersion":1,"control":{"decision":"quiet","reason":{"code":"unchanged","message":"No change"}}}"#;
        task.trigger = Some(crate::task_trigger::TaskTrigger {
            source: crate::task_trigger::TaskTriggerSource::Time,
            detector: crate::task_trigger::TaskTriggerDetector::Command {
                command: crate::task_trigger::TaskTriggerCommand {
                    executable: "/bin/sh".to_string(),
                    args: vec!["-c".to_string(), format!("printf '%s' '{quiet}'")],
                    cwd: Some(workspace.path().to_string_lossy().into_owned()),
                },
                timeout_ms: Some(5_000),
            },
        });
        let (_store_dir, store) = store_with_task(&task);
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let shutting_down = Arc::new(AtomicBool::new(false));
        let app_handle: Arc<RwLock<Option<AppHandle>>> = Arc::new(RwLock::new(None));
        let (queue_id, detector) = claim_detector_invocation(&executions, &shutting_down, &task.id)
            .await
            .unwrap();

        let result = run_command_check_claimed(
            &task.id,
            &queue_id,
            &store,
            &executions,
            &app_handle,
            CommandCheckInvocation {
                cause: DetectorInvocationCause::CheckNow,
                scheduled_at: None,
                detector_lifecycle: detector,
                detach_activation: true,
                schedule_wakeup: None,
                detector_result_override: Some(Ok(crate::task_trigger::DetectorRunSuccess {
                    invocation_id: "quiet-no-session".to_string(),
                    decision: crate::task_trigger::DetectorDecision::Quiet,
                    reason: crate::task_trigger::TaskTriggerReason {
                        code: "unchanged".to_string(),
                        message: "No change".to_string(),
                    },
                    event: None,
                    handoff: None,
                    next_checkpoint: None,
                    duration_ms: 1,
                    exit_code: 0,
                    stderr_tail: None,
                })),
            },
        )
        .await
        .expect("quiet check should commit successfully");

        assert!(!result.activation_detached);
        assert!(matches!(result.disposition, RunDisposition::Continue));
        let active = executions.read().await;
        let exact = active
            .get(&task.id)
            .expect("Detector claim remains caller-owned");
        assert_eq!(exact.state, TaskExecutionState::Checking);
        assert_eq!(exact.session_id, None);
        assert!(exact.pending_session_birth.is_none());
        drop(active);
        assert!(
            store.get(&task.id).await.unwrap().session_ids.is_empty(),
            "quiet must not persist a Session identity"
        );
        release_execution(&executions, &task.id, &queue_id).await;
    }

    fn matrix_pending(cause: DetectorInvocationCause) -> PendingTaskActivation {
        PendingTaskActivation {
            event: crate::task_trigger::TaskActivationEvent {
                id: "event-matrix".to_string(),
                kind: "state.changed".to_string(),
                occurred_at: "2026-08-03T09:30:00Z".to_string(),
            },
            handoff: crate::task_trigger::TaskActivationHandoff {
                summary: "State changed".to_string(),
                text: None,
                data: None,
            },
            reason: crate::task_trigger::TaskTriggerReason {
                code: "changed".to_string(),
                message: "Changed".to_string(),
            },
            invocation_cause: cause,
            detected_at: 1,
            task_updated_at: 1,
            delivery_state: crate::task_trigger::TaskActivationDeliveryState::Pending,
            queue_id: None,
        }
    }

    #[test]
    fn startup_pending_recovery_preserves_detector_origin_and_task_status() {
        let mut task = matrix_task(TaskExecutionMode::Recurring);
        for cause in [
            DetectorInvocationCause::Scheduled,
            DetectorInvocationCause::CheckNow,
        ] {
            let pending = matrix_pending(cause);
            task.status = TaskStatus::Running;
            assert_eq!(
                startup_pending_recovery_plan(&task, &pending),
                StartupPendingRecoveryPlan::Scheduler
            );
            assert_eq!(
                pending_execution_trigger(&pending).unwrap(),
                if cause == DetectorInvocationCause::Scheduled {
                    TaskExecutionTrigger::Scheduled
                } else {
                    TaskExecutionTrigger::Manual
                }
            );

            for status in [TaskStatus::Stopped, TaskStatus::Blocked] {
                task.status = status;
                assert_eq!(
                    startup_pending_recovery_plan(&task, &pending),
                    if cause == DetectorInvocationCause::CheckNow {
                        StartupPendingRecoveryPlan::ManualOneShot
                    } else {
                        StartupPendingRecoveryPlan::None
                    },
                    "recovery plan for {cause:?}/{status:?}"
                );
                assert_eq!(task.status, status, "planning must not mutate Task status");
            }
        }
    }

    #[tokio::test]
    async fn run_now_rejects_a_durable_pending_activation() {
        let mut task = matrix_task(TaskExecutionMode::Recurring);
        task.id = format!("task-run-now-pending-{}", uuid::Uuid::new_v4());
        task.trigger = Some(crate::task_trigger::TaskTrigger {
            source: crate::task_trigger::TaskTriggerSource::Time,
            detector: crate::task_trigger::TaskTriggerDetector::Command {
                command: crate::task_trigger::TaskTriggerCommand {
                    executable: "node".to_string(),
                    args: vec!["detector.mjs".to_string()],
                    cwd: None,
                },
                timeout_ms: None,
            },
        });
        let (_dir, store) = store_with_task(&task);
        store
            .commit_detector_success(
                &task,
                &crate::task_trigger::DetectorRunSuccess {
                    invocation_id: "invocation-run-now-fence".to_string(),
                    decision: crate::task_trigger::DetectorDecision::Activate,
                    reason: crate::task_trigger::TaskTriggerReason {
                        code: "changed".to_string(),
                        message: "Changed".to_string(),
                    },
                    event: Some(matrix_pending(DetectorInvocationCause::CheckNow).event),
                    handoff: Some(matrix_pending(DetectorInvocationCause::CheckNow).handoff),
                    next_checkpoint: None,
                    duration_ms: 1,
                    exit_code: 0,
                    stderr_tail: None,
                },
                DetectorInvocationCause::CheckNow,
            )
            .await
            .unwrap();

        let error = ensure_run_now_outbox_clear(&store, &task)
            .await
            .expect_err("pending Activation Event must be exclusive");
        assert!(error.contains("Activation Event is pending"));

        let controller = TaskSchedulerController::new();
        let task_control = acquire_task_control(&task.id).await;
        let busy = controller
            .trigger_now_with_store(&task.id, &store)
            .await
            .expect_err("Task control must serialize run-now admission");
        assert!(busy.contains("changing scheduler state"));
        drop(task_control);

        let pending = controller
            .trigger_now_with_store(&task.id, &store)
            .await
            .expect_err("controller path must reject the durable outbox");
        assert!(pending.contains("Activation Event is pending"));
        assert!(controller.executions.read().await.is_empty());
    }

    fn matrix_outcome(success: bool) -> crate::task_execution::TaskExecutionOutcome {
        crate::task_execution::TaskExecutionOutcome {
            success,
            turn_dispatched: true,
            termination_unconfirmed: false,
            failure_retryable: true,
            error: (!success).then(|| "AI execution failed".to_string()),
            ai_exit_reason: None,
            output_text: None,
            session_id: Some("session-matrix".to_string()),
            duration_ms: 1,
        }
    }

    #[test]
    fn scheduled_detector_and_activation_matrix_preserves_binary_semantics() {
        use crate::cron_task::CronRunRecord;

        let success_record = CronRunRecord {
            ts: 1,
            ok: true,
            duration_ms: 1,
            content: None,
            error: None,
        };
        for mode in [
            TaskExecutionMode::Once,
            TaskExecutionMode::Scheduled,
            TaskExecutionMode::Recurring,
        ] {
            let one_shot = matches!(mode, TaskExecutionMode::Once | TaskExecutionMode::Scheduled);
            assert_eq!(
                detector_scheduled_terminal_status(
                    mode,
                    DetectorScheduledOutcome::QuietOrDeduplicated,
                ),
                one_shot.then_some(TaskStatus::Done),
                "quiet/deduplicated matrix for {mode:?}"
            );
            assert_eq!(
                detector_scheduled_terminal_status(
                    mode,
                    DetectorScheduledOutcome::Failure {
                        consecutive_failures: 1,
                    },
                ),
                one_shot.then_some(TaskStatus::Blocked),
                "first Detector program failure matrix for {mode:?}"
            );
            assert_eq!(
                detector_scheduled_terminal_status(
                    mode,
                    DetectorScheduledOutcome::Failure {
                        consecutive_failures: 5,
                    },
                ),
                Some(TaskStatus::Blocked),
                "fifth Detector program failure matrix for {mode:?}"
            );

            let transition = execution_terminal_transition(
                &matrix_task(mode),
                TaskExecutionTrigger::Scheduled,
                Some(DetectorInvocationCause::Scheduled),
                &success_record,
                Some(&matrix_outcome(true)),
                None,
            );
            assert_eq!(
                transition.as_ref().map(|value| value.status),
                one_shot.then_some(TaskStatus::Done),
                "activate AI-success matrix for {mode:?}"
            );

            let ai_failure_record = CronRunRecord {
                ok: false,
                error: Some("AI execution failed".to_string()),
                ..success_record.clone()
            };
            let transition = execution_terminal_transition(
                &matrix_task(mode),
                TaskExecutionTrigger::Scheduled,
                Some(DetectorInvocationCause::Scheduled),
                &ai_failure_record,
                Some(&matrix_outcome(false)),
                None,
            );
            assert_eq!(
                transition.as_ref().map(|value| value.status),
                one_shot.then_some(TaskStatus::Blocked),
                "activate AI-failure matrix for {mode:?}"
            );
        }
    }

    #[test]
    fn recurring_ai_failures_block_only_on_fifth_retryable_or_first_permanent_failure() {
        let record = crate::cron_task::CronRunRecord {
            ts: 1,
            ok: false,
            duration_ms: 1,
            content: None,
            error: Some("execution failed".to_string()),
        };
        let retryable = matrix_outcome(false);
        let mut recurring = matrix_task(TaskExecutionMode::Recurring);

        for prior_failures in 0..4 {
            recurring.consecutive_execution_failures = prior_failures;
            assert!(execution_terminal_transition(
                &recurring,
                TaskExecutionTrigger::Scheduled,
                None,
                &record,
                Some(&retryable),
                None,
            )
            .is_none());
        }

        recurring.consecutive_execution_failures = 4;
        assert_eq!(
            execution_terminal_transition(
                &recurring,
                TaskExecutionTrigger::Scheduled,
                None,
                &record,
                Some(&retryable),
                None,
            )
            .map(|transition| transition.status),
            Some(TaskStatus::Blocked)
        );

        recurring.consecutive_execution_failures = 0;
        let mut permanent = matrix_outcome(false);
        permanent.failure_retryable = false;
        assert_eq!(
            execution_terminal_transition(
                &recurring,
                TaskExecutionTrigger::Scheduled,
                None,
                &record,
                Some(&permanent),
                None,
            )
            .map(|transition| transition.status),
            Some(TaskStatus::Blocked)
        );
        assert_eq!(
            execution_terminal_transition(
                &recurring,
                TaskExecutionTrigger::Scheduled,
                None,
                &record,
                None,
                Some(false),
            )
            .map(|transition| transition.status),
            Some(TaskStatus::Blocked),
            "permanent preflight failures use structured classification"
        );

        let mut ambiguous = matrix_outcome(false);
        ambiguous.termination_unconfirmed = true;
        assert_eq!(
            execution_terminal_transition(
                &recurring,
                TaskExecutionTrigger::Scheduled,
                None,
                &record,
                Some(&ambiguous),
                None,
            )
            .map(|transition| transition.status),
            Some(TaskStatus::Blocked),
            "unknown termination blocks immediately and retains exact owner authority"
        );

        assert!(execution_terminal_transition(
            &recurring,
            TaskExecutionTrigger::Manual,
            None,
            &record,
            Some(&permanent),
            None,
        )
        .is_none());
    }

    #[tokio::test]
    async fn recurring_preadmission_activation_failure_uses_retry_policy_without_receipt() {
        let mut task = matrix_task(TaskExecutionMode::Recurring);
        task.id = format!("activation-retry-{}", uuid::Uuid::new_v4());
        let (_dir, store) = store_with_task(&task);
        let activation = matrix_pending(DetectorInvocationCause::Scheduled);
        let mut rejected = matrix_outcome(false);
        rejected.turn_dispatched = false;
        rejected.error = Some("Runtime admission transport failed".to_string());
        let record = crate::cron_task::CronRunRecord {
            ts: 1,
            ok: false,
            duration_ms: 1,
            content: None,
            error: rejected.error.clone(),
        };

        assert!(!activation_turn_was_admitted(
            Some(&activation),
            Some(&rejected),
        ));
        let terminal = execution_terminal_transition(
            &task,
            TaskExecutionTrigger::Scheduled,
            Some(DetectorInvocationCause::Scheduled),
            &record,
            Some(&rejected),
            None,
        );
        assert!(terminal.is_none(), "failure 1 must remain retryable");

        let updated = store
            .settle_execution_if_status(
                &task.id,
                None,
                TaskExecutionTrigger::Scheduled,
                task.status,
                TaskExecutionSettlement {
                    success: false,
                    duration_ms: 1,
                    session_id: rejected.session_id.clone(),
                    error: rejected.error.clone(),
                },
                terminal,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(updated.status, TaskStatus::Running);
        assert_eq!(updated.consecutive_execution_failures, 1);
        assert_eq!(updated.last_activation_event_id, None);
    }

    #[test]
    fn max_executions_counts_ai_turns_not_quiet_detector_checks() {
        let mut recurring = matrix_task(TaskExecutionMode::Recurring);
        recurring.end_conditions = Some(crate::task::TaskEndConditions {
            deadline: None,
            max_executions: Some(1),
            ai_can_exit: true,
        });
        assert_eq!(
            detector_scheduled_terminal_status(
                recurring.execution_mode,
                DetectorScheduledOutcome::QuietOrDeduplicated,
            ),
            None,
            "a quiet check must not consume maxExecutions"
        );
        let record = crate::cron_task::CronRunRecord {
            ts: 1,
            ok: true,
            duration_ms: 1,
            content: None,
            error: None,
        };
        assert_eq!(
            execution_terminal_transition(
                &recurring,
                TaskExecutionTrigger::Scheduled,
                Some(DetectorInvocationCause::Scheduled),
                &record,
                Some(&matrix_outcome(true)),
                None,
            )
            .map(|value| value.status),
            Some(TaskStatus::Done)
        );
    }

    #[test]
    fn check_now_activation_honors_running_end_conditions_but_preserves_paused_status() {
        let mut recurring = matrix_task(TaskExecutionMode::Recurring);
        recurring.end_conditions = Some(crate::task::TaskEndConditions {
            deadline: None,
            max_executions: Some(1),
            ai_can_exit: true,
        });
        let record = crate::cron_task::CronRunRecord {
            ts: 1,
            ok: true,
            duration_ms: 1,
            content: None,
            error: None,
        };
        assert_eq!(
            execution_terminal_transition(
                &recurring,
                TaskExecutionTrigger::Manual,
                Some(DetectorInvocationCause::CheckNow),
                &record,
                Some(&matrix_outcome(true)),
                None,
            )
            .map(|value| value.status),
            Some(TaskStatus::Done),
            "a check-now AI turn counts toward maxExecutions"
        );

        let mut ai_exit = matrix_outcome(true);
        ai_exit.ai_exit_reason = Some("Goal reached".to_string());
        assert_eq!(
            execution_terminal_transition(
                &recurring,
                TaskExecutionTrigger::Manual,
                Some(DetectorInvocationCause::CheckNow),
                &record,
                Some(&ai_exit),
                None,
            )
            .map(|value| value.message),
            Some("Goal reached".to_string())
        );

        for status in [TaskStatus::Stopped, TaskStatus::Blocked] {
            recurring.status = status;
            assert!(execution_terminal_transition(
                &recurring,
                TaskExecutionTrigger::Manual,
                Some(DetectorInvocationCause::CheckNow),
                &record,
                Some(&ai_exit),
                None,
            )
            .is_none());
            assert_eq!(recurring.status, status);
        }
    }

    #[test]
    fn rerun_one_shot_is_not_gated_by_cumulative_execution_count() {
        for (mode, dispatch_at) in [
            (TaskExecutionMode::Once, None),
            (
                TaskExecutionMode::Scheduled,
                Some(Utc::now().timestamp_millis() - 1_000),
            ),
        ] {
            let mut task: Task = serde_json::from_value(serde_json::json!({
                "id": "task-rerun",
                "name": "rerun",
                "executor": "agent",
                "workspaceId": "ws",
                "workspacePath": "/tmp/ws",
                "executionMode": "once",
                "sessionIds": [],
                "executionCount": 3,
                "status": "running",
                "tags": [],
                "createdAt": 1,
                "updatedAt": 1,
                "statusHistory": [],
                "dispatchOrigin": "direct"
            }))
            .unwrap();
            task.execution_mode = mode;
            task.dispatch_at = dispatch_at;
            assert!(next_execution_at(&task).unwrap().is_some());
        }
    }
}
