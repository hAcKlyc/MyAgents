import type { TurnProviderAnalytics } from '../session-core/turn-analytics';
import type { AskUserQuestionAnswers } from '../../shared/types/askUserQuestion';
import type { RuntimeAgentWorkControl, RuntimeAgentWorkTree } from '../../shared/types/subagent-lifecycle';
import type { AsyncQuestionSet } from '../../shared/asyncUserQuestions';
import type { ProviderRoute } from '../../shared/providerRoute';
// AgentRuntime abstraction types (v0.1.59)
// Defines the interface that all runtime implementations must satisfy

import type { RuntimeType, RuntimeModelInfo, RuntimePermissionMode, RuntimeDetection, RuntimeDiagnostics, RuntimeEnvPolicy, RuntimeExtensionDiagnostics, RuntimePermissionRuleMutationResult, RuntimePermissionRulesSnapshot, RuntimeSource } from '../../shared/types/runtime';
import type { McpServerDefinition } from '../../shared/config-types';
import type { DshSystemContextSnapshot, InteractionScenario } from '../system-prompt';
import type { ModelUsageEntry } from '../types/session';
import type { ToolAttachment } from '../../shared/types/tool-attachment';
import type { SubagentLifecycle, SubagentLifecycleStatus } from '../../shared/types/subagent-lifecycle';
import type { LargeValueRef } from '../utils/large-value-store';
import type { ManagedCodexExtensionSnapshot } from './managed-codex/extensions/contracts';
import type { DshProductExtensionSource } from '../integrated-runtimes/dsh/extension-compiler';
import type { PermissionOperationDisplay, PermissionReview } from '../../shared/types/runtime';

export interface InlineImagePayload {
  kind?: 'inline_base64';
  /** Stable logical attachment identity supplied by renderer surfaces. */
  id?: string;
  name: string;
  mimeType: string;
  data: string;  // base64 without data URL prefix
  sizeBytes?: number;
}

export interface AttachmentRefImagePayload {
  kind: 'attachment_ref';
  id?: string;
  name: string;
  mimeType: string;
  relativePath: string;
  sizeBytes?: number;
}

/**
 * Image payload accepted at Sidecar ingress. Renderer path drops use
 * `attachment_ref`; legacy no-path File/paste fallback may still send
 * bounded base64.
 */
export type ImagePayload = InlineImagePayload | AttachmentRefImagePayload;

/** Image payload after Sidecar resolves refs at the runtime boundary. */
export type ResolvedImagePayload = InlineImagePayload & { data: string };

/**
 * Atomic first user turn for a newly started runtime process.
 *
 * The message and its caller-owned identity must cross the adapter boundary
 * together. Product Session turns use the persisted SessionMessage id; isolated
 * utility turns (for example auto-title generation) mint an ephemeral id. Keeping
 * these fields in one object makes an unowned initial root turn unrepresentable.
 */
export interface RuntimeInitialTurn {
  message: string;
  clientUserMessageId: string;
  /** Product-owned stable operation identity for runtimes with durable admission. */
  clientOperationId?: string;
  images?: ResolvedImagePayload[];
}

export function isAttachmentRefImagePayload(img: ImagePayload): img is AttachmentRefImagePayload {
  return img.kind === 'attachment_ref';
}

export function isInlineImagePayload(img: ImagePayload): img is InlineImagePayload {
  return typeof (img as { data?: unknown }).data === 'string';
}

/**
 * Options for starting a runtime session
 */
