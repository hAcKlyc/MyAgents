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
  WebFetchInput,
  WebSearchInput
} from '@anthropic-ai/claude-agent-sdk/sdk-tools';

import type { ToolUse } from '@/types/stream';

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
  WebFetchInput,
  WebSearchInput,
  NotebookEditInput
};

export type ToolInput =
  | AgentInput
  | BashInput
  | ReadInput
  | WriteInput
  | EditInput
  | GlobInput
  | GrepInput
  | TodoWriteInput
  | WebFetchInput
  | WebSearchInput
  | NotebookEditInput;

export interface SubagentToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  inputJson?: string;
  parsedInput?: ToolInput;
  result?: string;
  isLoading?: boolean;
  isError?: boolean;
}

// Task 工具运行统计
export interface TaskStats {
  toolCount: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ToolUseSimple extends ToolUse {
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
  // Nested tool calls emitted by subagents (Task tool)
  subagentCalls?: SubagentToolCall[];
  // Task tool specific: start time for duration calculation
  taskStartTime?: number;
  // Task tool specific: running statistics
  taskStats?: TaskStats;
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'thinking' | 'server_tool_use';
  text?: string;
  tool?: ToolUseSimple;
  thinking?: string;
  thinkingStartedAt?: number;
  thinkingDurationMs?: number;
  // Stream index for thinking blocks (to track separate thinking streams)
  thinkingStreamIndex?: number;
  // Whether this thinking block is complete (received content_block_stop)
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

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  timestamp: Date;
  attachments?: MessageAttachment[];
}
