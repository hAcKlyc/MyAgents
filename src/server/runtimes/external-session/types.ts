import type { AsyncQuestionSet, AsyncQuestionReply } from '../../../shared/asyncUserQuestions';
import type { ToolPermissionOption } from '../../../shared/types/toolPermission';
import type { InteractionScenario } from '../../system-prompt';
import type { ImagePayload } from '../types';
import type { ToolAttachment } from '../../../shared/types/tool-attachment';
import type { LargeValueRef } from '../../utils/large-value-store';
import type { AskUserQuestionInput } from '../../../shared/types/askUserQuestion';
import type { RuntimeType } from '../../../shared/types/runtime';
import type { ExternalRuntimeConfigPatch, ExternalRuntimeConfigSnapshot } from '../types';
import type { MessageUsage, SessionMessage, TurnAnalyticsSource } from '../../types/session';
import type { SystemInitInfo } from '../../../shared/types/system';
import type { ToolDisplayPayload } from '../../../shared/toolDisplay/filePatch';
import type { SessionOrigin } from '../../../shared/session-origin';
import type {
  DispatchGuard,
  TurnOwner,
  TurnTerminalObserver,
} from '../../session-core/turn-queue';
import type { TurnChannelDelivery } from '../../session-core/channel-delivery';
import type { SystemSkillAdmissionRequirement } from '../../../shared/systemSkills';
import type { SubagentLifecycle } from '../../../shared/types/subagent-lifecycle';

export interface PersistToolResultMeta {
  exitCode?: number | null;
  durationMs?: number | null;
  cwd?: string;
  processId?: string | null;
  status?: string;
  largeValueRef?: LargeValueRef;
}

export interface PersistContentBlock {
  asyncQuestions?: AsyncQuestionSet;
  type: 'text' | 'tool_use' | 'thinking' | 'server_tool_use';
  text?: string;
  providerRouteId?: string;
  providerBlockType?: string;
  resultProviderBlockType?: string;
  tool?: {
    id: string;
    name: string;
    input: Record<string, unknown>;
    inputJson?: string;
    isLoading?: boolean;
    result?: string;
    isError?: boolean;
    resultMeta?: PersistToolResultMeta;
    streamIndex: number;
    attachments?: ToolAttachment[];
    display?: ToolDisplayPayload;
    subagentLifecycle?: SubagentLifecycle;
    subagentCalls?: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
      inputJson?: string;
      result?: string;
      isLoading?: boolean;
      isError?: boolean;
      resultMeta?: PersistToolResultMeta;
      attachments?: ToolAttachment[];
    }>;
  };
  thinking?: string;
  thinkingStartedAt?: number;
  thinkingDurationMs?: number;
  thinkingStreamIndex?: number;
  isComplete?: boolean;
}

export type PersistSubagentCall = NonNullable<NonNullable<PersistContentBlock['tool']>['subagentCalls']>[number];

export type ExternalSessionState = 'idle' | 'running' | 'error';

export type ExternalPendingInteractiveRequest =
  | {
    type: 'permission:request';
    data: {
      requestId: string;
      sessionId?: string | null;
      toolName: string;
      toolUseId: string;
      input: string;
      inputRef?: LargeValueRef;
      permissionOptions?: readonly ToolPermissionOption[];
    };
  }
  | {
    type: 'ask-user-question:request';
    data: {
      requestId: string;
      sessionId?: string | null;
      questions: AskUserQuestionInput['questions'];
      previewFormat: 'html' | 'markdown';
    };
  }
  | {
    type: 'exit-plan-mode:request';
    data: {
      requestId: string;
      sessionId?: string | null;
      plan?: string;
      allowedPrompts?: [];
    };
  };

export type ExternalConfigSource =
  | 'runtime-config'
  | 'message-snapshot'
  | 'legacy-model-set'
  | 'legacy-permission-mode-set'
  | 'legacy-reasoning-effort-set'
  | 'desktop'
  | 'im-sync'
  | 'cron-sync'
  | 'adopt-sync';

export interface ExternalConfigUpdateResult {
  success: boolean;
  runtime: RuntimeType;
  status: 'applied' | 'queued' | 'noop';
  warnings: string[];
  error?: string;
}

export interface ExternalConfigApplyResult {
  warnings: string[];
  error?: string;
}

export type ExternalSendResult = {
  queued: boolean;
  error?: string;
  /** The runtime may have consumed the turn and its process could not be stopped. */
  terminationUnconfirmed?: boolean;
};

export interface ExternalUserMessageProjectionState {
  message: SessionMessage;
  surfaceMode: 'chat-replay' | 'queue-started';
  surfaced: boolean;
  inTranscript: boolean;
  persisted: boolean;
  retracted: boolean;
}