export interface SessionStartOptions {
  sessionId: string;
  workspacePath: string;
  initialTurn?: RuntimeInitialTurn;
  systemPromptAppend?: string;
  /** Declarative Host context used only by the Integrated DSH Runtime. */
  systemContext?: DshSystemContextSnapshot;
  model?: string;
  /** Product-owned DSH birth selection; credentials remain Host-owned. */
  providerRoute?: ProviderRoute;
  permissionMode?: string;
  /** #324 — NORMALIZED reasoning effort level (never 'default'); absent =
   *  runtime default. CC maps to `--effort`, Codex to `turn/start.effort`. */
  reasoningEffort?: string;
  maxTurns?: number;
  resumeSessionId?: string;
  disallowedTools?: string[];
  scenario: InteractionScenario;
  additionalArgs?: string[];
  /**
   * Per-session env policy (issue #194). Resolved by the caller from
   * `agent.runtimeConfig.envPolicy`. When omitted, runtime adapters default
   * to `{ proxy: 'myagents' }` — the legacy MyAgents-overrides-everything
   * behaviour, preserving backwards compat.
   */
  envPolicy?: RuntimeEnvPolicy;
  /**
   * Runtime binary/state owner. Missing keeps historical behaviour:
   * external CLI runtimes use the user's system CLI and native home directory.
   */
  runtimeSource?: RuntimeSource;
  /**
   * Do not persist the runtime-native thread/session. Used by short-lived
   * utility turns such as auto-title generation. Runtime adapters that do not
   * expose an ephemeral-session primitive may ignore this option.
   */
  ephemeral?: boolean;
  /**
   * Effective MyAgents MCP servers for runtimes that accept MCP at process
   * startup. The builtin SDK path owns live setMcpServers; managed Codex
   * consumes this as app-server startup config.
   */
  mcpServers?: McpServerDefinition[];
  /**
   * MyAgents-owned extension projection for the existing managed Codex
   * adapter. It is generation-scoped and never persisted by the runtime.
   */
  managedCodexExtensions?: ManagedCodexExtensionSnapshot;
  /**
   * Product-owned declarative inventory for the Integrated DSH component
   * compiler. Credential material remains generation-scoped in the Host.
   */
  dshExtensions?: DshProductExtensionSource;
}

/**
 * A handle to a running runtime subprocess
 */
export interface RuntimeProcess {
  readonly pid: number;
  /** Optional adapter-owned identity for generation-scoped projections/callbacks. */
  readonly runtimeGeneration?: string;
  /** Runtime admission completed a durable mutation that changed Product transcript state. */
  readonly productTranscriptChangedAtStartup?: boolean;
  /** Runtime-native Skill names confirmed after startup, when the adapter can inspect them. */
  loadedSkillNames?: readonly string[];
  /** Write a line to the process stdin */
  writeLine(line: string): Promise<void>;
  /** Kill the process */
  kill(signal?: number): void;
  /** Whether the process has exited */
  exited: boolean;
  /** Wait for the process to exit */
  waitForExit(): Promise<number>;
}

/**
 * A same-turn input was definitively not accepted because the runtime no
 * longer has an active steer target. Session orchestration may safely retain
 * the same user operation for the next turn; transport failures must not use
 * this error because their delivery outcome is unknown.
 */
export class RuntimeSteerUnavailableError extends Error {
  readonly code = 'runtime_steer_unavailable';

  constructor(message = 'Runtime has no active turn to steer') {
    super(message);
    this.name = 'RuntimeSteerUnavailableError';
  }
}

export function isRuntimeSteerUnavailableError(error: unknown): error is RuntimeSteerUnavailableError {
  return error instanceof RuntimeSteerUnavailableError
    || (
      typeof error === 'object'
      && error !== null
      && (error as { code?: unknown }).code === 'runtime_steer_unavailable'
    );
}

export type RuntimeConfigApplyMode =
  | 'next_turn_state'
  | 'live_session_rpc'
  | 'restart_when_idle'
  | 'unsupported';

export interface RuntimeConfigCapabilities {
  model: RuntimeConfigApplyMode;
  permissionMode: RuntimeConfigApplyMode;
  reasoningEffort: RuntimeConfigApplyMode;
}

export interface ExternalRuntimeConfigPatch {
  model?: string | undefined;
  permissionMode?: string | undefined;
  /** NORMALIZED level for the session layer: undefined = untouched, '' = runtime default. */
  reasoningEffort?: string | undefined;
}

export interface ExternalRuntimeConfigSnapshot {
  model?: string;
  providerRoute?: ProviderRoute;
  permissionMode?: string;
  reasoningEffort?: string;
}

