import { parseLeadingSystemReminder, parseSessionSendRequestDisplay } from './systemReminder';
import type { SessionMessage } from './types/session-message';

export class SessionTextProjectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SessionTextProjectionError';
  }
}

export interface SessionTextMessage {
  id: string;
  role: 'user' | 'assistant';
  timestamp: string;
  content: string;
  turnId?: string;
  transcriptState?: SessionMessage['transcriptState'];
}

function structuredBlocks(content: string): Record<string, unknown>[] | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('[') || !trimmed.includes('"type"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new SessionTextProjectionError(
      'SESSION_CONTENT_UNREADABLE',
      'A structured transcript message is malformed and cannot be projected safely.',
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (block) =>
        block &&
        typeof block === 'object' &&
        typeof (block as { type?: unknown }).type === 'string' &&
        ((block as { type: string }).type !== 'text' ||
          typeof (block as { text?: unknown }).text === 'string'),
    )
  ) {
    throw new SessionTextProjectionError(
      'SESSION_CONTENT_UNREADABLE',
      'A structured transcript message is malformed and cannot be projected safely.',
    );
  }
  return parsed as Record<string, unknown>[];
}

export function strictAssistantText(content: string): string {
  const blocks = structuredBlocks(content);
  if (!blocks) return content;
  return blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n\n');
}

function strictUserText(content: string): string {
  // A user can intentionally send JSON that resembles an assistant block
  // array. Without a typed persisted discriminator, parsing that text would
  // corrupt the user's own words and pagination anchors. Match the chat bubble:
  // visible tail first, then the displayable send.request payload; other pure
  // reminders remain hidden, including result/watch control events.
  const reminder = parseLeadingSystemReminder(content);
  return reminder.visibleText || parseSessionSendRequestDisplay(reminder)?.payload || '';
}

export function projectSessionTextMessage(
  message: SessionMessage,
): SessionTextMessage | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  const content =
    message.role === 'assistant'
      ? strictAssistantText(message.content)
      : strictUserText(message.content);
  if (!content.trim()) return null;
  return {
    id: message.id,
    role: message.role,
    timestamp: message.timestamp,
    content,
    ...(message.turnId ? { turnId: message.turnId } : {}),
    ...(message.transcriptState
      ? { transcriptState: message.transcriptState }
      : {}),
  };
}
