import type { TurnProviderAnalytics } from '../session-core/turn-analytics';
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  BackgroundAgentPermissionMode,
  PermissionMode as SharedPermissionMode,
} from '../../shared/config-types';
import type { ToolDisplayPayload } from '../../shared/toolDisplay/filePatch';
import type { ToolAttachment } from '../../shared/types/tool-attachment';
import type { ToolInput } from '../../shared/types/tool-input';
import type { SystemInitInfo } from '../../shared/types/system';
import type { SessionOrigin } from '../../shared/session-origin';
import type { InboxTurnMeta } from '../inbox/types';
import type { ImagePayload } from '../runtimes/types';
import type { MessageUsage, SessionSource, TurnAnalyticsSource } from '../types/session';
import type { MirrorImage } from '../utils/im-mirror';
import type { ProviderEnv } from '../provider-types';
import type {
  DispatchGuard,
  DesktopDeliveryMode,
  TurnOwner,
  TurnTerminalObserver,
} from '../session-core/turn-queue';
import type { SessionActivityTurnFacts } from '../session-core/session-activity-policy';
import type { SessionMaterializationScenario } from '../utils/session-materialization';
import type { TurnChannelDelivery } from '../session-core/channel-delivery';

export type BuiltinSessionState = 'idle' | 'starting' | 'running' | 'error';

export type PermissionMode = SharedPermissionMode | 'custom';

export type ToolUseState = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  streamIndex: number;
  inputJson?: string;
  parsedInput?: ToolInput;
  result?: string;
  isLoading?: boolean;
  isError?: boolean;
  subagentCalls?: SubagentToolCall[];
  /** Gemini thinking models: opaque signature that must be round-tripped on tool calls */
  thought_signature?: string;
  /** Rich-media produced by builtin media tools, normalized into the same attachment channel as Codex runtime. */
  attachments?: ToolAttachment[];
  /** Compact display protocol. Large text bodies remain in input/result. */
  display?: ToolDisplayPayload;
};

export type SubagentToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  streamIndex?: number;
  inputJson?: string;
  parsedInput?: ToolInput;
  result?: string;
  isLoading?: boolean;
  isError?: boolean;
  /** Gemini thinking models: opaque signature that must be round-tripped on tool calls */
  thought_signature?: string;
};

export type ContentBlock = {
  type: 'text' | 'tool_use' | 'thinking' | 'server_tool_use';
  text?: string;
  tool?: ToolUseState;
  thinking?: string;
  thinkingStartedAt?: number;
  thinkingDurationMs?: number;
  thinkingStreamIndex?: number;
  isComplete?: boolean;
};

export type MessageWireAttachment = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  savedPath?: string;
  relativePath?: string;
  previewUrl?: string;
  isImage?: boolean;
};

export type MessageWire = {
  desktopQuery?: import("../../shared/agentMentions").DesktopQueryDraft;
  id: string;
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  timestamp: string;
  turnId?: string;
  transcriptState?: 'streaming' | 'complete' | 'interrupted';
  messageKind?: 'diagnostic';
  sdkUuid?: string;
  sdkInputUuid?: string;
  attachments?: MessageWireAttachment[];
  metadata?: {
    clientRequestId?: string;
    source: SessionSource;
    sourceId?: string;
    senderName?: string;
  };
  usage?: MessageUsage;
  toolCount?: number;
  durationMs?: number;
};

type DeferredUserSurfaceBase = {
  message: MessageWire;
  sessionBirthOrigin?: SessionOrigin;
  mirrorImages?: MirrorImage[];
  channelDelivery: TurnChannelDelivery;
};

export type DeferredUserSurface = DeferredUserSurfaceBase & (
  | { event: 'message-replay' }
  | { event: 'queue-started'; queueId: string; midTurnBreak?: boolean }
);

export type BuiltinRestartReason =
  | 'mcp'
  | 'agents'
  | 'official-tools'
  | 'provider'
  | 'proxy'
  | 'oauth'
  | 'model-window'
  | 'model-aliases'
  | 'provider-history'
  | 'plugins'
  | 'capabilities';

export type { TurnProviderAnalytics } from '../session-core/turn-analytics';