/**
 * Sub-agent scope for a tool event. Set ONLY by runtimes whose protocol exposes
 * multi-agent / multi-thread tool activity within a single session (currently
 * Codex collab-agent: a spawned worker is a separate Codex thread). When present,
 * the session layer nests the tool under the parent card identified by
 * `parentToolUseId` (mirroring builtin's `parent_tool_use_id` → `subagentCalls`
 * path) instead of rendering it flat in the main transcript.
 *
 * builtin (Claude Agent SDK) does NOT use this — it has its own native
 * `parent_tool_use_id` stream path in agent-session.ts. Claude Code
 * never sets it, so its behaviour is unchanged.
 *
 * `parentToolUseId` is the toolUseId of the card that REPRESENTS the sub-agent
 * (for Codex: the `spawnAgent` collabAgentToolCall item id), already resolved by
 * the runtime to the TOP-LEVEL spawn card so the session layer stays
 * thread-agnostic.
 */
export interface SubAgentScope {
  parentToolUseId: string;
  /** Human-readable nickname assigned by the runtime to the spawned agent (optional). */
  nickname?: string;
  /** Role label assigned by the runtime to the spawned agent (optional). */
  role?: string;
}

export type AgentPlanTodoStatus = 'pending' | 'in_progress' | 'completed';

export interface AgentPlanTodo {
  /** Stable key for renderer reconciliation within the current runtime plan snapshot. */
  key: string;
  content: string;
  activeForm: string;
  status: AgentPlanTodoStatus;
}

/**
 * Unified event emitted by any runtime, consumed by the session layer.
 * The session layer maps these to SSE broadcast calls.
 */
export interface NativeContentSource {
  messageId: string;
  blockIndex?: number;
  parentToolUseId?: string;
  blockStart?: Record<string, unknown>;
}

