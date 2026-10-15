import type { AskUserQuestionAnswers } from '../../shared/types/askUserQuestion';
import type { RuntimeAgentWorkControl, RuntimeAgentWorkTree } from '../../shared/types/subagent-lifecycle';
import type { AsyncQuestionReply } from '../../shared/asyncUserQuestions';
import type { BackgroundAgentPermissionMode, ProxySettings } from '../../shared/config-types';
import type {
  RuntimeConfig,
  RuntimeExtensionDiagnostics,
  RuntimePermissionRuleMutationResult,
  RuntimePermissionRulesSnapshot,
  RuntimePermissionDiagnostics,
  RuntimeSource,
  RuntimeType,
} from '../../shared/types/runtime';
import type { McpServerDefinition } from '../../shared/config-types';
import type { ProviderEnv } from '../provider-types';
import type { InteractionScenario } from '../system-prompt';
import type { SessionSource, TurnAnalyticsSource } from '../types/session';
import type { SessionMessage, SessionMetadata } from '../types/session';
import type { ImagePayload } from '../runtimes/types';
import type { InboxTurnMeta } from '../inbox/types';
import type { ProviderRoute } from '../../shared/providerRoute';
import type { RuntimeBackedProviderIdentity } from '../../shared/providerExecution';
import type { OfficialToolId } from '../../shared/official-tools';
import type { RegisteredAgentSessionOrigin, SessionOrigin } from '../../shared/session-origin';
import type { SessionCompletionTerminal } from '../../shared/sessionCompletion';
import type { RequiredSystemSkill } from '../../shared/systemSkills';
import type { ProductSystemSkillRequirement } from '../../shared/systemSkills';
import type {
  DispatchGuard,
  DesktopDeliveryMode,
  QueueCancelResult,
  TurnIdentity,
  TurnOwner,
  TurnTerminalObserver,
} from '../session-core/turn-queue';
import type { AssistantChannelDelivery } from '../session-core/channel-delivery';
import type { ImBridgeTurnContext } from '../session-core/im-bridge-types';

export type SessionEngineKind = 'builtin' | 'integrated' | 'external';

export type { PermissionMode } from '../agent-session';

export type DesktopMessageRequest = {
  desktopQuery?: import("../../shared/agentMentions").DesktopQueryDraft;
  agentMentions?: import("../../shared/agentMentions").AgentMentionSnapshot[]; primaryContext?: import("../../shared/agentMentions").DesktopPrimaryContext;
  /** Product-only primary context supplied by the Goal owner, never raw XML. */
  queryPrimaryContext?: import("../../shared/agentMentions").QueryPrimaryContext;
  clientRequestId?: string;
  asyncQuestionReply?: AsyncQuestionReply;
  text: string;
  images?: ImagePayload[];
  /** Product mode for builtin sessions; runtime-native mode for external sessions. */
  permissionMode?: string;
  backgroundAgentPermissionMode?: BackgroundAgentPermissionMode;
  model?: string;
  providerRoute?: ProviderRoute;
  providerEnv?: ProviderEnv | 'subscription';
  reasoningEffort?: string;
  sessionId: string;
  workspacePath: string;
  scenario: Extract<InteractionScenario, { type: 'desktop' }>;
  analyticsSource?: TurnAnalyticsSource;
  analyticsOrigin?: SessionOrigin;
  birthOrigin?: SessionOrigin;
  turnBoundaryOnly?: boolean;
  /** Internal queue identity supplied by a domain owner such as Goal. */
  queueId?: string;
  turnOwner?: TurnOwner;
  onTerminal?: TurnTerminalObserver;
  beforeDispatch?: DispatchGuard;
  /** Strong app-owned Skill admission for product workflow turns. */
  requiredSystemSkill?: ProductSystemSkillRequirement;
};

/** Per-send choices; Session/provider/permission authority remains with the engine. */
export type DesktopRetryOptions = Pick<DesktopMessageRequest, 'model' | 'reasoningEffort'>;

export type DesktopAdmissionResult = {
  agentMentionsNeedReselect?: boolean;
  success: boolean;
  queued?: boolean;
  queueId?: string;
  isInFlight?: boolean;
  deliveryMode?: DesktopDeliveryMode;
  canCancel?: boolean;
  canForceExecute?: boolean;
  error?: string;
  status?: number;
  /** Internal dispatch acknowledgement; HTTP serializers must not expose it. */
  dispatchAcceptance?: Promise<{ accepted: boolean; error?: string }>;
};

