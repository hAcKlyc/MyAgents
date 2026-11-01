// Task types (v0.1.69 Task Center)
// Workspace-scoped execution units. Persisted to ~/.myagents/tasks.jsonl.
// Associated markdown documents live under <workspace>/.task/<taskId>/.
// See PRD §3.2 for the full schema and §9.1 for the state machine.

import type { RuntimeType } from './runtime';

/**
 * Task status — see PRD §9.1 state machine.
 *
 * `'deleted'` is a synthetic pseudo-state used only as the `to` of a soft-delete
 * audit entry (PRD §10.2.2) — it is never accepted as the target of
 * `update-status` and a task whose `status === 'deleted'` is equivalent to
 * `deleted === true` (filtered out of list queries by default).
 */
export type TaskStatus =
  | 'todo'
  | 'running'
  | 'verifying'
  | 'done'
  | 'blocked'
  | 'stopped'
  | 'archived'
  | 'deleted';

/** Transient state of one concrete scheduler turn; never persisted. */
export type TaskExecutionState = 'checking' | 'running' | 'stopping' | 'stop_failed';

export interface TaskTrigger {
  source: { type: 'time' };
  detector:
    | { type: 'always' }
    | {
      type: 'command';
      command: { executable: string; args: string[]; cwd?: string };
      timeoutMs?: number;
    };
}

export interface TaskTriggerReason {
  code: string;
  message: string;
}

export interface TaskActivationEvent {
  id: string;
  kind: string;
  occurredAt: string;
}

export interface TaskActivationHandoff {
  summary: string;
  text?: string;
  data?: Record<string, unknown>;
}

export interface PendingTaskActivation {
  event: TaskActivationEvent;
  handoff: TaskActivationHandoff;
  reason: TaskTriggerReason;
  invocationCause: 'scheduled' | 'check-now';
  detectedAt: number;
  taskUpdatedAt: number;
  deliveryState: 'pending' | 'dispatching';
  queueId?: string;
}

/** Activation evidence forwarded across Rust → SessionEngine → reminder. */
export type TaskActivationPayload = Pick<
  PendingTaskActivation,
  'event' | 'handoff' | 'reason' | 'detectedAt'
>;

export interface TaskTriggerError {
  code: string;
  message: string;
  occurredAt: number;
  exitCode?: number;
  signal?: string;
  timedOut?: boolean;
  stderrTail?: string;
}

export interface TaskTriggerRuntimeState {
  protocolVersion: 1;
  checkpoint: Record<string, unknown> | null;
  checkpointRevision: number;
  checkpointUpdatedAt?: number;
  checkCount: number;
  lastCheckedAt?: number;
  lastOutcome?: 'quiet' | 'activate' | 'deduplicated' | 'error';
  lastReason?: TaskTriggerReason;
  lastActivatedAt?: number;
  consecutiveFailures: number;
  backoffUntil?: number;
  lastError?: TaskTriggerError;
  pendingActivation?: PendingTaskActivation;
  recentEventIds: Array<{ id: string; settledAt: number }>;
}

export interface TaskTriggerTestSuccess {
  invocationId: string;
  decision: 'quiet' | 'activate';
  reason: TaskTriggerReason;
  event?: TaskActivationEvent;
  handoff?: TaskActivationHandoff;
  nextCheckpoint: Record<string, unknown> | null | undefined;
  durationMs: number;
  exitCode: number;
  stderrTail?: string;
}

export interface TaskTriggerTestFailure {
  error: TaskTriggerError;
  durationMs: number;
  stdout?: string;
}

export type TaskTriggerTestResponse =
  | { ok: true; result: TaskTriggerTestSuccess }
  | { ok: false; failure: TaskTriggerTestFailure };

export interface TaskTriggerCheckNowResult {
  state: TaskTriggerRuntimeState;
  outcome?: TaskTriggerRuntimeState['lastOutcome'];
}

/** Statuses accepted by the CLI `task update-status`. `archived` is user-only (see §9.1). */
export type CliSettableStatus = 'running' | 'verifying' | 'done' | 'blocked' | 'stopped';

/** Who actually triggered the transition. */
export type TransitionActor = 'system' | 'user' | 'agent';

/** Fine-grained transition source for audit/statistics. */
export type TransitionSource =
  | 'cli'
  | 'ui'
  | 'watchdog'
  | 'crash'
  | 'scheduler'
  | 'endCondition'
  | 'rerun'
  | 'migration';

/** Execution mode — see PRD §9.2. */
export type TaskExecutionMode = 'once' | 'scheduled' | 'recurring' | 'loop';