export type MessageQueueItem = {
  channelSnapshot?: import('../session-core/channel-context').ChannelTurnSnapshot | null;
  channelPrimaryReminder?: boolean;
  surfacedUserMessageId?: string;
  mirrorImages?: MirrorImage[];
  metadata?: MessageWire['metadata'];
  id: string;
  message: SDKUserMessage['message'];
  messageText: string;
  desktopQuery?: import("../../shared/agentMentions").DesktopQueryDraft;
  wasQueued: boolean;
  deliveryMode?: DesktopDeliveryMode;
  resolve: () => void;
  attachments?: MessageWire['attachments'];
  requestId?: string;
  analyticsSource?: TurnAnalyticsSource;
  analyticsOrigin?: SessionOrigin;
  sessionBirthOrigin?: SessionOrigin;
  providerAnalytics?: TurnProviderAnalytics;
  inputSource?: 'inbox';
  inboxMeta?: InboxTurnMeta;
  turnOwner?: TurnOwner;
  onTerminal?: TurnTerminalObserver;
  beforeDispatch?: DispatchGuard;
  channelDelivery: TurnChannelDelivery;
  /** SessionStore work held until the runtime admission commit for guarded turns. */
  deferredSessionMetadata?: {
    scenario: SessionMaterializationScenario;
    origin?: SessionOrigin;
    allowLazyMaterialization: boolean;
  };
  /** Frozen at the runtime admission seam for terminal activity policy. */
  activityFacts?: SessionActivityTurnFacts;
  /** User history/UI side effects held until a dispatch guard accepts. */
  deferredUserSurface?: DeferredUserSurface;
  /** Infrastructure admission must stay invisible until its final guard commits. */
  deferVisibleAdmission?: boolean;
  settleDispatchAcceptance?: (result: { accepted: boolean; error?: string }) => void;
  transientProviderRetry?: {
    rootQueueId: string;
    attempt: number;
  };
};

export type TurnBoundaryQueueItem = {
  queueId: string;
  ready: boolean;
  /** Cancellation owner while an infrastructure turn is still in preflight. */
  admissionTicket?: TurnAdmissionTicket;
  sourceItem?: MessageQueueItem;
  messageText: string;
  desktopQuery?: import("../../shared/agentMentions").DesktopQueryDraft;
  attachments?: MessageWire['attachments'];
  requestId?: string;
  source?: SessionSource;
  analyticsSource?: TurnAnalyticsSource;
  analyticsOrigin?: SessionOrigin;
  mirrorImages?: MirrorImage[];
};

export type TurnAdmissionTicket = {
  queueId: string;
  requestId?: string;
  createdAt: number;
  messageText: string;
  desktopQuery?: import("../../shared/agentMentions").DesktopQueryDraft;
  turnOwner?: TurnOwner;
  onTerminal?: TurnTerminalObserver;
  beforeUserPersistence?: DispatchGuard;
  beforeDispatch?: DispatchGuard;
  settleDispatchAcceptance?: (result: { accepted: boolean; error?: string }) => void;
  canceled: boolean;
  /** Exact guard rollback started by cancellation; shared by overlapping cancel owners. */
  cancellationSettlement?: Promise<void>;
};

export type InFlightMetadata = {
  metadata?: MessageWire['metadata'];
  messageText: string;
  desktopQuery?: import("../../shared/agentMentions").DesktopQueryDraft;
  attachments?: MessageWire['attachments'];
  requestId?: string;
  source?: SessionSource;
  analyticsSource?: TurnAnalyticsSource;
  analyticsOrigin?: SessionOrigin;
  mirrorImages?: MirrorImage[];
  channelDelivery: TurnChannelDelivery;
};

export type BuiltinTurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model?: string;
  modelUsage?: MessageUsage['modelUsage'];
  sdkCumulativeModelUsage?: MessageUsage['sdkCumulativeModelUsage'];
};

export type BuiltinLifecycleSnapshot = {
  querySession: Query | null;
  queryGeneration: number;
  queryMcpRevision: number;
  queryMcpFingerprint: string | null;
  queryMcpServerIds: string[];
  queryMcpMutationInFlight: boolean;
  isProcessing: boolean;
  abortRequested: boolean;
  sessionTerminationPromise: Promise<void> | null;
  abortCleanupInFlight: boolean;
  isPreWarming: boolean;
  preWarmTimer: ReturnType<typeof setTimeout> | null;
  preWarmFailCount: number;
  preWarmDisabled: boolean;
  systemInitInfo: SystemInitInfo | null;
  sdkControlReady: boolean;
  hasMessageResolver: boolean;
};

export type BuiltinConfigSnapshot = {
  mcpServers: import('../../shared/config-types').McpServerDefinition[] | null;
  enabledPluginIds: string[] | null;
  enabledOfficialToolIds: import('../../shared/official-tools').OfficialToolId[] | null;
  agentDefinitions: Record<string, import('@anthropic-ai/claude-agent-sdk').AgentDefinition> | null;
  permissionMode: PermissionMode;
  prePlanPermissionMode: PermissionMode | null;
  backgroundAgentPermissionMode: BackgroundAgentPermissionMode;
  model: string | undefined;
  reasoningEffort: string | undefined;
  providerEnv: ProviderEnv | undefined;
  pendingProviderHistoryBoundaryReset: boolean;
  frozenSdkMcpFingerprint: string;
  capabilitySnapshot: import('../../shared/projectCapabilities').EffectiveProjectCapabilitySnapshot | null;
  deferredRestartReasons: BuiltinRestartReason[];
};

export type BuiltinTurnStartContext = {
  startedAt: number;
  inboxMeta?: InboxTurnMeta;
  providerAnalytics?: TurnProviderAnalytics;
  images?: ImagePayload[];
};

export type TranscriptMessageSequence = {
  next(): number;
  reset(value?: number): void;
  current(): number;
};