export type ImMessageRequest = {
  message: string;
  images?: ImagePayload[];
  requestId: string;
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
  permissionMode?: string;
  model?: string;
  providerRoute?: ProviderRoute;
  providerEnv?: ProviderEnv | 'subscription';
  reasoningEffort?: string;
  runtimeConfig?: RuntimeConfig | null;
  metadataBirthPending?: boolean;
  metadata?: { source: SessionSource; sourceId?: string; senderName?: string };
  analyticsOrigin?: SessionOrigin;
  turnBoundaryOnly?: boolean;
  queueId?: string;
  turnOwner?: TurnOwner;
  onTerminal?: TurnTerminalObserver;
  beforeDispatch?: DispatchGuard;
};

export type ImAdmissionResult = {
  success: boolean;
  queued?: boolean;
  error?: string;
  status?: number;
  dispatchAcceptance?: Promise<{ accepted: boolean; error?: string }>;
};

export type ImCancelResult = {
  aborted: boolean;
  mode: 'running' | 'queued' | 'unknown';
};

export type InboxMessageRequest = {
  text: string;
  sessionId: string;
  workspacePath: string;
  scenario?: InteractionScenario;
  inboxMeta?: InboxTurnMeta;
  allowLazySessionMaterialization?: boolean;
  analyticsOrigin?: SessionOrigin;
  birthOrigin?: SessionOrigin;
  /** Stable request/turn identity used by guarded fresh-session admission. */
  queueId?: string;
  /** Final prepared-session claim at the Runtime dispatch boundary. */
  beforeDispatch?: DispatchGuard;
};

export type InboxAdmissionResult = {
  queued: boolean;
  error?: string;
  terminationUnconfirmed?: boolean;
  dispatchAcceptance?: Promise<{ accepted: boolean; error?: string }>;
};

export type BackgroundMessageRequest = {
  text: string;
  images?: ImagePayload[];
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
  permissionMode?: string;
  model?: string;
  providerRoute?: ProviderRoute;
  providerEnv?: ProviderEnv | 'subscription';
  reasoningEffort?: string;
  metadata?: { source: SessionSource; sourceId?: string; senderName?: string };
  analyticsOrigin?: SessionOrigin;
  turnBoundaryOnly?: boolean;
  queueId?: string;
  turnOwner?: TurnOwner;
  onTerminal?: TurnTerminalObserver;
  beforeDispatch?: DispatchGuard;
};

export type InjectedTurnRequest = {
  prompt: string;
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
  metadataBirthPending?: boolean;
  permissionMode?: string;
  model?: string;
  reasoningEffort?: string;
  providerEnv?: ProviderEnv | 'subscription';
  providerRoute?: ProviderRoute;
  /** Ephemeral owner-aware recovery for a route that becomes unavailable at final dispatch. */
  providerRoutingRecovery?: string;
  runtimeConfig?: RuntimeConfig | null;
  metadata?: { source: SessionSource; sourceId?: string; senderName?: string };
  analyticsOrigin?: SessionOrigin;
  /** Explicit owner of any public assistant response produced by this injected turn. */
  assistantChannelDelivery: AssistantChannelDelivery;
  timeoutMs: number;
  pollMs?: number;
  queueId?: string;
  turnOwner?: TurnOwner;
  onTerminal?: TurnTerminalObserver;
  /** Fires once after the exact Runtime queue accepts this turn. */
  onDispatched?: (queueId: string, sessionId: string) => Promise<void> | void;
  /** Final authority check at the runtime promotion boundary. */
  beforeDispatch?: DispatchGuard;
  requiredSystemSkill?: RequiredSystemSkill;
};

export type InjectedTurnResult = {
  success: boolean;
  enqueued?: boolean;
  /** The turn may still be alive and must remain addressable by its exact queue identity. */
  terminationUnconfirmed?: boolean;
  assistantMessagePresent?: boolean;
  text?: string;
  error?: string;
  code?: 'session_bind_failed' | 'configuration_failed' | 'scenario_failed';
  status?: number;
};

export type ScheduledTaskPreparation = {
  kind: 'task';
  initializeSession: boolean;
  model?: string;
  providerId?: string;
  permissionMode?: string;
  runtimeConfig?: RuntimeConfig;
  mcpEnabledServers?: string[];
  requiredSystemSkill?: RequiredSystemSkill;
  beforeDispatch: DispatchGuard;
};

export type ScheduledGoalPreparation = {
  kind: 'goal';
  permissionMode?: string;
};

export type ScheduledTurnPreparationRequest = {
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
  operation: ScheduledTaskPreparation | ScheduledGoalPreparation;
};