/** Session strategy across multiple runs. Mirrors cron_task.rs `RunMode`. */
export type TaskRunMode = 'single-session' | 'new-session';

/** Who is responsible for carrying out the task. */
export type TaskExecutor = 'user' | 'agent';

/** Product-owned managed task kinds. Ordinary user tasks leave this unset. */
export type ManagedTaskKind =
  | 'memory_gardener'
  | 'memory_molt'
  | 'memory_auto_update_batch';

/**
 * How the task was created. This is provenance only: every ordinary Task is
 * dispatched from its complete task.md regardless of origin. `ai-aligned` is
 * retained for rows created by older versions.
 */
export type TaskDispatchOrigin = 'direct' | 'ai-aligned' | 'attached-session';

export interface TaskExternalSource {
  type: 'space-issue';
  spaceId?: string;
  issueId: string;
  claimId?: string;
  deliveryId?: string;
}

/** One append-only entry in `Task.statusHistory`. See PRD §3.2. */
export interface StatusTransition {
  from: TaskStatus | null;
  to: TaskStatus;
  /** Timestamp (ms since epoch) */
  at: number;
  actor: TransitionActor;
  /** Free-form note; all target states can carry a message. */
  message?: string;
  source?: TransitionSource;
}

/** Auto-termination conditions for recurring/loop tasks. Mirrors cron_task.rs `EndConditions`. */
export interface EndConditions {
  /** Absolute timestamp (ms). After this point, no new round starts. */
  deadline?: number;
  /** Cap on total rounds run. */
  maxExecutions?: number;
  /** Whether AI may call `task update-status done` to exit a loop. Default `true`. */
  aiCanExit: boolean;
}

export interface ConversationRef { channelId: string; sessionKey: string }
export type NotificationTarget =
  | { type: 'off' }
  | ({ type: 'conversation' } & ConversationRef)
  | { type: 'recent-private'; scope: 'channel'; channelId: string }
  | { type: 'recent-private'; scope: 'agent'; agentId: string }
  | { type: 'current' };
export interface NotificationConfig {
  version?: 1;
  desktop: boolean;
  im?: NotificationTarget;
  source?: string;
  error?: string;
  /** Legacy input only. Canonical output uses im. */
  botChannelId?: string;
  botThread?: string;
  events?: Array<'execution' | 'done' | 'blocked' | 'stopped' | 'verifying' | 'endCondition'>;
}
export interface TaskNotificationDelivery {
  id: string;
  events: string[];
  policy: NotificationConfig;
  state: 'waiting' | 'preparing' | 'prepared' | 'sending' | 'sent' | 'handed-off' | 'suppressed' | 'failed' | 'unknown' | 'partial' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  title: string;
  target?: ConversationRef | null;
  executionSessionId?: string | null;
  targetSessionId?: string | null;
  error?: string | null;
  messageIds: string[];
  acceptedParts: number;
}

/** Field-level Task notification mutation. Omitted values stay unchanged;
 * `null` restores that field's default/absence. */
export interface TaskNotificationPatch {
  im?: NotificationTarget | null;
  desktop?: boolean | null;
  botChannelId?: string | null;
  botThread?: string | null;
  events?: NotificationConfig['events'] | null;
}

/** Runtime-scoped config snapshot captured at dispatch. */
export interface RuntimeConfigSnapshot {
  model?: string;
  permissionMode?: string;
  [key: string]: unknown;
}

export interface RecurringWindow {
  timezone: string;
  start: string;
  end: string;
}

export interface TaskLastExecution {
  at: number;
  trigger: 'scheduled' | 'manual';
  success: boolean;
  durationMs: number;
  sessionId?: string;
  error?: string;
  /** Immutable notification decision at settlement; absent on older executions. */
  notification?: {
    events: string[];
    subscribedEvents: string[];
    reason: 'delivery-recorded' | 'desktop-only' | 'not-subscribed' | 'disabled' | 'internal-task';
    deliveryId?: string;
  };
}