export interface ExternalMessageOperation {
  kind: 'message';
  /** Monotonic order assigned when this user intent first enters the queue owner. */
  admissionOrder: number;
  /** Consumption phase chosen at admission; Inbox can join the active turn. */
  deliveryMode: 'realtime' | 'turn';
  inputSource?: 'desktop' | 'im' | 'inbox';
  queueId: string;
  text: string;
  images?: ImagePayload[];
  context: ExternalSendContext;
  runtimeConfig: ExternalRuntimeConfigSnapshot;
  userProjection: ExternalUserMessageProjectionState;
  /** In-memory callback retained when startup recovery requeues this exact operation. */
  deferredDispatchAccepted?: () => void;
  /** Stable Product-minted identity reused by DSH admission and crash recovery. */
  dshClientOperationId?: string;
  /** Dispatch settlement belongs to every operation, including direct error retries. */
  dispatchAcceptance: Promise<ExternalSendResult>;
  settleDispatchAcceptance: (result: ExternalSendResult) => void;
}

export interface ExternalQueuedMessageOperation extends ExternalMessageOperation {
  /** Explicit user force-ahead overrides ordinary first-admission FIFO. */
  forcePriority?: true;
}

export interface ExternalQueuedConfigOperation {
  kind: 'config';
  admissionOrder: number;
  opId: string;
  patch: ExternalRuntimeConfigPatch;
  source: ExternalConfigSource;
}

export type ExternalTurnOperation = ExternalQueuedMessageOperation | ExternalQueuedConfigOperation;

export interface PendingExternalSessionBirth {
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
  runtimeSessionId?: string;
}

export type ExternalMetadataTurnPath = 'fresh-start' | 'resume-start' | 'active-process';

export type ExternalTurnUsage = MessageUsage & { semantics?: 'delta' | 'running_total' };

export interface ExternalAssistantSnapshotState {
  contentBlocks: readonly PersistContentBlock[];
  pendingTextBuffer: string;
  pendingThinkingBlock: PersistContentBlock | null;
  pendingToolInputs: ReadonlyMap<string, { name: string; inputJson: string }>;
  childToolToParent: ReadonlyMap<string, string>;
  pendingSubagentCallsByParent: ReadonlyMap<string, readonly PersistSubagentCall[]>;
  pendingSubagentLifecyclesByParent?: ReadonlyMap<string, SubagentLifecycle>;
  currentAssistantText: string;
}

export interface ExternalSendContext {
  channelPrimaryReminder?: boolean;
  channelSnapshot?: import('../../session-core/channel-context').ChannelTurnSnapshot | null;
  /** DSH uses the Product Provider picker; external CLIs own their Provider. */
  providerRoute?: import('../../../shared/providerRoute').ProviderRoute;
  desktopQuery?: import("../../../shared/agentMentions").DesktopQueryDraft;
  clientRequestId?: string;
  asyncQuestionReply?: AsyncQuestionReply;
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
  /** Per-turn analytics attribution. Does not alter prompt assembly or session materialization. */
  analyticsSource?: TurnAnalyticsSource;
  analyticsOrigin?: SessionOrigin;
  /** Stable session birth origin, used only when this send materializes metadata. */
  birthOrigin?: SessionOrigin;
  permissionMode?: string;
  model?: string;
  /** Raw effort setting from caller. PRESENT = authoritative; absent = unmanaged desktop state. */
  reasoningEffort?: string;
  /** Pattern B — IM trace ID. */
  requestId?: string;
  /** IM router says this sidecar/session id is a newly rotated channel birth. */
  metadataBirthPending?: boolean;
  /** PRD 0.2.18 Session Inbox metadata for cross-session messages. */
  inboxMeta?: import('../../inbox/types').InboxTurnMeta;
  turnBoundaryOnly?: boolean;
  queueId?: string;
  turnOwner?: TurnOwner;
  onTerminal?: TurnTerminalObserver;
  beforeDispatch?: DispatchGuard;
  /** Dependent automation contract, checked against Runtime-native read-back before dispatch. */
  requiredSystemSkill?: SystemSkillAdmissionRequirement;
  channelDelivery: TurnChannelDelivery;
}

export interface ExternalSystemInitPayload {
  info: SystemInitInfo;
  sessionId: string;
  prewarm?: boolean;
  runtime: RuntimeType;
  runtimeSource?: import('../../../shared/types/runtime').RuntimeSource;
}

export interface ExternalTurnPersistenceSnapshot {
  inboxMeta: import('../../inbox/types').InboxTurnMeta | null;
  attachmentHints: string[];
  contextUsage: import('../../../shared/types/context-usage').ContextUsage | null;
  contentBlocks: PersistContentBlock[];
  assistantText: string;
  usage: ExternalTurnUsage | null;
  startedAt: number;
  analyticsSource: TurnAnalyticsSource;
  analyticsOrigin?: SessionOrigin | null;
}
