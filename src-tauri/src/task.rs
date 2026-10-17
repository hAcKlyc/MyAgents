//! Task store for Task Center (v0.1.69).
//!
//! Tasks are workspace-scoped execution units. The primary index lives in
//! `~/.myagents/tasks.jsonl` (one task per line, atomic full-rewrite on change).
//! Associated markdown documents live under `~/.myagents/tasks/<taskId>/`.
//! `task.md` is the complete execution context. Older verify.md/progress.md/
//! alignment.md files remain readable; a non-empty legacy verify.md is lazily
//! appended to task.md before detail, edit, or dispatch.
//!
//! See PRD `specs/prd/prd_0.1.69_task_center.md`:
//! - §3.2 — schema
//! - §9.1 — state machine + transitions table
//! - §10.2.1 — `update-status` handler: transition validity, actor/source guard,
//!   atomic history append, side-effect dispatch, progress.md, notification, SSE.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, RwLock as StdRwLock};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::cron_task::{
    EndConditions as CronEndConditions, RecurringWindow, RunMode as CronRunMode,
};
use crate::task_trigger::{validate_task_trigger, TaskTrigger};
use crate::{ulog_debug, ulog_error, ulog_info, ulog_warn};
use tauri::Emitter;

/// Task-layer `RunMode`. Same semantics as `cron_task::RunMode` but emits PRD-
/// specified kebab-case JSON (`"single-session"` / `"new-session"`). We do NOT
/// reuse `cron_task::RunMode` directly because it emits snake_case which would
/// silently diverge from the TS shared type. Convert at the cron-adapter boundary
/// via `From`/`Into`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskRunMode {
    #[serde(rename = "single-session")]
    SingleSession,
    #[serde(rename = "new-session")]
    NewSession,
}

impl From<CronRunMode> for TaskRunMode {
    fn from(m: CronRunMode) -> Self {
        match m {
            CronRunMode::SingleSession => Self::SingleSession,
            CronRunMode::NewSession => Self::NewSession,
        }
    }
}
impl From<TaskRunMode> for CronRunMode {
    fn from(m: TaskRunMode) -> Self {
        match m {
            TaskRunMode::SingleSession => Self::SingleSession,
            TaskRunMode::NewSession => Self::NewSession,
        }
    }
}

/// Task-layer `EndConditions` — PRD-compatible shape.
///
/// `deadline` is a Unix timestamp in milliseconds (JS `Date.now()` compatible),
/// not a `DateTime<Utc>` like `cron_task::EndConditions`. We convert at the
/// cron-adapter boundary.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskEndConditions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_executions: Option<u32>,
    #[serde(default = "default_true")]
    pub ai_can_exit: bool,
}

impl From<CronEndConditions> for TaskEndConditions {
    fn from(c: CronEndConditions) -> Self {
        Self {
            deadline: c.deadline.map(|dt| dt.timestamp_millis()),
            max_executions: c.max_executions,
            ai_can_exit: c.ai_can_exit,
        }
    }
}

impl From<TaskEndConditions> for CronEndConditions {
    fn from(t: TaskEndConditions) -> Self {
        use chrono::TimeZone;
        Self {
            deadline: t
                .deadline
                .and_then(|ms| chrono::Utc.timestamp_millis_opt(ms).single()),
            max_executions: t.max_executions,
            ai_can_exit: t.ai_can_exit,
        }
    }
}