/** A Task — workspace-scoped execution unit. */
export interface Task {
  notificationDestination?: { label: string; availability: string; reason?: string; events?: string[]; executionResultsSubscribed?: boolean };
  id: string;
  name: string;
  executor: TaskExecutor;
  description?: string;
  workspaceId: string;
  /**
   * Absolute filesystem path of the workspace. Captured at create time so
   * background executors (scheduler, CLI) can locate `.task/<id>/` without
   * re-resolving the workspace. Not meant for UI display — prefer `workspaceId`.
   */
  workspacePath?: string;
  executionMode: TaskExecutionMode;
  /** Product-owned managed task marker; ordinary user tasks leave this unset. */
  managedKind?: ManagedTaskKind;
  runMode?: TaskRunMode;
  endConditions?: EndConditions;
  /** Recurring-mode fixed interval (minutes). Simple mode; mutually exclusive with `cronExpression`. */
  intervalMinutes?: number;
  /** Advanced-mode cron expression. Takes precedence over `intervalMinutes` when set. */
  cronExpression?: string;
  /** IANA timezone id for `cronExpression` (e.g. `Asia/Shanghai`). */
  cronTimezone?: string;
  /** Optional first fire timestamp for recurring tasks (RFC3339). */
  startAt?: string;
  /** Internal catch-up window for anchored recurring tasks. */
  recurringWindow?: RecurringWindow;
  /** Dedicated "when to fire" timestamp (ms) for `scheduled` mode. Decouples from `endConditions.deadline`. */
  dispatchAt?: number;
  /** Missing in legacy rows means effective time/always. */
  trigger?: TaskTrigger;
  /** Per-task model override. When absent, the Agent's default model is used.
   *
   *  PRD 0.2.9 pairing rule (asymmetric, by design): setting `providerId`
   *  REQUIRES `model` — the validator rejects provider-without-model so a
   *  user that picked a specific provider can't end up routing the Agent's
   *  default model name to the wrong upstream. The reverse is allowed:
   *  setting `model` alone means "use the Agent's currently-resolved
   *  provider but override the model id" — the renderer's grouped picker
   *  writes a `(providerId, model)` pair atomically; the model-only form
   *  is reachable only via the CLI / management API for legacy / advanced
   *  use. */
  model?: string;
  /** PRD 0.2.9 — Per-task provider id override. When absent, the cron follows
   *  the workspace agent. When set, the sidecar live-resolves the provider
   *  env from `~/.myagents/config.json` on every tick, so credential
   *  rotation propagates without re-saving the task and no credential
   *  copies land in `~/.myagents/tasks/...jsonl`.
   *
   *  Mutually exclusive with external runtime (`runtime ∈ {claude-code,
   *  codex}`) — those runtimes manage their own provider; the Rust
   *  validator rejects the combination. */
  providerId?: string;
  /** Per-task permission mode (auto / plan / fullAgency / …). Defaults to
   *  the **runtime maximum** (e.g. SDK builtin → `bypassPermissions`) rather
   *  than the Agent's default — see PRD 0.2.4 §需求 4 (4b note). */
  permissionMode?: string;
  /** For `single-session` run mode: id of a pre-existing SDK session to continue. */
  preselectedSessionId?: string;
  runtime?: RuntimeType;
  runtimeConfig?: RuntimeConfigSnapshot;
  /** Per-task MCP enable list override. `undefined` = follow Agent workspace.
   *  `[]` = explicitly run with no MCP servers. PRD 0.2.4 §需求 4 (4a). */
  mcpEnabledServers?: string[];
  /** Set only when the task was created from a text Record. */
  sourceRecordId?: string;
  sessionIds: string[];
  status: TaskStatus;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  lastExecutedAt?: number;
  /** Timer anchor; manual run-now must not move the recurring schedule. */
  lastScheduledAt?: number;
  executionCount?: number;
  /** Consecutive scheduled failures; a scheduled success resets this to zero. */
  consecutiveExecutionFailures?: number;
  /** TaskStore-owned current execution summary. Run history is audit-only. */
  lastExecution?: TaskLastExecution;
  /** Internal durable receipt for the last admitted command-trigger event. */
  lastActivationEventId?: string;
  /** Append-only audit log of status changes. See PRD §3.2 / §10.2.1. */
  statusHistory: StatusTransition[];
  notification?: NotificationConfig;
  notificationDeliveries?: TaskNotificationDelivery[];
  /** Creation provenance; never an execution-protocol switch. */
  dispatchOrigin: TaskDispatchOrigin;
  /** Optional external coordination record that caused this local Task. */
  externalSource?: TaskExternalSource;
  /** Set to `true` by `task delete` (soft delete with 30-day retention, §9.5). */
  deleted?: boolean;
  /** Set when `deleted = true`. Used for retention cleanup. */
  deletedAt?: number;
  /** Current concrete turn state. Separate from persisted scheduling status. */
  executionState?: TaskExecutionState;
  /** Stop confirmation failure for the current concrete turn. */
  executionError?: string;
  /** Read-time projection owned by Rust TaskStore; not persisted in tasks.jsonl. */
  triggerState?: TaskTriggerRuntimeState;
  /** Absolute paths to task markdown docs. Populated by
   *  `cmd_task_get` / `/api/task/get` at read time (not persisted) — the
   *  consumer (CLI, AI, UI) reads the files directly via Read/Edit/Write
   *  rather than going through dedicated read-doc / write-doc commands.
   *  Only existing files are surfaced (except `taskMd`, always present
   *  at creation time). See Rust `TaskDocs` for semantics. */
  docs?: TaskDocs;
}