export type ScheduledTurnPreparationResult = {
  success: boolean;
  sessionId?: string;
  permissionMode?: string;
  model?: string;
  providerEnv?: ProviderEnv | 'subscription';
  providerRoute?: ProviderRoute;
  /** Ephemeral owner-aware recovery retained through final provider materialization. */
  providerRoutingRecovery?: string;
  runtimeConfig?: RuntimeConfig | null;
  beforeDispatch?: DispatchGuard;
  requiredSystemSkill?: RequiredSystemSkill;
  release?: () => void | Promise<void>;
  error?: string;
  code?: 'session_bind_failed' | 'configuration_failed' | 'scenario_failed';
  status?: number;
};

export type QueueStatusItem = { id: string; messagePreview: string; asyncQuestionReply?: AsyncQuestionReply; agentMentions?: import("../../shared/agentMentions").AgentMentionSnapshot[]; primaryContext?: import("../../shared/agentMentions").DesktopPrimaryContext; canCancel?: boolean; canForceExecute?: boolean };

export type SessionEngineRuntimeIdentity = {
  kind: SessionEngineKind;
  runtime: RuntimeType;
  runtimeSource?: RuntimeSource;
  sessionId: string;
  boundSessionId?: string;
};

export type SessionEngineLiveState = {
  sessionState: string;
  isBusy: boolean;
  /** Work owned by the current Query that can outlive its root product turn. */
  backgroundWorkActive?: boolean;
  /** Actual root-blocking human interaction, not an async child question. */
  waitingForUser?: boolean;
  /** Start of the current product transcript turn; absent during pre-warm. */
  executionStartedAt?: string;
};

export type SessionEngineLatestResult = {
  sessionId: string;
  latestResult: string;
};

export type SessionEnginePendingInteractiveRequest = {
  type: string;
  data: unknown;
};

export type CapabilityOperationAttachment = {
  id: string;
  name: string;
  size?: number;
  mimeType: string;
  path?: string;
  savedPath?: string;
  relativePath?: string;
  previewUrl?: string;
  isImage?: boolean;
};

export type SessionEngineReplayMessage = Omit<SessionMessage, 'content' | 'attachments'> & {
  content: string | unknown[];
  attachments?: CapabilityOperationAttachment[];
};

export type SessionEngineStreamReplaySnapshot = {
  sessionId: string;
  initState: Record<string, unknown>;
  replayMessages: SessionEngineReplayMessage[];
  liveStreamingMessage?: SessionEngineReplayMessage | null;
  systemInitPayload?: unknown;
  mcpEffectiveSnapshot?: import('../../shared/mcpEffectiveState').McpEffectiveSnapshot | null;
  pendingInteractiveRequests: SessionEnginePendingInteractiveRequest[];
};

export type SessionEngineConfigSnapshot = {
  success: true;
  runtime: RuntimeType;
  runtimeSource?: RuntimeSource;
  model: string | null;
  mcpServerIds: string[] | null;
  agentNames: string[] | null;
  enabledPluginIds?: string[] | null;
  extensionStatus?: RuntimeExtensionDiagnostics;
  /** Non-sensitive desired/effective Runtime permission reconciliation. */
  permissionStatus?: RuntimePermissionDiagnostics;
  enabledOfficialToolIds: OfficialToolId[] | null;
  permissionMode: string | null;
  providerId: string | null;
  providerRoute?: ProviderRoute | null;
  providerExecutionIdentity?: RuntimeBackedProviderIdentity | null;
  reasoningEffort: string | null;
};

export type SessionEngineCurrentContext = {
  runtime: RuntimeType;
  sessionId: string | null;
  workspacePath: string | null;
  sessionMeta?: import('../types/session').SessionMetadata | null;
};

export type SessionEngineHeldImConfigSnapshot = {
  model?: string;
  permissionMode?: string;
  providerEnv?: ProviderEnv;
  reasoningEffort?: string;
};

export type SessionEngineSnapshotMaterializePatch = {
  model?: string | null;
  reasoningEffort?: string | null;
  permissionMode?: string | null;
  mcpEnabledServers?: string[] | null;
  enabledPluginIds?: string[] | null;
  enabledOfficialToolIds?: OfficialToolId[] | null;
  providerId?: string | null;
  providerRoute?: ProviderRoute | null;
  providerExecutionIdentity?: RuntimeBackedProviderIdentity | null;
  providerEnvJson?: string | null;
};

export type SessionEngineMaterializePendingResult = {
  success: boolean;
  sessionId?: string;
  metadata?: unknown;
  error?: string;
  status?: number;
};