// ================ Enums ================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Todo,
    Running,
    Verifying,
    Done,
    Blocked,
    Stopped,
    Archived,
    /// Pseudo-state used ONLY as the `to` field of a soft-delete audit entry
    /// (PRD §10.2.2). Never a legal transition target via `update_status`;
    /// only `delete()` may write it. A Task whose `status` equals `Deleted`
    /// is equivalent to `deleted=true` and is filtered out of all list
    /// queries by default.
    Deleted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskExecutionTrigger {
    Scheduled,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskLastExecution {
    pub at: i64,
    pub trigger: TaskExecutionTrigger,
    pub success: bool,
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct TaskExecutionSettlement {
    pub success: bool,
    pub duration_ms: u64,
    pub session_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct TaskExecutionTerminalTransition {
    pub status: TaskStatus,
    pub message: String,
    pub source: TransitionSource,
}

impl TaskStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Todo => "todo",
            Self::Running => "running",
            Self::Verifying => "verifying",
            Self::Done => "done",
            Self::Blocked => "blocked",
            Self::Stopped => "stopped",
            Self::Archived => "archived",
            Self::Deleted => "deleted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransitionActor {
    System,
    User,
    Agent,
}

impl TransitionActor {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Agent => "agent",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransitionSource {
    Cli,
    Ui,
    Watchdog,
    Crash,
    Scheduler,
    EndCondition,
    Rerun,
    /// Task was created by the backend Legacy Cron migration. Rendered in the status-
    /// history panel so the user can tell upgrade-originated tasks from
    /// user-authored ones.
    Migration,
}

impl TransitionSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Cli => "cli",
            Self::Ui => "ui",
            Self::Watchdog => "watchdog",
            Self::Crash => "crash",
            Self::Scheduler => "scheduler",
            Self::EndCondition => "endCondition",
            Self::Rerun => "rerun",
            Self::Migration => "migration",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskExecutionMode {
    Once,
    Scheduled,
    Recurring,
    /// Read-only compatibility value. New creation/update rejects it.
    Loop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskExecutor {
    User,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskDispatchOrigin {
    #[serde(rename = "direct")]
    Direct,
    #[serde(rename = "ai-aligned")]
    AiAligned,
    #[serde(rename = "attached-session")]
    AttachedSession,
}

// ================ Struct ================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusTransition {
    /// `None` represents the implicit pre-creation state.
    pub from: Option<TaskStatus>,
    pub to: TaskStatus,
    pub at: i64,
    pub actor: TransitionActor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<TransitionSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationConfig {
    #[serde(default = "default_true")]
    pub desktop: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_channel_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_thread: Option<String>,
    /// Defaults to `['done', 'blocked', 'endCondition']` when absent; keep as
    /// `Option<Vec>` so omitted-means-default is distinguishable from explicit empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<String>>,
}

impl Default for NotificationConfig {
    fn default() -> Self {
        Self {
            desktop: true,
            bot_channel_id: None,
            bot_thread: None,
            events: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum NotificationFieldPatch<T> {
    Unchanged,
    Clear,
    Set(T),
}

impl<T> Default for NotificationFieldPatch<T> {
    fn default() -> Self {
        Self::Unchanged
    }
}

impl<'de, T> Deserialize<'de> for NotificationFieldPatch<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(match Option::<T>::deserialize(deserializer)? {
            Some(value) => Self::Set(value),
            None => Self::Clear,
        })
    }
}

/// Task-specific partial notification mutation. Missing fields are unchanged;
/// explicit null clears the field to its domain default.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskNotificationPatch {
    #[serde(default)]
    desktop: NotificationFieldPatch<bool>,
    #[serde(default)]
    bot_channel_id: NotificationFieldPatch<String>,
    #[serde(default)]
    bot_thread: NotificationFieldPatch<String>,
    #[serde(default)]
    events: NotificationFieldPatch<Vec<String>>,
}

impl TaskNotificationPatch {
    fn is_empty(&self) -> bool {
        matches!(self.desktop, NotificationFieldPatch::Unchanged)
            && matches!(self.bot_channel_id, NotificationFieldPatch::Unchanged)
            && matches!(self.bot_thread, NotificationFieldPatch::Unchanged)
            && matches!(self.events, NotificationFieldPatch::Unchanged)
    }

    fn apply(self, existing: Option<NotificationConfig>) -> NotificationConfig {
        let mut notification = existing.unwrap_or_default();
        match self.desktop {
            NotificationFieldPatch::Unchanged => {}
            NotificationFieldPatch::Clear => notification.desktop = true,
            NotificationFieldPatch::Set(value) => notification.desktop = value,
        }
        match self.bot_channel_id {
            NotificationFieldPatch::Unchanged => {}
            NotificationFieldPatch::Clear => notification.bot_channel_id = None,
            NotificationFieldPatch::Set(value) => notification.bot_channel_id = Some(value),
        }
        match self.bot_thread {
            NotificationFieldPatch::Unchanged => {}
            NotificationFieldPatch::Clear => notification.bot_thread = None,
            NotificationFieldPatch::Set(value) => notification.bot_thread = Some(value),
        }
        match self.events {
            NotificationFieldPatch::Unchanged => {}
            NotificationFieldPatch::Clear => notification.events = None,
            NotificationFieldPatch::Set(value) => notification.events = Some(value),
        }
        notification
    }
}

fn default_true() -> bool {
    true
}

fn default_task_executor_agent() -> TaskExecutor {
    TaskExecutor::Agent
}

pub const MANAGED_KIND_MEMORY_GARDENER: &str = "memory_gardener";
pub const MANAGED_KIND_MEMORY_MOLT: &str = "memory_molt";
pub const MANAGED_KIND_MEMORY_AUTO_UPDATE_BATCH: &str = "memory_auto_update_batch";
pub const MANAGED_TASK_ERROR: &str =
    "Managed scheduled jobs are internal and cannot be managed from ordinary Task surfaces";

pub fn is_supported_managed_kind(kind: &str) -> bool {
    matches!(
        kind.trim(),
        MANAGED_KIND_MEMORY_GARDENER
            | MANAGED_KIND_MEMORY_MOLT
            | MANAGED_KIND_MEMORY_AUTO_UPDATE_BATCH
    )
}

pub fn is_managed_task(task: &Task) -> bool {
    task.managed_kind
        .as_deref()
        .is_some_and(is_supported_managed_kind)
}

fn reject_managed_kind_from_ordinary_create(kind: &Option<String>) -> Result<(), String> {
    if kind.as_deref().is_some_and(|raw| !raw.trim().is_empty()) {
        return Err(MANAGED_TASK_ERROR.to_string());
    }
    Ok(())
}

fn validate_ordinary_caller_origin(
    actor: TransitionActor,
    source: Option<TransitionSource>,
) -> Result<(), String> {
    match (actor, source) {
        (TransitionActor::User, Some(TransitionSource::Ui | TransitionSource::Cli))
        | (TransitionActor::Agent, Some(TransitionSource::Cli)) => Ok(()),
        (TransitionActor::System, _) => {
            Err("ordinary Task mutations cannot claim system authority".to_string())
        }
        (TransitionActor::Agent, _) => Err(String::from(TaskOpError::agent_source_must_be_cli())),
        (TransitionActor::User, _) => {
            Err("user Task mutations require source=ui or source=cli".to_string())
        }
    }
}

fn normalize_managed_kind(kind: Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = kind else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if is_supported_managed_kind(trimmed) {
        Ok(Some(trimmed.to_string()))
    } else {
        Err(format!("unsupported managedKind: {}", trimmed))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TaskExternalSourceType {
    #[serde(rename = "space-issue")]
    SpaceIssue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskExternalSource {
    #[serde(rename = "type")]
    pub source_type: TaskExternalSourceType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_id: Option<String>,
    pub issue_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub name: String,
    pub executor: TaskExecutor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub workspace_id: String,
    /// Absolute path to the workspace — Sidecar cwd and AI-bash base. Task
    /// docs live in `~/.myagents/tasks/<id>/` (user-scoped, v0.1.69+), not
    /// here. Stored so UI and execution don't have to resolve it separately.
    #[serde(default)]
    pub workspace_path: String,
    pub execution_mode: TaskExecutionMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_mode: Option<TaskRunMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_conditions: Option<TaskEndConditions>,
    /// Recurring-mode fixed interval (minutes). Set when
    /// `execution_mode == Recurring` and `cron_expression` is absent. The
    /// Task scheduler reads this field directly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_minutes: Option<u32>,
    /// Advanced-mode cron expression (takes precedence over
    /// `interval_minutes` when set).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron_expression: Option<String>,
    /// IANA timezone id for `cron_expression` (e.g. `Asia/Shanghai`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron_timezone: Option<String>,
    /// Optional first-fire timestamp for recurring tasks. Stored as RFC3339
    /// and used by tasks that should arm without firing immediately.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_at: Option<String>,
    /// Optional wall-clock window used to catch up missed anchored recurring
    /// runs without waiting for another full interval.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurring_window: Option<RecurringWindow>,
    /// Dedicated "when to fire" timestamp for `Scheduled` mode
    /// (ms since epoch). Decouples from `end_conditions.deadline`,
    /// which semantically means "when to stop running".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch_at: Option<i64>,
    /// Optional persisted trigger configuration. Missing means effective
    /// time/always without rewriting legacy Task rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<TaskTrigger>,
    /// Per-task model override used when the Task creates an execution Session.
    /// Existing Sessions keep their own model authority.
    ///
    /// PRD 0.2.9 pairing rule (asymmetric, by design): when `provider_id`
    /// is set, `model` MUST also be set (validated by
    /// `validate_task_provider_routing`) — provider-without-model would
    /// silently route the picked provider's API to the agent's default
    /// model and reproduce the cross-provider misroute that #130 surfaced.
    /// The reverse is intentionally NOT rejected: model-only means "use
    /// the Agent's currently-resolved provider but override model id",
    /// reachable from the CLI / management API for legacy / advanced use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// PRD 0.2.9 — Per-task provider id override. When `None` the Task
    /// follows the workspace agent. When set,
    /// the sidecar live-resolves env on every tick from
    /// `~/.myagents/config.json`, so credential rotation propagates without
    /// a re-save and credential copies never land in `tasks.jsonl` /
    /// the legacy Cron store.
    ///
    /// Mutually exclusive with `runtime ∈ {claude-code, codex}`
    /// (external runtimes manage their own provider) — enforced by
    /// `validate_task_provider_routing`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// Per-task permission mode override (auto / plan / fullAgency / custom).
    /// When `None`, the linked Agent's default is used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    /// For `single-session` run mode: id of a pre-existing SDK session to
    /// continue instead of minting a fresh uuid on first dispatch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preselected_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_config: Option<serde_json::Value>,
    /// Per-task MCP enable list override (PRD 0.2.4 §需求 4). When `None`
    /// the executor falls back to the Agent workspace's `mcpEnabledServers`.
    /// `Some(vec![])` means "explicitly run with no MCP servers".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_enabled_servers: Option<Vec<String>>,
    /// Internal system-managed task marker. Hidden from ordinary Task Center
    /// lists, but kept in task history/session records for auditability.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_kind: Option<String>,
    #[serde(
        default,
        rename = "sourceRecordId",
        skip_serializing_if = "Option::is_none"
    )]
    pub source_record_id: Option<String>,
    /// Persistence-only ingress for Tasks whose source Thought has not yet
    /// published a canonical Record. It is hidden from product/API output and
    /// written back by `persist_locked` until promotion is safe.
    #[serde(default, rename = "sourceThoughtId", skip_serializing)]
    legacy_source_thought_id: Option<String>,
    #[serde(default)]
    pub session_ids: Vec<String>,
    pub status: TaskStatus,
    #[serde(default)]
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_executed_at: Option<i64>,
    /// Last timer-driven execution. Manual `run-now` updates
    /// `last_executed_at` for audit/UI but must not move the recurring timer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_scheduled_at: Option<i64>,
    #[serde(default)]
    pub execution_count: u32,
    /// Consecutive failed scheduled AI turns. Manual run-now is observational
    /// and does not change this counter. A successful scheduled turn resets it.
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub consecutive_execution_failures: u32,
    /// Authoritative summary used by Task Center. `cron_runs` remains an audit
    /// projection and must not be stitched back into current Task state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_execution: Option<TaskLastExecution>,
    /// Durable receipt for the most recently admitted command-trigger event.
    /// It closes the cross-file crash window between Task outcome accounting
    /// and clearing the Trigger outbox. Startup may safely settle a matching
    /// pending event without admitting a second AI turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activation_event_id: Option<String>,
    #[serde(default)]
    pub status_history: Vec<StatusTransition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notification: Option<NotificationConfig>,
    pub dispatch_origin: TaskDispatchOrigin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_source: Option<TaskExternalSource>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
}

impl Task {
    pub fn effective_trigger(&self) -> TaskTrigger {
        self.trigger.clone().unwrap_or_default()
    }

    fn promote_legacy_source_if(&mut self, is_published_record: impl FnOnce(&str) -> bool) -> bool {
        let Some(legacy_id) = self.legacy_source_thought_id.as_deref() else {
            return false;
        };
        if self.source_record_id.is_some() || !is_published_record(legacy_id) {
            return false;
        }
        self.source_record_id = self.legacy_source_thought_id.take();
        true
    }

    fn promote_published_legacy_source(&mut self) -> bool {
        self.promote_legacy_source_if(|id| {
            crate::record::get_record_store().is_some_and(|store| store.has_published_record(id))
        })
    }

    fn serialize_for_disk(&self) -> Result<String, serde_json::Error> {
        let mut value = serde_json::to_value(self)?;
        if let Some(legacy_id) = self.legacy_source_thought_id.as_ref() {
            if let Some(object) = value.as_object_mut() {
                object.insert(
                    "sourceThoughtId".to_string(),
                    serde_json::Value::String(legacy_id.clone()),
                );
            }
        }
        serde_json::to_string(&value)
    }
}

fn is_zero_u32(value: &u32) -> bool {
    *value == 0
}

pub(crate) fn task_bound_session_ids(task: &Task) -> Vec<String> {
    let mut session_ids = task.session_ids.clone();
    if let Some(session_id) = task.preselected_session_id.as_ref() {
        session_ids.push(session_id.clone());
    }
    session_ids.retain(|session_id| !session_id.trim().is_empty());
    session_ids.sort();
    session_ids.dedup();
    session_ids
}

pub(crate) fn task_protected_session_ids(task: &Task) -> Vec<String> {
    if task.deleted {
        return Vec::new();
    }
    let protects_identity = if task.dispatch_origin == TaskDispatchOrigin::AttachedSession {
        matches!(
            task.status,
            TaskStatus::Todo
                | TaskStatus::Running
                | TaskStatus::Verifying
                | TaskStatus::Blocked
                | TaskStatus::Stopped
        )
    } else {
        task.status == TaskStatus::Running && task.run_mode == Some(TaskRunMode::SingleSession)
    };
    if protects_identity {
        task_bound_session_ids(task)
    } else {
        Vec::new()
    }
}

pub(crate) fn task_protects_session_identity(task: &Task, session_id: &str) -> bool {
    task_protected_session_ids(task)
        .iter()
        .any(|value| value == session_id)
}

/// Absolute paths to a task's markdown documents. Returned by `cmd_task_get`
/// as a sibling of `Task` so the CLI / AI can read & edit the docs directly
/// via standard file-system tools (Read / Edit / Write) without having to
/// re-derive the paths from `task_docs_dir()`'s convention. Single source of
/// truth for "where do the task docs live" — callers never guess the layout.
///
/// A doc path is only included when the file actually exists on disk
/// (except `task_md`, which is always created at task creation time and is
/// therefore always surfaced). This lets the consumer distinguish "AI has
/// started working" (progress.md / verify.md present) from "fresh task"
/// without a second `fs.exists()` round-trip.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDocs {
    /// Absolute path to the task's docs directory.
    pub dir: String,
    /// task.md — always created at task creation; always surfaced.
    pub task_md: String,
    /// Legacy verify.md — preserved after its content is merged into task.md.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verify_md: Option<String>,
    /// Legacy progress.md — preserved for compatibility.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_md: Option<String>,
    /// Legacy alignment.md — preserved for compatibility.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alignment_md: Option<String>,
}

pub const TASK_COMMENT_BODY_MAX_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TaskCommentAuthor {
    User {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    Agent {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskCommentAdmissionState {
    PendingSession,
    Sending,
    Accepted,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskCommentAdmission {
    pub state: TaskCommentAdmissionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskComment {
    pub id: String,
    pub task_id: String,
    pub body: String,
    pub author: TaskCommentAuthor,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to_comment_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admission: Option<TaskCommentAdmission>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCommentPage {
    pub items: Vec<TaskComment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_after: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reply_parents: Vec<TaskCommentReplySummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCommentReplySummary {
    pub comment_id: String,
    pub author: TaskCommentAuthor,
    pub created_at: i64,
    pub quote: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCommentContextPage {
    pub items: Vec<TaskComment>,
    pub target_comment_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_after: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reply_parents: Vec<TaskCommentReplySummary>,
}

/// Bounded notification locator derived from durable Agent comments. It keeps
/// only navigation/sort metadata and a short plain-text excerpt; full comment
/// bodies remain exclusively in comments.jsonl.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskAgentCommentLocator {
    pub notification_id: String,
    pub task_id: String,
    pub task_name: String,
    pub comment_id: String,
    pub created_at: i64,
    pub agent_label: Option<String>,
    pub session_id: String,
    pub excerpt: String,
}

#[derive(Debug, Default)]
struct TaskCommentNotificationIndex {
    ready: bool,
    partial_error: bool,
    items: Vec<TaskAgentCommentLocator>,
    pending_during_rebuild: Vec<TaskAgentCommentLocator>,
    /// Mutations that race the asynchronous startup rebuild. `None` means the
    /// Task was deleted; `Some(name)` is the current display name.
    task_projections: HashMap<String, Option<String>>,
}

#[derive(Debug, Clone)]
pub struct TaskCommentNotificationSource {
    pub ready: bool,
    pub partial_error: bool,
    pub items: Vec<TaskAgentCommentLocator>,
}

const MAX_TASK_COMMENT_NOTIFICATION_INDEX: usize = 5_000;

fn task_comment_excerpt(body: &str) -> String {
    let normalized = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = normalized.chars();
    let excerpt = chars.by_ref().take(180).collect::<String>();
    if chars.next().is_some() {
        format!("{excerpt}…")
    } else {
        excerpt
    }
}

fn next_task_comment_timestamp(comments: &[TaskComment]) -> i64 {
    comments
        .last()
        .map(|comment| comment.created_at.saturating_add(1))
        .unwrap_or_default()
        .max(now_ms())
}

fn task_comment_quote(body: &str) -> String {
    let mut points = body.trim().chars();
    // UI reply previews are deliberately more generous than the compact
    // delivery reminder injected into a Session.
    let quote: String = points.by_ref().take(60).collect();
    if points.next().is_some() {
        format!("{quote}…")
    } else {
        quote
    }
}

fn ordinary_task_for_read<'a>(
    tasks: &'a HashMap<String, Task>,
    task_id: &str,
) -> Result<&'a Task, String> {
    let task = tasks
        .get(task_id)
        .ok_or_else(|| String::from(TaskOpError::not_found(task_id)))?;
    if is_managed_task(task) {
        return Err(MANAGED_TASK_ERROR.to_string());
    }
    Ok(task)
}

fn ordinary_task_for_comment<'a>(
    tasks: &'a HashMap<String, Task>,
    task_id: &str,
) -> Result<&'a Task, String> {
    let task = ordinary_task_for_read(tasks, task_id)?;
    if task.deleted {
        return Err(String::from(TaskOpError::already_deleted()));
    }
    Ok(task)
}

fn reply_parent_summaries(
    all_comments: &[TaskComment],
    visible_comments: &[TaskComment],
) -> Vec<TaskCommentReplySummary> {
    let visible_ids = visible_comments
        .iter()
        .map(|comment| comment.id.as_str())
        .collect::<HashSet<_>>();
    let parent_ids = visible_comments
        .iter()
        .filter_map(|comment| comment.reply_to_comment_id.as_deref())
        .filter(|parent_id| !visible_ids.contains(parent_id))
        .collect::<HashSet<_>>();
    all_comments
        .iter()
        .filter(|comment| parent_ids.contains(comment.id.as_str()))
        .map(|comment| TaskCommentReplySummary {
            comment_id: comment.id.clone(),
            author: comment.author.clone(),
            created_at: comment.created_at,
            quote: task_comment_quote(&comment.body),
        })
        .collect()
}

fn agent_comment_locator(task: &Task, comment: &TaskComment) -> Option<TaskAgentCommentLocator> {
    let TaskCommentAuthor::Agent { label, session_id } = &comment.author else {
        return None;
    };
    Some(TaskAgentCommentLocator {
        notification_id: format!("task-comment:{}", comment.id),
        task_id: task.id.clone(),
        task_name: task.name.clone(),
        comment_id: comment.id.clone(),
        created_at: comment.created_at,
        agent_label: label.clone(),
        session_id: session_id.clone(),
        excerpt: task_comment_excerpt(&comment.body),
    })
}

fn sort_and_bound_comment_locators(items: &mut Vec<TaskAgentCommentLocator>) {
    items.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| right.notification_id.cmp(&left.notification_id))
    });
    items.dedup_by(|left, right| left.notification_id == right.notification_id);
    items.truncate(MAX_TASK_COMMENT_NOTIFICATION_INDEX);
}

fn spawn_comment_notification_rebuild(
    index_handle: Arc<StdRwLock<TaskCommentNotificationIndex>>,
    artifacts_root: PathBuf,
    tasks: Vec<Task>,
) {
    std::thread::spawn(move || {
        let mut items = Vec::new();
        let mut partial_error = false;
        for task in tasks {
            let path = artifacts_root.join(&task.id).join("comments.jsonl");
            let file = match fs::File::open(&path) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    partial_error = true;
                    continue;
                }
            };
            for line in BufReader::new(file).lines() {
                let Ok(line) = line else {
                    partial_error = true;
                    continue;
                };
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<TaskComment>(&line) {
                    Ok(comment) => {
                        if let Some(locator) = agent_comment_locator(&task, &comment) {
                            items.push(locator);
                            if items.len() >= MAX_TASK_COMMENT_NOTIFICATION_INDEX * 2 {
                                sort_and_bound_comment_locators(&mut items);
                            }
                        }
                    }
                    Err(_) => partial_error = true,
                }
            }
        }
        sort_and_bound_comment_locators(&mut items);
        let mut index = index_handle
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        items.extend(index.pending_during_rebuild.drain(..));
        items.retain_mut(|item| match index.task_projections.get(&item.task_id) {
            Some(Some(name)) => {
                item.task_name.clone_from(name);
                true
            }
            Some(None) => false,
            None => true,
        });
        sort_and_bound_comment_locators(&mut items);
        index.items = items;
        index.partial_error = partial_error;
        index.ready = true;
    });
}

/// Build a [`TaskDocs`] for a task id by resolving `task_docs_dir()` and
/// checking the on-disk existence of each optional doc file.
pub fn build_task_docs(task_id: &str) -> Result<TaskDocs, String> {
    let dir = task_docs_dir(task_id)?;
    let dir_str = dir.to_string_lossy().into_owned();
    let file_if_exists = |name: &str| -> Option<String> {
        let p = dir.join(name);
        if p.exists() {
            Some(p.to_string_lossy().into_owned())
        } else {
            None
        }
    };
    Ok(TaskDocs {
        dir: dir_str,
        task_md: dir.join("task.md").to_string_lossy().into_owned(),
        verify_md: file_if_exists("verify.md"),
        progress_md: file_if_exists("progress.md"),
        alignment_md: file_if_exists("alignment.md"),
    })
}

/// Response shape for `cmd_task_get` — flattens [`Task`] and adjoins a
/// computed [`TaskDocs`]. `#[serde(flatten)]` keeps the JSON shape
/// backwards-compatible (all prior Task fields appear at the top level);
/// only `docs` is new. Consumers that don't know about `docs` ignore it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWithDocs {
    #[serde(flatten)]
    pub task: Task,
    pub docs: TaskDocs,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_state: Option<crate::task_scheduler::TaskExecutionState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger_state: Option<crate::task_trigger::TaskTriggerRuntimeState>,
    /// Computed by the scheduler authority; never persisted on the Task row.
    pub next_execution_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProjection {
    #[serde(flatten)]
    pub task: Task,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_state: Option<crate::task_scheduler::TaskExecutionState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_error: Option<String>,
    /// Computed by the scheduler authority; never persisted on the Task row.
    pub next_execution_at: Option<i64>,
}

impl TaskProjection {
    fn new(task: Task, execution: Option<crate::task_scheduler::TaskExecutionProjection>) -> Self {
        let next_execution_at = crate::task_scheduler::next_execution_at(&task)
            .ok()
            .flatten()
            .map(|value| value.timestamp_millis());
        Self {
            task,
            execution_state: execution.as_ref().map(|value| value.state),
            execution_error: execution.and_then(|value| value.error),
            next_execution_at,
        }
    }
}

pub(crate) async fn project_task(task: Task) -> TaskProjection {
    let execution = crate::task_scheduler::get_task_scheduler()
        .execution_projection(&task.id)
        .await;
    TaskProjection::new(task, execution)
}

/// Lightweight list projection. Trigger runtime diagnostics intentionally stay
/// on the per-id get path so one large or corrupt state file cannot fail a
/// collection read.
pub(crate) async fn project_task_list(tasks: Vec<Task>) -> Vec<TaskProjection> {
    let executions = crate::task_scheduler::get_task_scheduler()
        .execution_projections_snapshot()
        .await;
    tasks
        .into_iter()
        .map(|task| {
            let execution = executions.get(&task.id).cloned();
            TaskProjection::new(task, execution)
        })
        .collect()
}

// ================ Input DTOs ================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreateDirectInput {
    pub name: String,
    pub executor: TaskExecutor,
    #[serde(default)]
    pub description: Option<String>,
    pub workspace_id: String,
    pub workspace_path: String,
    /// Contents of `task.md` — the "executor" prompt that will be sent on dispatch.
    pub task_md_content: String,
    pub execution_mode: TaskExecutionMode,
    #[serde(default)]
    pub run_mode: Option<TaskRunMode>,
    #[serde(default)]
    pub end_conditions: Option<TaskEndConditions>,
    // ── Scheduling detail fields (v0.1.69 unified model) ────────────────
    #[serde(default)]
    pub interval_minutes: Option<u32>,
    #[serde(default)]
    pub cron_expression: Option<String>,
    #[serde(default)]
    pub cron_timezone: Option<String>,
    #[serde(default)]
    pub start_at: Option<String>,
    #[serde(default)]
    pub recurring_window: Option<RecurringWindow>,
    #[serde(default)]
    pub dispatch_at: Option<i64>,
    #[serde(default)]
    pub trigger: Option<TaskTrigger>,
    // ── Execution overrides ──────────────────────────────────────────────
    #[serde(default)]
    pub model: Option<String>,
    /// PRD 0.2.9 — Per-task provider id override. MUST be paired with
    /// `model` (validated by `validate_task_provider_routing`).
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub preselected_session_id: Option<String>,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub runtime_config: Option<serde_json::Value>,
    /// Per-task MCP enable list override (PRD 0.2.4 §需求 4).
    #[serde(default)]
    pub mcp_enabled_servers: Option<Vec<String>>,
    /// Internal system-managed task marker. Only a small allow-list is accepted.
    #[serde(default)]
    pub managed_kind: Option<String>,
    #[serde(default, rename = "sourceRecordId")]
    pub source_record_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub notification: Option<NotificationConfig>,
}

#[derive(Debug, Clone, Deserialize)]
pub enum TaskCreateAttachedSource {
    #[serde(rename = "space-issue")]
    SpaceIssue,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreateAttachedInput {
    pub name: String,
    #[serde(default = "default_task_executor_agent")]
    pub executor: TaskExecutor,
    #[serde(default)]
    pub description: Option<String>,
    pub workspace_id: String,
    pub workspace_path: String,
    pub task_md_content: String,
    pub current_session_id: String,
    pub source: TaskCreateAttachedSource,
    #[serde(default)]
    pub source_space_id: Option<String>,
    pub source_issue_id: String,
    #[serde(default)]
    pub source_claim_id: Option<String>,
    #[serde(default)]
    pub source_delivery_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub notification: Option<NotificationConfig>,
}

/// Trusted context persisted for a Task discussion. Discussion artifacts live
/// outside the Task store and never create a task row by themselves.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDiscussionMetadata {
    pub discussion_id: String,
    pub workspace_id: String,
    pub workspace_path: String,
    #[serde(default, rename = "sourceRecordId", alias = "sourceThoughtId")]
    pub source_record_id: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedTaskDiscussion {
    pub discussion_id: String,
    pub discussion_dir: String,
    pub candidates_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDiscussionInput {
    text: String,
    client_request_id: String,
    primary_context: TaskDiscussionPrimaryContext,
    required_system_skill: TaskDiscussionSkillRequirement,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskDiscussionPrimaryContext {
    kind: String,
    input: TaskDiscussionContext,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskDiscussionContext {
    candidates_dir: String,
    workspace_id: String,
    workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_record_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_record_document_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_record_audio_paths: Option<Vec<TaskDiscussionAudioSource>>,
    visible_user_message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskDiscussionAudioSource {
    track: String,
    path: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskDiscussionSkillRequirement {
    name: String,
    source_local_id: String,
    system_skills_version: String,
    content_sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdateInput {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub executor: Option<TaskExecutor>,
    #[serde(default)]
    pub description: Option<String>,
    /// Workspace identity is an atomic pair. A caller must update both the
    /// stable project id and its absolute execution path in the same write.
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub execution_mode: Option<TaskExecutionMode>,
    #[serde(default)]
    pub run_mode: Option<TaskRunMode>,
    #[serde(default)]
    pub end_conditions: Option<TaskEndConditions>,
    // ── Scheduling detail fields ────────────────────────────────────────
    #[serde(default)]
    pub interval_minutes: Option<u32>,
    #[serde(default)]
    pub cron_expression: Option<String>,
    #[serde(default)]
    pub cron_timezone: Option<String>,
    #[serde(default)]
    pub start_at: Option<String>,
    #[serde(default)]
    pub recurring_window: Option<RecurringWindow>,
    #[serde(default)]
    pub dispatch_at: Option<i64>,
    #[serde(default)]
    pub trigger: Option<TaskTrigger>,
    #[serde(default)]
    pub clear_trigger: bool,
    // ── Execution overrides ──────────────────────────────────────────────
    #[serde(default)]
    pub model: Option<String>,
    /// PRD 0.2.9 — Per-task provider id override.
    ///
    /// On update semantics: `None` means "leave provider_id unchanged" (omitted
    /// in JSON or sent as `null` — serde collapses both to `None` here, so
    /// `null-as-clear` is NOT a thing for this field, contrary to a stale
    /// earlier doc revision). To clear the override, callers MUST use
    /// `clear_provider_override: true` (below), which atomically resets both
    /// `provider_id` and `model` to `None`. Validated by
    /// `validate_task_provider_routing`.
    #[serde(default)]
    pub provider_id: Option<String>,
    /// PRD 0.2.9 — Explicit "clear all builtin-runtime overrides" flag. When
    /// true, `provider_id` and `model` are both reset to `None` regardless
    /// of what the corresponding fields above carry. Lets the renderer's
    /// "跟随 Agent" picker option round-trip cleanly without inventing a
    /// double-Option serde shape.
    #[serde(default)]
    pub clear_provider_override: bool,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub preselected_session_id: Option<String>,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub runtime_config: Option<serde_json::Value>,
    /// PRD #131 / Codex-review #2 — symmetric "clear runtime override"
    /// flag. When true, `runtime` AND `runtime_config` are both reset to
    /// `None` regardless of what the corresponding fields above carry.
    /// Without this, the renderer's "跟随 Agent" runtime option could
    /// not round-trip a clear: `runtime: undefined` over JSON deserializes
    /// to `None`, but the apply path uses `if let Some(v) = input.runtime`
    /// which leaves the existing override untouched. Mirrors the
    /// established pattern from `clear_provider_override`.
    #[serde(default)]
    pub clear_runtime_override: bool,
    /// Per-task MCP enable list override. `Some(vec![])` means explicitly no
    /// MCP; `None` = leave existing override untouched.
    #[serde(default)]
    pub mcp_enabled_servers: Option<Vec<String>>,
    /// Reset MCP override to follow Agent/workspace. This is separate from
    /// `mcp_enabled_servers = Some(vec![])`, which is now a real explicit
    /// "no MCP" state.
    #[serde(default)]
    pub clear_mcp_override: bool,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub notification: Option<NotificationConfig>,
    /// Field-level notification update merged under the same Task write lock.
    /// Kept separate from full `notification` replacement so existing GUI
    /// callers retain their exact contract.
    #[serde(default)]
    pub notification_patch: Option<TaskNotificationPatch>,
    /// When `Some`, the new contents are atomically written to
    /// `~/.myagents/tasks/<id>/task.md` under the same write lock that persists the
    /// JSONL row. Empty string is rejected — prompt must have content.
    #[serde(default)]
    pub prompt: Option<String>,
}

/// Internal-only status-transition payload. Accepts explicit `actor`/`source`
/// because crash recovery, scheduler ticks, end-condition firing, watchdog,
/// and CLI adapters all need to assert *their* actor — not the client's.
///
/// The public Tauri command uses `UiTaskUpdateStatusInput` which omits these
/// fields and the Tauri layer stamps `actor=user, source=ui` authoritatively
/// (PRD §10.2.1 caller-inference table row 3: UI button → user/ui). This
/// prevents a malicious/buggy renderer from spoofing `actor=agent` or
/// `source=endCondition`.
#[derive(Debug, Clone)]
pub struct TaskUpdateStatusInput {
    pub id: String,
    pub status: TaskStatus,
    pub message: Option<String>,
    pub actor: TransitionActor,
    pub source: Option<TransitionSource>,
}

/// Public DTO for the Tauri command. NOT serde-tagged with `actor`/`source` — those
/// are stamped by the command handler from its trusted entry context.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiTaskUpdateStatusInput {
    pub id: String,
    pub status: TaskStatus,
    #[serde(default)]
    pub message: Option<String>,
}

/// Accepts either a single status (`"running"`) or an array (`["running", "done"]`).
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum StatusFilter {
    One(TaskStatus),
    Many(Vec<TaskStatus>),
}

impl StatusFilter {
    fn matches(&self, s: TaskStatus) -> bool {
        match self {
            Self::One(x) => *x == s,
            Self::Many(xs) => xs.iter().any(|x| *x == s),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskListFilter {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub status: Option<StatusFilter>,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub include_deleted: Option<bool>,
    #[serde(default)]
    pub include_managed: Option<bool>,
}

// ================ Errors ================

/// Transition-related rejection returned to the caller. Rendered as `{code, message}`
/// so the UI / CLI can branch on `code` rather than string-match messages.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOpError {
    pub code: String,
    pub message: String,
}

impl TaskOpError {
    fn invalid_transition(from: TaskStatus, to: TaskStatus) -> Self {
        Self {
            code: "invalid_transition".to_string(),
            message: format!(
                "invalid transition from {} to {}",
                from.as_str(),
                to.as_str()
            ),
        }
    }
    fn archive_user_only() -> Self {
        Self {
            code: "archive_user_only".to_string(),
            message: "archive is user-only (PRD §9.1)".to_string(),
        }
    }
    fn agent_source_must_be_cli() -> Self {
        Self {
            code: "agent_source_must_be_cli".to_string(),
            message: "agent transitions must come through CLI (source='cli')".to_string(),
        }
    }
    fn not_found(id: &str) -> Self {
        Self {
            code: "not_found".to_string(),
            message: format!("task not found: {}", id),
        }
    }
    fn already_deleted() -> Self {
        Self {
            code: "already_deleted".to_string(),
            message: "task has been deleted".to_string(),
        }
    }
    fn update_rejected_while_running() -> Self {
        Self {
            code: "update_rejected_running".to_string(),
            message: "cannot edit task fields while running/verifying".to_string(),
        }
    }
}

impl From<TaskOpError> for String {
    fn from(e: TaskOpError) -> Self {
        // When serialized to the CLI / invoke() caller, preserve `code` by
        // embedding a JSON-stringified payload. Callers that just want a message
        // can parse it back; ones that don't care just show it.
        serde_json::to_string(&e).unwrap_or_else(|_| e.message.clone())
    }
}

// ================ State machine ================

/// The exhaustive transition table from PRD §9.1 (v1.4, with lenient
/// verifying → running). Returns `true` if the transition is legal at the
/// machine level (actor/source guards are applied separately).
pub fn is_transition_legal(from: TaskStatus, to: TaskStatus) -> bool {
    use TaskStatus::*;
    matches!(
        (from, to),
        // Forward progression
        (Todo, Running)
        | (Running, Verifying)
        | (Running, Done)
        | (Running, Blocked)
        | (Running, Stopped)
        | (Verifying, Running)     // v1.4 lenient mode
        | (Verifying, Done)
        | (Verifying, Blocked)
        | (Verifying, Stopped)
        // Re-run / reset
        | (Blocked, Todo)
        | (Stopped, Todo)
        | (Done, Todo)
        | (Archived, Todo)
        // Archiving
        | (Done, Archived)
        // Restore is organization only, not a rerun. Only Done can archive.
        | (Archived, Done)
    )
}

/// A stop request against an already terminal schedule is idempotent control
/// of its concrete turn, not a second durable status transition. This keeps
/// the original terminal reason (`blocked` / `done` / `archived`) while still
/// providing retry-stop when exact turn confirmation previously failed.
pub(crate) fn is_terminal_execution_stop_request(from: TaskStatus, to: TaskStatus) -> bool {
    to == TaskStatus::Stopped
        && matches!(
            from,
            TaskStatus::Blocked | TaskStatus::Stopped | TaskStatus::Done | TaskStatus::Archived
        )
}

// ================ Store ================

pub struct TaskStore {
    /// taskId → Task (full row)
    inner: Arc<RwLock<HashMap<String, Task>>>,
    jsonl_path: PathBuf,
    /// A malformed store remains read-only so recovery cannot overwrite the
    /// original bytes with an empty or partial map.
    load_error: Option<String>,
    /// User-scoped Task artifact root. In production this is the same
    /// `~/.myagents/tasks/` root used by `task_docs_dir`; deriving it from the
    /// store data dir keeps tests and alternate app data roots isolated.
    task_artifacts_root: PathBuf,
    comment_notification_index: Arc<StdRwLock<TaskCommentNotificationIndex>>,
    /// Persisted `sending` receipts become `unknown` only once per Task after
    /// process start. Ordinary reads must never reinterpret a live admission
    /// as a restart recovery.
    comments_needing_recovery: Arc<StdMutex<HashSet<String>>>,
    #[cfg(test)]
    fail_next_acceptance_comment_persist: std::sync::atomic::AtomicBool,
}

impl TaskStore {
    /// Create a new store. Scans disk, runs crash-recovery migration on any
    /// running/verifying rows (PRD §9.1.1), and returns a handle with the live
    /// (post-recovery) map.
    pub fn new(data_dir: PathBuf) -> Self {
        let jsonl_path = data_dir.join("tasks.jsonl");
        let task_artifacts_root = data_dir.join("tasks");
        if let Some(parent) = jsonl_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let (initial, needs_rewrite, load_error) = match Self::load_and_recover(&jsonl_path) {
            Ok((tasks, needs_rewrite)) => (tasks, needs_rewrite, None),
            Err(error) => {
                ulog_error!(
                    "[task] store is corrupt and will remain read-only: {}",
                    error
                );
                (HashMap::new(), false, Some(error))
            }
        };
        // Write back the recovery results synchronously so a second crash doesn't
        // lose the migration. This runs during app `setup()` before any command is
        // dispatchable, so there is no contention.
        if needs_rewrite {
            if let Err(e) = Self::persist_locked(&jsonl_path, &initial) {
                ulog_warn!("[task] crash-recovery persist failed: {}", e);
            } else {
                ulog_info!("[task] startup recovery updates persisted");
            }
        }
        let comments_needing_recovery = Arc::new(StdMutex::new(
            initial.keys().cloned().collect::<HashSet<_>>(),
        ));
        let comment_notification_index =
            Arc::new(StdRwLock::new(TaskCommentNotificationIndex::default()));
        let rebuild_tasks = initial
            .values()
            .filter(|task| !task.deleted && !is_managed_task(task))
            .cloned()
            .collect::<Vec<_>>();
        // The comment source is rebuilt away from the startup/UI thread. Until
        // it completes, notification snapshots report the local source as
        // loading while Cloud notifications remain usable.
        spawn_comment_notification_rebuild(
            comment_notification_index.clone(),
            task_artifacts_root.clone(),
            rebuild_tasks,
        );
        let store = Self {
            inner: Arc::new(RwLock::new(initial)),
            jsonl_path,
            load_error,
            task_artifacts_root,
            comment_notification_index,
            comments_needing_recovery,
            #[cfg(test)]
            fail_next_acceptance_comment_persist: std::sync::atomic::AtomicBool::new(false),
        };
        store.cleanup_orphaned_trigger_state();
        store
    }

    pub fn agent_comment_notification_source(&self) -> TaskCommentNotificationSource {
        let index = self
            .comment_notification_index
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut items = index.items.clone();
        items.extend(index.pending_during_rebuild.clone());
        items.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| right.notification_id.cmp(&left.notification_id))
        });
        items.dedup_by(|left, right| left.notification_id == right.notification_id);
        items.truncate(MAX_TASK_COMMENT_NOTIFICATION_INDEX);
        TaskCommentNotificationSource {
            ready: index.ready,
            partial_error: index.partial_error,
            items,
        }
    }

    fn index_agent_comment(&self, locator: TaskAgentCommentLocator) {
        let mut index = self
            .comment_notification_index
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if matches!(index.task_projections.get(&locator.task_id), Some(None)) {
            return;
        }
        if !index.ready {
            index.pending_during_rebuild.push(locator);
            if index.pending_during_rebuild.len() >= MAX_TASK_COMMENT_NOTIFICATION_INDEX * 2 {
                sort_and_bound_comment_locators(&mut index.pending_during_rebuild);
            }
            return;
        }
        index
            .items
            .retain(|item| item.notification_id != locator.notification_id);
        index.items.push(locator);
        sort_and_bound_comment_locators(&mut index.items);
    }

    /// Retry a startup index scan that completed partially. Notification
    /// refreshes call this opportunistically, so transient file errors recover
    /// without adding another polling owner or blocking the UI thread.
    pub async fn retry_comment_notification_index_if_partial(&self) {
        let should_retry = {
            let mut index = self
                .comment_notification_index
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !index.ready || !index.partial_error {
                false
            } else {
                index.ready = false;
                index.partial_error = false;
                true
            }
        };
        if !should_retry {
            return;
        }
        let tasks = self
            .inner
            .read()
            .await
            .values()
            .filter(|task| !task.deleted && !is_managed_task(task))
            .cloned()
            .collect::<Vec<_>>();
        spawn_comment_notification_rebuild(
            self.comment_notification_index.clone(),
            self.task_artifacts_root.clone(),
            tasks,
        );
    }

    fn reconcile_task_comment_notification_index(&self, task: &Task) {
        let mut index = self
            .comment_notification_index
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let projection = (!task.deleted && !is_managed_task(task)).then(|| task.name.clone());
        index
            .task_projections
            .insert(task.id.clone(), projection.clone());
        if let Some(name) = projection.as_ref() {
            for item in index
                .items
                .iter_mut()
                .filter(|item| item.task_id == task.id)
            {
                item.task_name.clone_from(name);
            }
            for item in index
                .pending_during_rebuild
                .iter_mut()
                .filter(|item| item.task_id == task.id)
            {
                item.task_name.clone_from(name);
            }
        } else {
            index.items.retain(|item| item.task_id != task.id);
            index
                .pending_during_rebuild
                .retain(|item| item.task_id != task.id);
        }
    }

    /// A deleted or non-command Task cannot own Trigger runtime state. The Task
    /// row itself is the durable cleanup obligation, so startup can repair any
    /// interrupted best-effort deletion without a second persisted flag.
    fn cleanup_orphaned_trigger_state(&self) {
        let current = self
            .inner
            .try_read()
            .expect("TaskStore is uncontended during construction")
            .clone();
        for task in current
            .values()
            .filter(|task| task.deleted || !task.effective_trigger().is_command())
        {
            let task_id = &task.id;
            let path = match self.trigger_state_path(task_id) {
                Ok(path) => path,
                Err(error) => {
                    ulog_warn!(
                        "[task] Trigger state cleanup path rejected task={}: {}",
                        task_id,
                        error
                    );
                    continue;
                }
            };
            match fs::remove_file(&path) {
                Ok(()) => {
                    ulog_info!("[task] Trigger state cleanup recovered task={}", task_id);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    ulog_warn!(
                        "[task] Trigger state cleanup will retry on next startup task={}: {}",
                        task_id,
                        error
                    );
                }
            }
        }
    }

    pub(crate) fn trigger_state_path(&self, task_id: &str) -> Result<PathBuf, String> {
        validate_safe_id(task_id, "taskId")?;
        let resolved = self
            .task_artifacts_root
            .join(task_id)
            .join("trigger-state.json");
        if !resolved.starts_with(&self.task_artifacts_root) {
            return Err("trigger state path escaped Task artifact root".to_string());
        }
        Ok(resolved)
    }

    fn comments_path(&self, task_id: &str) -> Result<PathBuf, String> {
        validate_safe_id(task_id, "taskId")?;
        let resolved = self
            .task_artifacts_root
            .join(task_id)
            .join("comments.jsonl");
        if !resolved.starts_with(&self.task_artifacts_root) {
            return Err("comments path escaped Task artifact root".to_string());
        }
        Ok(resolved)
    }

    fn load_comments_file(
        path: &Path,
        recover_interrupted_sending: bool,
    ) -> Result<(Vec<TaskComment>, bool), String> {
        let file = match fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok((Vec::new(), false));
            }
            Err(error) => return Err(format!("open comments: {error}")),
        };
        let mut comments = Vec::new();
        let mut normalized = false;
        for (index, line) in BufReader::new(file).lines().enumerate() {
            let line =
                line.map_err(|error| format!("read comments line {}: {error}", index + 1))?;
            if line.trim().is_empty() {
                continue;
            }
            let mut comment: TaskComment = serde_json::from_str(&line)
                .map_err(|error| format!("parse comments line {}: {error}", index + 1))?;
            if recover_interrupted_sending
                && comment
                    .admission
                    .as_ref()
                    .is_some_and(|value| value.state == TaskCommentAdmissionState::Sending)
            {
                if let Some(admission) = comment.admission.as_mut() {
                    admission.state = TaskCommentAdmissionState::Unknown;
                    admission.error = Some(
                        "Delivery may have been accepted before the app restarted; retry explicitly if needed"
                            .to_string(),
                    );
                }
                normalized = true;
            }
            comments.push(comment);
        }
        comments.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok((comments, normalized))
    }

    fn load_task_comments(&self, task_id: &str, path: &Path) -> Result<Vec<TaskComment>, String> {
        let recover = {
            let mut pending = self
                .comments_needing_recovery
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            pending.remove(task_id)
        };
        let loaded = Self::load_comments_file(path, recover);
        let (comments, normalized) = match loaded {
            Ok(value) => value,
            Err(error) => {
                if recover {
                    self.comments_needing_recovery
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .insert(task_id.to_string());
                }
                return Err(error);
            }
        };
        if normalized {
            if let Err(error) = Self::persist_comments_file(path, &comments) {
                self.comments_needing_recovery
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(task_id.to_string());
                return Err(error);
            }
        }
        Ok(comments)
    }

    fn persist_comments_file(path: &Path, comments: &[TaskComment]) -> Result<(), String> {
        let mut content = String::new();
        for comment in comments {
            let line = serde_json::to_string(comment)
                .map_err(|error| format!("serialize task comment: {error}"))?;
            content.push_str(&line);
            content.push('\n');
        }
        write_atomic_text(path, &content).map_err(|error| format!("persist comments: {error}"))
    }

    fn validate_comment_body(body: &str) -> Result<String, String> {
        let body = body.trim().to_string();
        if body.is_empty() {
            return Err("comment body is empty".to_string());
        }
        if body.len() > TASK_COMMENT_BODY_MAX_BYTES {
            return Err(format!(
                "comment body exceeds {} byte limit",
                TASK_COMMENT_BODY_MAX_BYTES
            ));
        }
        Ok(body)
    }

    pub async fn list_comments(
        &self,
        task_id: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<TaskCommentPage, String> {
        let limit = limit.clamp(1, 100);
        let guard = self.inner.write().await;
        let task = ordinary_task_for_read(&guard, task_id)?;
        let path = self.comments_path(&task.id)?;
        let comments = self.load_task_comments(task_id, &path)?;
        let end = match before {
            Some(cursor) => comments
                .iter()
                .position(|comment| comment.id == cursor)
                .ok_or_else(|| format!("comment cursor not found: {cursor}"))?,
            None => comments.len(),
        };
        let start = end.saturating_sub(limit);
        let items = comments[start..end].to_vec();
        let next_before = (start > 0).then(|| items[0].id.clone());
        let reply_parents = reply_parent_summaries(&comments, &items);
        Ok(TaskCommentPage {
            items,
            next_before,
            next_after: None,
            reply_parents,
        })
    }

    pub async fn list_comments_after(
        &self,
        task_id: &str,
        after: &str,
        limit: usize,
    ) -> Result<TaskCommentPage, String> {
        let limit = limit.clamp(1, 100);
        let guard = self.inner.write().await;
        let task = ordinary_task_for_read(&guard, task_id)?;
        let path = self.comments_path(&task.id)?;
        let comments = self.load_task_comments(task_id, &path)?;
        let start = comments
            .iter()
            .position(|comment| comment.id == after)
            .ok_or_else(|| format!("comment cursor not found: {after}"))?
            .saturating_add(1);
        let end = start.saturating_add(limit).min(comments.len());
        let items = comments[start..end].to_vec();
        let next_after = (end < comments.len())
            .then(|| items.last().map(|item| item.id.clone()))
            .flatten();
        let reply_parents = reply_parent_summaries(&comments, &items);
        Ok(TaskCommentPage {
            items,
            next_before: None,
            next_after,
            reply_parents,
        })
    }

    pub async fn comment_context(
        &self,
        task_id: &str,
        comment_id: &str,
        radius: usize,
    ) -> Result<TaskCommentContextPage, String> {
        let guard = self.inner.write().await;
        let task = ordinary_task_for_read(&guard, task_id)?;
        let path = self.comments_path(&task.id)?;
        let comments = self.load_task_comments(task_id, &path)?;
        let target = comments
            .iter()
            .position(|comment| comment.id == comment_id)
            .ok_or_else(|| format!("comment not found: {comment_id}"))?;
        let start = target.saturating_sub(radius.clamp(1, 50));
        let end = (target + radius.clamp(1, 50) + 1).min(comments.len());
        let items = comments[start..end].to_vec();
        let reply_parents = reply_parent_summaries(&comments, &items);
        Ok(TaskCommentContextPage {
            items,
            target_comment_id: comment_id.to_string(),
            previous_before: (start > 0).then(|| comments[start].id.clone()),
            next_after: (end < comments.len()).then(|| comments[end - 1].id.clone()),
            reply_parents,
        })
    }

    pub async fn create_user_comment(
        &self,
        task_id: &str,
        body: &str,
        reply_to_comment_id: Option<&str>,
    ) -> Result<TaskComment, String> {
        self.create_user_comment_with_session_probe(
            task_id,
            body,
            reply_to_comment_id,
            session_metadata_exists,
        )
        .await
    }

    pub(crate) async fn create_user_comment_with_session_probe(
        &self,
        task_id: &str,
        body: &str,
        reply_to_comment_id: Option<&str>,
        session_exists: impl Fn(&str) -> bool,
    ) -> Result<TaskComment, String> {
        self.ensure_writable()?;
        let body = Self::validate_comment_body(body)?;
        let guard = self.inner.write().await;
        let task = ordinary_task_for_comment(&guard, task_id)?;
        let path = self.comments_path(&task.id)?;
        let mut comments = self.load_task_comments(task_id, &path)?;
        let target_session_id = if let Some(parent_id) = reply_to_comment_id {
            comments
                .iter()
                .find(|comment| comment.id == parent_id)
                .ok_or_else(|| format!("reply comment not found: {parent_id}"))?
                .conversation_session_id
                .clone()
        } else {
            task.session_ids
                .iter()
                .rev()
                .find(|session_id| session_exists(session_id))
                .cloned()
                .or_else(|| {
                    task.preselected_session_id
                        .as_ref()
                        .filter(|session_id| session_exists(session_id))
                        .cloned()
                })
        };
        // The persisted file is the linear timeline authority. Millisecond
        // clocks can tie during rapid replies, so advance from the last row to
        // preserve the user's observable order without a second sequence.
        let now = next_task_comment_timestamp(&comments);
        let comment = TaskComment {
            id: Uuid::new_v4().to_string(),
            task_id: task.id.clone(),
            body,
            author: TaskCommentAuthor::User { label: None },
            created_at: now,
            reply_to_comment_id: reply_to_comment_id.map(str::to_string),
            conversation_session_id: target_session_id.clone(),
            admission: Some(TaskCommentAdmission {
                state: if target_session_id.is_some() {
                    TaskCommentAdmissionState::Sending
                } else {
                    TaskCommentAdmissionState::PendingSession
                },
                target_session_id,
                attempt_id: Some(Uuid::new_v4().to_string()),
                accepted_at: None,
                error: None,
            }),
        };
        comments.push(comment.clone());
        Self::persist_comments_file(&path, &comments)?;
        drop(guard);
        emit_task_event(
            "task:comment-changed",
            serde_json::json!({ "taskId": task_id, "commentId": comment.id, "event": "created" }),
        );
        Ok(comment)
    }

    pub async fn append_agent_comment(
        &self,
        task_id: &str,
        session_id: &str,
        body: &str,
        reply_to_comment_id: Option<&str>,
    ) -> Result<TaskComment, String> {
        self.ensure_writable()?;
        validate_safe_id(session_id, "sessionId")?;
        let body = Self::validate_comment_body(body)?;
        let guard = self.inner.write().await;
        let task = ordinary_task_for_comment(&guard, task_id)?;
        if !task_bound_session_ids(task)
            .iter()
            .any(|value| value == session_id)
        {
            return Err(format!(
                "session {session_id} is not associated with task {task_id}"
            ));
        }
        let task_for_index = task.clone();
        let path = self.comments_path(&task.id)?;
        let mut comments = self.load_task_comments(task_id, &path)?;
        if let Some(parent_id) = reply_to_comment_id {
            if !comments.iter().any(|comment| comment.id == parent_id) {
                return Err(format!("reply comment not found: {parent_id}"));
            }
        }
        let comment = TaskComment {
            id: Uuid::new_v4().to_string(),
            task_id: task.id.clone(),
            body,
            author: TaskCommentAuthor::Agent {
                label: None,
                session_id: session_id.to_string(),
            },
            created_at: next_task_comment_timestamp(&comments),
            reply_to_comment_id: reply_to_comment_id.map(str::to_string),
            conversation_session_id: Some(session_id.to_string()),
            admission: None,
        };
        comments.push(comment.clone());
        Self::persist_comments_file(&path, &comments)?;
        drop(guard);
        if let Some(locator) = agent_comment_locator(&task_for_index, &comment) {
            self.index_agent_comment(locator);
        }
        emit_task_event(
            "task:comment-changed",
            serde_json::json!({
                "taskId": task_id,
                "commentId": comment.id,
                "event": "agent_created",
            }),
        );
        Ok(comment)
    }

    pub async fn update_comment_admission(
        &self,
        task_id: &str,
        comment_id: &str,
        state: TaskCommentAdmissionState,
        error: Option<String>,
    ) -> Result<TaskComment, String> {
        let guard = self.inner.write().await;
        ordinary_task_for_comment(&guard, task_id)?;
        let path = self.comments_path(task_id)?;
        let mut comments = self.load_task_comments(task_id, &path)?;
        let comment = comments
            .iter_mut()
            .find(|comment| comment.id == comment_id)
            .ok_or_else(|| format!("comment not found: {comment_id}"))?;
        let admission = comment
            .admission
            .as_mut()
            .ok_or_else(|| "agent comments do not have delivery admission".to_string())?;
        admission.state = state;
        admission.error = error.map(|value| value.chars().take(500).collect());
        admission.accepted_at = (state == TaskCommentAdmissionState::Accepted).then(now_ms);
        let updated = comment.clone();
        Self::persist_comments_file(&path, &comments)?;
        drop(guard);
        emit_task_event(
            "task:comment-changed",
            serde_json::json!({ "taskId": task_id, "commentId": comment_id, "event": "admission" }),
        );
        Ok(updated)
    }

    pub async fn claim_pending_comments(
        &self,
        task_id: &str,
        session_id: &str,
    ) -> Result<Vec<TaskComment>, String> {
        let guard = self.inner.write().await;
        ordinary_task_for_comment(&guard, task_id)?;
        let path = self.comments_path(task_id)?;
        let mut comments = self.load_task_comments(task_id, &path)?;
        let mut claimed = Vec::new();
        for comment in &mut comments {
            let Some(admission) = comment.admission.as_mut() else {
                continue;
            };
            if admission.state != TaskCommentAdmissionState::PendingSession
                || comment.conversation_session_id.is_some()
            {
                continue;
            }
            comment.conversation_session_id = Some(session_id.to_string());
            admission.state = TaskCommentAdmissionState::Sending;
            admission.target_session_id = Some(session_id.to_string());
            admission.attempt_id = Some(Uuid::new_v4().to_string());
            admission.error = None;
            claimed.push(comment.clone());
        }
        if !claimed.is_empty() {
            Self::persist_comments_file(&path, &comments)?;
        }
        drop(guard);
        if !claimed.is_empty() {
            emit_task_event(
                "task:comment-changed",
                serde_json::json!({ "taskId": task_id, "event": "claimed" }),
            );
        }
        Ok(claimed)
    }

    pub async fn retry_comment(
        &self,
        task_id: &str,
        comment_id: &str,
    ) -> Result<TaskComment, String> {
        let guard = self.inner.write().await;
        ordinary_task_for_comment(&guard, task_id)?;
        let path = self.comments_path(task_id)?;
        let mut comments = self.load_task_comments(task_id, &path)?;
        let comment = comments
            .iter_mut()
            .find(|comment| comment.id == comment_id)
            .ok_or_else(|| format!("comment not found: {comment_id}"))?;
        let admission = comment
            .admission
            .as_mut()
            .ok_or_else(|| "agent comments cannot be retried".to_string())?;
        if !matches!(
            admission.state,
            TaskCommentAdmissionState::Failed | TaskCommentAdmissionState::Unknown
        ) {
            return Err("only failed or unknown comments can be retried".to_string());
        }
        let target = admission
            .target_session_id
            .clone()
            .ok_or_else(|| "comment has no exact target Session".to_string())?;
        comment.conversation_session_id = Some(target);
        admission.state = TaskCommentAdmissionState::Sending;
        admission.attempt_id = Some(Uuid::new_v4().to_string());
        admission.accepted_at = None;
        admission.error = None;
        let updated = comment.clone();
        Self::persist_comments_file(&path, &comments)?;
        drop(guard);
        emit_task_event(
            "task:comment-changed",
            serde_json::json!({ "taskId": task_id, "commentId": comment_id, "event": "retry" }),
        );
        Ok(updated)
    }

    /// Acquire every Session lifecycle that the projected Task state will
    /// protect, then re-read under the TaskStore write lock. Retrying when the
    /// projection changes gives all durable binding mutations one lock order:
    /// Session lifecycle -> TaskStore. Session deletion uses the same order.
    async fn lock_for_session_protection<'a, F>(
        &'a self,
        id: &str,
        protected_after: F,
    ) -> Result<
        (
            tokio::sync::RwLockWriteGuard<'a, HashMap<String, Task>>,
            crate::sidecar::SessionLifecycleGuard,
        ),
        String,
    >
    where
        F: Fn(&Task) -> Vec<String>,
    {
        loop {
            // Do not await lifecycle while holding TaskStore: deletion takes
            // lifecycle first and then reads TaskStore.
            let expected_session_ids = {
                let inner = self.inner.read().await;
                let task = inner
                    .get(id)
                    .ok_or_else(|| String::from(TaskOpError::not_found(id)))?;
                protected_after(task)
            };
            let session_refs = expected_session_ids
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>();
            let lifecycle = crate::sidecar::acquire_session_lifecycle(&session_refs).await;
            let inner = self.inner.write().await;
            let current = inner
                .get(id)
                .ok_or_else(|| String::from(TaskOpError::not_found(id)))?;
            if protected_after(current) == expected_session_ids {
                return Ok((inner, lifecycle));
            }
            drop(inner);
            drop(lifecycle);
        }
    }

    fn load_and_recover(path: &Path) -> Result<(HashMap<String, Task>, bool), String> {
        let mut map = Self::load_jsonl(path)?;
        let now = now_ms();
        let mut changed = false;
        for task in map.values_mut() {
            if task.promote_published_legacy_source() {
                changed = true;
            }
            if task.last_scheduled_at.is_none() && task.last_executed_at.is_some() {
                task.last_scheduled_at = task.last_executed_at;
                changed = true;
            }
            if !matches!(task.status, TaskStatus::Running | TaskStatus::Verifying) {
                continue;
            }
            let from = task.status;
            if from == TaskStatus::Running && task.execution_mode == TaskExecutionMode::Loop {
                task.status = TaskStatus::Stopped;
                task.updated_at = now;
                task.status_history.push(StatusTransition {
                    from: Some(from),
                    to: TaskStatus::Stopped,
                    at: now,
                    actor: TransitionActor::System,
                    message: Some("Legacy Loop tasks are retired".to_string()),
                    source: Some(TransitionSource::Migration),
                });
                changed = true;
                continue;
            }
            // Running is the durable "scheduler enabled" state for time-based
            // Tasks, not proof that a turn was in flight. Preserve recurring
            // Tasks and one-shots that have not fired; TaskScheduler rebuilds
            // their only in-memory handle after startup migration.
            let recover_scheduler = from == TaskStatus::Running
                && (task.effective_trigger().is_command()
                    || task.execution_mode == TaskExecutionMode::Recurring
                    || (task.execution_mode == TaskExecutionMode::Scheduled
                        && task.execution_count == 0));
            if recover_scheduler {
                continue;
            }

            task.status = TaskStatus::Blocked;
            task.updated_at = now;
            task.status_history.push(StatusTransition {
                from: Some(from),
                to: TaskStatus::Blocked,
                at: now,
                actor: TransitionActor::System,
                message: Some("上次运行被应用重启中断,可重新派发以继续".to_string()),
                source: Some(TransitionSource::Crash),
            });
            changed = true;
        }
        Ok((map, changed))
    }

    fn load_jsonl(path: &Path) -> Result<HashMap<String, Task>, String> {
        let mut map: HashMap<String, Task> = HashMap::new();
        let file = match fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(map),
            Err(error) => return Err(format!("read {}: {}", path.display(), error)),
        };
        let reader = BufReader::new(file);
        for (i, line) in reader.lines().enumerate() {
            let raw = line.map_err(|error| {
                format!("{} line {} I/O error: {}", path.display(), i + 1, error)
            })?;
            if raw.trim().is_empty() {
                continue;
            }
            let task = serde_json::from_str::<Task>(&raw).map_err(|error| {
                format!("{} line {} malformed: {}", path.display(), i + 1, error)
            })?;
            if map.insert(task.id.clone(), task).is_some() {
                return Err(format!(
                    "{} line {} duplicates an earlier task id",
                    path.display(),
                    i + 1
                ));
            }
        }
        ulog_info!("[task] loaded {} task(s) from disk", map.len());
        Ok(map)
    }

    pub(crate) fn ensure_writable(&self) -> Result<(), String> {
        match self.load_error.as_deref() {
            Some(error) => Err(format!(
                "Task store is read-only because startup validation failed: {error}"
            )),
            None => Ok(()),
        }
    }

    /// Atomically rewrite the jsonl file from the provided map.
    ///
    /// Crash-durable atomic-write pattern: write + `sync_all` the tmp file, then
    /// rename, then fsync the containing directory. On any error the tmp file is
    /// best-effort unlinked. Caller MUST hold `inner.write()`; this function does
    /// not take the lock itself.
    fn persist_locked(path: &Path, map: &HashMap<String, Task>) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create tasks dir: {}", e))?;
        }
        let tmp = path.with_extension("jsonl.tmp");
        let write_res = (|| -> Result<(), String> {
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&tmp)
                .map_err(|e| format!("Failed to open tasks tmp: {}", e))?;
            // Deterministic ordering by createdAt for easier diffing.
            let mut rows: Vec<&Task> = map.values().collect();
            rows.sort_by_key(|t| t.created_at);
            for t in rows {
                let line = t
                    .serialize_for_disk()
                    .map_err(|e| format!("serialize task: {}", e))?;
                file.write_all(line.as_bytes())
                    .map_err(|e| format!("write task line: {}", e))?;
                file.write_all(b"\n")
                    .map_err(|e| format!("write newline: {}", e))?;
            }
            file.flush()
                .map_err(|e| format!("flush tasks tmp: {}", e))?;
            // Durability: force the tmp file contents to disk BEFORE rename.
            file.sync_all()
                .map_err(|e| format!("sync tasks tmp: {}", e))?;
            Ok(())
        })();
        if let Err(e) = write_res {
            let _ = fs::remove_file(&tmp); // best-effort cleanup
            return Err(e);
        }
        if let Err(e) = fs::rename(&tmp, path) {
            let _ = fs::remove_file(&tmp); // best-effort cleanup
            return Err(format!("rename tasks.jsonl: {}", e));
        }
        // Best-effort: fsync the containing directory so the rename is durable.
        // Failure here is logged but not fatal — the rename is already committed
        // at kernel level; dir-fsync is just power-loss insurance.
        if let Some(parent) = path.parent() {
            if let Ok(dir) = fs::File::open(parent) {
                let _ = dir.sync_all();
            }
        }
        ulog_debug!("[task] atomically persisted {} tasks", map.len());
        Ok(())
    }

    // ---- Create ----

    pub async fn create_direct(&self, input: TaskCreateDirectInput) -> Result<Task, String> {
        self.create_direct_with_origin(input, TransitionActor::User, Some(TransitionSource::Ui))
            .await
    }

    pub async fn create_direct_with_origin(
        &self,
        input: TaskCreateDirectInput,
        actor: TransitionActor,
        source: Option<TransitionSource>,
    ) -> Result<Task, String> {
        reject_managed_kind_from_ordinary_create(&input.managed_kind)?;
        validate_ordinary_caller_origin(actor, source)?;
        self.create_direct_internal(
            input,
            actor,
            source,
            "created (direct)",
            session_metadata_exists,
        )
        .await
    }

    pub async fn create_system_managed_direct(
        &self,
        input: TaskCreateDirectInput,
    ) -> Result<Task, String> {
        if !input
            .managed_kind
            .as_deref()
            .is_some_and(is_supported_managed_kind)
        {
            return Err("system managed task requires a supported managedKind".to_string());
        }
        self.create_direct_internal(
            input,
            TransitionActor::System,
            Some(TransitionSource::Scheduler),
            "created (system-managed)",
            session_metadata_exists,
        )
        .await
    }

    async fn create_direct_internal<F>(
        &self,
        mut input: TaskCreateDirectInput,
        created_actor: TransitionActor,
        created_source: Option<TransitionSource>,
        created_message: &'static str,
        session_exists: F,
    ) -> Result<Task, String>
    where
        F: FnOnce(&str) -> bool,
    {
        if input.execution_mode == TaskExecutionMode::Loop {
            return Err("Loop task mode is retired; use a Session Goal".to_string());
        }
        // Validate workspace_path + name up front so we don't half-write.
        let workspace_path = canonicalize_workspace_path(&input.workspace_path)?;
        validate_task_name(&input.name)?;
        validate_new_task_session_binding(input.run_mode, input.preselected_session_id.as_deref())?;
        if let Some(trigger) = input.trigger.as_ref() {
            validate_task_trigger(trigger)?;
        }
        // PRD 0.2.9 — Pin runtime='builtin' when provider_id is set with no
        // explicit runtime (closes the "Agent runtime later flips to
        // external" cross-talk hole). Idempotent.
        pin_runtime_for_provider_id(&input.provider_id, &mut input.runtime);
        // Provider/runtime identity invariants are enforced by the Task owner
        // for every ingress, not only by the Agent-facing Node preflight.
        validate_task_execution_routing(
            &input.provider_id,
            &input.model,
            &input.runtime,
            &input.runtime_config,
        )?;
        let managed_kind = normalize_managed_kind(input.managed_kind)?;
        // Cron expression validation at the boundary — same contract as
        // `update()`; ensures the scheduler never gets handed a malformed
        // expression that would make it die silently at first fire.
        if let Some(expr) = input.cron_expression.as_deref() {
            if !expr.trim().is_empty() {
                crate::cron_task::validate_cron_expression(expr, input.cron_timezone.as_deref())
                    .map_err(|e| format!("cron expression invalid: {}", e))?;
            }
        }
        let now = now_ms();
        let id = Uuid::new_v4().to_string();
        // task_docs_dir() internally validates `id`, but `id` is our freshly-minted
        // UUID so it always passes; the guard is for callers that pass external ids.
        let task_dir = task_docs_dir(&id)?;
        let bound_session_id = if input.run_mode == Some(TaskRunMode::SingleSession) {
            input.preselected_session_id.clone()
        } else {
            None
        };
        let bound_session_refs = bound_session_id
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let session_lifecycle =
            crate::sidecar::acquire_session_lifecycle(&bound_session_refs).await;
        if let Some(session_id) = bound_session_id.as_deref() {
            if !session_exists(session_id) {
                return Err(format!(
                    "preselectedSessionId does not reference an existing Session: {}",
                    session_id
                ));
            }
        }

        let t = Task {
            id: id.clone(),
            name: input.name,
            executor: input.executor,
            description: input.description,
            workspace_id: input.workspace_id,
            workspace_path: workspace_path.clone(),
            execution_mode: input.execution_mode,
            run_mode: input.run_mode,
            end_conditions: input.end_conditions,
            interval_minutes: input.interval_minutes,
            cron_expression: input.cron_expression,
            cron_timezone: input.cron_timezone,
            start_at: input.start_at,
            recurring_window: input.recurring_window,
            dispatch_at: input.dispatch_at,
            trigger: input.trigger,
            model: input.model,
            provider_id: input.provider_id,
            permission_mode: input.permission_mode,
            preselected_session_id: input.preselected_session_id,
            runtime: input.runtime,
            runtime_config: input.runtime_config,
            mcp_enabled_servers: normalize_mcp_override(input.mcp_enabled_servers),
            managed_kind,
            source_record_id: input.source_record_id,
            legacy_source_thought_id: None,
            session_ids: Vec::new(),
            status: TaskStatus::Todo,
            tags: input.tags,
            created_at: now,
            updated_at: now,
            last_executed_at: None,
            last_scheduled_at: None,
            execution_count: 0,
            consecutive_execution_failures: 0,
            last_execution: None,
            last_activation_event_id: None,
            status_history: vec![StatusTransition {
                from: None,
                to: TaskStatus::Todo,
                at: now,
                actor: created_actor,
                message: Some(created_message.to_string()),
                source: created_source,
            }],
            notification: input.notification,
            dispatch_origin: TaskDispatchOrigin::Direct,
            external_source: None,
            deleted: false,
            deleted_at: None,
        };

        // Materialize task.md FIRST, commit JSONL LAST (fix cross-review C3):
        // if the docs dir is unwritable (disk full, permissions, etc.) the task.md
        // write fails before the JSONL row is durable. Previous ordering left an
        // "orphan JSONL row with no task.md" on disk after restart — a real
        // integrity violation, not just a recoverable hiccup. Worst case now is
        // an orphan empty directory with no JSONL row referencing it, which is
        // harmless (never shows up in list()) and can be swept by a background
        // cleanup job later.
        self.ensure_writable()?;
        let mut inner = self.inner.write().await;
        fs::create_dir_all(&task_dir)
            .map_err(|e| format!("Failed to create task doc dir: {}", e))?;
        let task_md = task_dir.join("task.md");
        write_atomic_text(&task_md, &input.task_md_content)
            .map_err(|e| format!("Failed to write task.md: {}", e))?;

        let mut next = inner.clone();
        next.insert(id.clone(), t.clone());
        if let Err(e) = Self::persist_locked(&self.jsonl_path, &next) {
            // JSONL write failed — roll back the docs dir so we don't leave
            // orphan directories on disk. `remove_dir_all` is best-effort
            // (already-interrupted filesystem may leave stragglers); log and
            // continue so the caller gets the actual error, not a cleanup one.
            if let Err(cleanup_err) = fs::remove_dir_all(&task_dir) {
                ulog_warn!(
                    "[task] jsonl write failed AND task_dir cleanup failed id={} path={} err={}",
                    id,
                    task_dir.display(),
                    cleanup_err
                );
            }
            return Err(e);
        }
        *inner = next;
        drop(inner);
        drop(session_lifecycle);
        ulog_info!("[task] created direct id={} name={}", id, t.name);

        // Broadcast so every open Task Center panel refreshes (CC review C5).
        emit_task_event(
            "task:status-changed",
            serde_json::json!({
                "taskId": t.id,
                "from": serde_json::Value::Null,
                "to": TaskStatus::Todo.as_str(),
                "at": t.created_at,
                "actor": created_actor.as_str(),
                "source": created_source.map(|source| source.as_str()),
                "message": created_message,
                "event": "created",
            }),
        );
        Ok(t)
    }

    /// Create a Task at an explicit initial status, bypassing the default
    /// Todo entry point. Used only by backend Legacy Cron migration, which preserves the
    /// cron's lifecycle state (running crons → Running task, naturally
    /// ended crons → Done, user-paused crons → Stopped) so the Task
    /// Center doesn't spuriously mass-categorise every upgraded row as
    /// 待启动. The status-history entry records `actor=System,
    /// source=Migration` so the audit trail is clear.
    ///
    /// `initial_status` is validated against a whitelist of legitimate
    /// migration targets — the full state-machine alphabet isn't
    /// appropriate here (a migration can't plausibly land in Verifying
    /// or Blocked, and Deleted / Archived aren't reachable via this
    /// path).
    pub async fn create_migrated(
        &self,
        input: TaskCreateDirectInput,
        initial_status: TaskStatus,
        message: String,
    ) -> Result<Task, String> {
        self.create_migrated_with_id(Uuid::new_v4().to_string(), input, initial_status, message)
            .await
    }

    pub async fn create_migrated_with_id(
        &self,
        id: String,
        mut input: TaskCreateDirectInput,
        initial_status: TaskStatus,
        message: String,
    ) -> Result<Task, String> {
        validate_safe_id(&id, "legacy cron id")?;
        validate_task_name(&input.name)?;
        if let Some(trigger) = input.trigger.as_ref() {
            validate_task_trigger(trigger)?;
        }
        // PRD 0.2.9 — Same pin+validate sequence as create_direct.
        pin_runtime_for_provider_id(&input.provider_id, &mut input.runtime);
        validate_task_execution_routing(
            &input.provider_id,
            &input.model,
            &input.runtime,
            &input.runtime_config,
        )?;
        let managed_kind = normalize_managed_kind(input.managed_kind)?;
        if !matches!(
            initial_status,
            TaskStatus::Todo
                | TaskStatus::Running
                | TaskStatus::Done
                | TaskStatus::Stopped
                | TaskStatus::Blocked
        ) {
            return Err(format!(
                "invalid migration target status: {}",
                initial_status.as_str()
            ));
        }
        let now = now_ms();
        let workspace_path = canonicalize_workspace_path(&input.workspace_path)?;

        // task_docs_dir() internally validates `id`, but `id` is our freshly-minted
        // UUID so it cannot fail; the explicit check is still cheap insurance.
        let task_dir = task_docs_dir(&id)?;

        let t = Task {
            id: id.clone(),
            name: input.name,
            executor: input.executor,
            description: input.description,
            workspace_id: input.workspace_id,
            workspace_path: workspace_path.clone(),
            execution_mode: input.execution_mode,
            run_mode: input.run_mode,
            end_conditions: input.end_conditions,
            interval_minutes: input.interval_minutes,
            cron_expression: input.cron_expression,
            cron_timezone: input.cron_timezone,
            start_at: input.start_at,
            recurring_window: input.recurring_window,
            dispatch_at: input.dispatch_at,
            trigger: input.trigger,
            model: input.model,
            provider_id: input.provider_id,
            permission_mode: input.permission_mode,
            preselected_session_id: input.preselected_session_id,
            runtime: input.runtime,
            runtime_config: input.runtime_config,
            mcp_enabled_servers: normalize_mcp_override(input.mcp_enabled_servers),
            managed_kind,
            source_record_id: input.source_record_id,
            legacy_source_thought_id: None,
            session_ids: Vec::new(),
            status: initial_status,
            tags: input.tags,
            created_at: now,
            updated_at: now,
            last_executed_at: None,
            last_scheduled_at: None,
            execution_count: 0,
            consecutive_execution_failures: 0,
            last_execution: None,
            last_activation_event_id: None,
            status_history: vec![StatusTransition {
                from: None,
                to: initial_status,
                at: now,
                actor: TransitionActor::System,
                message: Some(message.clone()),
                source: Some(TransitionSource::Migration),
            }],
            notification: input.notification,
            dispatch_origin: TaskDispatchOrigin::Direct,
            external_source: None,
            deleted: false,
            deleted_at: None,
        };

        // Materialize task.md FIRST, commit JSONL LAST (same ordering invariant
        // as create_direct — see fix for C3). Orphan docs dir on JSONL failure is
        // harmless; orphan JSONL row without task.md is an integrity violation.
        let protected_session_ids = task_protected_session_ids(&t);
        let protected_session_refs = protected_session_ids
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let session_lifecycle =
            crate::sidecar::acquire_session_lifecycle(&protected_session_refs).await;
        self.ensure_writable()?;
        let mut inner = self.inner.write().await;
        if let Some(existing) = inner.get(&id) {
            let migrated = existing
                .status_history
                .iter()
                .any(|transition| transition.source == Some(TransitionSource::Migration));
            let same_workspace =
                crate::workspace_path::normalize_workspace_path_identity(&existing.workspace_path)
                    == crate::workspace_path::normalize_workspace_path_identity(&workspace_path);
            if migrated && same_workspace {
                return Ok(existing.clone());
            }
            return Err(format!(
                "Legacy cron id {id} collides with an unrelated Task"
            ));
        }
        fs::create_dir_all(&task_dir)
            .map_err(|e| format!("Failed to create task doc dir: {}", e))?;
        let task_md = task_dir.join("task.md");
        write_atomic_text(&task_md, &input.task_md_content)
            .map_err(|e| format!("Failed to write task.md: {}", e))?;

        let mut next = inner.clone();
        next.insert(id.clone(), t.clone());
        if let Err(e) = Self::persist_locked(&self.jsonl_path, &next) {
            if let Err(cleanup_err) = fs::remove_dir_all(&task_dir) {
                ulog_warn!(
                    "[task] migrated jsonl write failed AND task_dir cleanup failed id={} path={} err={}",
                    id,
                    task_dir.display(),
                    cleanup_err
                );
            }
            return Err(e);
        }
        *inner = next;
        drop(inner);
        drop(session_lifecycle);
        ulog_info!(
            "[task] created migrated id={} name={} status={}",
            id,
            t.name,
            initial_status.as_str()
        );

        emit_task_event(
            "task:status-changed",
            serde_json::json!({
                "taskId": t.id,
                "from": serde_json::Value::Null,
                "to": initial_status.as_str(),
                "at": t.created_at,
                "actor": TransitionActor::System.as_str(),
                "source": TransitionSource::Migration.as_str(),
                "message": message,
                "event": "created",
            }),
        );
        Ok(t)
    }

    pub async fn create_attached(&self, input: TaskCreateAttachedInput) -> Result<Task, String> {
        self.create_attached_with_session_probe(input, session_metadata_exists)
            .await
    }

    async fn create_attached_with_session_probe<F>(
        &self,
        input: TaskCreateAttachedInput,
        session_exists: F,
    ) -> Result<Task, String>
    where
        F: FnOnce(&str) -> bool,
    {
        let workspace_path = canonicalize_workspace_path(&input.workspace_path)?;
        validate_task_name(&input.name)?;
        validate_safe_id(&input.current_session_id, "currentSessionId")?;
        let task_md_content = input.task_md_content.trim().to_string();
        if task_md_content.is_empty() {
            return Err("taskMdContent is empty".to_string());
        }
        let source_issue_id = input.source_issue_id.trim().to_string();
        if source_issue_id.is_empty() {
            return Err("sourceIssueId is empty".to_string());
        }

        let now = now_ms();
        let id = Uuid::new_v4().to_string();
        let task_dir = task_docs_dir(&id)?;
        let external_source = match input.source {
            TaskCreateAttachedSource::SpaceIssue => TaskExternalSource {
                source_type: TaskExternalSourceType::SpaceIssue,
                space_id: input.source_space_id.filter(|s| !s.trim().is_empty()),
                issue_id: source_issue_id,
                claim_id: input.source_claim_id.filter(|s| !s.trim().is_empty()),
                delivery_id: input.source_delivery_id.filter(|s| !s.trim().is_empty()),
            },
        };

        let created_transition = StatusTransition {
            from: None,
            to: TaskStatus::Todo,
            at: now,
            actor: TransitionActor::Agent,
            message: Some("created (attached-session)".to_string()),
            source: Some(TransitionSource::Cli),
        };
        let attached_transition = StatusTransition {
            from: Some(TaskStatus::Todo),
            to: TaskStatus::Running,
            at: now,
            actor: TransitionActor::Agent,
            message: Some("attached to current session".to_string()),
            source: Some(TransitionSource::Cli),
        };

        let t = Task {
            id: id.clone(),
            name: input.name,
            executor: input.executor,
            description: input.description,
            workspace_id: input.workspace_id,
            workspace_path: workspace_path.clone(),
            execution_mode: TaskExecutionMode::Once,
            run_mode: None,
            end_conditions: None,
            interval_minutes: None,
            cron_expression: None,
            cron_timezone: None,
            start_at: None,
            recurring_window: None,
            dispatch_at: None,
            trigger: None,
            model: None,
            provider_id: None,
            permission_mode: None,
            preselected_session_id: None,
            runtime: None,
            runtime_config: None,
            mcp_enabled_servers: None,
            managed_kind: None,
            source_record_id: None,
            legacy_source_thought_id: None,
            session_ids: vec![input.current_session_id.clone()],
            status: TaskStatus::Running,
            tags: input.tags,
            created_at: now,
            updated_at: now,
            last_executed_at: Some(now),
            last_scheduled_at: None,
            execution_count: 0,
            consecutive_execution_failures: 0,
            last_execution: None,
            last_activation_event_id: None,
            status_history: vec![created_transition, attached_transition],
            notification: input.notification,
            dispatch_origin: TaskDispatchOrigin::AttachedSession,
            external_source: Some(external_source),
            deleted: false,
            deleted_at: None,
        };

        // Session deletion uses this same guard before checking Task/Goal/live
        // owners. Hold it until the attached Task's docs, JSONL row, and
        // in-memory authority all expose the binding atomically.
        let lifecycle =
            crate::sidecar::acquire_session_lifecycle(&[&input.current_session_id]).await;
        if !session_exists(&input.current_session_id) {
            return Err(
                "the attached Session no longer exists; reopen or reclaim the Space work before creating a Task"
                    .to_string(),
            );
        }
        self.ensure_writable()?;
        let mut inner = self.inner.write().await;
        fs::create_dir_all(&task_dir)
            .map_err(|e| format!("Failed to create task doc dir: {}", e))?;
        let task_md = task_dir.join("task.md");
        write_atomic_text(&task_md, &task_md_content)
            .map_err(|e| format!("Failed to write task.md: {}", e))?;

        let mut next = inner.clone();
        next.insert(id.clone(), t.clone());
        if let Err(e) = Self::persist_locked(&self.jsonl_path, &next) {
            if let Err(cleanup_err) = fs::remove_dir_all(&task_dir) {
                ulog_warn!(
                    "[task] attached jsonl write failed AND task_dir cleanup failed id={} path={} err={}",
                    id,
                    task_dir.display(),
                    cleanup_err
                );
            }
            return Err(e);
        }
        *inner = next;
        drop(inner);
        drop(lifecycle);

        ulog_info!(
            "[task] created attached id={} name={} session={}",
            id,
            t.name,
            input.current_session_id
        );
        emit_task_event(
            "task:status-changed",
            serde_json::json!({
                "taskId": t.id,
                "from": serde_json::Value::Null,
                "to": TaskStatus::Todo.as_str(),
                "at": t.created_at,
                "actor": TransitionActor::Agent.as_str(),
                "source": TransitionSource::Cli.as_str(),
                "message": "created (attached-session)",
                "event": "created",
            }),
        );
        emit_task_event(
            "task:status-changed",
            serde_json::json!({
                "taskId": t.id,
                "from": TaskStatus::Todo.as_str(),
                "to": TaskStatus::Running.as_str(),
                "at": t.created_at,
                "actor": TransitionActor::Agent.as_str(),
                "source": TransitionSource::Cli.as_str(),
                "message": "attached to current session",
            }),
        );
        emit_task_event(
            "task:session-appended",
            serde_json::json!({
                "taskId": t.id,
                "sessionId": input.current_session_id,
            }),
        );
        Ok(t)
    }

    // ---- Read ----

    pub async fn get(&self, id: &str) -> Option<Task> {
        self.inner.read().await.get(id).cloned()
    }

    pub async fn get_ordinary(&self, id: &str) -> Result<Task, String> {
        let task = self
            .get(id)
            .await
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?;
        if is_managed_task(&task) {
            return Err(MANAGED_TASK_ERROR.to_string());
        }
        Ok(task)
    }

    /// Merge a legacy verify.md into an ordinary Task's task.md using the
    /// deliberately simple compatibility shape. System-managed jobs own their
    /// generated task.md, so this compatibility helper is a no-op for them.
    /// The legacy file remains untouched and the exact heading makes repeated
    /// calls idempotent.
    pub async fn ensure_legacy_verify_merged(&self, id: &str) -> Result<(), String> {
        self.ensure_writable()?;
        let inner = self.inner.write().await;
        let task = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?;
        if is_managed_task(task) {
            return Ok(());
        }
        let dir = task_docs_dir(&task.id)?;
        let verify = match fs::read_to_string(dir.join("verify.md")) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("read verify.md: {error}")),
        };
        let verify = verify.trim();
        if verify.is_empty() {
            return Ok(());
        }
        let task_path = dir.join("task.md");
        let task_markdown =
            fs::read_to_string(&task_path).map_err(|error| format!("read task.md: {error}"))?;
        if task_markdown
            .lines()
            .any(|line| line.trim() == "# verify.md")
        {
            return Ok(());
        }
        let merged = format!("{}\n\n# verify.md\n\n{}", task_markdown.trim_end(), verify,);
        write_atomic_text(&task_path, &merged)
    }

    /// Check-and-write `~/.myagents/tasks/<id>/<filename>` atomically with respect to
    /// the running/verifying lock. The status check and the file write
    /// both happen under the same write lock so a concurrent
    /// `update_status(running)` can't slip in between and let us mutate
    /// a doc on an already-executing task. PRD §9.4.
    ///
    /// On success `updated_at` is bumped so listings re-sort.
    pub async fn write_doc(&self, id: &str, filename: &str, content: &str) -> Result<(), String> {
        self.ensure_writable()?;
        let mut inner = self.inner.write().await;
        let existing = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        if existing.deleted {
            return Err(String::from(TaskOpError::already_deleted()));
        }
        if matches!(existing.status, TaskStatus::Running | TaskStatus::Verifying) {
            return Err(String::from(TaskOpError::update_rejected_while_running()));
        }
        // Resolve path through the sandbox guard — rejects id escape.
        let dir = task_docs_dir(&existing.id)?;
        let path = dir.join(filename);

        // Persist the markdown file first. If this fails we haven't
        // touched the JSONL yet, so the store stays consistent.
        write_atomic_text(&path, content)?;

        // Bump `updated_at` and persist under the same lock.
        let mut updated = existing;
        updated.updated_at = now_ms();
        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated);
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        Ok(())
    }

    pub async fn list(&self, filter: TaskListFilter) -> Vec<Task> {
        let inner = self.inner.read().await;
        let mut out: Vec<Task> = inner.values().cloned().collect();

        if !filter.include_managed.unwrap_or(false) {
            out.retain(|t| !is_managed_task(t));
        }
        if !filter.include_deleted.unwrap_or(false) {
            out.retain(|t| !t.deleted);
        }
        if let Some(ws) = filter.workspace_id.as_deref() {
            out.retain(|t| t.workspace_id == ws);
        }
        if let Some(status_filter) = filter.status.as_ref() {
            out.retain(|t| status_filter.matches(t.status));
        }
        if let Some(tag) = filter.tag.as_deref() {
            let needle = tag.to_lowercase();
            out.retain(|t| t.tags.iter().any(|x| x.to_lowercase() == needle));
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        out
    }

    pub async fn remove_mcp_server_references(&self, server_id: &str) -> Result<usize, String> {
        self.ensure_writable()?;
        let mut inner = self.inner.write().await;
        let mut next = inner.clone();
        let mut updated = 0usize;

        for task in next.values_mut() {
            let Some(ids) = task.mcp_enabled_servers.as_mut() else {
                continue;
            };
            let before = ids.len();
            ids.retain(|id| id != server_id);
            if ids.len() != before {
                task.updated_at = now_ms();
                updated += 1;
            }
        }

        if updated == 0 {
            return Ok(0);
        }

        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        Ok(updated)
    }

    // ---- Update fields ----

    pub async fn update(&self, input: TaskUpdateInput) -> Result<Task, String> {
        let task_control = crate::task_scheduler::acquire_task_control(&input.id).await;
        self.update_with_task_control_held(input, &task_control)
            .await
    }

    pub(crate) async fn update_with_task_control_held(
        &self,
        input: TaskUpdateInput,
        task_control: &crate::task_scheduler::TaskControlGuard,
    ) -> Result<Task, String> {
        self.update_with_task_control_and_session_probe(
            input,
            task_control,
            session_metadata_matches_workspace,
        )
        .await
    }

    async fn update_with_task_control_and_session_probe<F>(
        &self,
        input: TaskUpdateInput,
        _task_control: &crate::task_scheduler::TaskControlGuard,
        session_matches_workspace: F,
    ) -> Result<Task, String>
    where
        F: Fn(&str, &str) -> bool,
    {
        let projected_workspace = match (&input.workspace_id, &input.workspace_path) {
            (None, None) => None,
            (Some(workspace_id), Some(workspace_path)) => {
                let workspace_id = workspace_id.trim();
                if workspace_id.is_empty() {
                    return Err("workspaceId is empty".to_string());
                }
                Some((
                    workspace_id.to_string(),
                    canonicalize_workspace_path(workspace_path)?,
                ))
            }
            _ => return Err("workspaceId and workspacePath must be updated together".to_string()),
        };
        if crate::task_scheduler::get_task_scheduler()
            .execution_projection(&input.id)
            .await
            .is_some()
        {
            return Err("cannot edit a Task while its current execution is unresolved".to_string());
        }
        if self
            .get(&input.id)
            .await
            .is_some_and(|task| task.effective_trigger().is_command())
            && self
                .read_trigger_state(&input.id)
                .await?
                .pending_activation
                .is_some()
        {
            return Err(
                "cannot edit a Task while its Activation Event is pending; stop it first"
                    .to_string(),
            );
        }
        self.ensure_writable()?;
        if input
            .run_mode
            .is_some_and(|mode| mode != TaskRunMode::SingleSession)
            && input
                .preselected_session_id
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
        {
            return Err(
                "preselectedSessionId is only valid with runMode=single-session".to_string(),
            );
        }
        if input.prompt.is_some() {
            self.ensure_legacy_verify_merged(&input.id).await?;
        }
        let projected_run_mode = input.run_mode;
        let projected_preselected_session_id = input.preselected_session_id.clone();
        let (mut inner, session_lifecycle) = self
            .lock_for_session_protection(&input.id, move |task| {
                let mut projected = task.clone();
                if let Some(value) = projected_run_mode {
                    projected.run_mode = Some(value);
                }
                if let Some(value) = projected_preselected_session_id.as_ref() {
                    projected.preselected_session_id = if value.trim().is_empty() {
                        None
                    } else {
                        Some(value.clone())
                    };
                }
                if projected_run_mode.is_some_and(|mode| mode != TaskRunMode::SingleSession) {
                    projected.preselected_session_id = None;
                }
                let mut protected = task_protected_session_ids(&projected);
                if projected.run_mode == Some(TaskRunMode::SingleSession) {
                    if let Some(session_id) = projected.preselected_session_id.as_ref() {
                        protected.push(session_id.clone());
                        protected.sort();
                        protected.dedup();
                    }
                }
                protected
            })
            .await?;
        let interval_updated = input.interval_minutes.is_some();
        let cron_expression_updated = input.cron_expression.is_some();
        let execution_mode_updated = input.execution_mode.is_some();
        let existing = inner
            .get(&input.id)
            .ok_or_else(|| String::from(TaskOpError::not_found(&input.id)))?
            .clone();
        if existing.deleted {
            return Err(String::from(TaskOpError::already_deleted()));
        }
        if matches!(existing.status, TaskStatus::Running | TaskStatus::Verifying) {
            return Err(String::from(TaskOpError::update_rejected_while_running()));
        }
        if input.execution_mode == Some(TaskExecutionMode::Loop) {
            return Err("Loop task mode is retired; use a Session Goal".to_string());
        }
        // PRD 0.2.9 invariant 3 — reject contradictory clear-vs-set inputs at
        // the input layer (rather than silently letting the merge order
        // decide). Surfaces client bugs instead of swallowing them.
        if input.clear_provider_override
            && input.provider_id.as_deref().is_some_and(|s| !s.is_empty())
        {
            return Err(
                "providerId 与 clearProviderOverride=true 冲突 — 调用方必须二选一".to_string(),
            );
        }
        if input.clear_mcp_override && input.mcp_enabled_servers.is_some() {
            return Err(
                "mcpEnabledServers 与 clearMcpOverride=true 冲突 — 调用方必须二选一".to_string(),
            );
        }
        if input.notification.is_some() && input.notification_patch.is_some() {
            return Err(
                "notification 与 notificationPatch 不能同时设置 — 调用方必须二选一".to_string(),
            );
        }
        if input.clear_trigger && input.trigger.is_some() {
            return Err("trigger 与 clearTrigger=true 冲突 — 调用方必须二选一".to_string());
        }
        let mut updated = existing.clone();
        if let Some(v) = input.name {
            validate_task_name(&v)?;
            updated.name = v;
        }
        if let Some(v) = input.executor {
            updated.executor = v;
        }
        if let Some(v) = input.description {
            updated.description = Some(v);
        }
        if let Some((workspace_id, workspace_path)) = projected_workspace {
            updated.workspace_id = workspace_id;
            updated.workspace_path = workspace_path;
        }
        if let Some(v) = input.execution_mode {
            updated.execution_mode = v;
        }
        if let Some(v) = input.run_mode {
            updated.run_mode = Some(v);
        }
        if let Some(v) = input.end_conditions {
            updated.end_conditions = Some(v);
        }
        if let Some(v) = input.interval_minutes {
            updated.interval_minutes = Some(v);
        }
        if let Some(v) = input.cron_expression {
            // Empty string clears — the renderer uses "" to mean "switch back
            // from advanced mode".
            updated.cron_expression = if v.trim().is_empty() { None } else { Some(v) };
        }
        if let Some(v) = input.cron_timezone {
            updated.cron_timezone = if v.trim().is_empty() { None } else { Some(v) };
        }
        if interval_updated && !cron_expression_updated {
            updated.cron_expression = None;
            updated.cron_timezone = None;
        } else if cron_expression_updated && updated.cron_expression.is_some() {
            updated.interval_minutes = None;
            updated.start_at = None;
            updated.recurring_window = None;
        }
        if let Some(v) = input.start_at {
            updated.start_at = if v.trim().is_empty() { None } else { Some(v) };
        }
        if let Some(v) = input.recurring_window {
            updated.recurring_window = Some(v);
        }
        if let Some(v) = input.dispatch_at {
            updated.dispatch_at = Some(v);
        }
        if let Some(v) = input.trigger {
            validate_task_trigger(&v)?;
            updated.trigger = Some(v);
        }
        if input.clear_trigger {
            updated.trigger = None;
        }
        if let Some(v) = input.model {
            updated.model = if v.trim().is_empty() { None } else { Some(v) };
        }
        if let Some(v) = input.provider_id {
            updated.provider_id = if v.trim().is_empty() { None } else { Some(v) };
        }
        // PRD 0.2.9 — Explicit "follow Agent" reset: clears both provider_id
        // and model atomically. Renderer's "跟随 Agent" picker option sends
        // this flag rather than relying on an empty-string round-trip,
        // which would only clear one field if the renderer accidentally
        // omitted the other.
        if input.clear_provider_override {
            updated.provider_id = None;
            updated.model = None;
        }
        if let Some(v) = input.permission_mode {
            updated.permission_mode = if v.trim().is_empty() { None } else { Some(v) };
        }
        if let Some(v) = input.preselected_session_id {
            updated.preselected_session_id = if v.trim().is_empty() { None } else { Some(v) };
        }
        if input
            .run_mode
            .is_some_and(|mode| mode != TaskRunMode::SingleSession)
        {
            updated.preselected_session_id = None;
        }
        if let Some(v) = input.runtime {
            updated.runtime = Some(v);
        }
        if let Some(v) = input.runtime_config {
            updated.runtime_config = Some(v);
        }
        // PRD #131 / Codex-review #2 — atomic clear of runtime + runtime_config.
        // Applied AFTER the merge so explicit field values get overridden
        // (matches `clear_provider_override` semantics, line above).
        if input.clear_runtime_override {
            updated.runtime = None;
            updated.runtime_config = None;
        }
        if let Some(v) = input.mcp_enabled_servers {
            updated.mcp_enabled_servers = normalize_mcp_override(Some(v));
        }
        if input.clear_mcp_override {
            updated.mcp_enabled_servers = None;
        }
        if let Some(v) = input.tags {
            updated.tags = v;
        }
        if let Some(v) = input.notification {
            updated.notification = Some(v);
        }
        if let Some(patch) = input.notification_patch {
            if !patch.is_empty() {
                updated.notification = Some(patch.apply(updated.notification));
            }
        }
        // PRD 0.2.9 — Pin runtime='builtin' on the merged state when the
        // post-merge shape has provider_id set without an explicit runtime.
        // Mirrors the pin done in create_direct; closes the cross-talk hole.
        pin_runtime_for_provider_id(&updated.provider_id, &mut updated.runtime);
        // Provider routing invariants on merged state. Runs after pin so the
        // external-exclusion rule fires correctly, and after all field merges
        // (including clear_provider_override) so the rules see the actual
        // post-update shape, not the input fragments.
        validate_task_execution_routing(
            &updated.provider_id,
            &updated.model,
            &updated.runtime,
            &updated.runtime_config,
        )?;
        updated.updated_at = now_ms();

        // Mode-transition hygiene: `run_mode` / `end_conditions` / the
        // schedule-detail fields are only meaningful for certain execution
        // modes. When the user flips `execution_mode → Once`, lingering
        // recurring/scheduled fields would leave an invalid Task schedule.
        // `TaskUpdateInput` uses `Option<T>` so the client can't express
        // "clear me", so we clear server-side the moment the mode no longer
        // needs them.
        match updated.execution_mode {
            TaskExecutionMode::Once => {
                // Session strategy and pre-trigger detection are recurring-only.
                // Enforce this on the merged row, not merely when the mode field
                // is present, so a stale partial editor cannot reintroduce them
                // after another writer has already switched the Task to Once.
                if execution_mode_updated {
                    updated.run_mode = Some(TaskRunMode::NewSession);
                    updated.preselected_session_id = None;
                    updated.trigger = None;
                }
                updated.interval_minutes = None;
                updated.cron_expression = None;
                updated.cron_timezone = None;
                updated.start_at = None;
                updated.recurring_window = None;
                updated.dispatch_at = None;
            }
            TaskExecutionMode::Scheduled => {
                // Scheduled only needs dispatch_at; clear recurring knobs.
                // Also strip any legacy `endConditions.deadline` that a
                // pre-v0.1.69 row might be carrying — once dispatch_at is
                // populated (either by the user editing or by the
                // legacy-upgrade path), the deadline has no remaining
                // meaning here and only confuses later readers that still
                // treat `endConditions.deadline` as "when to stop running".
                if execution_mode_updated {
                    updated.run_mode = Some(TaskRunMode::NewSession);
                    updated.preselected_session_id = None;
                    updated.trigger = None;
                }
                updated.interval_minutes = None;
                updated.cron_expression = None;
                updated.cron_timezone = None;
                updated.start_at = None;
                updated.recurring_window = None;
                if let Some(ref mut ec) = updated.end_conditions {
                    ec.deadline = None;
                }
            }
            TaskExecutionMode::Recurring => {
                // dispatch_at belongs to Scheduled only.
                updated.dispatch_at = None;
            }
            TaskExecutionMode::Loop => {
                // dispatch_at and anchored windows belong to time-based modes.
                updated.dispatch_at = None;
                updated.start_at = None;
                updated.recurring_window = None;
            }
        }

        let session_binding_updated = updated.run_mode != existing.run_mode
            || updated.preselected_session_id != existing.preselected_session_id
            || updated.workspace_id != existing.workspace_id
            || updated.workspace_path != existing.workspace_path;
        if session_binding_updated {
            validate_new_task_session_binding(
                updated.run_mode,
                updated.preselected_session_id.as_deref(),
            )?;
            if updated.run_mode == Some(TaskRunMode::SingleSession) {
                let session_id = updated
                    .preselected_session_id
                    .as_deref()
                    .expect("single-session binding validated above");
                if !session_matches_workspace(session_id, &updated.workspace_path) {
                    return Err(format!(
                        "preselectedSessionId does not reference an existing Session: {}",
                        session_id
                    ));
                }
            }
        }

        // Validate cron_expression at the boundary so malformed input can't
        // reach the scheduler (it would silently die at first fire, leaving
        // the task "running" but never ticking).
        if let Some(expr) = updated.cron_expression.as_deref() {
            if !expr.trim().is_empty() {
                crate::cron_task::validate_cron_expression(expr, updated.cron_timezone.as_deref())
                    .map_err(|e| format!("cron expression invalid: {}", e))?;
            }
        }

        let leaves_command_mode =
            existing.effective_trigger().is_command() && !updated.effective_trigger().is_command();
        let enters_command_mode =
            !existing.effective_trigger().is_command() && updated.effective_trigger().is_command();
        if enters_command_mode {
            // A non-command row is itself the durable proof that any existing
            // Trigger state is stale. Delete it before enabling command mode;
            // if this fails the authoritative row remains non-command.
            self.remove_trigger_state_file(&updated.id)?;
        }

        // Atomic task.md write — when the client sent `prompt`, we want the
        // new markdown body committed under the same write lock that
        // persists the JSONL row. Status was already verified above, so a
        // concurrent `update_status(running)` can't land between these two
        // writes.
        if let Some(ref prompt) = input.prompt {
            if prompt.trim().is_empty() {
                return Err("prompt is empty".to_string());
            }
            let dir = task_docs_dir(&updated.id)?;
            fs::create_dir_all(&dir).map_err(|e| format!("mkdir task dir: {}", e))?;
            write_atomic_text(&dir.join("task.md"), prompt)?;
        }

        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        drop(inner);
        drop(session_lifecycle);

        self.reconcile_task_comment_notification_index(&updated);
        if leaves_command_mode {
            if let Err(error) = self.remove_trigger_state(&updated.id).await {
                ulog_warn!(
                    "[task] command Trigger state cleanup deferred to startup task={}: {}",
                    updated.id,
                    error
                );
            }
        }

        Ok(updated)
    }

    // ---- Status transition ----

    /// Apply a status transition with PRD §10.2.1 core semantics:
    ///   1. transition-table legality
    ///   2. actor/source guards (archived user-only, agent→cli only,
    ///      `Deleted` never accepted here — only `delete()` may write it)
    ///   3. persist-then-swap atomic history append
    ///
    /// `actor` is explicit (not inferred): callers MUST assert their actor. The
    /// Tauri command layer sets `actor=User, source=Ui` authoritatively so a
    /// malicious renderer cannot spoof `agent` / `system`.
    ///
    /// Returns `(updated_task, transition_written)`. Progress.md / notification /
    /// SSE side-effects are caller responsibility (Phase 4/5 wiring).
    pub async fn update_status(
        &self,
        input: TaskUpdateStatusInput,
    ) -> Result<(Task, StatusTransition), String> {
        let task_control = crate::task_scheduler::acquire_task_control(&input.id).await;
        self.update_status_with_task_control_held(input, &task_control)
            .await
    }

    pub(crate) async fn update_status_with_task_control_held(
        &self,
        input: TaskUpdateStatusInput,
        task_control: &crate::task_scheduler::TaskControlGuard,
    ) -> Result<(Task, StatusTransition), String> {
        // `Deleted` is reserved for `delete()`.
        if input.status == TaskStatus::Deleted {
            return Err(String::from(TaskOpError::invalid_transition(
                TaskStatus::Deleted,
                TaskStatus::Deleted,
            )));
        }

        self.ensure_writable()?;
        let target_status = input.status;
        let (mut inner, session_lifecycle) = self
            .lock_for_session_protection(&input.id, move |task| {
                let mut projected = task.clone();
                projected.status = target_status;
                task_protected_session_ids(&projected)
            })
            .await?;
        let existing = inner
            .get(&input.id)
            .ok_or_else(|| String::from(TaskOpError::not_found(&input.id)))?
            .clone();
        if existing.deleted {
            return Err(String::from(TaskOpError::already_deleted()));
        }

        let from = existing.status;
        let to = input.status;

        // 1. legality
        if !is_transition_legal(from, to) {
            return Err(String::from(TaskOpError::invalid_transition(from, to)));
        }

        // 2. actor/source guard
        let actor = input.actor;
        let source = input.source;
        if (to == TaskStatus::Archived || from == TaskStatus::Archived && to == TaskStatus::Done)
            && actor != TransitionActor::User
        {
            return Err(String::from(TaskOpError::archive_user_only()));
        }
        if actor == TransitionActor::Agent && source != Some(TransitionSource::Cli) {
            return Err(String::from(TaskOpError::agent_source_must_be_cli()));
        }
        if existing.dispatch_origin == TaskDispatchOrigin::AttachedSession && to == TaskStatus::Todo
        {
            return Err(
                "attached-session Tasks cannot be rerun; reopen or reclaim the Space work to create a new attached Task"
                    .to_string(),
            );
        }

        let now = now_ms();
        let mut updated = existing;
        updated.status = to;
        updated.updated_at = now;
        let transition = StatusTransition {
            from: Some(from),
            to,
            at: now,
            actor,
            message: input.message,
            source,
        };
        updated.status_history.push(transition.clone());

        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        // Drop the write lock before firing side-effects so listeners that
        // refetch via `get()` don't contend with us.
        drop(inner);
        // The committed row is now visible to the deletion predicate, so its
        // durable protection set takes over from the mutation guard.
        drop(session_lifecycle);

        ulog_info!(
            "[task] status {}: {} → {} (actor={}, source={:?})",
            updated.id,
            from.as_str(),
            to.as_str(),
            actor.as_str(),
            source.map(|s| s.as_str())
        );

        let stop_error = if matches!(
            to,
            TaskStatus::Stopped | TaskStatus::Blocked | TaskStatus::Archived | TaskStatus::Done
        ) {
            crate::task_scheduler::get_task_scheduler()
                .stop_with_control_held(&updated.id, task_control)
                .await
                .err()
        } else {
            None
        };
        // An ambiguous exact stop still owns the durable Activation Event.
        // Only clear that outbox after Runtime termination was confirmed.
        let pending_cancel_error = if should_cancel_pending_after_transition(
            to,
            updated.effective_trigger().is_command(),
            stop_error.is_none(),
        ) {
            self.cancel_pending_activation(&updated.id)
                .await
                .err()
                .map(|error| {
                    format!("Task was stopped, but pending Activation cleanup needs retry: {error}")
                })
        } else {
            None
        };

        // Legacy progress.md is intentionally not touched here. New ordinary
        // Tasks use task.md as their single semantic contract; TaskStore's
        // status_history remains the authoritative machine audit trail.

        // PRD §10.2.1 step 6: notification dispatch (desktop + bot) for
        // subscribed transitions. Side-effects fire AFTER persist so a
        // crash between write and notify is recoverable from disk state.
        dispatch_notification(&updated, &transition);

        // PRD §10.2.1 step 7: SSE broadcast. Renderer listens on
        // `task:status-changed` for live refresh across all open Task Center
        // tabs.
        emit_task_event(
            "task:status-changed",
            serde_json::json!({
                "taskId": updated.id,
                "from": transition.from.map(|s| s.as_str()),
                "to": transition.to.as_str(),
                "at": transition.at,
                "actor": transition.actor.as_str(),
                "source": transition.source.map(|s| s.as_str()),
                "message": transition.message.clone(),
            }),
        );

        if let Some(error) = stop_error.or(pending_cancel_error) {
            return Err(error);
        }

        Ok((updated, transition))
    }

    // ---- Execution bookkeeping ----

    fn append_session_locked(
        &self,
        inner: &mut HashMap<String, Task>,
        id: &str,
        session_id: &str,
    ) -> Result<(Task, bool), String> {
        let existing = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        let mut updated = existing;
        if updated.session_ids.iter().any(|value| value == session_id) {
            return Ok((updated, false));
        }
        updated.session_ids.push(session_id.to_string());
        updated.updated_at = now_ms();
        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        Ok((updated, true))
    }

    fn emit_session_appended(updated: &Task, session_id: &str) {
        emit_task_event(
            "task:session-appended",
            serde_json::json!({
                "taskId": updated.id,
                "sessionId": session_id,
            }),
        );
    }

    pub async fn append_session(&self, id: &str, session_id: &str) -> Result<Task, String> {
        self.ensure_writable()?;
        let projected_session_id = session_id.to_string();
        let (mut inner, session_lifecycle) = self
            .lock_for_session_protection(id, move |task| {
                let mut projected = task.clone();
                if !projected
                    .session_ids
                    .iter()
                    .any(|value| value == &projected_session_id)
                {
                    projected.session_ids.push(projected_session_id.clone());
                }
                task_protected_session_ids(&projected)
            })
            .await?;
        let result = self.append_session_locked(&mut inner, id, session_id);
        // Drop the write lock before emitting — listeners may call back
        // into TaskStore (e.g. overlay refetch) and we don't want a
        // re-entrant deadlock.
        drop(inner);
        drop(session_lifecycle);
        let (updated, changed) = result?;
        if changed {
            // Surfaces newly-linked sessions to TaskDetailOverlay while it's
            // already open. Without this the "任务执行" section under-reports
            // until the user closes and reopens the overlay (review HIGH
            // finding: a pre-existing silent mutation that became visible
            // after promoting TaskSessionsList to the second block).
            Self::emit_session_appended(&updated, session_id);
        }
        Ok(updated)
    }

    /// Publish a newly admitted execution Session and claim every comment
    /// that was waiting for the first Session under one TaskStore write lock.
    /// A concurrent user comment therefore observes exactly one side of the
    /// boundary: either it already exists and is claimed here, or it is
    /// created afterwards and directly targets the now-visible Session.
    pub async fn append_session_and_claim_pending_comments(
        &self,
        id: &str,
        session_id: &str,
    ) -> Result<(Task, Vec<TaskComment>), String> {
        self.ensure_writable()?;
        let projected_session_id = session_id.to_string();
        let (mut inner, session_lifecycle) = self
            .lock_for_session_protection(id, move |task| {
                let mut projected = task.clone();
                if !projected
                    .session_ids
                    .iter()
                    .any(|value| value == &projected_session_id)
                {
                    projected.session_ids.push(projected_session_id.clone());
                }
                task_protected_session_ids(&projected)
            })
            .await?;

        let path = self.comments_path(id)?;
        let managed = inner.get(id).is_some_and(is_managed_task);
        let original_comments = if managed {
            Vec::new()
        } else {
            self.load_task_comments(id, &path)?
        };
        let mut comments = original_comments.clone();
        let mut claimed = Vec::new();
        for comment in &mut comments {
            let Some(admission) = comment.admission.as_mut() else {
                continue;
            };
            if admission.state != TaskCommentAdmissionState::PendingSession
                || comment.conversation_session_id.is_some()
            {
                continue;
            }
            comment.conversation_session_id = Some(session_id.to_string());
            admission.state = TaskCommentAdmissionState::Sending;
            admission.target_session_id = Some(session_id.to_string());
            admission.attempt_id = Some(Uuid::new_v4().to_string());
            admission.error = None;
            claimed.push(comment.clone());
        }
        #[cfg(test)]
        if !claimed.is_empty()
            && self
                .fail_next_acceptance_comment_persist
                .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return Err("injected acceptance comment persist failure".to_string());
        }
        if !claimed.is_empty() {
            Self::persist_comments_file(&path, &comments)?;
        }
        // Publish the relation only after the pending-comment claim is
        // durable. Otherwise a comments write failure exposes a Session that
        // later comments can target while the older backlog is still pending.
        let existing = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        let mut updated = existing;
        let changed = !updated.session_ids.iter().any(|value| value == session_id);
        if changed {
            updated.session_ids.push(session_id.to_string());
            updated.updated_at = now_ms();
            let mut next = inner.clone();
            next.insert(updated.id.clone(), updated.clone());
            if let Err(error) = Self::persist_locked(&self.jsonl_path, &next) {
                if !claimed.is_empty() {
                    if let Err(rollback_error) =
                        Self::persist_comments_file(&path, &original_comments)
                    {
                        ulog_warn!(
                            "[task-comment] acceptance rollback failed task={} persist_error={} rollback_error={}",
                            id,
                            error,
                            rollback_error
                        );
                    }
                }
                return Err(error);
            }
            *inner = next;
        }
        drop(inner);
        drop(session_lifecycle);

        if changed {
            Self::emit_session_appended(&updated, session_id);
        }
        if !claimed.is_empty() {
            emit_task_event(
                "task:comment-changed",
                serde_json::json!({ "taskId": id, "event": "claimed" }),
            );
        }
        Ok((updated, claimed))
    }

    /// Commit a Session binding while the caller retains that Session's
    /// lifecycle guard. Scheduler reservation uses this to publish transient
    /// execution ownership and durable TaskStore binding under one guard.
    pub(crate) async fn append_session_with_lifecycle_held(
        &self,
        id: &str,
        session_id: &str,
    ) -> Result<Task, String> {
        self.ensure_writable()?;
        let mut inner = self.inner.write().await;
        let result = self.append_session_locked(&mut inner, id, session_id);
        drop(inner);
        let (updated, changed) = result?;
        if changed {
            Self::emit_session_appended(&updated, session_id);
        }
        Ok(updated)
    }

    /// Replace a deleted fixed Session identity while the scheduler holds
    /// lifecycle guards for both the stale and replacement IDs.
    pub(crate) async fn rebind_missing_single_session_with_lifecycle_held(
        &self,
        id: &str,
        expected_session_id: &str,
        replacement_session_id: &str,
    ) -> Result<Option<Task>, String> {
        self.ensure_writable()?;
        let mut inner = self.inner.write().await;
        let Some(existing) = inner.get(id).cloned() else {
            return Err(String::from(TaskOpError::not_found(id)));
        };
        if existing.run_mode != Some(TaskRunMode::SingleSession)
            || existing.preselected_session_id.as_deref() != Some(expected_session_id)
            || existing.deleted
        {
            return Ok(None);
        }

        let mut updated = existing;
        updated.preselected_session_id = Some(replacement_session_id.to_string());
        updated
            .session_ids
            .retain(|session_id| session_id != expected_session_id);
        if updated
            .session_ids
            .iter()
            .all(|session_id| session_id != replacement_session_id)
        {
            updated.session_ids.push(replacement_session_id.to_string());
        }
        updated.updated_at = now_ms();

        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        drop(inner);

        emit_task_event(
            "task:session-rebound",
            serde_json::json!({
                "taskId": updated.id,
                "fromSessionId": expected_session_id,
                "toSessionId": replacement_session_id,
            }),
        );
        Ok(Some(updated))
    }

    /// Atomically settle one completed AI turn into the Task authority.
    ///
    /// The Task row owns the current outcome summary, counters, consecutive
    /// scheduled failure count, and any terminal status transition. The
    /// append-only `cron_runs` file is written afterwards as an audit
    /// projection and is never read back to reconstruct these facts.
    pub(crate) async fn settle_execution_if_status(
        &self,
        id: &str,
        activation_event_id: Option<&str>,
        trigger: TaskExecutionTrigger,
        expected_status: TaskStatus,
        settlement: TaskExecutionSettlement,
        terminal: Option<TaskExecutionTerminalTransition>,
    ) -> Result<Option<Task>, String> {
        self.ensure_writable()?;
        let projected_terminal = terminal.as_ref().map(|transition| transition.status);
        let (mut inner, session_lifecycle) = self
            .lock_for_session_protection(id, move |task| {
                let mut projected = task.clone();
                if let Some(status) = projected_terminal {
                    projected.status = status;
                }
                task_protected_session_ids(&projected)
            })
            .await?;
        let existing = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        if existing.deleted {
            return Ok(None);
        }
        if activation_event_id.is_some()
            && existing.last_activation_event_id.as_deref() == activation_event_id
        {
            return Ok(Some(existing));
        }
        if existing.status != expected_status {
            return Ok(None);
        }
        let mut updated = existing;
        let executed_at = now_ms();
        updated.execution_count = updated.execution_count.saturating_add(1);
        updated.last_executed_at = Some(executed_at);
        if trigger == TaskExecutionTrigger::Scheduled {
            updated.last_scheduled_at = Some(executed_at);
            updated.consecutive_execution_failures = if settlement.success {
                0
            } else {
                updated.consecutive_execution_failures.saturating_add(1)
            };
        }
        updated.last_execution = Some(TaskLastExecution {
            at: executed_at,
            trigger,
            success: settlement.success,
            duration_ms: settlement.duration_ms,
            session_id: settlement.session_id,
            error: settlement.error,
        });
        if let Some(event_id) = activation_event_id {
            updated.last_activation_event_id = Some(event_id.to_string());
        }
        let transition = if let Some(terminal) = terminal {
            if !matches!(terminal.status, TaskStatus::Done | TaskStatus::Blocked)
                || !is_transition_legal(updated.status, terminal.status)
            {
                return Err(format!(
                    "invalid execution terminal transition: {} -> {}",
                    updated.status.as_str(),
                    terminal.status.as_str()
                ));
            }
            let transition = StatusTransition {
                from: Some(updated.status),
                to: terminal.status,
                at: executed_at,
                actor: TransitionActor::System,
                message: Some(terminal.message),
                source: Some(terminal.source),
            };
            updated.status = terminal.status;
            updated.status_history.push(transition.clone());
            Some(transition)
        } else {
            None
        };
        updated.updated_at = executed_at;

        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        drop(inner);
        drop(session_lifecycle);

        emit_task_event(
            "task:execution-complete",
            serde_json::json!({
                "taskId": updated.id,
                "executionCount": updated.execution_count,
                "lastExecutedAt": updated.last_executed_at,
                "success": updated.last_execution.as_ref().map(|value| value.success),
                "activationEventId": activation_event_id,
            }),
        );
        if let Some(transition) = transition.as_ref() {
            dispatch_notification(&updated, transition);
            emit_task_event(
                "task:status-changed",
                serde_json::json!({
                    "taskId": updated.id,
                    "from": transition.from.map(|status| status.as_str()),
                    "to": transition.to.as_str(),
                    "at": transition.at,
                    "actor": transition.actor.as_str(),
                    "source": transition.source.map(|source| source.as_str()),
                    "message": transition.message.clone(),
                }),
            );
        }
        Ok(Some(updated))
    }

    /// Advance only the timer anchor after a command Detector check that did
    /// not enter an AI turn. `executionCount` and `lastExecutedAt` remain AI-
    /// execution metrics.
    pub async fn record_scheduled_check_if_status(
        &self,
        id: &str,
        expected_status: TaskStatus,
    ) -> Result<Option<Task>, String> {
        self.ensure_writable()?;
        let mut inner = self.inner.write().await;
        let existing = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        if existing.status != expected_status || existing.deleted {
            return Ok(None);
        }
        let mut updated = existing;
        let checked_at = now_ms();
        updated.last_scheduled_at = Some(checked_at);
        updated.updated_at = checked_at;
        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        Ok(Some(updated))
    }

    pub async fn import_legacy_execution_state(
        &self,
        id: &str,
        execution_count: u32,
        last_executed_at: Option<i64>,
        session_id: Option<&str>,
    ) -> Result<Task, String> {
        self.ensure_writable()?;
        let projected_session_id = session_id
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let (mut inner, session_lifecycle) = self
            .lock_for_session_protection(id, move |task| {
                let mut projected = task.clone();
                if let Some(session_id) = projected_session_id.as_ref() {
                    if !projected
                        .session_ids
                        .iter()
                        .any(|value| value == session_id)
                    {
                        projected.session_ids.push(session_id.clone());
                    }
                }
                task_protected_session_ids(&projected)
            })
            .await?;
        let existing = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        let mut updated = existing.clone();
        updated.execution_count = updated.execution_count.max(execution_count);
        updated.last_executed_at = match (updated.last_executed_at, last_executed_at) {
            (Some(current), Some(legacy)) => Some(current.max(legacy)),
            (current, legacy) => current.or(legacy),
        };
        updated.last_scheduled_at = match (updated.last_scheduled_at, last_executed_at) {
            (Some(current), Some(legacy)) => Some(current.max(legacy)),
            (current, legacy) => current.or(legacy),
        };
        let mut changed = updated.execution_count != existing.execution_count
            || updated.last_executed_at != existing.last_executed_at
            || updated.last_scheduled_at != existing.last_scheduled_at;
        if let Some(session_id) = session_id.filter(|value| !value.is_empty()) {
            if !updated.session_ids.iter().any(|value| value == session_id) {
                updated.session_ids.push(session_id.to_string());
                changed = true;
            }
        }
        if !changed {
            drop(inner);
            drop(session_lifecycle);
            return Ok(existing);
        }
        updated.updated_at = now_ms();
        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        drop(inner);
        drop(session_lifecycle);
        Ok(updated)
    }

    // ---- Archive / Delete ----

    /// User-only archive entry. Emits `Done → Archived` with actor=user.
    /// `update_status` tears down the Task scheduler on terminal states.
    pub async fn archive(&self, id: &str, message: Option<String>) -> Result<Task, String> {
        self.archive_with_origin(
            id,
            message,
            TransitionActor::User,
            Some(TransitionSource::Ui),
        )
        .await
    }

    pub async fn archive_with_origin(
        &self,
        id: &str,
        message: Option<String>,
        actor: TransitionActor,
        source: Option<TransitionSource>,
    ) -> Result<Task, String> {
        validate_ordinary_caller_origin(actor, source)?;
        let (task, _) = self
            .update_status(TaskUpdateStatusInput {
                id: id.to_string(),
                status: TaskStatus::Archived,
                message,
                actor,
                source,
            })
            .await?;
        Ok(task)
    }

    /// Product-level delete. Writes a durable `→ Deleted` tombstone transition
    /// to `statusHistory` (PRD §10.2.2), sets `status=Deleted`, flips the
    /// `deleted` flag, and tears down the Task scheduler so it cannot fire
    /// against a deleted Task. Downstream auditors
    /// can filter `statusHistory` on `to == Deleted` to find all removed tasks,
    /// preserving migration safety and audit without promising restoration or a
    /// retention window. Workspace-owned scripts are outside this store.
    pub async fn delete(&self, id: &str) -> Result<(), String> {
        self.delete_with_origin(id, TransitionActor::User, Some(TransitionSource::Ui))
            .await
    }

    pub async fn delete_with_origin(
        &self,
        id: &str,
        actor: TransitionActor,
        source: Option<TransitionSource>,
    ) -> Result<(), String> {
        validate_ordinary_caller_origin(actor, source)?;
        let task_control = crate::task_scheduler::acquire_task_control(id).await;
        self.ensure_writable()?;
        let before = self
            .get(id)
            .await
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?;
        // Delete owns cancellation: an active Detector/AI turn is stopped and
        // its exact process/session lifecycle is confirmed before the row can
        // disappear from ordinary recovery surfaces.
        crate::task_scheduler::get_task_scheduler()
            .stop_with_control_held(id, &task_control)
            .await?;
        if before.deleted {
            self.reconcile_task_comment_notification_index(&before);
            if let Err(error) = self.remove_trigger_state(id).await {
                ulog_warn!(
                    "[task] deleted Trigger state cleanup deferred to startup retry task={}: {}",
                    id,
                    error
                );
            }
            return Ok(());
        }
        let mut inner = self.inner.write().await;
        let existing = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        let mut updated = existing;
        let now = now_ms();
        let from = updated.status;
        updated.status_history.push(StatusTransition {
            from: Some(from),
            to: TaskStatus::Deleted,
            at: now,
            actor,
            message: Some("deleted".to_string()),
            source,
        });
        updated.status = TaskStatus::Deleted;
        updated.deleted = true;
        updated.deleted_at = Some(now);
        updated.updated_at = now;
        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        if let Err(error) = Self::persist_locked(&self.jsonl_path, &next) {
            drop(inner);
            if before.status == TaskStatus::Running {
                let _ = crate::task_scheduler::get_task_scheduler()
                    .start_with_control_held(id, &task_control)
                    .await;
            }
            return Err(error);
        }
        *inner = next;
        drop(inner);
        self.reconcile_task_comment_notification_index(&updated);
        if let Err(error) = self.remove_trigger_state(id).await {
            ulog_warn!(
                "[task] deleted Trigger state cleanup deferred to startup retry task={}: {}",
                id,
                error
            );
        }
        ulog_info!("[task] soft-deleted id={}", id);
        Ok(())
    }
}