/** Absolute paths to a task's markdown docs. Returned alongside a [`Task`]
 *  by `cmd_task_get` so the AI / CLI can `Read` / `Edit` / `Write` them
 *  directly. Only existing files are surfaced (task.md is always created
 *  at task-creation time, so it's always present). */
export interface TaskDocs {
  /** Absolute path to the docs directory: `~/.myagents/tasks/<id>/`. */
  dir: string;
  /** `task.md` — always present; the task's instruction/prompt body. */
  taskMd: string;
  /** Legacy `verify.md`; new tasks keep verification inside task.md. */
  verifyMd?: string;
  /** Legacy `progress.md`; preserved for compatibility. */
  progressMd?: string;
  /** Legacy `alignment.md`; preserved for compatibility. */
  alignmentMd?: string;
}

/** Payload for `cmd_task_create_direct` (PRD §10.2.2). */
export interface TaskCreateDirectInput {
  name: string;
  executor: TaskExecutor;
  description?: string;
  workspaceId: string;
  workspacePath: string;
  taskMdContent: string;
  executionMode: TaskExecutionMode;
  runMode?: TaskRunMode;
  endConditions?: EndConditions;
  /** Recurring-mode fixed interval (minutes). Mutually exclusive with `cronExpression`. */
  intervalMinutes?: number;
  /** Advanced-mode cron expression. Takes precedence over `intervalMinutes` when set. */
  cronExpression?: string;
  /** IANA timezone id for `cronExpression`. */
  cronTimezone?: string;
  /** Optional first fire timestamp for recurring tasks (RFC3339). */
  startAt?: string;
  /** Internal catch-up window for anchored recurring tasks. */
  recurringWindow?: RecurringWindow;
  /** Fire time for `scheduled` mode (ms epoch). */
  dispatchAt?: number;
  trigger?: TaskTrigger;
  /** Per-task model override. */
  model?: string;
  /** PRD 0.2.9 — Per-task provider id override. MUST be paired with `model`. */
  providerId?: string;
  /** Per-task permission mode override. */
  permissionMode?: string;
  /** For `single-session` run mode: id of a pre-existing SDK session to continue. */
  preselectedSessionId?: string;
  runtime?: RuntimeType;
  runtimeConfig?: RuntimeConfigSnapshot;
  /** Per-task MCP enable list override (PRD 0.2.4 §需求 4). */
  mcpEnabledServers?: string[];
  /** Product-owned managed task marker; ordinary user tasks leave this unset. */
  managedKind?: ManagedTaskKind;
  sourceRecordId?: string;
  tags?: string[];
  notification?: NotificationConfig;
}

/** Payload for `cmd_task_create_attached` / `myagents task create-attached`. */
export interface TaskCreateAttachedInput {
  name: string;
  executor?: TaskExecutor;
  description?: string;
  workspaceId: string;
  workspacePath: string;
  taskMdContent: string;
  currentSessionId: string;
  source: 'space-issue';
  sourceSpaceId?: string;
  sourceIssueId: string;
  sourceClaimId?: string;
  sourceDeliveryId?: string;
  tags?: string[];
  notification?: NotificationConfig;
}