export type SessionEngineLiveOverlay = {
  isActive: boolean;
  runtime?: RuntimeType;
  snapshotRevision?: number;
  liveStreamingMessage?: SessionMessage | null;
  queuedMessages?: QueueStatusItem[];
  liveSessionState?: string;
  inMemoryMessages?: SessionMessage[];
  pendingInteractiveRequests?: SessionEnginePendingInteractiveRequest[];
};

export type CapabilityOperationResult = {
  desktopQuery?: import("../../shared/agentMentions").DesktopQueryDraft;
  conversationCommitted?: boolean;
  retryQueued?: boolean;
  success: boolean;
  error?: string;
  status?: number;
  content?: string;
  attachments?: CapabilityOperationAttachment[];
  newSessionId?: string;
  agentDir?: string;
  title?: string;
  sessionId?: string;
  text?: string;
  images?: ImagePayload[];
  /** Files intentionally left untouched by SDK rewind link-safety checks. */
  skippedLinks?: number;
  /** Outcome of the independent workspace checkpoint restoration during rewind. */
  fileRewindStatus?: 'complete' | 'partial' | 'failed' | 'not_attempted';
  errorCode?: ConversationOperationErrorCode;
  rewindScope?: 'conversation-only';
};

export type ForkConversationOptions = {
  /** Product Session identity allocated by the caller for transport-loss reconciliation. */
  targetSessionId?: string;
};

export type ConversationOperationErrorCode =
  | 'unsupported_runtime'
  | 'codex_update_required'
  | 'session_busy'
  | 'anchor_unavailable'
  | 'native_fork_failed'
  | 'native_mutation_failed'
  | 'persistence_failed'
  | 'storage_consistency_error'
  | 'restore_failed';

