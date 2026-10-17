import type { SessionMessage } from '../types/session';
import {
  LOCAL_COMMAND_OUTPUT_TAG,
  SESSION_EVENT_TAG,
  SPACE_ISSUE_CONTEXT_TAG,
  parseLeadingSystemReminder,
} from '../../shared/systemReminder';
import {
  normalizeSessionOrigin,
  type SessionOrigin,
} from '../../shared/session-origin';

export const CLIENT_HISTORY_AUXILIARY_MAX_BYTES = 256 * 1024;
const MAX_JSON_SHRINK_DEPTH = 8;

interface StructuredShrinkLimits {
  thinkingBytes: number;
  toolStringBytes: number;
  parsedInputStringBytes: number;
  rawToolStringBytes: number;
  jsonArrayItems: number;
  omitDuplicateInput: boolean;
  minimalToolDetails: boolean;
}

const STRUCTURED_SHRINK_PASSES: StructuredShrinkLimits[] = [
  {
    thinkingBytes: 8 * 1024,
    toolStringBytes: 2 * 1024,
    parsedInputStringBytes: 2 * 1024,
    rawToolStringBytes: 4 * 1024,
    jsonArrayItems: 80,
    omitDuplicateInput: true,
    minimalToolDetails: false,
  },
  {
    thinkingBytes: 2 * 1024,
    toolStringBytes: 768,
    parsedInputStringBytes: 768,
    rawToolStringBytes: 1024,
    jsonArrayItems: 40,
    omitDuplicateInput: true,
    minimalToolDetails: false,
  },
  {
    thinkingBytes: 1024,
    toolStringBytes: 256,
    parsedInputStringBytes: 256,
    rawToolStringBytes: 384,
    jsonArrayItems: 20,
    omitDuplicateInput: true,
    minimalToolDetails: false,
  },
  {
    thinkingBytes: 512,
    toolStringBytes: 192,
    parsedInputStringBytes: 192,
    rawToolStringBytes: 256,
    jsonArrayItems: 12,
    omitDuplicateInput: true,
    minimalToolDetails: true,
  },
];