// ================ Helpers ================

/// Normalise the per-task `mcp_enabled_servers` override at storage time.
///
///   `None`      → follow Agent/workspace
///   `Some([])`  → explicit no MCP
///   `Some([…])` → explicit override
fn normalize_mcp_override(input: Option<Vec<String>>) -> Option<Vec<String>> {
    input
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// Strict id validator — rejects `..`, path separators, `\0`, leading `.`, and
/// anything not ASCII alphanumeric / `-` / `_`. Also rejects Windows reserved
/// device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) case-insensitively —
/// creating a file/dir with these names on Windows triggers OS-level errors
/// regardless of extension. This is the pit-of-success guard against
/// `taskId="../../etc/passwd"` and similar injections (CC + Codex review).
pub fn validate_safe_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 128 {
        return Err(format!("{} is empty or too long", label));
    }
    if value.starts_with('.') {
        return Err(format!("{} may not start with '.'", label));
    }
    for ch in value.chars() {
        let ok = ch.is_ascii_alphanumeric() || ch == '-' || ch == '_';
        if !ok {
            return Err(format!("{} contains invalid character {:?}", label, ch));
        }
    }
    let upper = value.to_ascii_uppercase();
    const WINDOWS_RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if WINDOWS_RESERVED.iter().any(|r| upper == *r) {
        return Err(format!(
            "{} matches a Windows reserved device name ({})",
            label, upper
        ));
    }
    Ok(())
}