export interface SessionEngine {
  /** Optional runtime-owned, tool-free auxiliary generation; never enqueues a turn. */
  runTextUtility?(task: import('../runtimes/types').RuntimeTextUtilityTask): Promise<string | null>;
  publishTranscriptSaveStatus(status: import('../../shared/sessionTranscript').TranscriptSaveStatus): void;
  kind: SessionEngineKind;
  isBusy(): boolean;
  getRuntimeIdentity(): SessionEngineRuntimeIdentity;
  getLiveSessionState(): SessionEngineLiveState;
  getLatestAssistantResult(): Promise<SessionEngineLatestResult>;
  getStreamReplaySnapshot(): SessionEngineStreamReplaySnapshot;
  getSessionConfigSnapshot(): SessionEngineConfigSnapshot;
  inspectRuntime?(runtime: RuntimeType): Promise<import('../../shared/types/runtime').RuntimeInspection | null>;
  getCurrentSessionContext(): SessionEngineCurrentContext;
  getSessionOrigin(sessionId: string): SessionOrigin | undefined;
  ensureRegisteredAgentSessionOrigin(
    sessionId: string,
    expected: RegisteredAgentSessionOrigin,
  ): Promise<{ success: boolean; metadataExists?: boolean; adoptedLegacyOrigin?: boolean; error?: string }>;
  getCurrentTurnIdentity(): TurnIdentity | null;
  getExecutionTurnId(): string | null;
  getActiveImBridgeTurnContext(): ImBridgeTurnContext | null;
  getSessionCompletionTerminal(): SessionCompletionTerminal | null;
  hasQueuedTurnOwnedBy(owner: TurnOwner): boolean;
  getHeldImConfigSnapshot(): SessionEngineHeldImConfigSnapshot;
  getLiveSessionOverlay(sessionId: string): SessionEngineLiveOverlay;
  sendDesktopMessage(request: DesktopMessageRequest): Promise<DesktopAdmissionResult>;
  /** Run a runtime-native context compaction without adding a transcript turn. */
  compactContext(): Promise<CapabilityOperationResult>;
  retryMcpServer(serverId: string): Promise<import('../../shared/mcpFailure').McpRetryResult>;
  enqueueImMessage(request: ImMessageRequest): Promise<ImAdmissionResult>;
  cancelImRequest(requestId: string, reason?: string): Promise<ImCancelResult>;
  enqueueBackgroundMessage(request: BackgroundMessageRequest): Promise<ImAdmissionResult>;
  enqueueInboxMessage(request: InboxMessageRequest): Promise<InboxAdmissionResult>;
  prepareScheduledTurn(request: ScheduledTurnPreparationRequest): Promise<ScheduledTurnPreparationResult>;
  runInjectedTurn(request: InjectedTurnRequest): Promise<InjectedTurnResult>;
  stopTurn(options?: { preserveQueue?: boolean }): Promise<{ success: boolean; alreadyStopped?: boolean; error?: string }>;
  stopOwnedTurn(owner: TurnOwner): Promise<{ success: boolean; alreadyStopped?: boolean; error?: string }>;
  cancelQueuedMessage(queueId: string): Promise<QueueCancelResult>;
  forceQueuedMessage(queueId: string): Promise<boolean>;
  getQueueStatus(): QueueStatusItem[];
  waitIdle(timeoutMs: number, pollMs?: number): Promise<boolean>;
  applyModelSelection(input: { model: string; providerEnv?: ProviderEnv; reasoningEffort?: string }): Promise<{ success: boolean; status?: string; error?: string }>;
  updateModel(model: string, opts?: { imConfigSync?: boolean }): Promise<{ success: boolean; error?: string }>;
  updatePermissionMode(mode: string): Promise<{ success: boolean; error?: string }>;
  /** Optional because only Runtimes with an authoritative exact-rule API expose it. */
  listAgentWork?(tasksFor?: string): Promise<RuntimeAgentWorkTree>;
  controlAgentWork?(input: RuntimeAgentWorkControl): Promise<void>;
  listPermissionRules?(): Promise<RuntimePermissionRulesSnapshot>;
  addPermissionRule?(input: Readonly<{
    expectedRevision: string;
    tool: string;
    permissionClass: string;
    target: string;
  }>): Promise<RuntimePermissionRuleMutationResult>;
  revokePermissionRule?(input: Readonly<{
    expectedRevision: string;
    ruleId: string;
  }>): Promise<RuntimePermissionRuleMutationResult>;
  updateReasoningEffort(effort: string): Promise<{ success: boolean; error?: string }>;
  updateOfficialToolIds(ids: OfficialToolId[] | null): Promise<{ success: boolean; error?: string; skipped?: string }>;
  updateProxyConfig(proxySettings: ProxySettings | null): Promise<{ success: boolean; error?: string; skipped?: string }>;
  materializePendingDesktopSession(request: {
    workspacePath: string;
    phase?: 'prepare' | 'commit' | 'rollback';
    preparedSessionId?: string;
    snapshotPatch?: SessionEngineSnapshotMaterializePatch;
    origin?: SessionOrigin;
    /** Server-validated creation snapshot; never accepted by the materialize HTTP route. */
    birthSnapshot?: Partial<SessionMetadata>;
  }): Promise<SessionEngineMaterializePendingResult>;
  freezeCurrentSessionForImDetach(options?: {
    metadataBirthPending?: boolean;
    metadataIndexed?: boolean;
  }): Promise<{
    success: boolean;
    sessionId?: string;
    metadata?: unknown;
    error?: string;
  }>;
  respondPermission(
    requestId: string,
    decision: 'deny' | 'allow_once' | 'always_allow',
    reason?: string,
  ): Promise<boolean>;
  respondAskUserQuestion(requestId: string, answers: AskUserQuestionAnswers | null): Promise<boolean>;
  respondPlanApproval(requestId: string, approved: boolean, feedback?: string): Promise<boolean>;
  retryUserMessage(userMessageId: string, options?: DesktopRetryOptions): Promise<CapabilityOperationResult>;
  rewindToUserMessage(userMessageId: string): Promise<CapabilityOperationResult>;
  forkAtAssistantMessage(
    messageId: string,
    options?: ForkConversationOptions,
  ): Promise<CapabilityOperationResult>;
  updateProviderEnv(providerEnv: ProviderEnv | undefined): Promise<{ success: boolean; skipped?: string; error?: string }>;
  updateMcpServers(servers: McpServerDefinition[]): Promise<{ success: boolean; servers?: string[]; skipped?: string; error?: string }>;
  updateAgents(agents: Record<string, unknown>, options?: { forceReload?: boolean }): Promise<{ success: boolean; skipped?: string; error?: string }>;
  updateEnabledPluginIds(ids: string[] | null): Promise<{ success: boolean; enabledIds?: string[] | null; skipped?: string; error?: string }>;
  updateDesktopInteractionScenario(
    scenario: Extract<InteractionScenario, { type: 'desktop' }>,
  ): Promise<{ success: boolean; skipped?: string; error?: string }>;
  resetForNewDesktopSession(workspacePath: string): Promise<{ success: boolean; sessionId?: string; error?: string }>;
  migrateBoundSurfaceSession(
    workspacePath: string,
    options: {
      targetSessionId: string;
      metadataBirthPending?: boolean;
      metadataIndexed?: boolean;
    },
  ): Promise<{ success: boolean; sessionId?: string; error?: string }>;
}
