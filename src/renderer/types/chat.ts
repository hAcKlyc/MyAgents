import type { ExecutionTiming } from '../../shared/executionTiming';
import type { AsyncQuestionSet, AsyncQuestionReply } from '../../shared/asyncUserQuestions';
// Import tool input types from Claude Agent SDK for end-to-end type safety
import type {
  AgentInput,
  BashInput,
  FileEditInput,
  FileReadInput,
  FileWriteInput,
  GlobInput,
  GrepInput,
  NotebookEditInput,
  TodoWriteInput,
  TaskCreateInput,
  TaskUpdateInput,
  TaskGetInput,
  TaskListInput,
  WebFetchInput,
  WebSearchInput
} from '@anthropic-ai/claude-agent-sdk/sdk-tools';

import type { ToolUse } from '@/types/stream';
import type { ToolDisplayPayload } from '../../shared/toolDisplay/filePatch';
import type { ToolAttachment } from '../../shared/types/tool-attachment';
import type { ToolInput } from '../../shared/types/tool-input';
import type { SubagentLifecycle } from '../../shared/types/subagent-lifecycle';

export type { ToolAttachment, ToolAttachmentKind } from '../../shared/types/tool-attachment';
export type { ToolInput } from '../../shared/types/tool-input';

// Re-export SDK types with friendly names
export type ReadInput = FileReadInput;
export type WriteInput = FileWriteInput;
export type EditInput = FileEditInput;

// Re-export other SDK types directly
export type {
  AgentInput,
  BashInput,
  GlobInput,
  GrepInput,
  TodoWriteInput,
  TaskCreateInput,
  TaskUpdateInput,
  TaskGetInput,
  TaskListInput,
  WebFetchInput,
  WebSearchInput,
  NotebookEditInput
};

export type AgentStatusTodoSnapshotStatus = 'pending' | 'in_progress' | 'completed';

export interface AgentStatusTodoSnapshot {
  key: string;
  content: string;
  activeForm: string;
  status: AgentStatusTodoSnapshotStatus;
}

export interface SubagentToolCall {
  executionTiming?: ExecutionTiming;
  id: string;
  name: string;
  input: Record<string, unknown>;
  inputJson?: string;
  parsedInput?: ToolInput;
  result?: string;
  isLoading?: boolean;
  isError?: boolean;
  resultMeta?: ToolResultMeta;
  // Rich-media produced by a nested sub-agent tool (e.g. Codex child running
  // image_generation). Rendered via ToolAttachmentGallery, mirroring the parent
  // tool's `attachments`. Kept in sync with the server persist type in
  // external-session.ts (PersistContentBlock.tool.subagentCalls).
  attachments?: ToolAttachment[];
}

export interface ToolResultMeta {
  exitCode?: number | null;
  durationMs?: number | null;
  cwd?: string;
  processId?: string | null;
  status?: string;
  /** Full result body was moved to the existing `/refs/:id` large-value store. */
  largeValueRef?: {
    kind: 'ref';
    id: string;
    sizeBytes: number;
    mimetype: string;
    preview: string;
    expiresAt: number;
  };
}

// Task 工具运行统计
export interface TaskStats {
  toolCount: number;
  inputTokens: number;
  outputTokens: number;
}

// 后台任务轮询统计
export interface BackgroundTaskStats {
  toolCount: number;
  assistantCount: number;
  userCount: number;
  progressCount: number;
  elapsed: number;  // ms, 从首行到末行时间差
}