/// Clean + validate a caller-supplied workspace path. Requires non-empty absolute
/// path. Does NOT perform `.canonicalize()` (that would require the path to exist
/// at call time — tasks may reference workspaces that have been moved).
fn canonicalize_workspace_path(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("workspacePath is empty".to_string());
    }
    let p = Path::new(trimmed);
    if !p.is_absolute() {
        return Err(format!("workspacePath must be absolute: {}", trimmed));
    }
    Ok(trimmed.to_string())
}

fn validate_task_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("task name is empty".to_string());
    }
    // PRD §3.2 says "短，<60 字符" — enforce char count (not bytes).
    if trimmed.chars().count() > 120 {
        return Err("task name exceeds 120 chars".to_string());
    }
    Ok(())
}

fn validate_new_task_session_binding(
    run_mode: Option<TaskRunMode>,
    preselected_session_id: Option<&str>,
) -> Result<(), String> {
    if run_mode != Some(TaskRunMode::SingleSession) {
        if preselected_session_id
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        {
            return Err(
                "preselectedSessionId is only valid with runMode=single-session".to_string(),
            );
        }
        return Ok(());
    }
    let session_id = preselected_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "single-session Task creation requires a materialized preselectedSessionId".to_string()
        })?;
    if session_id.starts_with("pending-") {
        return Err(
            "single-session Task creation requires a materialized preselectedSessionId".to_string(),
        );
    }
    Ok(())
}

