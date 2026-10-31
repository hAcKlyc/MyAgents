import type { SessionMessage } from '../types/session';
import type { ContentBlock, MessageWire } from './types';

/** Product filtering is identical for legacy rows and V2 full-block confirmation. */
export const PLAYWRIGHT_RESULT_SENTINEL = '[playwright_result_stripped]';

export function stripPlaywrightResults(content: ContentBlock[]): ContentBlock[] {
  return content.map(block => {
    if (
      block.type === 'tool_use' &&
      block.tool?.name.startsWith('mcp__playwright__') &&
      block.tool.result &&
      block.tool.result !== PLAYWRIGHT_RESULT_SENTINEL
    ) {
      return { ...block, tool: { ...block.tool, result: PLAYWRIGHT_RESULT_SENTINEL } };
    }
    return block;
  });
}

export function messageWireToSessionMessage(msg: MessageWire): SessionMessage {
  const contentForDisk = typeof msg.content === 'string'
    ? msg.content
    : JSON.stringify(stripPlaywrightResults(msg.content));
  const isAssistant = msg.role === 'assistant';
  return {
    id: msg.id,
    role: msg.role,
    content: contentForDisk,
    timestamp: msg.timestamp,
    ...(msg.turnId ? { turnId: msg.turnId } : {}),
    ...(msg.transcriptState ? { transcriptState: msg.transcriptState } : {}),
    ...(msg.messageKind ? { messageKind: msg.messageKind } : {}),
    sdkUuid: msg.sdkUuid,
    sdkInputUuid: msg.sdkInputUuid,
    attachments: msg.attachments?.map((att) => ({
      id: att.id,
      name: att.name,
      mimeType: att.mimeType,
      path: att.relativePath ?? '',
    })),
    metadata: msg.metadata,
    desktopQuery: msg.desktopQuery,
    usage: isAssistant ? msg.usage : undefined,
    toolCount: isAssistant ? msg.toolCount : undefined,
    durationMs: isAssistant ? msg.durationMs : undefined,
  };
}

export function sessionMessageToMessageWire(storedMsg: SessionMessage): MessageWire {
  let parsedContent: string | ContentBlock[] = storedMsg.content;
  if (storedMsg.content.startsWith('[')) {
    try {
      const parsed = JSON.parse(storedMsg.content);
      if (Array.isArray(parsed)) {
        parsedContent = parsed as ContentBlock[];
      }
    } catch {
      // Keep as string if parse fails.
    }
  }
  return {
    id: storedMsg.id,
    role: storedMsg.role,
    content: parsedContent,
    timestamp: storedMsg.timestamp,
    ...(storedMsg.turnId ? { turnId: storedMsg.turnId } : {}),
    ...(storedMsg.transcriptState ? { transcriptState: storedMsg.transcriptState } : {}),
    ...(storedMsg.messageKind ? { messageKind: storedMsg.messageKind } : {}),
    sdkUuid: storedMsg.sdkUuid,
    sdkInputUuid: storedMsg.sdkInputUuid,
    attachments: storedMsg.attachments?.map((att) => ({
      id: att.id,
      name: att.name,
      size: 0,
      mimeType: att.mimeType,
      relativePath: att.path,
    })),
    metadata: storedMsg.metadata,
    desktopQuery: storedMsg.desktopQuery,
    usage: storedMsg.usage,
    toolCount: storedMsg.toolCount,
    durationMs: storedMsg.durationMs,
  };
}