export interface ToolUseSimple extends ToolUse {
  executionTiming?: ExecutionTiming;
  // Raw input as it streams in - no parsing, just accumulate the raw string
  inputJson?: string;
  // Parsed input object (populated when inputJson is complete)
  parsedInput?: ToolInput;
  // Tool result content
  result?: string;
  // Whether tool is currently executing
  isLoading?: boolean;
  // Whether tool result is an error
  isError?: boolean;
  // Whether tool was stopped by user (interrupted)
  isStopped?: boolean;
  // Whether tool failed due to error
  isFailed?: boolean;
  // Runtime-specific metadata about the completed tool result
  resultMeta?: ToolResultMeta;
  // Nested tool calls emitted by subagents (Task tool)
  subagentCalls?: SubagentToolCall[];
  // Runtime-neutral lifecycle for CollabAgent cards that own a real child turn.
  subagentLifecycle?: SubagentLifecycle;
  // Task tool specific: start time for duration calculation
  taskStartTime?: number;
  // Task tool specific: running statistics
  taskStats?: TaskStats;
  // PRD 0.2.15 — rich-media attachments (image/audio/pdf/file) produced by the tool.
  // Rendered uniformly via ToolAttachmentGallery; orthogonal to `result` text.
  attachments?: ToolAttachment[];
  // Compact protocol descriptor for specialized tool display. Text/diff bodies
  // stay in the existing input/result channels for history compatibility.
  display?: ToolDisplayPayload;
}

export interface ProviderToolUsePayload extends ToolUse {
  providerRouteId?: string;
  providerBlockType?: string;
}

export interface ContentBlock {
  executionTiming?: ExecutionTiming;
  /** Present on V2 blocks; supplied by the product transcript owner. */
  id?: string;
  asyncQuestions?: AsyncQuestionSet;
  type: 'text' | 'tool_use' | 'thinking' | 'server_tool_use';
  text?: string;
  providerRouteId?: string;
  providerBlockType?: string;
  resultProviderBlockType?: string;
  tool?: ToolUseSimple;
  thinking?: string;
  thinkingStartedAt?: number;
  thinkingDurationMs?: number;
  // Stream index for thinking blocks (to track separate thinking streams)
  thinkingStreamIndex?: number;
  // Closed text/thinking boundary; subsequent deltas must start a new block.
  isComplete?: boolean;
  // Whether this block was stopped by user (interrupted)
  isStopped?: boolean;
  // Whether this block failed due to error
  isFailed?: boolean;
}

export interface MessageAttachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  savedPath?: string;
  relativePath?: string;
  previewUrl?: string;
  isImage?: boolean;
}

export type MessageSource = 'desktop' | `${string}_private` | `${string}_group`;

export interface MessageMetadata {
  clientRequestId?: string;
  source: MessageSource;
  sourceId?: string;
  senderName?: string;
}

export interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface MessageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  providerId?: string;
  model?: string;
  modelUsage?: Record<string, ModelUsageEntry>;
}

export interface Message {
  /** Local send presentation only; never written into the product transcript. */
  deliveryStatus?: 'sending' | 'failed';
  /** Transport loss cannot prove rejection; inspect history before resending. */
  deliveryUnconfirmed?: boolean;
  desktopQuery?: import('../../shared/agentMentions').DesktopQueryDraft;
  turnId?: string;
  transcriptState?: import('../../shared/types/session-message').SessionMessage['transcriptState'];
  asyncQuestionReply?: AsyncQuestionReply;
  id: string;
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  timestamp: Date;
  sdkUuid?: string;  // SDK 分配的 UUID，用于 resumeSessionAt / rewindFiles
  runtimeTurnAnchor?: {
    turnId: string;
    rootUserMessageId: string;
  };
  attachments?: MessageAttachment[];
  /** Message source metadata (IM integration) */
  metadata?: MessageMetadata;
  /**
   * Transient streaming flag: true while the trailing text is the actively-streaming
   * edge (drives the Markdown tail-fade). Set when text deltas arrive, cleared on the
   * text block's content-block-stop — so the fade stops the moment the model finishes
   * the text even if the turn keeps running. Not persisted; meaningless for history.
   */
  streamingTextActive?: boolean;
  /** Usage info for a completed assistant turn. */
  usage?: MessageUsage;
  /** Tool call count in this assistant response. */
  toolCount?: number;
  /** Completed assistant turn duration in milliseconds. */
  durationMs?: number;
}
