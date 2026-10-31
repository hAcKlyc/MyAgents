import type { AsyncQuestionReply } from '../asyncUserQuestions';

/**
 * Attachment info for messages
 */
export interface MessageAttachment {
    id: string;
    name: string;
    mimeType: string;
    path: string; // Relative path in attachments directory
}

/**
 * Per-model usage breakdown
 */
export interface ModelUsageEntry {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
}

/**
 * Usage information for assistant messages
 */
export interface MessageUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    /** Provider used for this turn. Legacy messages may omit it and fall back to session metadata. */
    providerId?: string;
    /** Primary model (for backwards compatibility and simple display) */
    model?: string;
    /** Per-model breakdown (for detailed statistics) */
    modelUsage?: Record<string, ModelUsageEntry>;
    /** Builtin SDK's raw cumulative result snapshot. Used only to recover the next Query's usage baseline. */
    sdkCumulativeModelUsage?: Record<string, ModelUsageEntry>;
}

/** Session source: 'desktop' for desktop, '{platform}_{private|group}' for IM/channels (supports bridge plugins with dynamic platform names) */
export type SessionSource = 'desktop' | `${string}_private` | `${string}_group`;

/** Analytics source for a completed AI turn. Kept separate from SessionSource:
 *  SessionSource drives persistence / IM mirroring, while this is per-turn
 *  attribution for product analytics. */
export type TurnAnalyticsSource = 'desktop' | 'floating_ball' | 'cron' | 'im' | 'agent-channel' | 'registeredAgent';

/**
 * Message source metadata (IM integration)
 */
export interface MessageSourceMetadata {
    /** Correlates a desktop send preview with its server-owned user message. */
    clientRequestId?: string;
    source: SessionSource;
    sourceId?: string;
    senderName?: string;
}

/**
 * Simplified message format for storage
 */
export interface SessionMessage {
  desktopQuery?: import("../agentMentions").DesktopQueryDraft;
    asyncQuestionReply?: AsyncQuestionReply;
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    /** V2 product execution and display segment state; absent on legacy rows. */
    turnId?: string;
    transcriptState?: 'streaming' | 'complete' | 'interrupted';
    /** Independent product diagnostic; never represents native conversation content. */
    messageKind?: 'diagnostic';
    sdkUuid?: string;  // SDK 分配的 UUID，用于 resumeSessionAt / rewindFiles
    /** Submitted builtin input correlation. A receipt does not make it a native history anchor. */
    sdkInputUuid?: string;
    /** Exact runtime-native root Turn represented by this terminal assistant row. */
    runtimeTurnAnchor?: RuntimeTurnAnchor;
    runtimeOperationAnchor?: RuntimeOperationAnchor;
    completionState?: 'partial';
    terminalStatus?: 'stopped' | 'error';
    attachments?: MessageAttachment[];
    /** Usage info (only for assistant messages) */
    usage?: MessageUsage;
    /** Tool call count in this response */
    toolCount?: number;
    /** Response duration in milliseconds */
    durationMs?: number;
    /** Message source metadata (IM integration) */
    metadata?: MessageSourceMetadata;
}

export type RuntimeTurnAnchor =
  | {
      turnId: string;
      rootUserMessageId: string;
      origin?: 'user';
      clientOperationId?: string;
    }
  | {
      turnId: string;
      origin: 'collaboration';
      clientOperationId: string;
      rootUserMessageId?: never;
    };

export interface RuntimeOperationAnchor {
  runtime: 'dsh';
  clientOperationId: string;
  runtimeSessionId: string;
}
