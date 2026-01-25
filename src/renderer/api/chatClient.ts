import type { ContentBlock } from '@/types/chat';
import type {
  ContentBlockStop,
  ThinkingChunk,
  ThinkingStart,
  ToolInputDelta,
  ToolResultComplete,
  ToolResultDelta,
  ToolResultStart,
  ToolUse
} from '@/types/stream';

import type { SendMessagePayload, SendMessageResponse } from '../../shared/types/ipc';
import type { SystemInitInfo } from '../../shared/types/system';
import { onEvent } from './eventBus';
import { getServerUrl, proxyFetch } from './tauriClient';

export type ChatInitPayload = {
  agentDir: string;
  sessionState: 'idle' | 'running' | 'error';
  hasInitialPrompt: boolean;
};

export type ChatMessageReplayPayload = {
  message: {
    id: string;
    role: 'user' | 'assistant';
    content: string | ContentBlock[];
    timestamp: string;
    attachments?: {
      id: string;
      name: string;
      size: number;
      mimeType: string;
      savedPath?: string;
      relativePath?: string;
      previewUrl?: string;
      isImage?: boolean;
    }[];
  };
};

export type ChatStatusPayload = {
  sessionState: 'idle' | 'running' | 'error';
};

export type ChatAgentErrorPayload = {
  message: string;
};

export type ChatSystemInitPayload = {
  info: SystemInitInfo;
};

/**
 * @deprecated chatClient uses global sidecar URL. Prefer TabContext's sendMessage/stopResponse.
 * Get the full URL for an API endpoint using global sidecar
 */
async function getApiUrl(path: string): Promise<string> {
  const baseUrl = await getServerUrl();
  return `${baseUrl}${path}`;
}

/**
 * @deprecated chatClient uses global sidecar URL. Prefer TabContext API.
 * POST JSON using proxyFetch to bypass CORS in Tauri
 */
async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const url = await getApiUrl(path);
  const response = await proxyFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return (await response.json()) as T;
}

export const chatClient = {
  sendMessage: (payload: SendMessagePayload): Promise<SendMessageResponse> =>
    postJson('/chat/send', payload),
  stopMessage: (): Promise<{ success: boolean; error?: string }> => postJson('/chat/stop'),
  onInit: (callback: (payload: ChatInitPayload) => void) => onEvent('chat:init', callback),
  onMessageReplay: (callback: (payload: ChatMessageReplayPayload) => void) =>
    onEvent('chat:message-replay', callback),
  onStatus: (callback: (payload: ChatStatusPayload) => void) => onEvent('chat:status', callback),
  onMessageChunk: (callback: (chunk: string) => void) => onEvent('chat:message-chunk', callback),
  onThinkingStart: (callback: (data: ThinkingStart) => void) =>
    onEvent('chat:thinking-start', callback),
  onThinkingChunk: (callback: (data: ThinkingChunk) => void) =>
    onEvent('chat:thinking-chunk', callback),
  onMessageComplete: (callback: () => void) => onEvent('chat:message-complete', callback),
  onMessageStopped: (callback: () => void) => onEvent('chat:message-stopped', callback),
  onMessageError: (callback: (error: string) => void) => onEvent('chat:message-error', callback),
  onDebugMessage: (callback: (message: string) => void) => onEvent('chat:debug-message', callback),
  onToolUseStart: (callback: (tool: ToolUse) => void) => onEvent('chat:tool-use-start', callback),
  onToolInputDelta: (callback: (data: ToolInputDelta) => void) =>
    onEvent('chat:tool-input-delta', callback),
  onContentBlockStop: (callback: (data: ContentBlockStop) => void) =>
    onEvent('chat:content-block-stop', callback),
  onToolResultStart: (callback: (data: ToolResultStart) => void) =>
    onEvent('chat:tool-result-start', callback),
  onToolResultDelta: (callback: (data: ToolResultDelta) => void) =>
    onEvent('chat:tool-result-delta', callback),
  onToolResultComplete: (callback: (data: ToolResultComplete) => void) =>
    onEvent('chat:tool-result-complete', callback),
  onSubagentToolUse: (callback: (data: { parentToolUseId: string; tool: ToolUse }) => void) =>
    onEvent('chat:subagent-tool-use', callback),
  onSubagentToolInputDelta: (
    callback: (data: { parentToolUseId: string; toolId: string; delta: string }) => void
  ) => onEvent('chat:subagent-tool-input-delta', callback),
  onSubagentToolResultStart: (
    callback: (data: {
      parentToolUseId: string;
      toolUseId: string;
      content: string;
      isError: boolean;
    }) => void
  ) => onEvent('chat:subagent-tool-result-start', callback),
  onSubagentToolResultDelta: (
    callback: (data: { parentToolUseId: string; toolUseId: string; delta: string }) => void
  ) => onEvent('chat:subagent-tool-result-delta', callback),
  onSubagentToolResultComplete: (
    callback: (data: {
      parentToolUseId: string;
      toolUseId: string;
      content: string;
      isError?: boolean;
    }) => void
  ) => onEvent('chat:subagent-tool-result-complete', callback),
  onLogsSnapshot: (callback: (data: { lines: string[] }) => void) => onEvent('chat:logs', callback),
  onLog: (callback: (line: string) => void) => onEvent('chat:log', callback),
  onAgentError: (callback: (payload: ChatAgentErrorPayload) => void) =>
    onEvent('chat:agent-error', callback),
  onSystemInit: (callback: (payload: ChatSystemInitPayload) => void) =>
    onEvent('chat:system-init', callback)
};