export type UnifiedEvent = (
  // === Text streaming ===
  | { kind: 'text_delta'; text: string; traceId?: string; subAgent?: SubAgentScope }
  | { kind: 'text_stop'; nativeText?: string; traceId?: string; subAgent?: SubAgentScope; asyncQuestions?: AsyncQuestionSet }

  // === Thinking/reasoning streaming ===
  | { kind: 'thinking_start'; index: number; traceId?: string; subAgent?: SubAgentScope }
  | { kind: 'thinking_delta'; text: string; index: number; traceId?: string; subAgent?: SubAgentScope }
  | { kind: 'thinking_stop'; index: number; traceId?: string; subAgent?: SubAgentScope }

  // === Tool use ===
  // `subAgent` (optional, Codex-only today): when set, the session layer nests
  // this tool under the parent spawn card instead of rendering it flat. See
  // SubAgentScope. Absent for builtin / Claude Code.
  | { kind: 'tool_use_start'; toolUseId: string; toolName: string; input?: Record<string, unknown>; subAgent?: SubAgentScope }
  | { kind: 'tool_input_delta'; toolUseId: string; delta: string; subAgent?: SubAgentScope }
  | { kind: 'tool_use_stop'; toolUseId: string; input?: Record<string, unknown>; subAgent?: SubAgentScope }
  | { kind: 'tool_result_delta'; toolUseId: string; delta: string; subAgent?: SubAgentScope }
  | {
    kind: 'provider_tool_use_start';
    providerRouteId: string;
    providerBlockType: string;
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
  }
  | {
    kind: 'provider_tool_result';
    providerRouteId: string;
    providerBlockType: string;
    toolUseId: string;
    toolName: string;
    content: string;
    isError: boolean;
    attachments?: ToolAttachment[];
  }
  | {
    kind: 'tool_result';
    toolUseId: string;
    content: string;
    subAgent?: SubAgentScope;
    /**
     * Rich-media attachments (image/audio/pdf/file). Each entry references a
     * file already persisted by the sidecar (or a placeholder pending async
     * save — see ToolAttachment.pendingId). Frontend renders via
     * ToolAttachmentGallery; tool_result.content remains the human/AI-readable
     * text summary.
     */
    attachments?: ToolAttachment[];
    isError?: boolean;
    metadata?: {
      exitCode?: number | null;
      durationMs?: number | null;
      cwd?: string;
      processId?: string | null;
      status?: string;
      largeValueRef?: LargeValueRef;
    };
  }
  /**
   * Async placeholder fulfillment (Review A4 of PRD 0.2.15). Emitted after
   * tool_result, once a deferred saveToolAttachment() resolves. The frontend
   * matches by (toolUseId, pendingId) and replaces the placeholder in-place.
   */
  | {
    kind: 'tool_attachment_update';
    toolUseId: string;
    pendingId: string;
    attachment: ToolAttachment;
  }

  // === Normalized child-turn lifecycle ===
  | {
    kind: 'subagent_lifecycle';
    handleRevision?: number;
    agentId?: string;
    taskId?: string;
    tree?: SubagentLifecycle['tree'];
    modelRoute?: SubagentLifecycle['modelRoute'];
    lastActivityAt?: number;
    activation?: SubagentLifecycle['activation'];
    handleState?: SubagentLifecycle['handleState'];
    startedAt?: number;
    parentToolUseId: string;
    status: SubagentLifecycleStatus;
    observedAt: number;
    agentType?: string;
    description?: string;
    mode?: 'foreground' | 'continuable';
    model?: string;
    result?: string;
    resultTruncated?: boolean;
    usage?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      costUsd?: number | null;
    };
    /** ProductWork is child/background state and must not drive root loading/watchdogs. */
    affectsRootActivity?: boolean;
  }

  // === Turn lifecycle ===
  | { kind: 'turn_started' }
  | { kind: 'root_turn_admitted'; runtimeTurnId: string; clientUserMessageId: string; origin?: 'user' }
  | { kind: 'root_turn_admitted'; runtimeTurnId: string; clientOperationId: string; origin: 'collaboration'; clientUserMessageId?: never }

  // === Permission delegation ===
  | {
    kind: 'permission_request';
    requestId: string;
    toolName: string;
    toolUseId: string;
    input: Record<string, unknown>;
    display?: PermissionOperationDisplay;
    review?: PermissionReview;
    reviewRef?: LargeValueRef;
    rootToolUseId?: string;
    /** Whether this interaction belongs to root execution, from producer authority. */
    affectsRootActivity?: boolean;
    /** CC's suggested permission rules for "always allow" (echoed back as updatedPermissions) */
    suggestions?: unknown[];
    /** Preserve the Runtime interaction presentation instead of inferring it from a tool name. */
    interactionKind?: 'permission' | 'ask_user' | 'plan_approval';
    defaultToNo?: boolean;
    suppressAlwaysAllowRule?: boolean;
  }
  | {
    kind: 'interactive_request_resolved';
    requestId: string;
    status?: 'applied' | 'already_settled' | 'expired' | 'cancelled';
  }

  // === Session lifecycle ===
  | { kind: 'session_init'; sessionId: string; model: string; tools: string[] }
  | { kind: 'status_change'; state: 'idle' | 'running' | 'waiting_permission' | 'error' }
  | {
    kind: 'turn_complete';
    result?: string;
    status?: string;
    error?: string;
    /** Exact durable operation owner when the Runtime exposes one. */
    clientOperationId?: string;
  }
  | {
    kind: 'session_complete';
    result: string;
    subtype: 'success' | 'error' | 'error_max_turns' | 'error_max_budget';
  }

  // === Metadata ===
  | {
    kind: 'usage';
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    costUsd?: number;
    model?: string;
    modelUsage?: Record<string, ModelUsageEntry>;
    semantics?: 'delta' | 'running_total';
    /**
     * PRD 0.2.32 — 当前 context 占用（最近一次调用 input 系 token），用于 context 用量指示器。
     * **与 `inputTokens` 分开**：`inputTokens` 可能是 running_total（Codex watchdog 依赖它），
     * 而占用必须是「最近一次」。**计算占用是 adapter 的职责**：Codex = `tokenUsage.last.inputTokens`
     * （OpenAI 系，已含 cached、不再加）；Anthropic 系（CC）= 最近一次的 `input + cacheRead + cacheCreation`。
     * external-session 只消费 adapter 显式填的这个字段，**自己不做回退**——缺失则不发 context-usage 事件。
     */
    contextOccupiedTokens?: number;
    /** PRD 0.2.32 — runtime 自报的 context 窗口（Codex `tokenUsage.modelContextWindow`）；不报传 null/省略 → 回落 registry/200K。 */
    runtimeContextWindow?: number | null;
  }
  | {
    kind: 'context_update';
    contextOccupiedTokens: number;
    runtimeContextWindow: number;
  }
  | { kind: 'model_update'; model: string }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string }

  // === Runtime-discovered tools / diagnostics ===
  // Mutable tool discovery is separate from session_init so startup remains a
  // one-time lifecycle event. External session state replays the latest catalog
  // through its system-init snapshot on reconnect.
  | { kind: 'runtime_tool_catalog'; tools: string[] }
  | {
    kind: 'mcp_effective_update';
    configGeneration: number;
    configFingerprint: string;
    catalogGeneration: number;
    browserHostGeneration?: number;
    dispatch: import('../../shared/mcpEffectiveState').McpEffectiveSnapshot['dispatch'];
    servers: import('../../shared/mcpEffectiveState').McpEffectiveServerSnapshot[];
    tools: string[];
    observationStale?: boolean;
  }
  | { kind: 'mcp_startup_admission_ready' }
  | { kind: 'mcp_runtime_replacement_required'; serverId: string }

  // === Runtime diagnostics (issue #194) ===
  // External-runtime self-report (auth state, feature flags, MCP/apps the
  // runtime sees, effective env). Emitted shortly after session_init.
  // Diagnostics remain health/debug data; runtime_tool_catalog owns the tools
  // shown by the composer.
  | { kind: 'runtime_diagnostics'; diagnostics: RuntimeDiagnostics }

  // === Runtime-native todo/plan snapshot ===
  | { kind: 'agent_plan_update'; todos: AgentPlanTodo[] }

  // === Message replay (for session resume) ===
  | { kind: 'message_replay'; message: { id: string; role: string; content: unknown; timestamp?: string } }

  // === Live user message echo ===
  // Codex emits this when a turn/steer input is actually admitted into the
  // active turn. The session layer uses it to promote a realtime queue pill to
  // a visible user bubble; the turn/steer RPC response alone is only transport
  // acknowledgement.
  | { kind: 'user_message_accepted'; clientUserMessageId?: string }
  | { kind: 'user_message_cancelled'; clientUserMessageId: string }

  // === Passthrough for unrecognized events ===
  | { kind: 'native_retraction'; messageIds: string[]; scope?: 'local' | 'session'; parentToolUseId?: string }
  | { kind: 'raw'; data: unknown }) & { nativeSource?: NativeContentSource };