/** Payload for `cmd_task_update`. */
export interface TaskUpdateInput {
  id: string;
  name?: string;
  executor?: TaskExecutor;
  description?: string;
  /** Workspace identity is an atomic pair: callers must send both fields or neither. */
  workspaceId?: string;
  workspacePath?: string;
  executionMode?: TaskExecutionMode;
  runMode?: TaskRunMode;
  endConditions?: EndConditions;
  /** Recurring-mode fixed interval (minutes). */
  intervalMinutes?: number;
  /** Advanced-mode cron expression. Empty string clears (switches back to simple mode). */
  cronExpression?: string;
  cronTimezone?: string;
  /** Internal recurring anchor. Used by system-managed tasks to avoid immediate catch-up. */
  startAt?: string;
  /** Internal catch-up window for anchored recurring tasks. */
  recurringWindow?: RecurringWindow;
  /** Dedicated dispatch time for `scheduled` mode (ms epoch). */
  dispatchAt?: number;
  trigger?: TaskTrigger;
  /** Clear persisted trigger configuration back to effective always. */
  clearTrigger?: boolean;
  /** Per-task model override. Empty string clears. */
  model?: string;
  /** PRD 0.2.9 — Per-task provider id override. Empty string clears. */
  providerId?: string;
  /** PRD 0.2.9 — Atomic "follow Agent" reset: clears providerId AND model
   *  in one update. Lets the renderer's "跟随 Agent" picker option round-trip
   *  cleanly without inventing a double-Option JSON shape. Pure boolean — no
   *  pairing risk if only one of (providerId, model) is omitted. */
  clearProviderOverride?: boolean;
  /** Per-task permission mode override. Empty string clears. */
  permissionMode?: string;
  /** For `single-session` run mode: id of a pre-existing SDK session to continue. */
  preselectedSessionId?: string;
  runtime?: RuntimeType;
  runtimeConfig?: RuntimeConfigSnapshot;
  /** PRD #131 — Atomic clear of `runtime` + `runtimeConfig`. The
   *  renderer's "跟随 Agent" runtime option sends this flag because
   *  `runtime: undefined` deserializes to `None` server-side which the
   *  apply path leaves untouched. Symmetric with `clearProviderOverride`. */
  clearRuntimeOverride?: boolean;
  /** Per-task MCP enable list override. `undefined` leaves the existing value
   *  unchanged, `[]` explicitly runs with no MCP, and a populated array
   *  snapshots the chosen server ids. Use `clearMcpOverride` to follow Agent. */
  mcpEnabledServers?: string[];
  /** Reset MCP override to follow Agent/workspace. Distinct from
   *  `mcpEnabledServers: []`, which explicitly runs with no MCP. */
  clearMcpOverride?: boolean;
  tags?: string[];
  notification?: NotificationConfig;
  notificationPatch?: TaskNotificationPatch;
  /**
   * When provided, the new markdown body is atomically written to
   * `.task/<id>/task.md` under the same write lock that persists the JSONL
   * row. Empty string is rejected server-side. This is the complete execution
   * context for every ordinary Task, including legacy ai-aligned rows.
   */
  prompt?: string;
}

/** Response from `cmd_task_get_run_stats` — aggregated telemetry for the task detail overlay. */
export interface TaskRunStats {
  executionCount: number;
  lastExecutedAt?: number;
  /** Success flag from `Task.lastExecution`. */
  lastSuccess?: boolean;
  /** Duration from `Task.lastExecution` (ms). */
  lastDurationMs?: number;
  /** Task scheduler status. */
  schedulerStatus?: string;
  /** Number of SDK sessions this task has spanned. */
  sessionCount: number;
  /** Next scheduled fire (ms since epoch). Parsed server-side from
   *  the Rust Task scheduler so the frontend avoids cron-parser /
   *  timezone math — reflects what Rust will actually run. Absent when
   *  the task has no active schedule or the schedule is not
   *  recurring / scheduled. */
  nextExecutionAt?: number;
}

/**
 * Payload for `cmd_task_update_status`. See PRD §10.2.1.
 *
 * UI callers MUST NOT send `actor` / `source` — these are authoritatively
 * stamped server-side at the Tauri command layer (`user` / `ui` for any
 * renderer-originated call). The fields are present in the shared type only for
 * internal Admin API / CLI transport payloads. A buggy renderer that sends them
 * anyway has them ignored.
 */
export interface TaskUpdateStatusInput {
  id: string;
  status: TaskStatus;
  message?: string;
  /** Internal only — ignored by the renderer-facing `cmd_task_update_status`. */
  actor?: TransitionActor;
  /** Internal only — ignored by the renderer-facing `cmd_task_update_status`. */
  source?: TransitionSource;
}

/** Filters accepted by `cmd_task_list`. Accepts a single status or an array. */
export interface TaskListFilter {
  workspaceId?: string;
  status?: TaskStatus | TaskStatus[];
  tag?: string;
  /** If `true`, include soft-deleted rows (default `false`). */
  includeDeleted?: boolean;
  /** Internal only. If `true`, include system-managed hidden tasks. */
  includeManaged?: boolean;
}

/** Form completeness only; Channel authority still validates the destination. */
export function isNotificationTargetComplete(config?: NotificationConfig): boolean {
  const target = config?.im;
  return target?.type !== 'conversation' || !!(target.channelId.trim() && target.sessionKey.trim());
}