/// PRD 0.2.9 — Validate the per-task provider routing invariants.
///
/// Three invariants enforced uniformly across Task write paths, including
/// compatibility ingress and Legacy Cron migration:
///
///   1. **Pairing**: `provider_id.is_some()` ⇒ `model.is_some()`. Picking
///      a provider without a model silently routes the chosen provider's
///      API to the agent's default model — exactly the cross-provider
///      misroute that #130 surfaced.
///
///   2. **External-runtime exclusion**: external runtimes (claude-code /
///      codex) MUST NOT carry a builtin `provider_id`; they
///      self-manage providers via their own CLI. A task with
///      `runtime='codex' + provider_id='openai-...'` would either fail
///      validation or, worse, get a model id that codex doesn't recognise.
///
///      `runtime: None` is treated as "force builtin" when `provider_id`
///      is set — see invariant 3 below. This closes the codex-review
///      finding "Agent runtime later switched to Codex/Claude Code → task
///      survives with `providerId+model` and silently ignores them at
///      execute time" (Codex P1 #5 against PRD 0.2.9): with `provider_id`
///      set, the only valid runtime is `'builtin'` or `None` AND we
///      additionally pin runtime='builtin' on save (see callers).
///
///   3. **No contradictory clear**: `clear_provider_override == true`
///      together with `provider_id == Some(_)` is rejected at the input
///      layer. The Rust merge order (apply provider_id, then clear)
///      makes "clear win", but accepting the contradictory shape silently
///      hides client bugs. Callers must send one or the other.
///
/// `provider_id`-aware runtime materialization (the matching pin) lives at
/// the call sites — see `create_direct` / `update`.
fn validate_task_provider_routing(
    provider_id: &Option<String>,
    model: &Option<String>,
    runtime: &Option<String>,
) -> Result<(), String> {
    if provider_id.is_some() && model.is_none() {
        return Err(
            "providerId 必须与 model 配对设置 — 选了 provider 后请同时选择该 provider 下的具体 model"
                .to_string(),
        );
    }
    if let Some(rt) = runtime.as_deref() {
        let is_external = matches!(rt, "claude-code" | "codex");
        if is_external && provider_id.is_some() {
            return Err(format!(
                "外部 runtime '{}' 自管 provider — 不允许同时指定 providerId（请在该 runtime 自身的设置中切换 provider）",
                rt
            ));
        }
    }
    Ok(())
}

fn validate_task_execution_routing(
    provider_id: &Option<String>,
    model: &Option<String>,
    runtime: &Option<String>,
    runtime_config: &Option<serde_json::Value>,
) -> Result<(), String> {
    validate_task_provider_routing(provider_id, model, runtime)?;
    let Some(config) = runtime_config.as_ref() else {
        return Ok(());
    };
    let object = config
        .as_object()
        .ok_or_else(|| "runtimeConfig must be a JSON object".to_string())?;
    if object
        .get("model")
        .is_some_and(|value| !value.is_null() && !value.is_string())
    {
        return Err("runtimeConfig.model must be a string".to_string());
    }
    let Some(source_value) = object.get("source") else {
        return Ok(());
    };
    let source = source_value
        .as_str()
        .ok_or_else(|| "runtimeConfig.source must be a string".to_string())?;
    if !matches!(source, "integrated" | "system-cli" | "managed-provider") {
        return Err(format!(
            "invalid runtimeConfig.source '{source}'; valid values: integrated, system-cli, managed-provider"
        ));
    }
    if source == "integrated" && runtime.as_deref() != Some("dsh") {
        return Err("runtimeConfig.source=integrated requires runtime=dsh".to_string());
    }
    if source == "managed-provider" && runtime.as_deref() != Some("codex") {
        return Err("runtimeConfig.source=managed-provider requires runtime=codex".to_string());
    }
    if runtime.as_deref() == Some("dsh") && source != "integrated" {
        return Err(
            "runtime=dsh requires runtimeConfig.source=integrated when source is explicit"
                .to_string(),
        );
    }
    Ok(())
}

/// Validate the execution-routing slice of a Task update against the current
/// row without mutating it. Cron compatibility uses this while a Running Task
/// is still Running, before its stop→update→restart sequence begins.
pub(crate) fn validate_task_update_execution_routing(
    existing: &Task,
    input: &TaskUpdateInput,
) -> Result<(), String> {
    if input.clear_provider_override
        && input
            .provider_id
            .as_deref()
            .is_some_and(|value| !value.is_empty())
    {
        return Err("providerId 与 clearProviderOverride=true 冲突 — 调用方必须二选一".to_string());
    }
    let mut provider_id = existing.provider_id.clone();
    let mut model = existing.model.clone();
    let mut runtime = existing.runtime.clone();
    let mut runtime_config = existing.runtime_config.clone();
    if let Some(value) = input.model.as_ref() {
        model = (!value.trim().is_empty()).then(|| value.clone());
    }
    if let Some(value) = input.provider_id.as_ref() {
        provider_id = (!value.trim().is_empty()).then(|| value.clone());
    }
    if input.clear_provider_override {
        provider_id = None;
        model = None;
    }
    if let Some(value) = input.runtime.as_ref() {
        runtime = Some(value.clone());
    }
    if let Some(value) = input.runtime_config.as_ref() {
        runtime_config = Some(value.clone());
    }
    if input.clear_runtime_override {
        runtime = None;
        runtime_config = None;
    }
    pin_runtime_for_provider_id(&provider_id, &mut runtime);
    validate_task_execution_routing(&provider_id, &model, &runtime, &runtime_config)
}

fn session_metadata_matches_workspace(session_id: &str, workspace_path: &str) -> bool {
    crate::sidecar::runtime_identity::session_metadata_matches_workspace(session_id, workspace_path)
}

fn session_metadata_exists(session_id: &str) -> bool {
    crate::sidecar::runtime_identity::resolve_session_runtime_identity_full(session_id).is_some()
}

fn should_cancel_pending_after_transition(
    status: TaskStatus,
    command_trigger: bool,
    exact_stop_confirmed: bool,
) -> bool {
    exact_stop_confirmed
        && command_trigger
        && matches!(status, TaskStatus::Stopped | TaskStatus::Archived)
}

/// PRD 0.2.9 — Materialize `runtime: Some("builtin")` whenever a
/// `provider_id` is set with `runtime: None`. This closes the cross-talk
/// hole flagged by Codex review (P1 #5):
///
/// - User saves task with `runtime: None, provider_id: 'openai-...'`
///   (relying on Agent runtime = builtin).
/// - Later: user changes Agent runtime to codex.
/// - Without pinning, the task survives validation but its provider
///   fields are silently ignored at execute time (codex branch reads
///   only runtimeConfig.model).
/// - Pinning `runtime: 'builtin'` makes the task fail validation at
///   next save (provider_id + external runtime is invariant 2),
///   AND keeps execution honoring the chosen provider regardless of
///   Agent's later runtime switch — providerId IS the user's pinned
///   intent for THIS task.
///
/// Idempotent: if `runtime` is already `Some(_)`, do nothing. Validator
/// runs after this materialization, so any non-None+external case still
/// surfaces as a "外部 runtime 不允许 providerId" error.
fn pin_runtime_for_provider_id(provider_id: &Option<String>, runtime: &mut Option<String>) {
    if provider_id.is_some() && runtime.is_none() {
        *runtime = Some("builtin".to_string());
    }
}

/// Resolve `~/.myagents/tasks/<id>/` and verify the resolved path stays inside
/// `~/.myagents/tasks/`. This is the pit-of-success guard — centralizing path
/// join + boundary check here means no caller can accidentally escape the
/// sandbox via a bad id.
///
/// v0.1.69 relocation: task docs used to live under `<workspace>/.task/<id>/`,
/// keyed by the absolute workspace path. That coupled application data
/// (markdown describing how the task runs) to project content (which could
/// be moved, renamed, deleted, or tracked in git by accident). Tasks are
/// now a first-class user-scoped artifact, alongside `thoughts/`,
/// `sessions/`, and `cron_runs/` — the workspace remains the *execution
/// context* (Sidecar cwd, AI bash tool base) but no longer the storage.
pub fn task_docs_dir(task_id: &str) -> Result<PathBuf, String> {
    validate_safe_id(task_id, "taskId")?;
    let base = task_docs_root()?;
    let resolved = base.join(task_id);
    // Defense in depth: after the `validate_safe_id` check above, any resolved
    // path must still lexically start with `~/.myagents/tasks/`. This catches
    // future bypasses if the validator is weakened.
    if !resolved.starts_with(&base) {
        return Err(format!(
            "task_docs_dir escaped base: {} (base={})",
            resolved.display(),
            base.display()
        ));
    }
    Ok(resolved)
}

/// Root dir for all task documents — `~/.myagents/tasks/`.
///
/// Honors `MYAGENTS_TASK_DOCS_ROOT` **only in debug / test builds** so tests
/// (and the one-off migration script) can redirect to a tempdir without
/// touching the real user profile. Production builds ignore the env var to
/// shut down the "user's shell rc or a rogue child-process env accidentally
/// redirects application data" risk. The env var MUST be an absolute path;
/// relative values are rejected so a stray `./tasks` in CI doesn't pollute
/// the cwd.
fn task_docs_root() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        if let Ok(override_path) = std::env::var("MYAGENTS_TASK_DOCS_ROOT") {
            let p = PathBuf::from(&override_path);
            if !p.is_absolute() {
                return Err(format!(
                    "MYAGENTS_TASK_DOCS_ROOT must be absolute, got {}",
                    override_path
                ));
            }
            return Ok(p);
        }
    }
    // Route through `app_dirs::myagents_data_dir()` so future dev/prod data
    // isolation (see `app_dirs.rs` doc — e.g. `~/.myagents-dev/` for debug
    // builds) picks up this path automatically. Don't hardcode home dir.
    crate::app_dirs::myagents_data_dir()
        .map(|d| d.join("tasks"))
        .ok_or_else(|| "cannot resolve myagents data dir for task docs".to_string())
}

/// Crash-durable atomic text write: tmp write → sync_all → rename → cleanup
/// on any failure. Mirrors `persist_locked` guarantees for arbitrary files.
pub(crate) fn write_atomic_text(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    let tmp = path.with_extension("tmp");
    let write_res = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&tmp)
            .map_err(|e| format!("open tmp: {}", e))?;
        file.write_all(content.as_bytes())
            .map_err(|e| format!("write tmp: {}", e))?;
        file.flush().map_err(|e| format!("flush tmp: {}", e))?;
        file.sync_all().map_err(|e| format!("sync tmp: {}", e))?;
        Ok(())
    })();
    if let Err(e) = write_res {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("rename: {}", e));
    }
    // A synced file followed by rename is not fully power-loss durable until
    // the directory entry itself is synced. Trigger state contains the durable
    // Activation Event outbox, so treat a failed directory sync as a failed
    // commit on Unix instead of acknowledging an event that may disappear.
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| format!("sync parent dir: {e}"))?;
    }
    Ok(())
}

/// Construct the first-message prompt for a dispatch tick. Every ordinary Task
/// receives its complete task.md; dispatchOrigin is provenance only.
///
/// Returns `None` if the store isn't initialized or the task doesn't exist.
/// Returns `Some(Err(...))` for unrecoverable I/O such as a missing task.md.
pub async fn build_dispatch_prompt(task_id: &str) -> Option<Result<String, String>> {
    let store = get_task_store()?;
    let task = store.get(task_id).await?;
    if task.dispatch_origin != TaskDispatchOrigin::AttachedSession {
        if let Err(error) = store.ensure_legacy_verify_merged(task_id).await {
            return Some(Err(error));
        }
    }
    Some(compose_dispatch_prompt(&task))
}

fn compose_dispatch_prompt(task: &Task) -> Result<String, String> {
    match task.dispatch_origin {
        TaskDispatchOrigin::AttachedSession => Err(format!(
            "attached-session task {} is already bound to a live session and cannot be dispatched",
            task.id
        )),
        TaskDispatchOrigin::Direct | TaskDispatchOrigin::AiAligned => {
            let dir = task_docs_dir(&task.id)?;
            let task_md = dir.join("task.md");
            match fs::read_to_string(&task_md) {
                Ok(body) => {
                    let trimmed = body.trim();
                    if trimmed.is_empty() {
                        Err(format!("task.md is empty for task {}", task.id))
                    } else {
                        Ok(format!("执行任务：{}", trimmed))
                    }
                }
                Err(e) => Err(format!(
                    "Failed to read task.md for {} ({}): {}",
                    task.id,
                    task_md.display(),
                    e
                )),
            }
        }
    }
}

/// Default events a task subscribes to when `NotificationConfig.events` is absent.
const DEFAULT_NOTIFICATION_EVENTS: &[&str] = &["done", "blocked", "endCondition"];

/// PRD §12.2 — check the per-task subscription and dispatch desktop + bot pushes.
/// Dispatch runs best-effort; bot push failure falls back to desktop (§12.6).
fn dispatch_notification(task: &Task, t: &StatusTransition) {
    // Event key — prefer the transition source if it's an `endCondition`
    // virtual event (PRD §12.2), else use the target status.
    let event_key: &str = match (t.source, t.to) {
        (Some(TransitionSource::EndCondition), _) => "endCondition",
        (_, TaskStatus::Done) => "done",
        (_, TaskStatus::Blocked) => "blocked",
        (_, TaskStatus::Stopped) => "stopped",
        (_, TaskStatus::Verifying) => "verifying",
        _ => return, // other transitions don't map to notification events
    };

    let cfg = task.notification.as_ref();
    let subscribed: Vec<String> = cfg.and_then(|c| c.events.clone()).unwrap_or_else(|| {
        DEFAULT_NOTIFICATION_EVENTS
            .iter()
            .map(|s| s.to_string())
            .collect()
    });
    if !subscribed.iter().any(|e| e == event_key) {
        return;
    }

    // Build the message (PRD §12.3): "任务「<name>」<动词短语>" + optional
    // `message` body. No emoji (v1.4 decision).
    let verb = match event_key {
        "done" => "已完成",
        "blocked" => "已阻塞",
        "stopped" => "已暂停",
        "verifying" => "进入验证",
        "endCondition" => "循环收敛",
        _ => "状态变更",
    };
    let title = format!("任务「{}」{}", task.name, verb);
    let body = t.message.clone().unwrap_or_default();

    let desktop_enabled = cfg.map(|c| c.desktop).unwrap_or(true);
    let bot_channel = cfg.and_then(|c| c.bot_channel_id.clone());

    let Some(handle) = crate::logger::get_app_handle() else {
        ulog_warn!("[task] notification skipped — no app handle");
        return;
    };

    // Task Center notifications bring the window to the foreground on click
    // but don't deep-link to a specific chat Tab — Tasks live in their own
    // surface (the Task Center page), and no Tab is owned by a Task. The
    // legacy implementation emitted `taskId` in the event payload but the
    // front-end listener typed the field as `tabId`, so the value was always
    // dropped. Pass `None` here and preserve that no-deep-link semantics
    // exactly.
    if desktop_enabled {
        crate::notification::show_with_navigation_target_and_badge(
            &handle,
            &title,
            &body,
            None,
            Some(crate::notification_badge::NotificationBadgeIncrement {
                id: format!("task:{}:{}:{}", task.id, event_key, t.at),
                source: "task-center".to_string(),
                created_at: t.at,
                target: crate::notification_badge::NotificationBadgeTarget::TaskCenter {
                    task_id: Some(task.id.clone()),
                },
            }),
        );
    }

    if let Some(channel) = bot_channel {
        let handle_cloned = handle.clone();
        let bot_thread = cfg.and_then(|c| c.bot_thread.clone());
        let summary = if body.is_empty() {
            title.clone()
        } else {
            format!("{}\n{}", title, body)
        };
        let task_id = task.id.clone();
        let title_owned = title.clone();
        let desktop_was_enabled = desktop_enabled;
        let event_key_owned = event_key.to_string();
        let transition_at = t.at;
        tauri::async_runtime::spawn(async move {
            // PRD §12.6 — bot push failure falls back to desktop so the user
            // isn't silently left without any notification. Even if the user
            // explicitly turned off `desktop`, a bot failure that left them
            // with zero notifications is a degraded experience we surface.
            let delivered = crate::cron_task::deliver_task_notification_to_bot_checked(
                &handle_cloned,
                &channel,
                bot_thread.as_deref(),
                &task_id,
                &summary,
            )
            .await;
            if !delivered {
                let fallback_body = if desktop_was_enabled {
                    format!("(bot 推送失败) {}", summary)
                } else {
                    format!("(bot 推送失败，降级桌面通知) {}", summary)
                };
                crate::notification::show_with_navigation_target_and_badge(
                    &handle_cloned,
                    &title_owned,
                    &fallback_body,
                    None,
                    Some(crate::notification_badge::NotificationBadgeIncrement {
                        id: format!(
                            "task:{}:{}:{}:bot-fallback",
                            task_id, event_key_owned, transition_at
                        ),
                        source: "task-center".to_string(),
                        created_at: chrono::Utc::now().timestamp_millis(),
                        target: crate::notification_badge::NotificationBadgeTarget::TaskCenter {
                            task_id: Some(task_id.clone()),
                        },
                    }),
                );
            }
        });
    }
}

/// SSE / frontend broadcast. Uses the global AppHandle from `logger` so any
/// module can emit without threading the handle through constructors.
fn emit_task_event(event: &str, payload: serde_json::Value) {
    if let Some(handle) = crate::logger::get_app_handle() {
        let _ = handle.emit(event, payload);
    }
}

// ================ Static access for Management API ================
//
// The Rust Management API (src/management_api.rs) serves HTTP requests from
// the Bun Sidecar on a loopback port. It runs as a tokio task without direct
// access to Tauri `State`, so we expose a singleton `OnceLock` just like
// `cron_task::CRON_TASK_MANAGER`. `lib.rs` calls `set_task_store()` during
// `setup()` with the same `Arc<TaskStore>` that's in managed state — the two
// handles point at the same inner store (Arc::clone), so mutations are
// visible to both the Tauri IPC path and the HTTP path.

static TASK_STORE: std::sync::OnceLock<Arc<TaskStore>> = std::sync::OnceLock::new();

pub fn set_task_store(store: Arc<TaskStore>) {
    let _ = TASK_STORE.set(store);
}

pub fn get_task_store() -> Option<&'static Arc<TaskStore>> {
    TASK_STORE.get()
}

// ================ Tauri commands ================
//
// The Tauri layer is the trust boundary for actor/source inference (PRD §10.2.1
// caller-inference table): UI button presses are authoritatively stamped as
// `actor=User, source=Ui`. The command DTOs therefore do NOT expose `actor`/
// `source` fields — a malicious renderer cannot spoof `agent` / `system`.
// Server-side callers (scheduler, CLI → Admin API) use the richer internal
// `TaskStore::update_status` API and supply their own trusted actor/source.
//
// Cross-store/scheduler policy lives in `task_application`; commands only
// stamp trusted caller fields and adapt Tauri DTOs/errors.

pub type ManagedTaskStore = Arc<TaskStore>;