/**
 * Callback for unified events from the runtime
 */
export type UnifiedEventCallback = (event: UnifiedEvent) => void;

export type ConversationBranchBoundary =
  | { kind: 'through-turn'; runtimeTurnId: string }
  | { kind: 'before-turn'; runtimeTurnId: string };

export type ConversationBranchResult =
  | { kind: 'native-thread'; runtimeSessionId: string }
  | { kind: 'fresh-thread' };

export type RuntimeConversationBranchErrorCode =
  | 'capability_unavailable'
  | 'anchor_unavailable'
  | 'native_fork_failed'
  | 'unsubscribe_failed';

export class RuntimeConversationBranchError extends Error {
  constructor(
    readonly code: RuntimeConversationBranchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeConversationBranchError';
  }
}

/**
 * AgentRuntime interface — one implementation per CLI type
 */
/** Tool-free auxiliary text generation; never a Product Session turn. */
export interface RuntimeTextUtilityTask {
  prompt: string;
  systemPrompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AgentRuntime {
  readonly type: RuntimeType;
  runTextUtility?(process: RuntimeProcess, task: RuntimeTextUtilityTask): Promise<string | null>;

  /** How this runtime applies turn-scoped config changes at a safe boundary. */
  getConfigCapabilities?(): RuntimeConfigCapabilities;

  /** Read the effective process configuration without IO; callers snapshot before terminal persistence. */
  getTurnProviderAnalytics?(process: RuntimeProcess): TurnProviderAnalytics;

  /** Check if the CLI is installed and get version info */
  detect(): Promise<RuntimeDetection>;

  /** Read-only resources plus the supplied lifecycle-owned process, if any. */
  inspectRuntime?(process?: RuntimeProcess): Promise<import('../../shared/types/runtime').RuntimeInspection>;

  /** Query available models from the CLI (may spawn a temporary process) */
  queryModels(options?: {
    /** An existing Session process is authoritative over an installed upgrade. */
    process?: RuntimeProcess;
    runtimeSource?: RuntimeSource;
    envPolicy?: RuntimeEnvPolicy;
    signal?: AbortSignal;
  }): Promise<RuntimeModelInfo[]>;

  /** Get the permission modes supported by this runtime */
  getPermissionModes(): RuntimePermissionMode[];

  /**
   * Start a session. Events are delivered via the callback.
   * Returns a RuntimeProcess handle for sending messages and controlling the session.
   */
  startSession(
    options: SessionStartOptions,
    onEvent: UnifiedEventCallback,
  ): Promise<RuntimeProcess>;

  /**
   * Replace the declarative Product extension generation owned by an
   * Integrated DSH process. The adapter preserves desired/effective state
   * when DSH has prepared a candidate that is waiting for an operation
   * boundary.
   */
  replaceDshExtensions?(
    process: RuntimeProcess,
    extensions: DshProductExtensionSource,
  ): Promise<RuntimeExtensionDiagnostics>;

  /** Retry a prepared DSH extension generation at a quiescent boundary. */
  reconcileDshExtensions?(
    process: RuntimeProcess,
  ): Promise<RuntimeExtensionDiagnostics | null>;

  /** Inspect the authoritative Runtime permission policy for this Session. */
  listAgentWork?(process: RuntimeProcess, tasksFor?: string): Promise<RuntimeAgentWorkTree>;
  controlAgentWork?(process: RuntimeProcess, input: RuntimeAgentWorkControl): Promise<void>;
  listPermissionRules?(process: RuntimeProcess): Promise<RuntimePermissionRulesSnapshot>;

  /** Pre-authorize one exact Runtime-owned permission tuple. */
  addPermissionRule?(
    process: RuntimeProcess,
    input: Readonly<{
      expectedRevision: string;
      tool: string;
      permissionClass: string;
      target: string;
    }>,
  ): Promise<RuntimePermissionRuleMutationResult>;

  /** Revoke one exact Runtime-owned permission rule. */
  revokePermissionRule?(
    process: RuntimeProcess,
    input: Readonly<{ expectedRevision: string; ruleId: string }>,
  ): Promise<RuntimePermissionRuleMutationResult>;

  /** Send a follow-up user message to an active session */
  sendMessage(
    process: RuntimeProcess,
    message: string,
    images?: ResolvedImagePayload[],
    options?: {
      clientUserMessageId?: string;
      clientOperationId?: string;
      /** Recovered roots remain turn-boundary-only until their exact terminal settles. */
      allowRealtimeSteer?: boolean;
    },
  ): Promise<void>;

  /** Exact active root and whether this Host generation may steer it in-place. */
  getActiveRootOperation?(process: RuntimeProcess): Readonly<{
    clientOperationId: string;
    clientUserMessageId?: string;
    origin?: 'collaboration';
    realtimeSteerEligible?: boolean;
  }> | null;

  /**
   * Compact the active conversation through the runtime's native control
   * plane. This is intentionally separate from sendMessage(): compaction is a
   * control turn and must never create user/assistant transcript messages.
   */
  compactContext?(process: RuntimeProcess): Promise<void>;

  /** Create a runtime-native conversation branch at a stable root-turn boundary. */
  branchConversation?(
    process: RuntimeProcess,
    boundary: ConversationBranchBoundary,
  ): Promise<ConversationBranchResult>;

  /**
   * Append a user message to the currently active turn instead of starting a
   * new turn. Only runtimes whose protocol exposes same-turn steering should
   * implement this; others fall back to MyAgents' turn-boundary queue.
   */
  canSteerMessage?(process: RuntimeProcess): boolean;

  steerMessage?(
    process: RuntimeProcess,
    message: string,
    images?: ResolvedImagePayload[],
    options?: {
      clientUserMessageId?: string;
      clientOperationId?: string;
      beforeDispatch?: (identity: { clientOperationId: string; inputFingerprint: string }) => Promise<void>;
    },
  ): Promise<void>;

  /** Cancel one identified input; a consumed input cannot be retracted. */
  cancelSteeredMessage?(
    process: RuntimeProcess,
    input: { clientOperationId: string; clientUserMessageId: string },
  ): Promise<'cancelled' | 'delivered'>;

  /** Deliver lossless structured answers when supported by the Runtime. */
  respondAskUserQuestion?(process: RuntimeProcess, requestId: string, answers: AskUserQuestionAnswers | null): Promise<void>;

  /** Respond to a permission request from the runtime */
  respondPermission(
    process: RuntimeProcess,
    requestId: string,
    decision: 'deny' | 'allow_once' | 'always_allow',
    reason?: string,
    /** CC: echoed permission_suggestions for 'always_allow' → updatedPermissions */
    suggestions?: unknown[],
    /** CC: override the tool's input (e.g. AskUserQuestion needs answers injected). Empty = use original. */
    updatedInput?: Record<string, unknown>,
    /**
     * PRD #131 — for CC's `behavior: 'deny'` schema this maps to the SDK
     * `interrupt` field. `true` aborts the assistant turn after the deny
     * tool_result lands (control-transfer tool semantics: AskUserQuestion
     * cancellation, ExitPlanMode rejection, …); `false` (default) only
     * denies this single tool and lets the AI choose another. Other
     * runtimes can ignore — Codex has no equivalent knob today.
     */
    interrupt?: boolean,
  ): Promise<void>;

  /** Tear down the process, preserving whether its owner is stopping or cleaning up a failure. */
  stopSession(process: RuntimeProcess, reason?: 'stop' | 'failure'): Promise<void>;

  /**
   * Interrupt the CURRENT turn WITHOUT killing the process — the runtime emits its normal
   * turn-end event (e.g. Codex `turn/completed`) so the session goes idle and the next queued
   * message can run. Used by force-send ("立即发送") of a queued message. Optional: runtimes
   * whose protocol can't interrupt a turn without ending the session omit it (the caller then
   * falls back to draining once the turn ends on its own). Distinct from stopSession (which
   * closes stdin / tears down the process).
   */
  interruptTurn?(process: RuntimeProcess): Promise<void>;

  /**
   * Apply a model update at the session layer's chosen turn boundary. The
   * actual meaning is declared by getConfigCapabilities(): Codex records
   * next-turn state; per-turn
   * runtimes may omit this because the next spawn reads SessionStartOptions.
   */
  setModel?(process: RuntimeProcess, model: string | undefined): Promise<void>;

  /** Switch the session permission mode according to this runtime's capabilities. */
  setPermissionMode?(process: RuntimeProcess, mode: string | undefined): Promise<void>;

  /**
   * #324 — apply reasoning effort at the session layer's chosen turn boundary.
   * `effort` is a NORMALIZED level (never 'default'); undefined = runtime
   * default. Codex records next-turn process state; Claude Code omits this and
   * rereads SessionStartOptions.reasoningEffort on the next per-turn spawn.
   */
  setReasoningEffort?(process: RuntimeProcess, effort: string | undefined): Promise<void>;
}

/**
 * Runtime rejected a `thread/resume` (Codex) or `session/resume` (DSH) because
 * the persisted runtime-side session no longer exists — the rollout was GC'd,
 * the thread was archived, or the CLI upgraded across an on-disk format change.
 *
 * external-session.ts catches this specifically so it can invalidate the stale
 * pointer (module state + persisted `meta.runtimeSessionId`) and retry fresh
 * without losing the user's message. See issue #105.
 */
export class StaleRuntimeSessionError extends Error {
  readonly isStaleRuntimeSession = true;
  constructor(public readonly runtimeSessionId: string, message: string) {
    super(message);
    this.name = 'StaleRuntimeSessionError';
  }
}