function utf8Size(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function sliceUtf8(value: string, maxBytes: number, fromEnd = false): string {
  if (maxBytes <= 0 || value.length === 0) return '';
  if (utf8Size(value) <= maxBytes) return value;

  let lo = 0;
  let hi = value.length;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = fromEnd ? value.slice(value.length - mid) : value.slice(0, mid);
    if (utf8Size(candidate) <= maxBytes) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return fromEnd ? value.slice(value.length - best) : value.slice(0, best);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function truncateStringForHistory(value: string, maxBytes: number): string {
  const size = utf8Size(value);
  if (size <= maxBytes) return value;

  const marker = `\n\n... [history display truncated: original ${formatBytes(size)}; full content is preserved in the local session file]`;
  const markerBytes = utf8Size(marker);
  const headBytes = Math.max(0, maxBytes - markerBytes);
  return `${sliceUtf8(value, headBytes)}${marker}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStructuredBlockArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((block) => isRecord(block) && typeof block.type === 'string');
}

function parseStructuredBlocks(content: string): Record<string, unknown>[] | null {
  if (!content.startsWith('[') || !content.includes('"type"')) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    return isStructuredBlockArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractTextPreview(content: string, maxLen: number): string {
  const blocks = parseStructuredBlocks(content);
  if (blocks) {
    return blocks
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('')
      .slice(0, maxLen);
  }
  return content.slice(0, maxLen);
}

export function resolveVisibleUserTurnText(text: string): string | null {
  const reminder = parseLeadingSystemReminder(text);
  if (!reminder.hasReminder) {
    return text;
  }
  if (reminder.visibleText) return reminder.visibleText;
  return null;
}

/**
 * Whether a persisted user row represents a human-authored query. This is for
 * Memory and human-query analytics only; Session activity/recency is owned by
 * the admitted turn lifecycle and must not use this classifier.
 */
export function isHumanUserMessage(
  message: Pick<SessionMessage, 'content' | 'attachments'>,
  origin?: SessionOrigin,
): boolean {
  const reminder = parseLeadingSystemReminder(message.content);
  if (
    reminder.kind === 'MEMORY_UPDATE'
    || reminder.kind === 'HEARTBEAT'
    || reminder.kind === 'CRON_TASK'
    || reminder.kind === SPACE_ISSUE_CONTEXT_TAG
    || reminder.kind === LOCAL_COMMAND_OUTPUT_TAG
    || reminder.kind === SESSION_EVENT_TAG
  ) {
    return false;
  }
  const normalizedOrigin = normalizeSessionOrigin(origin);
  const hasKnownOrigin = Boolean(
    normalizedOrigin
    && (normalizedOrigin.kind !== 'unknown' || normalizedOrigin.surface !== 'unknown'),
  );
  if (hasKnownOrigin) {
    if (
      normalizedOrigin!.kind === 'automation'
      || normalizedOrigin!.kind === 'registered-agent'
      || normalizedOrigin!.kind === 'session-inbox'
      || normalizedOrigin!.surface === 'memory_update'
      || normalizedOrigin!.surface === 'channel_heartbeat'
    ) return false;
  }

  const hasVisibleText = reminder.hasReminder
    ? reminder.visibleText.trim().length > 0
    : message.content.trim().length > 0;
  return hasVisibleText || Boolean(message.attachments?.length);
}

export function resolveLastVisibleTurnPreview(
  messages: Pick<SessionMessage, 'role' | 'content'>[],
  maxLen = 60,
): { found: boolean; preview?: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const reminder = parseLeadingSystemReminder(msg.content);
    if (reminder.kind === LOCAL_COMMAND_OUTPUT_TAG || reminder.kind === SESSION_EVENT_TAG) continue;
    const visibleText = resolveVisibleUserTurnText(msg.content);
    if (visibleText === null) continue;
    const preview = extractTextPreview(visibleText, maxLen).trim();
    if (!preview) continue;
    return {
      found: true,
      preview,
    };
  }

  return { found: false };
}

function shrinkJsonValueForHistory(value: unknown, maxStringBytes: number, maxArrayItems: number, depth = 0): unknown {
  if (typeof value === 'string') {
    return truncateStringForHistory(value, maxStringBytes);
  }
  if (typeof value !== 'object' || value === null) return value;

  if (depth >= MAX_JSON_SHRINK_DEPTH) {
    return '[history display truncated: nested value too deep; full content is preserved in the local session file]';
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, maxArrayItems)
      .map((item) => shrinkJsonValueForHistory(item, maxStringBytes, maxArrayItems, depth + 1));
    if (value.length > maxArrayItems) {
      items.push(`[history display truncated: omitted ${value.length - maxArrayItems} array items]`);
    }
    return items;
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = shrinkJsonValueForHistory(child, maxStringBytes, maxArrayItems, depth + 1);
  }
  return output;
}

function shrinkJsonStringForHistory(value: string, maxStringBytes: number, maxArrayItems: number, rawStringBytes: number): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    return JSON.stringify(shrinkJsonValueForHistory(parsed, maxStringBytes, maxArrayItems), null, 2);
  } catch {
    return truncateStringForHistory(value, rawStringBytes);
  }
}

function shrinkToolForHistory(tool: Record<string, unknown>, limits: StructuredShrinkLimits): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(tool)) {
    if (limits.minimalToolDetails && (key === 'input' || key === 'parsedInput' || key === 'inputJson')) {
      continue;
    }

    if (limits.omitDuplicateInput && key === 'input' && typeof tool.inputJson === 'string') {
      continue;
    }

    if (key === 'result' || key === 'inputJson') {
      output[key] = typeof value === 'string'
        ? shrinkJsonStringForHistory(value, limits.toolStringBytes, limits.jsonArrayItems, limits.rawToolStringBytes)
        : shrinkJsonValueForHistory(value, limits.toolStringBytes, limits.jsonArrayItems);
      continue;
    }

    if (key === 'parsedInput' || key === 'input' || key === 'subagentCalls') {
      output[key] = shrinkJsonValueForHistory(value, limits.parsedInputStringBytes, limits.jsonArrayItems);
      continue;
    }

    if (typeof value === 'string') {
      output[key] = truncateStringForHistory(value, limits.rawToolStringBytes);
    } else if (typeof value === 'object' && value !== null) {
      output[key] = shrinkJsonValueForHistory(value, limits.toolStringBytes, limits.jsonArrayItems);
    } else {
      output[key] = value;
    }
  }

  return output;
}

function shrinkStructuredBlocksForHistory(
  blocks: Record<string, unknown>[],
  limits: StructuredShrinkLimits,
): Record<string, unknown>[] {
  return blocks.map((block) => {
    const output: Record<string, unknown> = { ...block };

    if (typeof output.thinking === 'string') {
      output.thinking = truncateStringForHistory(output.thinking, limits.thinkingBytes);
    }
    if (isRecord(output.tool)) {
      output.tool = shrinkToolForHistory(output.tool, limits);
    }

    return output;
  });
}

function shrinkStructuredContentForClient(content: string): string | null {
  const blocks = parseStructuredBlocks(content);
  if (!blocks) return null;

  // The budget belongs to auxiliary history, never to user-visible prose.
  // HTTP/SSE transports own spilling a large complete body to /refs/:id.
  const auxiliarySize = (items: Record<string, unknown>[]) => utf8Size(JSON.stringify(
    items.filter(block => typeof block.text !== 'string'),
  ));
  if (auxiliarySize(blocks) <= CLIENT_HISTORY_AUXILIARY_MAX_BYTES) return content;
  for (const limits of STRUCTURED_SHRINK_PASSES) {
    const shrunk = shrinkStructuredBlocksForHistory(blocks, limits);
    if (auxiliarySize(shrunk) <= CLIENT_HISTORY_AUXILIARY_MAX_BYTES) {
      return JSON.stringify(shrunk);
    }
  }

  const minimalBlocks = blocks.map((block) => {
    if (typeof block.text === 'string') return block;
    const output: Record<string, unknown> = {
      type: block.type,
      ...(typeof block.id === 'string' ? { id: block.id } : {}),
    };
    if (typeof block.thinking === 'string') {
      output.thinking = truncateStringForHistory(block.thinking, 512);
      output.isComplete = block.isComplete;
      output.thinkingDurationMs = block.thinkingDurationMs;
    }
    if (isRecord(block.tool)) {
      const tool: Record<string, unknown> = {};
      for (const key of ['id', 'name', 'isLoading', 'isError', 'isStopped', 'isFailed', 'streamIndex']) {
        if (key in block.tool) tool[key] = block.tool[key];
      }
      if (typeof block.tool.result === 'string') {
        tool.result = truncateStringForHistory(block.tool.result, 256);
      }
      output.tool = tool;
    }
    return output;
  });

  if (auxiliarySize(minimalBlocks) <= CLIENT_HISTORY_AUXILIARY_MAX_BYTES) return JSON.stringify(minimalBlocks);
  return JSON.stringify(capBlockCountForHistory(minimalBlocks, CLIENT_HISTORY_AUXILIARY_MAX_BYTES));
}

/** Keep head/tail auxiliary blocks, and EVERY prose block at its original position. */
function capBlockCountForHistory(
  blocks: Record<string, unknown>[],
  maxBytes: number,
): Record<string, unknown>[] {
  const auxiliary = blocks.flatMap((block, index) => typeof block.text === 'string' ? [] : [index]);
  const retained = new Set<number>();
  let used = 2;
  let lo = 0;
  let hi = auxiliary.length - 1;
  let takeHead = true;
  while (lo <= hi) {
    const index = auxiliary[takeHead ? lo : hi];
    const cost = utf8Size(JSON.stringify(blocks[index])) + 1;
    if (used + cost > Math.floor(maxBytes * 0.9)) break;
    used += cost;
    retained.add(index);
    if (takeHead) lo++; else hi--;
    takeHead = !takeHead;
  }
  const omitted = auxiliary.length - retained.size;
  let marked = false;
  return blocks.flatMap((block, index) => {
    if (typeof block.text === 'string' || retained.has(index)) return [block];
    if (marked) return [];
    marked = true;
    return [{
      type: 'text',
      text: `\n... [history display truncated: ${omitted} auxiliary blocks omitted; full content is preserved in the local session file] ...\n`,
    }];
  });
}

export function shrinkSessionMessageForClient(message: SessionMessage): SessionMessage {
  const size = utf8Size(message.content);
  if (size <= CLIENT_HISTORY_AUXILIARY_MAX_BYTES) return message;

  const structuredContent = shrinkStructuredContentForClient(message.content);
  const content = structuredContent ?? message.content;

  return { ...message, content };
}

export function shrinkSessionMessagesForClient(messages: SessionMessage[]): SessionMessage[] {
  return messages.map(shrinkSessionMessageForClient);
}

/** Same auxiliary projection as REST, preserving the legacy string/array shape. */
export function shrinkReplayContentForClient(content: string | unknown[]): string | unknown[] {
  const serialized = typeof content === 'string' ? content : JSON.stringify(content);
  if (utf8Size(serialized) <= CLIENT_HISTORY_AUXILIARY_MAX_BYTES) return content;
  const shrunk = shrinkStructuredContentForClient(serialized);
  if (shrunk === null || shrunk === serialized) return content;
  return typeof content === 'string' ? shrunk : JSON.parse(shrunk) as unknown[];
}