#[tauri::command]
pub async fn cmd_task_create_direct(
    task_state: tauri::State<'_, ManagedTaskStore>,
    thought_state: tauri::State<'_, crate::thought::ManagedThoughtStore>,
    input: TaskCreateDirectInput,
) -> Result<Task, String> {
    crate::task_application::TaskApplication::new(
        task_state.inner().as_ref(),
        Some(thought_state.inner().as_ref()),
    )
    .create_direct(input)
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cmd_task_create_attached(
    task_state: tauri::State<'_, ManagedTaskStore>,
    input: TaskCreateAttachedInput,
) -> Result<Task, String> {
    crate::task_application::TaskApplication::new(task_state.inner().as_ref(), None)
        .create_attached(input)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cmd_task_list(
    state: tauri::State<'_, ManagedTaskStore>,
    filter: Option<TaskListFilter>,
) -> Result<Vec<TaskProjection>, String> {
    let mut filter = filter.unwrap_or_default();
    filter.include_managed = None;
    let tasks = state.list(filter).await;
    Ok(project_task_list(tasks).await)
}

#[tauri::command]
pub async fn cmd_task_get(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
) -> Result<Option<TaskWithDocs>, String> {
    if state.get(&id).await.is_some() {
        state.ensure_legacy_verify_merged(&id).await?;
    }
    let task = match state.get_ordinary(&id).await {
        Ok(task) => task,
        Err(error) if error == String::from(TaskOpError::not_found(&id)) => return Ok(None),
        Err(error) => return Err(error),
    };
    let docs = build_task_docs(&task.id)?;
    let execution = crate::task_scheduler::get_task_scheduler()
        .execution_projection(&task.id)
        .await;
    let trigger_state = if task.effective_trigger().is_command() {
        Some(state.read_trigger_state(&task.id).await?)
    } else {
        None
    };
    let next_execution_at = crate::task_scheduler::next_execution_at(&task)
        .ok()
        .flatten()
        .map(|value| value.timestamp_millis());
    Ok(Some(TaskWithDocs {
        task,
        docs,
        execution_state: execution.as_ref().map(|value| value.state),
        execution_error: execution.and_then(|value| value.error),
        trigger_state,
        next_execution_at,
    }))
}

#[tauri::command]
pub async fn cmd_task_trigger_validate(trigger: TaskTrigger) -> Result<TaskTrigger, String> {
    validate_task_trigger(&trigger)?;
    Ok(trigger)
}

#[tauri::command]
pub async fn cmd_task_trigger_test(
    task_id: Option<String>,
    owner_task_id: Option<String>,
    trigger: Option<TaskTrigger>,
    workspace_path: Option<String>,
    checkpoint: Option<serde_json::Map<String, serde_json::Value>>,
    checkpoint_revision: Option<u64>,
    checkpoint_updated_at: Option<i64>,
) -> serde_json::Value {
    let result = match (task_id, trigger, workspace_path) {
        (Some(task_id), None, None) => {
            crate::task_scheduler::get_task_scheduler()
                .test_trigger(&task_id, None)
                .await
        }
        (None, Some(trigger), Some(workspace_path)) => {
            crate::task_scheduler::get_task_scheduler()
                .test_trigger_spec(
                    owner_task_id,
                    trigger,
                    workspace_path,
                    checkpoint,
                    checkpoint_revision.unwrap_or(0),
                    checkpoint_updated_at,
                )
                .await
        }
        _ => Err(crate::task_trigger::DetectorRunFailure::from_message(
            "invalid_request",
            "provide either taskId or trigger + workspacePath",
        )),
    };
    match result {
        Ok(result) => serde_json::json!({ "ok": true, "result": result }),
        Err(failure) => serde_json::json!({ "ok": false, "failure": failure }),
    }
}

#[tauri::command]
pub async fn cmd_task_check_now(
    id: String,
) -> Result<crate::task_scheduler::TaskTriggerCheckNowResult, String> {
    crate::task_scheduler::get_task_scheduler()
        .check_now(&id)
        .await
}

#[tauri::command]
pub async fn cmd_task_run_now(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
) -> Result<String, String> {
    state.get_ordinary(&id).await?;
    crate::task_scheduler::get_task_scheduler()
        .trigger_now(&id)
        .await
}

#[tauri::command]
pub async fn cmd_task_reset_checkpoint(
    id: String,
) -> Result<crate::task_trigger::TaskTriggerRuntimeState, String> {
    crate::task_scheduler::get_task_scheduler()
        .reset_checkpoint(&id)
        .await
}

#[tauri::command]
pub async fn cmd_task_update(
    state: tauri::State<'_, ManagedTaskStore>,
    input: TaskUpdateInput,
) -> Result<Task, String> {
    crate::task_application::TaskApplication::new(state.inner().as_ref(), None)
        .update_ordinary(input)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cmd_task_update_status(
    state: tauri::State<'_, ManagedTaskStore>,
    input: UiTaskUpdateStatusInput,
) -> Result<Task, String> {
    // Trust boundary: UI callers are stamped as user/ui here. The internal
    // `update_status` API remains available for scheduler / watchdog / crash /
    // endCondition / rerun paths with their own actor/source context.
    crate::task_application::TaskApplication::new(state.inner().as_ref(), None)
        .update_status_ordinary(TaskUpdateStatusInput {
            id: input.id,
            status: input.status,
            message: input.message,
            actor: TransitionActor::User,
            source: Some(TransitionSource::Ui),
        })
        .await
        .map(|result| result.task)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cmd_task_append_session(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
    session_id: String,
) -> Result<Task, String> {
    crate::task_application::TaskApplication::new(state.inner().as_ref(), None)
        .append_session_ordinary(&id, &session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cmd_task_list_comments(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
    before: Option<String>,
    after: Option<String>,
    limit: Option<usize>,
) -> Result<TaskCommentPage, String> {
    if before.is_some() && after.is_some() {
        return Err("comment pagination accepts only one of before or after".to_string());
    }
    if let Some(after) = after.as_deref() {
        state
            .list_comments_after(&id, after, limit.unwrap_or(50))
            .await
    } else {
        state
            .list_comments(&id, before.as_deref(), limit.unwrap_or(50))
            .await
    }
}

#[tauri::command]
pub async fn cmd_task_get_comment_context(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
    comment_id: String,
) -> Result<TaskCommentContextPage, String> {
    state.comment_context(&id, &comment_id, 25).await
}

#[tauri::command]
pub async fn cmd_task_create_user_comment(
    app_handle: tauri::AppHandle,
    task_state: tauri::State<'_, ManagedTaskStore>,
    sidecar_state: tauri::State<'_, crate::sidecar::ManagedSidecarManager>,
    id: String,
    body: String,
    reply_to_comment_id: Option<String>,
) -> Result<TaskComment, String> {
    crate::task_application::TaskApplication::new(task_state.inner().as_ref(), None)
        .create_user_comment(
            &app_handle,
            sidecar_state.inner(),
            &id,
            &body,
            reply_to_comment_id.as_deref(),
        )
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cmd_task_retry_comment(
    app_handle: tauri::AppHandle,
    task_state: tauri::State<'_, ManagedTaskStore>,
    sidecar_state: tauri::State<'_, crate::sidecar::ManagedSidecarManager>,
    id: String,
    comment_id: String,
) -> Result<TaskComment, String> {
    crate::task_application::TaskApplication::new(task_state.inner().as_ref(), None)
        .retry_user_comment(&app_handle, sidecar_state.inner(), &id, &comment_id)
        .await
        .map_err(|error| error.to_string())
}

/// Prepare a durable, non-Task artifact root for one AI discussion. Candidate
/// task.md files may be written under `candidates/`, but no Task row or
/// schedule exists until the Agent calls the ordinary create-direct API after
/// explicit user confirmation.
#[tauri::command]
pub async fn cmd_task_prepare_discussion(
    discussion_id: String,
    workspace_id: String,
    workspace_path: String,
    source_record_id: Option<String>,
) -> Result<PreparedTaskDiscussion, String> {
    validate_safe_id(&discussion_id, "discussionId")?;
    let root = crate::app_dirs::myagents_data_dir()
        .ok_or_else(|| "cannot resolve MyAgents data dir".to_string())?
        .join("task-discussions");
    if fs::symlink_metadata(&root)
        .ok()
        .is_some_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err("Task discussion root may not be a symlink".to_string());
    }
    let dir = discussion_artifact_dir(&root, &discussion_id)?;
    if !dir.starts_with(&root) {
        return Err("Task discussion path escaped artifact root".to_string());
    }
    let candidates = dir.join("candidates");
    if fs::symlink_metadata(&candidates)
        .ok()
        .is_some_and(|meta| meta.file_type().is_symlink())
    {
        return Err("Task discussion candidates may not be a symlink".into());
    }
    if dir.join("metadata.json").exists() {
        return Err("Task discussion already exists".into());
    }
    fs::create_dir_all(&candidates)
        .map_err(|e| format!("mkdir Task discussion candidates: {e}"))?;
    let meta = TaskDiscussionMetadata {
        discussion_id: discussion_id.clone(),
        workspace_id,
        workspace_path,
        source_record_id,
        created_at: now_ms(),
    };
    let json = serde_json::to_string_pretty(&meta)
        .map_err(|e| format!("serialize Task discussion metadata: {e}"))?;
    write_atomic_text(&dir.join("metadata.json"), &json)?;
    ulog_debug!(
        "[task] prepared discussion id={} record={:?}",
        discussion_id,
        meta.source_record_id,
    );
    Ok(PreparedTaskDiscussion {
        discussion_id,
        discussion_dir: dir.to_string_lossy().into_owned(),
        candidates_dir: candidates.to_string_lossy().into_owned(),
    })
}

const TASK_DISCUSSION_INPUT_MAX_BYTES: u64 = 4 * 1024 * 1024;

fn discussion_artifact_dir(root: &Path, discussion_id: &str) -> Result<PathBuf, String> {
    validate_safe_id(discussion_id, "discussionId")?;
    let dir = root.join(discussion_id);
    for path in [
        root.to_path_buf(),
        dir.clone(),
        dir.join("metadata.json"),
        dir.join("input.json"),
    ] {
        if fs::symlink_metadata(&path)
            .ok()
            .is_some_and(|meta| meta.file_type().is_symlink())
        {
            return Err("Task discussion artifact may not be a symlink".into());
        }
    }
    Ok(dir)
}

fn validate_discussion_input(
    dir: &Path,
    discussion_id: &str,
    input: &TaskDiscussionInput,
) -> Result<(), String> {
    let metadata: TaskDiscussionMetadata = serde_json::from_slice(
        &fs::read(dir.join("metadata.json"))
            .map_err(|e| format!("read discussion metadata: {e}"))?,
    )
    .map_err(|e| format!("parse discussion metadata: {e}"))?;
    let context = &input.primary_context.input;
    if metadata.discussion_id != discussion_id
        || input.primary_context.kind != "task-discussion"
        || context.workspace_id != metadata.workspace_id
        || context.workspace_path != metadata.workspace_path
        || context.source_record_id != metadata.source_record_id
        || Path::new(&context.candidates_dir) != dir.join("candidates")
        || input.text.trim().is_empty()
        || input.text != context.visible_user_message
        || Uuid::parse_str(&input.client_request_id).is_err()
        || input.required_system_skill.name != "myagents-task-alignment"
        || input.required_system_skill.source_local_id != "myagents-task-alignment"
        || input.required_system_skill.system_skills_version.is_empty()
        || input.required_system_skill.content_sha256.len() != 64
        || !input
            .required_system_skill
            .content_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Task discussion input does not match its owned contract".into());
    }
    // Keep the exact saved requirement even after an app upgrade. The runtime's
    // ordinary admission validator, not recovery, decides whether it is current.
    Ok(())
}

fn save_discussion_input_under(
    root: &Path,
    discussion_id: &str,
    input: &TaskDiscussionInput,
) -> Result<(), String> {
    let dir = discussion_artifact_dir(root, discussion_id)?;
    validate_discussion_input(&dir, discussion_id, input)?;
    let json = serde_json::to_string_pretty(input).map_err(|e| e.to_string())?;
    if json.len() as u64 > TASK_DISCUSSION_INPUT_MAX_BYTES {
        return Err("Task discussion input exceeds size limit".into());
    }
    let path = dir.join("input.json");
    if path.exists() {
        return Err("Task discussion original input already exists".into());
    }
    // Publish once, atomically. Concurrent saves cannot replace the original;
    // the source form is released only after the file and directory are synced.
    let staging = dir.join(format!("input-{}.pending", Uuid::new_v4()));
    write_atomic_text(&staging, &json)?;
    let published =
        fs::hard_link(&staging, &path).map_err(|e| format!("publish discussion input: {e}"));
    let _ = fs::remove_file(&staging);
    published?;
    crate::durable_fs::sync_directory(&dir).map_err(|e| e.to_string())
}

fn read_discussion_input_under(
    root: &Path,
    discussion_id: &str,
) -> Result<Option<TaskDiscussionInput>, String> {
    let dir = discussion_artifact_dir(root, discussion_id)?;
    let path = dir.join("input.json");
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() || metadata.len() > TASK_DISCUSSION_INPUT_MAX_BYTES {
        return Err("Task discussion input is invalid or exceeds size limit".into());
    }
    let input = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("parse discussion input: {e}"))?;
    validate_discussion_input(&dir, discussion_id, &input)?;
    Ok(Some(input))
}

#[tauri::command]
pub async fn cmd_task_save_discussion_input(
    discussion_id: String,
    input: TaskDiscussionInput,
) -> Result<(), String> {
    let root = crate::app_dirs::myagents_data_dir()
        .ok_or("cannot resolve MyAgents data dir")?
        .join("task-discussions");
    tauri::async_runtime::spawn_blocking(move || {
        save_discussion_input_under(&root, &discussion_id, &input)
    })
    .await
    .map_err(|error| format!("save discussion input task failed: {error}"))?
}

#[tauri::command]
pub async fn cmd_task_read_discussion_input(
    discussion_id: String,
) -> Result<Option<TaskDiscussionInput>, String> {
    let root = crate::app_dirs::myagents_data_dir()
        .ok_or("cannot resolve MyAgents data dir")?
        .join("task-discussions");
    tauri::async_runtime::spawn_blocking(move || {
        read_discussion_input_under(&root, &discussion_id)
    })
    .await
    .map_err(|error| format!("read discussion input task failed: {error}"))?
}

const TASK_DISCUSSION_CANDIDATE_MAX_BYTES: u64 = 1024 * 1024;

/// Re-read an app-owned smart-discussion candidate at the authoritative Rust
/// boundary immediately before Task creation. Generic CLI files outside the
/// discussion root return `None`; paths that claim to be candidates but have
/// an invalid shape, symlink, oversized body, or stale/unreadable file fail
/// closed instead of trusting the CLI's earlier snapshot.
pub fn read_owned_discussion_candidate(raw_path: &str) -> Result<Option<String>, String> {
    let root = crate::app_dirs::myagents_data_dir()
        .ok_or_else(|| "cannot resolve MyAgents data dir".to_string())?
        .join("task-discussions");
    read_owned_discussion_candidate_under(&root, raw_path)
}

fn read_owned_discussion_candidate_under(
    root: &Path,
    raw_path: &str,
) -> Result<Option<String>, String> {
    if !root.exists() {
        return Ok(None);
    }
    if fs::symlink_metadata(root)
        .map_err(|error| format!("inspect Task discussion root: {error}"))?
        .file_type()
        .is_symlink()
    {
        return Err("Task discussion root may not be a symlink".to_string());
    }
    let canonical_root =
        fs::canonicalize(root).map_err(|error| format!("resolve Task discussion root: {error}"))?;
    let supplied = PathBuf::from(raw_path);
    if let Ok(metadata) = fs::symlink_metadata(&supplied) {
        if metadata.file_type().is_symlink() {
            return Err("Task discussion candidate may not be a symlink".to_string());
        }
    }
    let canonical_file = match fs::canonicalize(&supplied) {
        Ok(path) => path,
        Err(error) => {
            // Only candidate-shaped paths fail closed. Ordinary external CLI
            // files have already been read by the CLI and are not app-owned.
            if supplied.starts_with(root) || supplied.starts_with(&canonical_root) {
                return Err(format!("resolve Task discussion candidate: {error}"));
            }
            return Ok(None);
        }
    };
    if !canonical_file.starts_with(&canonical_root) {
        return Ok(None);
    }
    if !supplied.starts_with(root) {
        return Err("Task discussion candidate must use its app-owned path".to_string());
    }
    let relative = canonical_file
        .strip_prefix(&canonical_root)
        .map_err(|_| "Task discussion candidate escaped its root".to_string())?;
    let components = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    if components.len() != 4 || components[1] != "candidates" || components[3] != "task.md" {
        return Err(
            "Task discussion candidate must be <discussion>/candidates/<candidate>/task.md"
                .to_string(),
        );
    }
    validate_safe_id(&components[0], "discussionId")?;
    validate_safe_id(&components[2], "candidateId")?;

    let mut cursor = root.to_path_buf();
    for component in &components {
        cursor.push(component);
        let metadata = fs::symlink_metadata(&cursor)
            .map_err(|error| format!("inspect Task discussion candidate: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("Task discussion candidate may not contain symlinks".to_string());
        }
    }
    let metadata = fs::metadata(&canonical_file)
        .map_err(|error| format!("inspect Task discussion candidate: {error}"))?;
    if !metadata.is_file() {
        return Err("Task discussion candidate is not a regular file".to_string());
    }
    if metadata.len() > TASK_DISCUSSION_CANDIDATE_MAX_BYTES {
        return Err("Task discussion candidate exceeds the 1 MB limit".to_string());
    }
    let content = fs::read_to_string(&canonical_file)
        .map_err(|error| format!("read Task discussion candidate: {error}"))?;
    if content.contains('\0') {
        return Err("Task discussion candidate contains NUL bytes".to_string());
    }
    if content.trim().is_empty() {
        return Err("Task discussion candidate is empty".to_string());
    }
    Ok(Some(content))
}

#[tauri::command]
pub async fn cmd_task_archive(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
    message: Option<String>,
) -> Result<Task, String> {
    crate::task_application::TaskApplication::new(state.inner().as_ref(), None)
        .archive_ordinary(&id, message)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cmd_task_delete(
    task_state: tauri::State<'_, ManagedTaskStore>,
    thought_state: tauri::State<'_, crate::thought::ManagedThoughtStore>,
    id: String,
) -> Result<(), String> {
    crate::task_application::TaskApplication::new(
        task_state.inner().as_ref(),
        Some(thought_state.inner().as_ref()),
    )
    .delete_ordinary(&id)
    .await
    .map_err(|error| error.to_string())
}

/// Read one of the markdown documents attached to a Task.
///
/// - `task`: the executor prompt (`~/.myagents/tasks/<id>/task.md`). Authored by the user
///   at dispatch, editable from the task detail overlay.
/// - `verify`, `progress`, `alignment`: retained legacy documents. They are
///   read-only compatibility surfaces except for the legacy verify editor API.
#[tauri::command]
pub async fn cmd_task_read_doc(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
    doc: String,
) -> Result<String, String> {
    state.ensure_legacy_verify_merged(&id).await?;
    let task = state.get_ordinary(&id).await?;
    let filename = task_doc_filename(&doc)?;
    let path = task_docs_dir(&task.id)?.join(filename);
    match fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("read {}: {}", filename, e)),
    }
}

/// Write the single editable Task authority, `task.md`. Legacy `verify.md`,
/// `progress.md`, and `alignment.md` remain read-only compatibility inputs.
/// The running/
/// verifying lock is enforced atomically with the file write inside
/// `TaskStore::write_doc` — status check and file mutation happen under
/// the same lock so a concurrent `update_status(running)` can't land in
/// between and let us mutate a doc that's mid-execution.
#[tauri::command]
pub async fn cmd_task_write_doc(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
    doc: String,
    content: String,
) -> Result<(), String> {
    if doc != "task" {
        return Err(format!(
            "{} is a read-only legacy document; edit task.md instead",
            task_doc_filename(&doc)?
        ));
    }
    state.get_ordinary(&id).await?;
    state.write_doc(&id, "task.md", &content).await
}

/// Reveal `~/.myagents/tasks/<id>/` in the OS file manager so the user
/// can inspect / edit `task.md`, `verify.md`, `progress.md`, `alignment.md`
/// directly. Sandboxed through `task_docs_dir` so we can't be coerced into
/// opening an arbitrary path. Creates the dir on demand — a fresh Task
/// has no docs dir until its first write.
#[tauri::command]
pub async fn cmd_task_open_docs_dir(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
) -> Result<(), String> {
    // Validate the task exists so the UI can't open a docs dir for a
    // deleted / unknown task (Finder would happily open an empty dir).
    state.get_ordinary(&id).await?;
    let dir = task_docs_dir(&id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir task dir: {}", e))?;
    let path = dir.to_string_lossy().to_string();

    // OS openers via process_cmd::new — CREATE_NO_WINDOW is a no-op for
    // GUI-subsystem binaries (open / explorer.exe / xdg-open) so the wrapper
    // is functionally equivalent to raw Command::new here, but going through
    // it preserves the single-mental-model rule ("ALL child processes use
    // process_cmd::new"; pit_of_success.md#process_cmd).
    #[cfg(target_os = "macos")]
    {
        crate::process_cmd::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("open finder: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        crate::process_cmd::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("open explorer: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        crate::process_cmd::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("xdg-open: {}", e))?;
    }
    Ok(())
}

/// Aggregate runtime telemetry from the Task authority. The append-only run
/// history is an audit projection and is deliberately not consulted here.
///
/// The renderer uses this in the detail overlay's "运行统计" section
/// without having to stitch three data sources together.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunStats {
    pub execution_count: u32,
    pub last_executed_at: Option<i64>,
    pub last_success: Option<bool>,
    pub last_duration_ms: Option<i64>,
    pub scheduler_status: Option<String>,
    pub session_count: usize,
    /// Next scheduled fire time (ms since epoch), computed by the same Rust
    /// resolver used by the live Task scheduler.
    pub next_execution_at: Option<i64>,
}

#[tauri::command]
pub async fn cmd_task_get_run_stats(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
) -> Result<TaskRunStats, String> {
    let task = state
        .get(&id)
        .await
        .ok_or_else(|| String::from(TaskOpError::not_found(&id)))?;

    let mut stats = TaskRunStats {
        execution_count: task.execution_count,
        last_executed_at: task.last_executed_at,
        last_success: None,
        last_duration_ms: None,
        scheduler_status: Some(task.status.as_str().to_string()),
        session_count: task.session_ids.len(),
        next_execution_at: crate::task_scheduler::next_execution_at(&task)
            .ok()
            .flatten()
            .map(|value| value.timestamp_millis()),
    };

    if let Some(last) = task.last_execution.as_ref() {
        stats.last_success = Some(last.success);
        stats.last_duration_ms = Some(last.duration_ms as i64);
    }

    Ok(stats)
}

/// Central doc-name whitelist for all task-md entry points (Tauri IPC
/// `cmd_task_read_doc`/`cmd_task_write_doc` + Management API
/// `/api/task/read-doc`/`/api/task/write-doc`). Keep these in lockstep —
/// divergence led to the v0.1.69 bug where Management API accepted
/// `alignment` but Tauri IPC rejected it, so the renderer couldn't read
/// alignment.md through the same path the CLI uses.
pub fn task_doc_filename(doc: &str) -> Result<&'static str, String> {
    match doc {
        "task" => Ok("task.md"),
        "verify" => Ok("verify.md"),
        "progress" => Ok("progress.md"),
        "alignment" => Ok("alignment.md"),
        other => Err(format!(
            "unknown doc name: {} (expected task|verify|progress|alignment)",
            other
        )),
    }
}

// ================ Tests ================

/// Shared task-docs root for the entire test binary. Initialised
/// exactly once via `ensure_test_docs_root()` before any test touches
/// `task_docs_dir()`. Each test uses a fresh UUID task id, so writes
/// never collide even though the root is shared.
///
/// Per-test tempdir + env-var swapping doesn't work here: `cargo test`
/// runs tests in parallel within one process, and env vars are
/// process-global — two concurrent tests would race each other's
/// redirects. `std::env::set_var` is also technically unsound when
/// called from multiple threads (Rust 2024 edition marks it `unsafe`
/// for this reason), so we call it exactly once inside
/// `get_or_init`'s closure.
#[cfg(test)]
static TEST_DOCS_ROOT: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();

#[cfg(test)]
pub(crate) fn ensure_test_docs_root() {
    TEST_DOCS_ROOT.get_or_init(|| {
        let dir = tempfile::tempdir().expect("create shared test docs tempdir");
        std::env::set_var("MYAGENTS_TASK_DOCS_ROOT", dir.path());
        dir
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::sync::Arc;
    use tempfile::tempdir;

    async fn create_direct_with_existing_session(
        store: &TaskStore,
        input: TaskCreateDirectInput,
    ) -> Result<Task, String> {
        reject_managed_kind_from_ordinary_create(&input.managed_kind)?;
        store
            .create_direct_internal(
                input,
                TransitionActor::User,
                Some(TransitionSource::Ui),
                "created (direct)",
                |_| true,
            )
            .await
    }

    fn sample_direct_input(ws: &Path) -> TaskCreateDirectInput {
        TaskCreateDirectInput {
            name: "升级 openclaw lark 适配器".to_string(),
            executor: TaskExecutor::Agent,
            description: None,
            workspace_id: "ws-myagents".to_string(),
            workspace_path: ws.to_string_lossy().into_owned(),
            task_md_content: "跑通 v2.4".to_string(),
            execution_mode: TaskExecutionMode::Once,
            run_mode: None,
            end_conditions: None,
            interval_minutes: None,
            cron_expression: None,
            cron_timezone: None,
            start_at: None,
            recurring_window: None,
            dispatch_at: None,
            trigger: None,
            model: None,
            provider_id: None,
            permission_mode: None,
            preselected_session_id: None,
            runtime: None,
            runtime_config: None,
            mcp_enabled_servers: None,
            managed_kind: None,
            source_record_id: Some("record-1".to_string()),
            tags: vec!["MyAgents".to_string()],
            notification: None,
        }
    }

    fn successful_settlement() -> TaskExecutionSettlement {
        TaskExecutionSettlement {
            success: true,
            duration_ms: 12,
            session_id: Some("test-session".to_string()),
            error: None,
        }
    }

    fn status_input(
        id: &str,
        to: TaskStatus,
        actor: TransitionActor,
        source: Option<TransitionSource>,
    ) -> TaskUpdateStatusInput {
        TaskUpdateStatusInput {
            id: id.to_string(),
            status: to,
            message: None,
            actor,
            source,
        }
    }

    fn empty_update_input(id: &str) -> TaskUpdateInput {
        TaskUpdateInput {
            id: id.to_string(),
            name: None,
            executor: None,
            description: None,
            workspace_id: None,
            workspace_path: None,
            execution_mode: None,
            run_mode: None,
            end_conditions: None,
            interval_minutes: None,
            cron_expression: None,
            cron_timezone: None,
            start_at: None,
            recurring_window: None,
            dispatch_at: None,
            trigger: None,
            clear_trigger: false,
            model: None,
            provider_id: None,
            clear_provider_override: false,
            permission_mode: None,
            preselected_session_id: None,
            runtime: None,
            runtime_config: None,
            clear_runtime_override: false,
            mcp_enabled_servers: None,
            clear_mcp_override: false,
            tags: None,
            notification: None,
            notification_patch: None,
            prompt: None,
        }
    }

    async fn assert_waits_for_session_lifecycle<T, F>(session_id: &str, operation: F) -> T
    where
        T: Send + 'static,
        F: Future<Output = Result<T, String>> + Send + 'static,
    {
        let guard = crate::sidecar::acquire_session_lifecycle(&[session_id]).await;
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let mut task = tauri::async_runtime::spawn(async move {
            let _ = started_tx.send(());
            operation.await
        });
        started_rx.await.expect("mutation task should start");
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut task)
                .await
                .is_err(),
            "mutation must wait while deletion owns the Session lifecycle"
        );
        drop(guard);
        tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .expect("mutation should resume after lifecycle release")
            .expect("mutation task should not panic")
            .expect("mutation should succeed")
    }

    async fn assert_waits_for_task_control<T, F>(task_id: &str, operation: F) -> T
    where
        T: Send + 'static,
        F: Future<Output = Result<T, String>> + Send + 'static,
    {
        let guard = crate::task_scheduler::acquire_task_control(task_id).await;
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let mut task = tauri::async_runtime::spawn(async move {
            let _ = started_tx.send(());
            operation.await
        });
        started_rx.await.expect("Task mutation should start");
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut task)
                .await
                .is_err(),
            "Task mutation must wait for the same Task control lifecycle"
        );
        drop(guard);
        tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .expect("Task mutation should resume after control release")
            .expect("Task mutation should not panic")
            .expect("Task mutation should succeed")
    }

    #[tokio::test]
    async fn ordinary_create_rejects_managed_kind() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let mut input = sample_direct_input(&ws);
        input.managed_kind = Some(MANAGED_KIND_MEMORY_GARDENER.to_string());

        let err = store
            .create_direct(input)
            .await
            .expect_err("ordinary create must not mint hidden managed tasks");
        assert_eq!(err, MANAGED_TASK_ERROR);
        assert!(store.list(TaskListFilter::default()).await.is_empty());
    }

    #[tokio::test]
    async fn system_managed_create_is_hidden_from_default_list() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let mut input = sample_direct_input(&ws);
        input.managed_kind = Some(MANAGED_KIND_MEMORY_GARDENER.to_string());

        let created = store.create_system_managed_direct(input).await.unwrap();
        assert!(is_managed_task(&created));
        assert!(store.list(TaskListFilter::default()).await.is_empty());

        let visible_to_system = store
            .list(TaskListFilter {
                include_managed: Some(true),
                ..Default::default()
            })
            .await;
        assert_eq!(visible_to_system.len(), 1);
        assert_eq!(visible_to_system[0].id, created.id);

        let mut reconcile = empty_update_input(&created.id);
        reconcile.prompt = Some("updated managed memory instructions".to_string());
        store
            .update(reconcile)
            .await
            .expect("the dedicated managed-task owner must be able to reconcile task.md");
        assert_eq!(
            std::fs::read_to_string(task_docs_dir(&created.id).unwrap().join("task.md")).unwrap(),
            "updated managed memory instructions"
        );

        std::fs::write(
            task_docs_dir(&created.id).unwrap().join("verify.md"),
            "legacy ordinary verification",
        )
        .unwrap();
        store
            .ensure_legacy_verify_merged(&created.id)
            .await
            .expect("ordinary legacy migration must be a no-op for managed jobs");
        assert_eq!(
            compose_dispatch_prompt(&store.get(&created.id).await.unwrap()).unwrap(),
            "执行任务：updated managed memory instructions"
        );
    }

    #[tokio::test]
    async fn system_managed_tasks_reject_the_local_comment_surface() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let mut input = sample_direct_input(&ws);
        input.managed_kind = Some(MANAGED_KIND_MEMORY_GARDENER.to_string());
        let managed = store.create_system_managed_direct(input).await.unwrap();

        assert_eq!(
            store
                .create_user_comment(&managed.id, "should stay internal", None)
                .await
                .unwrap_err(),
            MANAGED_TASK_ERROR
        );
        assert_eq!(
            store
                .list_comments(&managed.id, None, 50)
                .await
                .unwrap_err(),
            MANAGED_TASK_ERROR
        );
    }

    #[tokio::test]
    async fn startup_notification_index_ignores_historical_managed_comments() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let data = dir.path().join("data");
        let store = TaskStore::new(data.clone());
        let mut input = sample_direct_input(&ws);
        input.managed_kind = Some(MANAGED_KIND_MEMORY_GARDENER.to_string());
        let managed = store.create_system_managed_direct(input).await.unwrap();
        let comments_path = data.join("tasks").join(&managed.id).join("comments.jsonl");
        std::fs::create_dir_all(comments_path.parent().unwrap()).unwrap();
        let historical = TaskComment {
            id: "historical-managed-comment".to_string(),
            task_id: managed.id.clone(),
            body: "Internal maintenance result".to_string(),
            author: TaskCommentAuthor::Agent {
                label: None,
                session_id: "managed-session".to_string(),
            },
            created_at: now_ms(),
            reply_to_comment_id: None,
            conversation_session_id: Some("managed-session".to_string()),
            admission: None,
        };
        TaskStore::persist_comments_file(&comments_path, &[historical]).unwrap();
        drop(store);

        let recovered = TaskStore::new(data);
        for _ in 0..100 {
            if recovered.agent_comment_notification_source().ready {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let source = recovered.agent_comment_notification_source();
        assert!(source.ready);
        assert!(source.items.is_empty());
    }

    #[test]
    fn transition_table_allows_lenient_verifying_to_running() {
        use TaskStatus::*;
        assert!(is_transition_legal(Verifying, Running));
        assert!(is_transition_legal(Running, Verifying));
        assert!(is_transition_legal(Verifying, Done));
        assert!(is_transition_legal(Running, Done));
        assert!(is_transition_legal(Done, Archived));
        assert!(is_transition_legal(Archived, Todo));
        assert!(is_transition_legal(Archived, Done));
    }

    #[test]
    fn transition_table_rejects_bad_paths() {
        use TaskStatus::*;
        assert!(!is_transition_legal(Todo, Done)); // no skipping run
        assert!(!is_transition_legal(Todo, Archived)); // archive only from done
        assert!(!is_transition_legal(Blocked, Archived)); // must reset first
        assert!(!is_transition_legal(Stopped, Archived));
        assert!(!is_transition_legal(Running, Archived));
    }

    #[test]
    fn stop_request_preserves_existing_terminal_reason() {
        use TaskStatus::*;
        for status in [Blocked, Stopped, Done, Archived] {
            assert!(is_terminal_execution_stop_request(status, Stopped));
        }
        assert!(!is_terminal_execution_stop_request(Running, Stopped));
        assert!(!is_terminal_execution_stop_request(Done, Todo));
    }

    #[tokio::test]
    async fn create_direct_writes_task_md_and_history() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store_dir = dir.path().join("data");
        std::fs::create_dir_all(&store_dir).unwrap();
        let store = TaskStore::new(store_dir);

        let input = sample_direct_input(&ws);
        let created = store.create_direct(input).await.unwrap();
        assert_eq!(created.status, TaskStatus::Todo);
        assert_eq!(created.status_history.len(), 1);
        assert_eq!(created.status_history[0].to, TaskStatus::Todo);
        assert_eq!(created.status_history[0].actor, TransitionActor::User);
        assert_eq!(created.dispatch_origin, TaskDispatchOrigin::Direct);

        // task.md materialized at the user-scoped location (no longer under
        // `<workspace>/.task/`).
        let md = task_docs_dir(&created.id).unwrap().join("task.md");
        assert!(md.exists());
        let body = std::fs::read_to_string(&md).unwrap();
        assert_eq!(body, "跑通 v2.4");
    }

    #[tokio::test]
    async fn single_session_create_requires_a_materialized_binding() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));

        for preselected_session_id in [None, Some("   "), Some("pending-tab-1")] {
            let mut input = sample_direct_input(&ws);
            input.run_mode = Some(TaskRunMode::SingleSession);
            input.preselected_session_id = preselected_session_id.map(str::to_string);
            let error = store
                .create_direct(input)
                .await
                .expect_err("pending or empty single-session binding must not commit a Task");
            assert_eq!(
                error,
                "single-session Task creation requires a materialized preselectedSessionId"
            );
        }

        assert!(store.list(TaskListFilter::default()).await.is_empty());
    }

    #[tokio::test]
    async fn single_session_create_rejects_a_missing_session() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let missing = format!("missing-session-{}", uuid::Uuid::new_v4());
        let mut input = sample_direct_input(&ws);
        input.run_mode = Some(TaskRunMode::SingleSession);
        input.preselected_session_id = Some(missing.clone());

        let error = store
            .create_direct_internal(
                input,
                TransitionActor::User,
                Some(TransitionSource::Ui),
                "created (direct)",
                |_| false,
            )
            .await
            .unwrap_err();
        assert_eq!(
            error,
            format!(
                "preselectedSessionId does not reference an existing Session: {}",
                missing
            )
        );
        assert!(store.list(TaskListFilter::default()).await.is_empty());
    }

    #[tokio::test]
    async fn unchanged_legacy_single_session_binding_remains_editable() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let mut input = sample_direct_input(&ws);
        input.run_mode = Some(TaskRunMode::SingleSession);
        input.preselected_session_id = Some("legacy-missing-session".to_string());
        let created = store
            .create_migrated_with_id(
                format!("legacy-edit-{}", uuid::Uuid::new_v4()),
                input,
                TaskStatus::Stopped,
                "migrated".to_string(),
            )
            .await
            .unwrap();
        let mut update = empty_update_input(&created.id);
        update.name = Some("edited legacy task".to_string());
        update.run_mode = Some(TaskRunMode::SingleSession);
        update.preselected_session_id = Some("legacy-missing-session".to_string());

        let updated = store.update(update).await.unwrap();
        assert_eq!(updated.name, "edited legacy task");
        assert_eq!(
            updated.preselected_session_id.as_deref(),
            Some("legacy-missing-session")
        );
    }

    #[tokio::test]
    async fn explicit_single_session_rebind_rejects_a_missing_session() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        let missing = format!("missing-session-{}", uuid::Uuid::new_v4());
        let mut update = empty_update_input(&created.id);
        update.run_mode = Some(TaskRunMode::SingleSession);
        update.preselected_session_id = Some(missing.clone());
        let task_control = crate::task_scheduler::acquire_task_control(&created.id).await;

        let error = store
            .update_with_task_control_and_session_probe(update, &task_control, |_, _| false)
            .await
            .unwrap_err();
        assert_eq!(
            error,
            format!(
                "preselectedSessionId does not reference an existing Session: {}",
                missing
            )
        );
        let unchanged = store.get(&created.id).await.unwrap();
        assert_eq!(unchanged.run_mode, None);
        assert!(unchanged.preselected_session_id.is_none());
    }

    #[tokio::test]
    async fn multiple_single_session_tasks_can_share_one_materialized_binding() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));

        for _ in 0..2 {
            let mut input = sample_direct_input(&ws);
            input.run_mode = Some(TaskRunMode::SingleSession);
            input.preselected_session_id = Some("session-real".to_string());
            let created = create_direct_with_existing_session(&store, input)
                .await
                .unwrap();
            assert_eq!(
                created.preselected_session_id.as_deref(),
                Some("session-real")
            );
        }

        assert_eq!(store.list(TaskListFilter::default()).await.len(), 2);
    }

    #[tokio::test]
    async fn corrupt_store_is_all_or_nothing_and_read_only() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let data = dir.path().join("data");
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&ws).unwrap();
        let path = data.join("tasks.jsonl");
        std::fs::write(&path, b"{not-json}\n").unwrap();

        let store = TaskStore::new(data);

        assert!(store.list(TaskListFilter::default()).await.is_empty());
        let error = store
            .create_direct(sample_direct_input(&ws))
            .await
            .expect_err("corrupt stores must reject mutation");
        assert!(error.contains("read-only"), "got: {error}");
        assert_eq!(std::fs::read(&path).unwrap(), b"{not-json}\n");
    }

    #[tokio::test]
    async fn legacy_import_never_regresses_newer_task_progress() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let task = store
            .create_migrated_with_id(
                "legacy-progress".to_string(),
                sample_direct_input(&ws),
                TaskStatus::Stopped,
                "migrated".to_string(),
            )
            .await
            .unwrap();
        let imported = store
            .import_legacy_execution_state(&task.id, 5, Some(100), Some("legacy-session"))
            .await
            .unwrap();
        assert_eq!(imported.execution_count, 5);

        let current = store
            .settle_execution_if_status(
                &task.id,
                None,
                TaskExecutionTrigger::Scheduled,
                TaskStatus::Stopped,
                successful_settlement(),
                None,
            )
            .await
            .unwrap()
            .unwrap();
        let after_restart = store
            .import_legacy_execution_state(&task.id, 2, Some(50), Some("legacy-session"))
            .await
            .unwrap();

        assert_eq!(after_restart.execution_count, current.execution_count);
        assert_eq!(after_restart.last_executed_at, current.last_executed_at);
    }

    #[tokio::test]
    async fn running_legacy_create_waits_for_bound_session_lifecycle() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = Arc::new(TaskStore::new(dir.path().join("data")));
        let mut input = sample_direct_input(&ws);
        input.run_mode = Some(TaskRunMode::SingleSession);
        input.preselected_session_id = Some("legacy-create-session".to_string());
        let store_for_create = Arc::clone(&store);
        let id = format!("legacy-create-{}", uuid::Uuid::new_v4());

        let created = assert_waits_for_session_lifecycle("legacy-create-session", async move {
            store_for_create
                .create_migrated_with_id(id, input, TaskStatus::Running, "migrated".to_string())
                .await
        })
        .await;
        assert_eq!(created.status, TaskStatus::Running);
    }

    #[tokio::test]
    async fn legacy_session_import_waits_before_extending_protected_binding() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = Arc::new(TaskStore::new(dir.path().join("data")));
        let mut input = sample_direct_input(&ws);
        input.run_mode = Some(TaskRunMode::SingleSession);
        input.preselected_session_id = Some("legacy-primary-session".to_string());
        let task = store
            .create_migrated_with_id(
                format!("legacy-import-{}", uuid::Uuid::new_v4()),
                input,
                TaskStatus::Running,
                "migrated".to_string(),
            )
            .await
            .unwrap();
        let store_for_import = Arc::clone(&store);
        let task_id = task.id.clone();

        let imported = assert_waits_for_session_lifecycle("legacy-import-session", async move {
            store_for_import
                .import_legacy_execution_state(
                    &task_id,
                    1,
                    Some(100),
                    Some("legacy-import-session"),
                )
                .await
        })
        .await;
        assert!(imported
            .session_ids
            .iter()
            .any(|session_id| session_id == "legacy-import-session"));
    }

    #[tokio::test]
    async fn manual_execution_does_not_move_the_scheduler_anchor() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let task = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        let scheduled = store
            .settle_execution_if_status(
                &task.id,
                None,
                TaskExecutionTrigger::Scheduled,
                task.status,
                successful_settlement(),
                None,
            )
            .await
            .unwrap()
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        let manual = store
            .settle_execution_if_status(
                &task.id,
                None,
                TaskExecutionTrigger::Manual,
                task.status,
                successful_settlement(),
                None,
            )
            .await
            .unwrap()
            .unwrap();

        assert_eq!(manual.last_scheduled_at, scheduled.last_scheduled_at);
        assert!(manual.last_executed_at >= scheduled.last_executed_at);
    }

    #[tokio::test]
    async fn scheduled_success_resets_consecutive_failures_and_updates_authoritative_summary() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let task = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        let mut current = task;
        for attempt in 1..=4 {
            current = store
                .settle_execution_if_status(
                    &current.id,
                    None,
                    TaskExecutionTrigger::Scheduled,
                    current.status,
                    TaskExecutionSettlement {
                        success: false,
                        duration_ms: attempt,
                        session_id: Some(format!("failed-{attempt}")),
                        error: Some("temporary failure".to_string()),
                    },
                    None,
                )
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(current.consecutive_execution_failures, 4);
        assert_eq!(current.execution_count, 4);
        assert_eq!(current.last_execution.as_ref().unwrap().duration_ms, 4);
        assert!(!current.last_execution.as_ref().unwrap().success);

        let recovered = store
            .settle_execution_if_status(
                &current.id,
                None,
                TaskExecutionTrigger::Scheduled,
                current.status,
                successful_settlement(),
                None,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovered.consecutive_execution_failures, 0);
        assert_eq!(recovered.execution_count, 5);
        assert!(recovered.last_execution.as_ref().unwrap().success);
        assert_eq!(
            recovered
                .last_execution
                .as_ref()
                .unwrap()
                .session_id
                .as_deref(),
            Some("test-session")
        );
    }

    #[tokio::test]
    async fn activation_receipt_closes_outbox_accounting_crash_window() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(data_dir.clone());
        let mut input = sample_direct_input(&ws);
        input.trigger = Some(crate::task_trigger::TaskTrigger {
            source: crate::task_trigger::TaskTriggerSource::Time,
            detector: crate::task_trigger::TaskTriggerDetector::Command {
                command: crate::task_trigger::TaskTriggerCommand {
                    executable: "node".to_string(),
                    args: vec!["detector.mjs".to_string()],
                    cwd: None,
                },
                timeout_ms: Some(30_000),
            },
        });
        let task = store.create_direct(input).await.unwrap();
        let (task, _) = store
            .update_status(status_input(
                &task.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Scheduler),
            ))
            .await
            .unwrap();
        let detector_result = crate::task_trigger::DetectorRunSuccess {
            invocation_id: "invocation-319".to_string(),
            decision: crate::task_trigger::DetectorDecision::Activate,
            reason: crate::task_trigger::TaskTriggerReason {
                code: "build_failed".to_string(),
                message: "Build failed".to_string(),
            },
            event: Some(crate::task_trigger::TaskActivationEvent {
                id: "build-319".to_string(),
                kind: "ci.failed".to_string(),
                occurred_at: "2026-08-03T09:30:00+08:00".to_string(),
            }),
            handoff: Some(crate::task_trigger::TaskActivationHandoff {
                summary: "Build 319 failed".to_string(),
                text: None,
                data: None,
            }),
            next_checkpoint: None,
            duration_ms: 10,
            exit_code: 0,
            stderr_tail: None,
        };
        store
            .commit_detector_success(
                &task,
                &detector_result,
                crate::task_trigger::DetectorInvocationCause::Scheduled,
            )
            .await
            .unwrap();

        let committed = store
            .settle_execution_if_status(
                &task.id,
                Some("build-319"),
                TaskExecutionTrigger::Scheduled,
                TaskStatus::Running,
                successful_settlement(),
                Some(TaskExecutionTerminalTransition {
                    status: TaskStatus::Done,
                    message: "Task execution completed".to_string(),
                    source: TransitionSource::EndCondition,
                }),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(committed.execution_count, 1);
        assert_eq!(committed.status, TaskStatus::Done);
        assert_eq!(
            committed.last_activation_event_id.as_deref(),
            Some("build-319")
        );
        assert!(store
            .read_trigger_state(&task.id)
            .await
            .unwrap()
            .pending_activation
            .is_some());

        // Simulate a crash after the Task row commit but before clearing the
        // Trigger outbox. The receipt survives reload and makes re-accounting
        // idempotent; startup can now settle only the matching pending event.
        let recovered = TaskStore::new(data_dir);
        let replay = recovered
            .settle_execution_if_status(
                &task.id,
                Some("build-319"),
                TaskExecutionTrigger::Scheduled,
                TaskStatus::Running,
                successful_settlement(),
                None,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(replay.execution_count, 1);
        assert_eq!(replay.status, TaskStatus::Done);
        recovered
            .settle_pending_activation(&task.id, "build-319")
            .await
            .unwrap();
        assert!(recovered
            .read_trigger_state(&task.id)
            .await
            .unwrap()
            .pending_activation
            .is_none());
    }

    #[tokio::test]
    async fn command_task_cannot_be_edited_while_activation_is_pending() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let mut input = sample_direct_input(&ws);
        input.trigger = Some(crate::task_trigger::TaskTrigger {
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
        let task = store.create_direct(input).await.unwrap();
        let success = crate::task_trigger::DetectorRunSuccess {
            invocation_id: "invocation-pending".to_string(),
            decision: crate::task_trigger::DetectorDecision::Activate,
            reason: crate::task_trigger::TaskTriggerReason {
                code: "changed".to_string(),
                message: "Changed".to_string(),
            },
            event: Some(crate::task_trigger::TaskActivationEvent {
                id: "event-pending".to_string(),
                kind: "state.changed".to_string(),
                occurred_at: "2026-08-03T09:30:00Z".to_string(),
            }),
            handoff: Some(crate::task_trigger::TaskActivationHandoff {
                summary: "State changed".to_string(),
                text: None,
                data: None,
            }),
            next_checkpoint: None,
            duration_ms: 1,
            exit_code: 0,
            stderr_tail: None,
        };
        store
            .commit_detector_success(
                &task,
                &success,
                crate::task_trigger::DetectorInvocationCause::Scheduled,
            )
            .await
            .unwrap();
        let mut update = empty_update_input(&task.id);
        update.name = Some("must not change".to_string());

        let error = store.update(update).await.unwrap_err();

        assert!(error.contains("Activation Event is pending"));
        assert_eq!(store.get(&task.id).await.unwrap().name, task.name);
    }

    #[tokio::test]
    async fn stale_execution_cannot_commit_after_status_changes() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let task = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store
            .update_status(status_input(
                &task.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Scheduler),
            ))
            .await
            .unwrap();

        let committed = store
            .settle_execution_if_status(
                &task.id,
                None,
                TaskExecutionTrigger::Scheduled,
                TaskStatus::Todo,
                successful_settlement(),
                None,
            )
            .await
            .unwrap();

        assert!(committed.is_none());
        assert_eq!(store.get(&task.id).await.unwrap().execution_count, 0);
    }

    #[tokio::test]
    async fn migration_rejects_an_unrelated_task_id_collision() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let ordinary = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        let error = store
            .create_migrated_with_id(
                ordinary.id,
                sample_direct_input(&ws),
                TaskStatus::Stopped,
                "migrated".to_string(),
            )
            .await
            .expect_err("migration must not adopt an unrelated Task");

        assert!(error.contains("collides"), "got: {error}");
    }

    #[tokio::test]
    async fn create_attached_binds_current_session_without_cron() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));

        let created = store
            .create_attached_with_session_probe(
                TaskCreateAttachedInput {
                    name: "Space Issue #123".to_string(),
                    executor: TaskExecutor::Agent,
                    description: Some("MyAgents Space Issue iss_123".to_string()),
                    workspace_id: "ws-myagents".to_string(),
                    workspace_path: ws.to_string_lossy().into_owned(),
                    task_md_content: "处理 Space Issue".to_string(),
                    current_session_id: "session-123".to_string(),
                    source: TaskCreateAttachedSource::SpaceIssue,
                    source_space_id: Some("official".to_string()),
                    source_issue_id: "iss_123".to_string(),
                    source_claim_id: Some("claim_123".to_string()),
                    source_delivery_id: Some("delivery_123".to_string()),
                    tags: vec![],
                    notification: None,
                },
                |_| true,
            )
            .await
            .unwrap();

        assert_eq!(created.status, TaskStatus::Running);
        assert_eq!(created.dispatch_origin, TaskDispatchOrigin::AttachedSession);
        assert_eq!(created.session_ids, vec!["session-123".to_string()]);
        assert_eq!(created.status_history.len(), 2);
        assert_eq!(created.status_history[0].from, None);
        assert_eq!(created.status_history[0].to, TaskStatus::Todo);
        assert_eq!(created.status_history[1].from, Some(TaskStatus::Todo));
        assert_eq!(created.status_history[1].to, TaskStatus::Running);
        assert_eq!(
            created
                .external_source
                .as_ref()
                .map(|s| s.issue_id.as_str()),
            Some("iss_123")
        );

        let md = task_docs_dir(&created.id).unwrap().join("task.md");
        assert_eq!(std::fs::read_to_string(&md).unwrap(), "处理 Space Issue");
        let dispatch_err = compose_dispatch_prompt(&created).unwrap_err();
        assert!(dispatch_err.contains("attached-session"));
    }

    #[tokio::test]
    async fn legacy_verify_is_merged_once_and_preserved() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        let docs = task_docs_dir(&created.id).unwrap();
        std::fs::write(docs.join("verify.md"), "- run focused tests\n").unwrap();

        store
            .ensure_legacy_verify_merged(&created.id)
            .await
            .unwrap();
        store
            .ensure_legacy_verify_merged(&created.id)
            .await
            .unwrap();

        let task_md = std::fs::read_to_string(docs.join("task.md")).unwrap();
        assert_eq!(task_md.matches("# verify.md").count(), 1);
        assert!(task_md.ends_with("# verify.md\n\n- run focused tests"));
        assert_eq!(
            std::fs::read_to_string(docs.join("verify.md")).unwrap(),
            "- run focused tests\n"
        );
    }

    #[tokio::test]
    async fn legacy_ai_aligned_origin_dispatches_complete_task_markdown() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let mut created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        created.dispatch_origin = TaskDispatchOrigin::AiAligned;

        let prompt = compose_dispatch_prompt(&created).unwrap();
        assert!(prompt.starts_with("执行任务："));
        assert!(!prompt.contains("/task-implement"));
    }

    #[tokio::test]
    async fn create_attached_rejects_a_session_deleted_before_binding() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));

        let error = store
            .create_attached_with_session_probe(
                TaskCreateAttachedInput {
                    name: "Space Issue #deleted".to_string(),
                    executor: TaskExecutor::Agent,
                    description: None,
                    workspace_id: "ws-myagents".to_string(),
                    workspace_path: ws.to_string_lossy().into_owned(),
                    task_md_content: "处理 Space Issue".to_string(),
                    current_session_id: "deleted-attached-session".to_string(),
                    source: TaskCreateAttachedSource::SpaceIssue,
                    source_space_id: Some("official".to_string()),
                    source_issue_id: "iss_deleted".to_string(),
                    source_claim_id: Some("claim_deleted".to_string()),
                    source_delivery_id: None,
                    tags: vec![],
                    notification: None,
                },
                |_| false,
            )
            .await
            .expect_err("deletion that wins the lifecycle must prevent attachment");
        assert!(error.contains("no longer exists"), "got: {error}");
        assert!(store.list(TaskListFilter::default()).await.is_empty());
    }

    #[tokio::test]
    async fn running_transition_waits_for_bound_session_lifecycle() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = Arc::new(TaskStore::new(dir.path().join("data")));
        let mut input = sample_direct_input(&ws);
        input.run_mode = Some(TaskRunMode::SingleSession);
        input.preselected_session_id = Some("session-locked".to_string());
        let created = create_direct_with_existing_session(&store, input)
            .await
            .unwrap();
        let store_for_transition = Arc::clone(&store);
        let task_id = created.id.clone();
        let (updated, _) = assert_waits_for_session_lifecycle("session-locked", async move {
            store_for_transition
                .update_status(status_input(
                    &task_id,
                    TaskStatus::Running,
                    TransitionActor::System,
                    Some(TransitionSource::Scheduler),
                ))
                .await
        })
        .await;
        assert_eq!(updated.status, TaskStatus::Running);
    }

    #[tokio::test]
    async fn terminal_transition_and_runtime_stop_share_task_control() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = Arc::new(TaskStore::new(dir.path().join("data")));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Scheduler),
            ))
            .await
            .unwrap();
        let store_for_stop = Arc::clone(&store);
        let task_id = created.id.clone();
        let task_id_for_operation = task_id.clone();

        let (stopped, _) = assert_waits_for_task_control(&task_id, async move {
            store_for_stop
                .update_status(status_input(
                    &task_id_for_operation,
                    TaskStatus::Stopped,
                    TransitionActor::User,
                    Some(TransitionSource::Ui),
                ))
                .await
        })
        .await;
        assert_eq!(stopped.status, TaskStatus::Stopped);
    }

    #[tokio::test]
    async fn attached_terminal_task_cannot_be_rerun() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = Arc::new(TaskStore::new(dir.path().join("data")));
        let created = store
            .create_attached_with_session_probe(
                TaskCreateAttachedInput {
                    name: "Space Issue #lifecycle".to_string(),
                    executor: TaskExecutor::Agent,
                    description: None,
                    workspace_id: "ws-myagents".to_string(),
                    workspace_path: ws.to_string_lossy().into_owned(),
                    task_md_content: "处理 Space Issue".to_string(),
                    current_session_id: "attached-session-locked".to_string(),
                    source: TaskCreateAttachedSource::SpaceIssue,
                    source_space_id: Some("official".to_string()),
                    source_issue_id: "iss_lifecycle".to_string(),
                    source_claim_id: Some("claim_lifecycle".to_string()),
                    source_delivery_id: None,
                    tags: vec![],
                    notification: None,
                },
                |_| true,
            )
            .await
            .unwrap();
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Done,
                TransitionActor::System,
                Some(TransitionSource::EndCondition),
            ))
            .await
            .unwrap();

        let error = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Todo,
                TransitionActor::System,
                Some(TransitionSource::Rerun),
            ))
            .await
            .expect_err("Attached Space work must be reclaimed into a new Task");
        assert!(error.contains("cannot be rerun"), "got: {error}");
        assert_eq!(
            store.get(&created.id).await.unwrap().status,
            TaskStatus::Done
        );
    }

    #[tokio::test]
    async fn public_append_waits_before_adding_a_protected_session_binding() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = Arc::new(TaskStore::new(dir.path().join("data")));
        let mut input = sample_direct_input(&ws);
        input.run_mode = Some(TaskRunMode::SingleSession);
        input.preselected_session_id = Some("primary-session".to_string());
        let created = create_direct_with_existing_session(&store, input)
            .await
            .unwrap();
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Scheduler),
            ))
            .await
            .unwrap();

        let store_for_append = Arc::clone(&store);
        let task_id = created.id.clone();
        let updated = assert_waits_for_session_lifecycle("appended-session", async move {
            store_for_append
                .append_session(&task_id, "appended-session")
                .await
        })
        .await;
        assert!(updated
            .session_ids
            .iter()
            .any(|id| id == "appended-session"));
    }

    #[tokio::test]
    async fn attached_field_update_waits_before_adding_a_protected_binding() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = Arc::new(TaskStore::new(dir.path().join("data")));
        let created = store
            .create_attached_with_session_probe(
                TaskCreateAttachedInput {
                    name: "Space Issue #field-update".to_string(),
                    executor: TaskExecutor::Agent,
                    description: None,
                    workspace_id: "ws-myagents".to_string(),
                    workspace_path: ws.to_string_lossy().into_owned(),
                    task_md_content: "处理 Space Issue".to_string(),
                    current_session_id: "attached-primary".to_string(),
                    source: TaskCreateAttachedSource::SpaceIssue,
                    source_space_id: Some("official".to_string()),
                    source_issue_id: "iss_field_update".to_string(),
                    source_claim_id: Some("claim_field_update".to_string()),
                    source_delivery_id: None,
                    tags: vec![],
                    notification: None,
                },
                |_| true,
            )
            .await
            .unwrap();
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Stopped,
                TransitionActor::User,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();

        let store_for_update = Arc::clone(&store);
        let task_id = created.id.clone();
        let mut update = empty_update_input(&task_id);
        update.run_mode = Some(TaskRunMode::SingleSession);
        update.preselected_session_id = Some("attached-secondary".to_string());
        let updated = assert_waits_for_session_lifecycle("attached-secondary", async move {
            let task_control = crate::task_scheduler::acquire_task_control(&task_id).await;
            store_for_update
                .update_with_task_control_and_session_probe(update, &task_control, |_, _| true)
                .await
        })
        .await;
        assert_eq!(
            updated.preselected_session_id.as_deref(),
            Some("attached-secondary")
        );
    }

    #[tokio::test]
    async fn restore_archived_done_preserves_completion_without_rerunning() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store_dir = dir.path().join("data");
        let store = TaskStore::new(store_dir.clone());
        let task = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        for status in [TaskStatus::Running, TaskStatus::Done] {
            store.update_status(status_input(&task.id, status, TransitionActor::User, Some(TransitionSource::Ui))).await.unwrap();
        }
        let done = store.get(&task.id).await.unwrap();
        store.archive(&task.id, None).await.unwrap();
        let rejected = store.update_status(status_input(&task.id, TaskStatus::Done, TransitionActor::Agent, Some(TransitionSource::Cli))).await.unwrap_err();
        assert!(rejected.contains("archive_user_only"));
        let (restored, transition) = store.update_status(status_input(&task.id, TaskStatus::Done, TransitionActor::User, Some(TransitionSource::Ui))).await.unwrap();
        assert_eq!(transition.from, Some(TaskStatus::Archived));
        assert_eq!(restored.status, TaskStatus::Done);
        assert_eq!(restored.execution_count, done.execution_count);
        assert_eq!(restored.last_executed_at, done.last_executed_at);
        assert_eq!(TaskStore::new(store_dir).get(&task.id).await.unwrap().status, TaskStatus::Done);
    }

    #[tokio::test]
    async fn update_status_appends_history_and_persists() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store_dir = dir.path().join("data");
        let store = TaskStore::new(store_dir.clone());

        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        // todo → running (system)
        let (t, tr) = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();
        assert_eq!(t.status, TaskStatus::Running);
        assert_eq!(tr.from, Some(TaskStatus::Todo));
        assert_eq!(t.status_history.len(), 2);
        assert!(t.last_executed_at.is_none());

        // running → verifying (agent/cli)
        let (t, _) = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Verifying,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .unwrap();
        assert_eq!(t.status, TaskStatus::Verifying);

        // lenient: verifying → running (v1.4)
        let (t, _) = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .unwrap();
        assert_eq!(t.status, TaskStatus::Running);

        // verify persistence across reopen
        drop(store);
        let store2 = TaskStore::new(store_dir);
        let reloaded = store2.get(&created.id).await.unwrap();
        // Crash recovery kicks in — running rows are rewritten to blocked at load.
        assert_eq!(reloaded.status, TaskStatus::Blocked);
        // 4 transitions from the runtime session + 1 crash-recovery transition.
        assert_eq!(reloaded.status_history.len(), 5);
        let last = reloaded.status_history.last().unwrap();
        assert_eq!(last.actor, TransitionActor::System);
        assert_eq!(last.source, Some(TransitionSource::Crash));
    }

    #[tokio::test]
    async fn update_status_rejects_invalid_transition() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        let err = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Done,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .expect_err("illegal transition should fail");
        assert!(err.contains("invalid_transition"));
    }

    #[tokio::test]
    async fn update_status_rejects_deleted_as_target() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        let err = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Deleted,
                TransitionActor::User,
                Some(TransitionSource::Ui),
            ))
            .await
            .expect_err("Deleted is delete()-only");
        assert!(err.contains("invalid_transition"));
    }

    #[tokio::test]
    async fn update_status_rejects_agent_without_cli_source() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();

        let err = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Done,
                TransitionActor::Agent,
                Some(TransitionSource::Ui), // <-- wrong
            ))
            .await
            .expect_err("agent must come from cli");
        assert!(err.contains("agent_source_must_be_cli"));
    }

    #[tokio::test]
    async fn archive_rejects_non_user_actor() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        // todo → running → done
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Done,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .unwrap();

        // agent cannot archive
        let err = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Archived,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .expect_err("agent cannot archive");
        assert!(err.contains("archive_user_only"));

        // user can
        let archived = store.archive(&created.id, None).await.unwrap();
        assert_eq!(archived.status, TaskStatus::Archived);
    }

    #[tokio::test]
    async fn update_rejects_while_running() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();

        let err = store
            .update(TaskUpdateInput {
                id: created.id.clone(),
                name: Some("new".to_string()),
                executor: None,
                description: None,
                workspace_id: None,
                workspace_path: None,
                execution_mode: None,
                run_mode: None,
                end_conditions: None,
                interval_minutes: None,
                cron_expression: None,
                cron_timezone: None,
                start_at: None,
                recurring_window: None,
                dispatch_at: None,
                trigger: None,
                clear_trigger: false,
                model: None,
                provider_id: None,
                clear_provider_override: false,
                permission_mode: None,
                preselected_session_id: None,
                runtime: None,
                runtime_config: None,
                clear_runtime_override: false,
                mcp_enabled_servers: None,
                clear_mcp_override: false,
                tags: None,
                notification: None,
                notification_patch: None,
                prompt: None,
            })
            .await
            .expect_err("should reject");
        assert!(err.contains("update_rejected_running"));
    }

    #[tokio::test]
    async fn update_workspace_requires_and_persists_an_atomic_identity_pair() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let original_ws = dir.path().join("workspace-original");
        let next_ws = dir.path().join("workspace-next");
        std::fs::create_dir_all(&original_ws).unwrap();
        std::fs::create_dir_all(&next_ws).unwrap();
        let data_dir = dir.path().join("data");
        let store = TaskStore::new(data_dir.clone());
        let created = store
            .create_direct(sample_direct_input(&original_ws))
            .await
            .unwrap();

        let mut id_only = empty_update_input(&created.id);
        id_only.workspace_id = Some("ws-next".to_string());
        let error = store
            .update(id_only)
            .await
            .expect_err("pair must be atomic");
        assert!(error.contains("must be updated together"));
        assert_eq!(
            store.get(&created.id).await.unwrap().workspace_id,
            "ws-myagents"
        );

        let mut relative_path = empty_update_input(&created.id);
        relative_path.workspace_id = Some("ws-next".to_string());
        relative_path.workspace_path = Some("relative/workspace".to_string());
        let error = store
            .update(relative_path)
            .await
            .expect_err("workspace path must remain absolute");
        assert!(error.contains("workspacePath must be absolute"));

        let mut paired = empty_update_input(&created.id);
        paired.workspace_id = Some(" ws-next ".to_string());
        paired.workspace_path = Some(format!(" {} ", next_ws.display()));
        let updated = store.update(paired).await.unwrap();
        assert_eq!(updated.workspace_id, "ws-next");
        assert_eq!(updated.workspace_path, next_ws.to_string_lossy());

        let reloaded = TaskStore::new(data_dir).get(&created.id).await.unwrap();
        assert_eq!(reloaded.workspace_id, "ws-next");
        assert_eq!(reloaded.workspace_path, next_ws.to_string_lossy());
    }

    #[tokio::test]
    async fn stale_recurring_editor_reapplies_its_mode_instead_of_hidden_state() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let command_trigger = crate::task_trigger::TaskTrigger {
            source: crate::task_trigger::TaskTriggerSource::Time,
            detector: crate::task_trigger::TaskTriggerDetector::Command {
                command: crate::task_trigger::TaskTriggerCommand {
                    executable: "node".to_string(),
                    args: vec!["detector.mjs".to_string()],
                    cwd: None,
                },
                timeout_ms: None,
            },
        };

        for execution_mode in [TaskExecutionMode::Once, TaskExecutionMode::Scheduled] {
            let mut create = sample_direct_input(&ws);
            create.name = format!("stale editor {execution_mode:?}");
            create.execution_mode = TaskExecutionMode::Recurring;
            create.run_mode = Some(TaskRunMode::NewSession);
            create.interval_minutes = Some(30);
            create.trigger = Some(command_trigger.clone());
            let created = store.create_direct(create).await.unwrap();

            let mut first_writer = empty_update_input(&created.id);
            first_writer.execution_mode = Some(execution_mode);
            if execution_mode == TaskExecutionMode::Scheduled {
                first_writer.dispatch_at = Some(now_ms() + 60_000);
            }
            let first = store.update(first_writer).await.unwrap();
            assert_eq!(first.run_mode, Some(TaskRunMode::NewSession));
            assert!(first.preselected_session_id.is_none());
            assert!(first.trigger.is_none());

            // A second full editor still holds the old recurring snapshot. It
            // must submit that structural discriminator alongside its dependent
            // fields, producing a coherent last-writer-wins recurring row rather
            // than hidden recurring state under the first writer's mode.
            let mut stale_writer = empty_update_input(&created.id);
            stale_writer.execution_mode = Some(TaskExecutionMode::Recurring);
            stale_writer.run_mode = Some(TaskRunMode::SingleSession);
            stale_writer.preselected_session_id = Some("stale-session".to_string());
            stale_writer.trigger = Some(command_trigger.clone());
            stale_writer.interval_minutes = Some(30);
            let task_control = crate::task_scheduler::acquire_task_control(&created.id).await;
            let final_task = store
                .update_with_task_control_and_session_probe(stale_writer, &task_control, |_, _| {
                    true
                })
                .await
                .unwrap();

            assert_eq!(final_task.execution_mode, TaskExecutionMode::Recurring);
            assert_eq!(final_task.run_mode, Some(TaskRunMode::SingleSession));
            assert_eq!(
                final_task.preselected_session_id.as_deref(),
                Some("stale-session")
            );
            assert!(final_task.effective_trigger().is_command());
        }
    }

    #[tokio::test]
    async fn notification_patch_preserves_omitted_fields_and_applies_false_and_null() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let mut create = sample_direct_input(&ws);
        create.notification = Some(NotificationConfig {
            desktop: true,
            bot_channel_id: Some("bot-a".to_string()),
            bot_thread: Some("thread-a".to_string()),
            events: Some(vec!["done".to_string()]),
        });
        let created = store.create_direct(create).await.unwrap();

        let mut false_patch = empty_update_input(&created.id);
        false_patch.notification_patch =
            Some(serde_json::from_value(serde_json::json!({ "desktop": false })).unwrap());
        let after_false = store.update(false_patch).await.unwrap();
        let notification = after_false.notification.unwrap();
        assert!(!notification.desktop);
        assert_eq!(notification.bot_channel_id.as_deref(), Some("bot-a"));
        assert_eq!(notification.bot_thread.as_deref(), Some("thread-a"));
        assert_eq!(notification.events, Some(vec!["done".to_string()]));

        let mut clear_patch = empty_update_input(&created.id);
        clear_patch.notification_patch = Some(
            serde_json::from_value(serde_json::json!({
                "desktop": null,
                "botChannelId": null,
                "botThread": null,
                "events": null
            }))
            .unwrap(),
        );
        let after_clear = store.update(clear_patch).await.unwrap();
        assert_eq!(
            after_clear.notification,
            Some(NotificationConfig::default())
        );
    }

    #[tokio::test]
    async fn empty_notification_patch_is_an_exact_noop() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        assert!(created.notification.is_none());

        let mut update = empty_update_input(&created.id);
        update.notification_patch = Some(serde_json::from_value(serde_json::json!({})).unwrap());
        let updated = store.update(update).await.unwrap();

        assert!(updated.notification.is_none());
    }

    #[tokio::test]
    async fn concurrent_notification_patches_preserve_both_writers() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        let mut desktop = empty_update_input(&created.id);
        desktop.notification_patch =
            Some(serde_json::from_value(serde_json::json!({ "desktop": false })).unwrap());
        let mut bot = empty_update_input(&created.id);
        bot.notification_patch =
            Some(serde_json::from_value(serde_json::json!({ "botChannelId": "bot-b" })).unwrap());

        let (desktop_result, bot_result) = tokio::join!(store.update(desktop), store.update(bot));
        desktop_result.unwrap();
        bot_result.unwrap();
        let final_task = store.get(&created.id).await.unwrap();
        let notification = final_task.notification.unwrap();
        assert!(!notification.desktop);
        assert_eq!(notification.bot_channel_id.as_deref(), Some("bot-b"));
    }

    #[tokio::test]
    async fn full_notification_and_patch_are_mutually_exclusive() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        let mut update = empty_update_input(&created.id);
        update.notification = Some(NotificationConfig::default());
        update.notification_patch =
            Some(serde_json::from_value(serde_json::json!({ "desktop": false })).unwrap());

        let error = store.update(update).await.unwrap_err();

        assert!(error.contains("notificationPatch"));
        assert!(store.get(&created.id).await.unwrap().notification.is_none());
    }

    #[tokio::test]
    async fn delete_soft_and_idempotent() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        store.delete(&created.id).await.unwrap();
        // list excludes deleted by default
        assert!(store.list(TaskListFilter::default()).await.is_empty());
        // include_deleted shows it
        let all = store
            .list(TaskListFilter {
                include_deleted: Some(true),
                ..Default::default()
            })
            .await;
        assert_eq!(all.len(), 1);
        assert!(all[0].deleted);
        // Delete writes a proper `→ Deleted` pseudo-transition (not from==to).
        assert_eq!(all[0].status, TaskStatus::Deleted);
        let last = all[0].status_history.last().unwrap();
        assert_eq!(last.to, TaskStatus::Deleted);
        assert_eq!(last.from, Some(TaskStatus::Todo));
        assert_eq!(last.actor, TransitionActor::User);

        // second delete is a no-op
        store.delete(&created.id).await.unwrap();
    }

    #[tokio::test]
    async fn startup_retries_trigger_state_cleanup_for_deleted_rows() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store_dir = dir.path().join("data");
        let store = TaskStore::new(store_dir.clone());
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store.delete(&created.id).await.unwrap();

        // Recreate the file after delete to model a transient cleanup failure
        // that left the durable deleted row as the retry obligation.
        let trigger_state = store.trigger_state_path(&created.id).unwrap();
        std::fs::create_dir_all(trigger_state.parent().unwrap()).unwrap();
        std::fs::write(&trigger_state, "orphaned-state").unwrap();
        drop(store);

        let recovered = TaskStore::new(store_dir);
        assert!(recovered.get(&created.id).await.unwrap().deleted);
        assert!(!trigger_state.exists());
    }

    #[tokio::test]
    async fn startup_retries_trigger_state_cleanup_for_non_command_rows() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store_dir = dir.path().join("data");
        let store = TaskStore::new(store_dir.clone());
        let mut input = sample_direct_input(&ws);
        input.trigger = Some(crate::task_trigger::TaskTrigger {
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
        let created = store.create_direct(input).await.unwrap();
        let mut update = empty_update_input(&created.id);
        update.trigger = Some(crate::task_trigger::TaskTrigger::default());
        let updated = store.update(update).await.unwrap();
        assert!(!updated.effective_trigger().is_command());

        // Recreate the file after the authoritative command-to-always row
        // commit to model a transient physical-cleanup failure. The
        // non-command row remains the durable retry obligation across restart.
        let trigger_state = store.trigger_state_path(&created.id).unwrap();
        std::fs::create_dir_all(trigger_state.parent().unwrap()).unwrap();
        std::fs::write(&trigger_state, "orphaned-state").unwrap();
        drop(store);

        let recovered = TaskStore::new(store_dir);
        assert!(!recovered
            .get(&created.id)
            .await
            .unwrap()
            .effective_trigger()
            .is_command());
        assert!(!trigger_state.exists());
    }

    #[tokio::test]
    async fn failed_command_cleanup_blocks_reenable_until_stale_state_is_gone() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let command_trigger = crate::task_trigger::TaskTrigger {
            source: crate::task_trigger::TaskTriggerSource::Time,
            detector: crate::task_trigger::TaskTriggerDetector::Command {
                command: crate::task_trigger::TaskTriggerCommand {
                    executable: "node".to_string(),
                    args: vec!["detector.mjs".to_string()],
                    cwd: None,
                },
                timeout_ms: None,
            },
        };
        let mut input = sample_direct_input(&ws);
        input.trigger = Some(command_trigger.clone());
        let created = store.create_direct(input).await.unwrap();

        let trigger_state = store.trigger_state_path(&created.id).unwrap();
        std::fs::create_dir_all(trigger_state.parent().unwrap()).unwrap();
        std::fs::write(
            &trigger_state,
            serde_json::to_vec(&crate::task_trigger::TaskTriggerRuntimeState::default()).unwrap(),
        )
        .unwrap();
        let cleanup_failure = crate::task_trigger::force_trigger_cleanup_failure(&created.id);
        let mut disable = empty_update_input(&created.id);
        disable.trigger = Some(crate::task_trigger::TaskTrigger::default());
        let disabled = store.update(disable).await.unwrap();
        assert!(!disabled.effective_trigger().is_command());
        assert!(trigger_state.exists());

        let mut reenable = empty_update_input(&created.id);
        reenable.trigger = Some(command_trigger.clone());
        let error = store.update(reenable).await.unwrap_err();
        assert!(error.contains("remove"), "got: {error}");
        let still_disabled = store.get(&created.id).await.unwrap();
        assert!(!still_disabled.effective_trigger().is_command());
        assert!(trigger_state.exists());

        drop(cleanup_failure);
        let mut retry = empty_update_input(&created.id);
        retry.trigger = Some(command_trigger);
        let reenabled = store.update(retry).await.unwrap();
        assert!(reenabled.effective_trigger().is_command());
        assert!(!trigger_state.exists());
    }

    #[tokio::test]
    async fn stop_reports_pending_activation_cleanup_failure_after_persisting_status() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let data_dir = dir.path().join("data");
        let store = TaskStore::new(data_dir.clone());
        let mut input = sample_direct_input(&ws);
        input.trigger = Some(crate::task_trigger::TaskTrigger {
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
        let created = store.create_direct(input).await.unwrap();
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::User,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();
        // Make the TaskStore-owned trigger-state root non-traversable. The
        // durable status write still succeeds, while pending cancellation must
        // fail loudly so the user can retry instead of assuming cleanup won.
        std::fs::write(data_dir.join("tasks"), "not-a-directory").unwrap();

        let error = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Stopped,
                TransitionActor::User,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap_err();
        assert!(error.contains("trigger-state.json"), "got: {error}");
        assert_eq!(
            store.get(&created.id).await.unwrap().status,
            TaskStatus::Stopped
        );
    }

    #[test]
    fn ambiguous_exact_stop_keeps_the_durable_pending_activation() {
        assert!(!should_cancel_pending_after_transition(
            TaskStatus::Stopped,
            true,
            false,
        ));
        assert!(should_cancel_pending_after_transition(
            TaskStatus::Stopped,
            true,
            true,
        ));
    }

    #[tokio::test]
    async fn delete_rejects_until_the_exact_execution_is_settled() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        let scheduler = crate::task_scheduler::get_task_scheduler();
        let queue_id = scheduler
            .claim_execution_for_test(&created.id)
            .await
            .unwrap();

        let result = store.delete(&created.id).await;
        scheduler
            .release_execution_for_test(&created.id, &queue_id)
            .await;

        let error = result.expect_err("delete must fail closed until exact stop is confirmed");
        assert!(
            error.contains("current turn could not be confirmed stopped"),
            "got: {error}"
        );
        assert!(!store.get(&created.id).await.unwrap().deleted);
    }

    #[test]
    fn task_docs_dir_rejects_traversal() {
        assert!(task_docs_dir("../etc").is_err());
        assert!(task_docs_dir("..").is_err());
        assert!(task_docs_dir("a/b").is_err());
        assert!(task_docs_dir("a\\b").is_err());
        assert!(task_docs_dir(".hidden").is_err());
        assert!(task_docs_dir("").is_err());
        // Valid UUID-ish id works
        assert!(task_docs_dir("abc-123_ok").is_ok());
    }

    fn sample_discussion_input(root: &Path) -> TaskDiscussionInput {
        let dir = root.join("discussion-input");
        fs::create_dir_all(dir.join("candidates")).unwrap();
        fs::write(
            dir.join("metadata.json"),
            serde_json::to_vec(&TaskDiscussionMetadata {
                discussion_id: "discussion-input".into(),
                workspace_id: "ws".into(),
                workspace_path: "/ws".into(),
                source_record_id: Some("record-audio".into()),
                created_at: 1,
            })
            .unwrap(),
        )
        .unwrap();
        serde_json::from_value(serde_json::json!({
            "text": "  Original input\nkeep spaces  ", "clientRequestId": Uuid::new_v4().to_string(),
            "primaryContext": { "kind": "task-discussion", "input": {
                "candidatesDir": dir.join("candidates").to_string_lossy(), "workspaceId": "ws", "workspacePath": "/ws", "sourceRecordId": "record-audio",
                "sourceRecordDocumentPath": "/record/content.md", "sourceRecordAudioPaths": [{ "track": "mixed", "path": "/record/audio.wav" }],
                "visibleUserMessage": "  Original input\nkeep spaces  " } },
            "requiredSystemSkill": { "name": "myagents-task-alignment", "sourceLocalId": "myagents-task-alignment", "systemSkillsVersion": "60", "contentSha256": "a".repeat(64) }
        })).unwrap()
    }

    #[test]
    fn discussion_input_survives_reload_without_creating_a_task_or_candidate() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("task-discussions");
        let input = sample_discussion_input(&root);
        save_discussion_input_under(&root, "discussion-input", &input).unwrap();
        let restored = read_discussion_input_under(&root, "discussion-input")
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(restored).unwrap(),
            serde_json::to_value(&input).unwrap()
        );
        assert_eq!(
            fs::read_dir(root.join("discussion-input/candidates"))
                .unwrap()
                .count(),
            0
        );
        assert!(!dir.path().join("tasks").exists());
        let mut replacement = input;
        replacement.text = "replacement".into();
        replacement.primary_context.input.visible_user_message = replacement.text.clone();
        assert!(save_discussion_input_under(&root, "discussion-input", &replacement).is_err());
        assert_eq!(
            read_discussion_input_under(&root, "discussion-input")
                .unwrap()
                .unwrap()
                .text,
            "  Original input\nkeep spaces  "
        );
    }

    #[test]
    fn discussion_input_rejects_wrong_scope_and_oversize_and_does_not_invent_legacy_text() {
        let dir = tempdir().unwrap();
        let input = sample_discussion_input(dir.path());
        assert!(read_discussion_input_under(dir.path(), "discussion-input")
            .unwrap()
            .is_none());
        assert!(read_discussion_input_under(dir.path(), "../escape").is_err());
        let mut wrong = input.clone();
        wrong.primary_context.input.workspace_path = "/other".into();
        assert!(save_discussion_input_under(dir.path(), "discussion-input", &wrong).is_err());
        let mut oversized = input;
        oversized.text = "a".repeat(TASK_DISCUSSION_INPUT_MAX_BYTES as usize);
        oversized.primary_context.input.visible_user_message = oversized.text.clone();
        assert!(save_discussion_input_under(dir.path(), "discussion-input", &oversized).is_err());
        assert!(!dir.path().join("discussion-input/input.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn discussion_input_rejects_symlinked_artifacts() {
        let dir = tempdir().unwrap();
        let input = sample_discussion_input(dir.path());
        let external = dir.path().join("external");
        fs::write(&external, "external").unwrap();
        std::os::unix::fs::symlink(&external, dir.path().join("discussion-input/input.json"))
            .unwrap();
        assert!(save_discussion_input_under(dir.path(), "discussion-input", &input).is_err());
        assert!(read_discussion_input_under(dir.path(), "discussion-input").is_err());
        assert_eq!(fs::read_to_string(external).unwrap(), "external");
    }

    #[test]
    fn discussion_candidate_is_reread_only_from_the_owned_shape() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("task-discussions");
        let candidate = root
            .join("discussion-1")
            .join("candidates")
            .join("candidate-1")
            .join("task.md");
        std::fs::create_dir_all(candidate.parent().unwrap()).unwrap();
        std::fs::write(&candidate, "# Current candidate\n").unwrap();

        assert_eq!(
            read_owned_discussion_candidate_under(&root, candidate.to_str().unwrap()).unwrap(),
            Some("# Current candidate\n".to_string())
        );
        std::fs::write(&candidate, "# Updated after CLI snapshot\n").unwrap();
        assert_eq!(
            read_owned_discussion_candidate_under(&root, candidate.to_str().unwrap()).unwrap(),
            Some("# Updated after CLI snapshot\n".to_string())
        );

        let generic = dir.path().join("ordinary-task.md");
        std::fs::write(&generic, "ordinary").unwrap();
        assert_eq!(
            read_owned_discussion_candidate_under(&root, generic.to_str().unwrap()).unwrap(),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn discussion_candidate_rejects_a_symlink() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let root = dir.path().join("task-discussions");
        let candidate_dir = root
            .join("discussion-1")
            .join("candidates")
            .join("candidate-1");
        std::fs::create_dir_all(&candidate_dir).unwrap();
        let target = candidate_dir.join("target.md");
        std::fs::write(&target, "shadow").unwrap();
        let candidate = candidate_dir.join("task.md");
        symlink(&target, &candidate).unwrap();

        assert!(
            read_owned_discussion_candidate_under(&root, candidate.to_str().unwrap())
                .unwrap_err()
                .contains("symlink")
        );
    }

    #[cfg(unix)]
    #[test]
    fn discussion_candidate_rejects_a_symlinked_artifact_root() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let external = dir.path().join("external");
        let candidate = external
            .join("discussion-1")
            .join("candidates")
            .join("candidate-1")
            .join("task.md");
        std::fs::create_dir_all(candidate.parent().unwrap()).unwrap();
        std::fs::write(&candidate, "# Outside candidate\n").unwrap();
        let root = dir.path().join("task-discussions");
        symlink(&external, &root).unwrap();
        let supplied = root
            .join("discussion-1")
            .join("candidates")
            .join("candidate-1")
            .join("task.md");

        assert!(
            read_owned_discussion_candidate_under(&root, supplied.to_str().unwrap())
                .unwrap_err()
                .contains("root may not be a symlink")
        );
    }

    #[test]
    fn normalize_mcp_override_preserves_explicit_empty() {
        assert_eq!(normalize_mcp_override(None), None);
        assert_eq!(normalize_mcp_override(Some(vec![])), Some(vec![]));
        assert_eq!(
            normalize_mcp_override(Some(vec!["tool-a".to_string()])),
            Some(vec!["tool-a".to_string()])
        );
    }

    #[tokio::test]
    async fn remove_mcp_server_references_preserves_empty_override() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let mut input = sample_direct_input(&ws);
        input.mcp_enabled_servers = Some(vec!["removed".to_string()]);
        let created = store.create_direct(input).await.unwrap();

        let updated = store.remove_mcp_server_references("removed").await.unwrap();
        assert_eq!(updated, 1);

        let task = store.get(&created.id).await.unwrap();
        assert_eq!(task.mcp_enabled_servers, Some(vec![]));
    }

    #[tokio::test]
    async fn update_rejects_conflicting_mcp_override_inputs() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        let err = store
            .update(TaskUpdateInput {
                id: created.id.clone(),
                name: None,
                executor: None,
                description: None,
                workspace_id: None,
                workspace_path: None,
                execution_mode: None,
                run_mode: None,
                end_conditions: None,
                interval_minutes: None,
                cron_expression: None,
                cron_timezone: None,
                start_at: None,
                recurring_window: None,
                dispatch_at: None,
                trigger: None,
                clear_trigger: false,
                model: None,
                provider_id: None,
                clear_provider_override: false,
                permission_mode: None,
                preselected_session_id: None,
                runtime: None,
                runtime_config: None,
                clear_runtime_override: false,
                mcp_enabled_servers: Some(vec![]),
                clear_mcp_override: true,
                tags: None,
                notification: None,
                notification_patch: None,
                prompt: None,
            })
            .await
            .expect_err("should reject contradictory MCP override inputs");

        assert!(err.contains("mcpEnabledServers"));
        assert!(err.contains("clearMcpOverride"));
    }

    /// PRD 0.2.9 — verify the provider-routing validator enforces both
    /// invariants (pairing + external-runtime exclusion) and accepts the
    /// "follow Agent" empty state plus the legacy `model`-only shape.
    #[test]
    fn validate_task_provider_routing_enforces_pairing_and_runtime_exclusion() {
        // 1. Empty (= follow Agent) — accepted.
        assert!(validate_task_provider_routing(&None, &None, &None).is_ok());

        // 2. Pair (provider + model) on builtin runtime — accepted.
        assert!(validate_task_provider_routing(
            &Some("openai-x".into()),
            &Some("gpt-4o".into()),
            &Some("builtin".into()),
        )
        .is_ok());

        // 3. providerId without model — rejected (cross-provider misroute risk).
        let err =
            validate_task_provider_routing(&Some("openai-x".into()), &None, &None).unwrap_err();
        assert!(err.contains("providerId"), "got: {}", err);
        assert!(err.contains("model"), "got: {}", err);

        // 4. External runtime + providerId — rejected (codex / cc
        //    self-manage providers).
        for rt in ["claude-code", "codex"] {
            let err = validate_task_provider_routing(
                &Some("openai-x".into()),
                &Some("gpt-4o".into()),
                &Some(rt.to_string()),
            )
            .unwrap_err();
            assert!(err.contains(rt), "got: {}", err);
        }

        // 5. Legacy `model`-only (pre-0.2.9 task) — accepted as FollowAgent.
        assert!(
            validate_task_provider_routing(&None, &Some("legacy-model".into()), &None,).is_ok()
        );

        // 6. External runtime without provider override — accepted (the
        //    common case for codex/cc tasks).
        assert!(validate_task_provider_routing(&None, &None, &Some("codex".into()),).is_ok());
    }

    #[test]
    fn validate_task_execution_routing_enforces_runtime_config_source() {
        let integrated = Some(serde_json::json!({
            "source": "integrated",
            "model": "glm-4.7",
        }));
        assert!(
            validate_task_execution_routing(&None, &None, &Some("dsh".into()), &integrated,)
                .is_ok()
        );
        assert!(
            validate_task_execution_routing(&None, &None, &Some("codex".into()), &integrated,)
                .unwrap_err()
                .contains("requires runtime=dsh")
        );
        let managed = Some(serde_json::json!({
            "source": "managed-provider",
            "model": "gpt-5.6-sol",
        }));
        assert!(
            validate_task_execution_routing(&None, &None, &Some("codex".into()), &managed,).is_ok()
        );
        assert!(
            validate_task_execution_routing(&None, &None, &Some("claude-code".into()), &managed,)
                .unwrap_err()
                .contains("requires runtime=codex")
        );
        assert!(validate_task_execution_routing(
            &None,
            &None,
            &Some("codex".into()),
            &Some(serde_json::json!({ "source": "mystery" })),
        )
        .unwrap_err()
        .contains("invalid runtimeConfig.source"));
        assert!(validate_task_execution_routing(
            &None,
            &None,
            &Some("dsh".into()),
            &Some(serde_json::json!({ "source": "system-cli" })),
        )
        .unwrap_err()
        .contains("requires runtimeConfig.source=integrated"));
    }

    #[tokio::test]
    async fn update_rejects_managed_provider_config_on_latest_non_codex_row() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let mut create = sample_direct_input(&ws);
        create.runtime = Some("claude-code".to_string());
        let created = store.create_direct(create).await.unwrap();
        let mut update = empty_update_input(&created.id);
        update.runtime_config = Some(serde_json::json!({
            "source": "managed-provider",
            "model": "gpt-5.6-sol",
        }));

        let error = store.update(update).await.unwrap_err();

        assert!(error.contains("requires runtime=codex"));
        let unchanged = store.get(&created.id).await.unwrap();
        assert_eq!(unchanged.runtime.as_deref(), Some("claude-code"));
        assert!(unchanged.runtime_config.is_none());
    }

    /// PRD 0.2.9 — verify `pin_runtime_for_provider_id` materialises
    /// `runtime: 'builtin'` when `provider_id` is set with no explicit
    /// runtime. Closes the cross-talk hole flagged by Codex review.
    #[test]
    fn pin_runtime_for_provider_id_materialises_builtin() {
        // 1. provider_id set, runtime None → pin to builtin.
        let mut rt: Option<String> = None;
        pin_runtime_for_provider_id(&Some("openai-x".into()), &mut rt);
        assert_eq!(rt, Some("builtin".into()));

        // 2. provider_id None, runtime None → no change.
        let mut rt2: Option<String> = None;
        pin_runtime_for_provider_id(&None, &mut rt2);
        assert_eq!(rt2, None);

        // 3. provider_id set, runtime already set → no change (idempotent).
        let mut rt3: Option<String> = Some("builtin".into());
        pin_runtime_for_provider_id(&Some("openai-x".into()), &mut rt3);
        assert_eq!(rt3, Some("builtin".into()));

        // 4. provider_id set, runtime explicitly external → no change here
        //    (validator catches the conflict afterward).
        let mut rt4: Option<String> = Some("codex".into());
        pin_runtime_for_provider_id(&Some("openai-x".into()), &mut rt4);
        assert_eq!(rt4, Some("codex".into()));
    }

    #[tokio::test]
    async fn crash_recovery_rewrites_running_to_blocked_on_reload() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store_dir = dir.path().join("data");
        let store = TaskStore::new(store_dir.clone());
        let a = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        let b = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store
            .update_status(status_input(
                &a.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();
        store
            .update_status(status_input(
                &b.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();
        store
            .update_status(status_input(
                &b.id,
                TaskStatus::Verifying,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .unwrap();
        drop(store);

        let recovered = TaskStore::new(store_dir);
        let ra = recovered.get(&a.id).await.unwrap();
        let rb = recovered.get(&b.id).await.unwrap();
        assert_eq!(ra.status, TaskStatus::Blocked);
        assert_eq!(rb.status, TaskStatus::Blocked);
        // Each has a crash-recovery transition appended.
        assert_eq!(
            ra.status_history.last().unwrap().source,
            Some(TransitionSource::Crash)
        );
        assert_eq!(
            rb.status_history.last().unwrap().source,
            Some(TransitionSource::Crash)
        );
    }

    #[tokio::test]
    async fn startup_preserves_enabled_time_schedules_for_scheduler_recovery() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store_dir = dir.path().join("data");
        let store = TaskStore::new(store_dir.clone());

        let mut recurring_input = sample_direct_input(&ws);
        recurring_input.execution_mode = TaskExecutionMode::Recurring;
        recurring_input.interval_minutes = Some(60);
        let recurring = store.create_direct(recurring_input).await.unwrap();

        let mut scheduled_input = sample_direct_input(&ws);
        scheduled_input.execution_mode = TaskExecutionMode::Scheduled;
        scheduled_input.dispatch_at = Some(now_ms() + 60_000);
        let scheduled = store.create_direct(scheduled_input).await.unwrap();

        for id in [&recurring.id, &scheduled.id] {
            store
                .update_status(status_input(
                    id,
                    TaskStatus::Running,
                    TransitionActor::System,
                    Some(TransitionSource::Scheduler),
                ))
                .await
                .unwrap();
        }
        let recurring_history_len = recurring.status_history.len() + 1;
        let scheduled_history_len = scheduled.status_history.len() + 1;
        drop(store);

        let recovered = TaskStore::new(store_dir);
        let recurring = recovered.get(&recurring.id).await.unwrap();
        let scheduled = recovered.get(&scheduled.id).await.unwrap();
        assert_eq!(recurring.status, TaskStatus::Running);
        assert_eq!(scheduled.status, TaskStatus::Running);
        assert_eq!(recurring.status_history.len(), recurring_history_len);
        assert_eq!(scheduled.status_history.len(), scheduled_history_len);
    }

    #[tokio::test]
    async fn status_filter_accepts_single_or_array() {
        use serde_json::json;
        // Single value
        let f: TaskListFilter = serde_json::from_value(json!({"status": "running"})).unwrap();
        assert!(f.status.is_some());
        // Array of values
        let f: TaskListFilter =
            serde_json::from_value(json!({"status": ["running", "done"]})).unwrap();
        assert!(f.status.is_some());
    }

    #[tokio::test]
    async fn dispatch_origin_and_run_mode_serialize_kebab_case() {
        // PRD §3.2 / TS shared types — these wire values must match exactly.
        let d = TaskDispatchOrigin::AiAligned;
        assert_eq!(serde_json::to_string(&d).unwrap(), "\"ai-aligned\"");
        let attached = TaskDispatchOrigin::AttachedSession;
        assert_eq!(
            serde_json::to_string(&attached).unwrap(),
            "\"attached-session\""
        );
        let r = TaskRunMode::SingleSession;
        assert_eq!(serde_json::to_string(&r).unwrap(), "\"single-session\"");
    }

    #[test]
    fn execution_projection_serializes_as_transient_camel_case_fields() {
        let task: Task = serde_json::from_value(serde_json::json!({
            "id": "task-projection",
            "name": "projection",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp/workspace",
            "executionMode": "once",
            "sessionIds": [],
            "status": "stopped",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();
        let projection = TaskProjection::new(
            task,
            Some(crate::task_scheduler::TaskExecutionProjection {
                state: crate::task_scheduler::TaskExecutionState::StopFailed,
                error: Some("stop failed".to_string()),
            }),
        );

        let value = serde_json::to_value(projection).unwrap();
        assert_eq!(
            value.get("executionState"),
            Some(&serde_json::json!("stop_failed"))
        );
        assert_eq!(
            value.get("executionError"),
            Some(&serde_json::json!("stop failed"))
        );
        assert!(value.get("execution_state").is_none());
        assert!(value.get("triggerState").is_none());
    }

    #[test]
    fn legacy_source_thought_id_is_preserved_until_its_record_is_published() {
        let mut task: Task = serde_json::from_value(serde_json::json!({
            "id": "task-legacy-source",
            "name": "legacy source",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp/workspace",
            "executionMode": "once",
            "sourceThoughtId": "record-1",
            "sessionIds": [],
            "status": "stopped",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();
        assert!(task.source_record_id.is_none());
        assert_eq!(task.legacy_source_thought_id.as_deref(), Some("record-1"));
        let api_value = serde_json::to_value(&task).unwrap();
        assert!(api_value.get("sourceRecordId").is_none());
        assert!(api_value.get("sourceThoughtId").is_none());
        assert!(task
            .serialize_for_disk()
            .unwrap()
            .contains("sourceThoughtId"));

        assert!(task.promote_legacy_source_if(|id| id == "record-1"));
        let persisted = serde_json::to_value(task).unwrap();
        assert_eq!(
            persisted.get("sourceRecordId"),
            Some(&serde_json::json!("record-1"))
        );
        assert!(persisted.get("sourceThoughtId").is_none());
    }

    #[tokio::test]
    async fn end_conditions_deadline_serializes_as_ms() {
        let ec = TaskEndConditions {
            deadline: Some(1_700_000_000_000),
            max_executions: Some(5),
            ai_can_exit: true,
        };
        let s = serde_json::to_string(&ec).unwrap();
        assert!(s.contains("\"deadline\":1700000000000"));
    }

    #[tokio::test]
    // `tokio::spawn` is fine inside `#[tokio::test]` — the test attribute
    // provides the runtime context. Allow the project-wide ban only here.
    #[allow(clippy::disallowed_methods)]
    async fn concurrent_creates_preserve_all_rows() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = Arc::new(TaskStore::new(dir.path().join("data")));

        let mut handles = Vec::new();
        for i in 0..20 {
            let s = store.clone();
            let w = ws.clone();
            handles.push(tokio::spawn(async move {
                let mut input = sample_direct_input(&w);
                input.name = format!("task {}", i);
                s.create_direct(input).await.unwrap()
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        let listed = store.list(TaskListFilter::default()).await;
        assert_eq!(listed.len(), 20);
    }

    #[tokio::test]
    async fn append_session_idempotent() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store.append_session(&created.id, "sess-1").await.unwrap();
        store.append_session(&created.id, "sess-1").await.unwrap();
        store.append_session(&created.id, "sess-2").await.unwrap();
        let reloaded = store.get(&created.id).await.unwrap();
        assert_eq!(
            reloaded.session_ids,
            vec!["sess-1".to_string(), "sess-2".to_string()]
        );
    }

    #[tokio::test]
    async fn task_comments_preserve_exact_session_and_rebuild_agent_notification_source() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let data = dir.path().join("data");
        let store = TaskStore::new(data.clone());
        for _ in 0..100 {
            if store.agent_comment_notification_source().ready {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let task = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        // A direct user comment has no valid execution Session yet and stays
        // pending without mutating Task lifecycle.
        let pending = store
            .create_user_comment(&task.id, "Please also check docs", None)
            .await
            .unwrap();
        assert_eq!(
            pending.admission.as_ref().map(|value| value.state),
            Some(TaskCommentAdmissionState::PendingSession)
        );
        assert_eq!(store.get(&task.id).await.unwrap().status, TaskStatus::Todo);

        let (_, claimed) = store
            .append_session_and_claim_pending_comments(&task.id, "session-exact")
            .await
            .unwrap();
        assert_eq!(
            claimed
                .iter()
                .map(|comment| comment.id.as_str())
                .collect::<Vec<_>>(),
            vec![pending.id.as_str()]
        );
        let agent = store
            .append_agent_comment(&task.id, "session-exact", "Found two risks", None)
            .await
            .unwrap();
        let reply = store
            .create_user_comment(&task.id, "Fix only the first", Some(&agent.id))
            .await
            .unwrap();
        assert_eq!(
            reply.conversation_session_id.as_deref(),
            Some("session-exact")
        );
        assert_eq!(
            reply
                .admission
                .as_ref()
                .and_then(|value| value.target_session_id.as_deref()),
            Some("session-exact")
        );
        let live_page = store.list_comments(&task.id, None, 50).await.unwrap();
        assert!(live_page
            .items
            .iter()
            .filter_map(|item| item.admission.as_ref())
            .all(|admission| { admission.state == TaskCommentAdmissionState::Sending }));

        let source = store.agent_comment_notification_source();
        let indexed = source
            .items
            .iter()
            .find(|item| item.comment_id == agent.id)
            .expect("new Agent comment is incrementally indexed");
        assert_eq!(indexed.task_id, task.id);
        assert_eq!(indexed.excerpt, "Found two risks");

        let mut rename = empty_update_input(&task.id);
        rename.name = Some("Renamed risk review".to_string());
        store.update(rename).await.unwrap();
        assert_eq!(
            store
                .agent_comment_notification_source()
                .items
                .iter()
                .find(|item| item.comment_id == agent.id)
                .map(|item| item.task_name.as_str()),
            Some("Renamed risk review")
        );

        // A persisted in-flight admission is ambiguous after restart and is
        // normalized to unknown rather than silently retried.
        drop(store);
        let recovered = TaskStore::new(data);
        let page = recovered.list_comments(&task.id, None, 50).await.unwrap();
        let recovered_reply = page.items.iter().find(|item| item.id == reply.id).unwrap();
        assert_eq!(
            recovered_reply.admission.as_ref().map(|value| value.state),
            Some(TaskCommentAdmissionState::Unknown)
        );
        for _ in 0..100 {
            if recovered.agent_comment_notification_source().ready {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let rebuilt = recovered.agent_comment_notification_source();
        assert!(rebuilt.ready);
        assert_eq!(
            rebuilt
                .items
                .iter()
                .find(|item| item.comment_id == agent.id)
                .map(|item| item.task_name.as_str()),
            Some("Renamed risk review")
        );

        recovered.delete(&task.id).await.unwrap();
        // Deletion preserves audit read authority, matching task get/runs.
        assert!(!recovered
            .list_comments(&task.id, None, 50)
            .await
            .unwrap()
            .items
            .is_empty());
        assert!(recovered
            .agent_comment_notification_source()
            .items
            .iter()
            .all(|item| item.task_id != task.id));
    }

    #[tokio::test]
    async fn task_comment_pages_and_context_keep_one_linear_timeline() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let task = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        for index in 0..7 {
            store
                .create_user_comment(&task.id, &format!("comment {index}"), None)
                .await
                .unwrap();
        }

        let newest = store.list_comments(&task.id, None, 3).await.unwrap();
        assert_eq!(
            newest
                .items
                .iter()
                .map(|item| item.body.as_str())
                .collect::<Vec<_>>(),
            vec!["comment 4", "comment 5", "comment 6"]
        );
        let previous = store
            .list_comments(&task.id, newest.next_before.as_deref(), 3)
            .await
            .unwrap();
        assert_eq!(
            previous
                .items
                .iter()
                .map(|item| item.body.as_str())
                .collect::<Vec<_>>(),
            vec!["comment 1", "comment 2", "comment 3"]
        );
        assert!(previous.next_before.is_some());

        let all = store.list_comments(&task.id, None, 100).await.unwrap();
        let target = &all.items[3];
        let context = store
            .comment_context(&task.id, &target.id, 2)
            .await
            .unwrap();
        assert_eq!(context.target_comment_id, target.id);
        assert_eq!(
            context
                .items
                .iter()
                .map(|item| item.body.as_str())
                .collect::<Vec<_>>(),
            vec![
                "comment 1",
                "comment 2",
                "comment 3",
                "comment 4",
                "comment 5"
            ]
        );
        assert!(context.previous_before.is_some());
        assert!(context.next_after.is_some());

        let newer = store
            .list_comments_after(&task.id, context.next_after.as_deref().unwrap(), 3)
            .await
            .unwrap();
        assert_eq!(
            newer
                .items
                .iter()
                .map(|item| item.body.as_str())
                .collect::<Vec<_>>(),
            vec!["comment 6"]
        );

        let parent = all.items.first().unwrap();
        store
            .create_user_comment(&task.id, "reply to oldest", Some(&parent.id))
            .await
            .unwrap();
        let latest = store.list_comments(&task.id, None, 1).await.unwrap();
        assert_eq!(latest.reply_parents.len(), 1);
        assert_eq!(latest.reply_parents[0].comment_id, parent.id);
        assert_eq!(latest.reply_parents[0].quote, "comment 0");
    }

    #[test]
    fn task_comment_display_quote_keeps_sixty_code_points() {
        let body = "字".repeat(61);
        assert_eq!(task_comment_quote(&body), format!("{}…", "字".repeat(60)));
    }

    #[tokio::test]
    async fn failed_pending_claim_does_not_publish_the_new_session_relation() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let task = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        let pending = store
            .create_user_comment(&task.id, "Older pending requirement", None)
            .await
            .unwrap();
        store
            .fail_next_acceptance_comment_persist
            .store(true, std::sync::atomic::Ordering::SeqCst);

        let error = store
            .append_session_and_claim_pending_comments(&task.id, "session-new")
            .await
            .unwrap_err();
        assert!(error.contains("injected acceptance comment persist failure"));
        assert!(store.get(&task.id).await.unwrap().session_ids.is_empty());
        let page = store.list_comments(&task.id, None, 50).await.unwrap();
        let unchanged = page
            .items
            .iter()
            .find(|comment| comment.id == pending.id)
            .unwrap();
        assert_eq!(unchanged.conversation_session_id, None);
        assert_eq!(
            unchanged.admission.as_ref().map(|value| value.state),
            Some(TaskCommentAdmissionState::PendingSession)
        );
    }

    #[test]
    fn deleted_task_projection_rejects_a_late_agent_comment_locator() {
        let dir = tempdir().unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        {
            let mut index = store
                .comment_notification_index
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            index.ready = true;
            index
                .task_projections
                .insert("deleted-task".to_string(), None);
        }
        store.index_agent_comment(TaskAgentCommentLocator {
            notification_id: "task-comment:late".to_string(),
            task_id: "deleted-task".to_string(),
            task_name: "Deleted".to_string(),
            comment_id: "late".to_string(),
            created_at: 1,
            agent_label: None,
            session_id: "session-1".to_string(),
            excerpt: "late write".to_string(),
        });

        assert!(store.agent_comment_notification_source().items.is_empty());
    }

    #[tokio::test]
    async fn partial_comment_notification_index_retries_after_source_repair() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let data = dir.path().join("data");
        let store = TaskStore::new(data.clone());
        while !store.agent_comment_notification_source().ready {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let task = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        let comments_path = data.join("tasks").join(&task.id).join("comments.jsonl");
        std::fs::create_dir_all(comments_path.parent().unwrap()).unwrap();
        std::fs::write(&comments_path, "{malformed\n").unwrap();
        {
            let mut index = store
                .comment_notification_index
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            index.ready = true;
            index.partial_error = true;
        }
        store.retry_comment_notification_index_if_partial().await;
        for _ in 0..100 {
            if store.agent_comment_notification_source().ready {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(store.agent_comment_notification_source().partial_error);

        let comment = TaskComment {
            id: "recovered-comment".to_string(),
            task_id: task.id.clone(),
            body: "Recovered source".to_string(),
            author: TaskCommentAuthor::Agent {
                label: None,
                session_id: "session-1".to_string(),
            },
            created_at: 2,
            reply_to_comment_id: None,
            conversation_session_id: Some("session-1".to_string()),
            admission: None,
        };
        TaskStore::persist_comments_file(&comments_path, &[comment]).unwrap();
        store.retry_comment_notification_index_if_partial().await;
        for _ in 0..100 {
            let source = store.agent_comment_notification_source();
            if source.ready && !source.partial_error {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let recovered = store.agent_comment_notification_source();
        assert!(recovered.ready);
        assert!(!recovered.partial_error);
        assert_eq!(recovered.items[0].comment_id, "recovered-comment");
    }

    #[tokio::test]
    async fn large_comment_history_rebuild_is_async_and_keeps_a_bounded_projection() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let data = dir.path().join("data");
        let store = TaskStore::new(data.clone());
        let task = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        drop(store);

        let comments_path = data.join("tasks").join(&task.id).join("comments.jsonl");
        std::fs::create_dir_all(comments_path.parent().unwrap()).unwrap();
        let file = std::fs::File::create(&comments_path).unwrap();
        let mut writer = std::io::BufWriter::new(file);
        for index in 0..20_000 {
            let comment = TaskComment {
                id: format!("agent-{index:05}"),
                task_id: task.id.clone(),
                body: format!("result {index}"),
                author: TaskCommentAuthor::Agent {
                    label: None,
                    session_id: "session-large".to_string(),
                },
                created_at: index,
                reply_to_comment_id: None,
                conversation_session_id: Some("session-large".to_string()),
                admission: None,
            };
            serde_json::to_writer(&mut writer, &comment).unwrap();
            writer.write_all(b"\n").unwrap();
        }
        writer.flush().unwrap();

        let started = std::time::Instant::now();
        let rebuilt = TaskStore::new(data);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(1),
            "TaskStore construction must not synchronously scan comment history"
        );
        for _ in 0..1_000 {
            if rebuilt.agent_comment_notification_source().ready {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let source = rebuilt.agent_comment_notification_source();
        assert!(source.ready);
        assert_eq!(source.items.len(), MAX_TASK_COMMENT_NOTIFICATION_INDEX);
        assert_eq!(
            source.items.first().map(|item| item.comment_id.as_str()),
            Some("agent-19999")
        );
    }

    // Removed `update_progress_appends_to_file` test: targeted `TaskStore::update_progress`
    // which was renamed/removed in v0.1.69+ (see comment at line 1935 about
    // append_progress_line). Test code was stale dead reference blocking the
    // workspace test binary from compiling. Cleaned up incidentally during
    // PRD 0.2.7 Phase A so workspace_files unit tests can run.
}
