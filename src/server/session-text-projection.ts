import { isHistoryVisibleSession, getSessionData } from './SessionStore';
import { getSessionEngine } from './session-engine';
import { managementApi } from './utils/management-api-client';
import { projectSessionActivity } from './session-engine/observation';
import type { SessionMessage } from './types/session';

export { SessionTextProjectionError, projectSessionTextMessage, strictAssistantText } from '../shared/sessionTextProjection';
export type { SessionTextMessage } from '../shared/sessionTextProjection';
import { SessionTextProjectionError, projectSessionTextMessage, type SessionTextMessage } from '../shared/sessionTextProjection';

export function mergeSessionMessagesByIdentity(
  diskMessages: SessionMessage[],
  memoryMessages: SessionMessage[] | undefined,
  streamingMessage: SessionMessage | null | undefined,
): SessionMessage[] {
  const merged = [...diskMessages];
  const indexById = new Map(
    merged.map((message, index) => [message.id, index]),
  );
  for (const message of memoryMessages ?? []) {
    const index = indexById.get(message.id);
    if (index === undefined) {
      indexById.set(message.id, merged.length);
      merged.push(message);
    } else {
      merged[index] = message;
    }
  }
  if (streamingMessage) {
    const index = indexById.get(streamingMessage.id);
    if (index === undefined) merged.push(streamingMessage);
    else merged[index] = streamingMessage;
  }
  return merged;
}

export function paginateSessionTextMessages(
  projected: SessionTextMessage[],
  input: { limit: number; before?: string },
): { messages: SessionTextMessage[]; hasMoreBefore: boolean } {
  let end = projected.length;
  if (input.before) {
    end = projected.findIndex((message) => message.id === input.before);
    if (end < 0) {
      throw new SessionTextProjectionError(
        'SESSION_BEFORE_ANCHOR_NOT_FOUND',
        'The --before transcript message no longer exists in the readable text history. Read the latest page again.',
      );
    }
  }
  const start = Math.max(0, end - input.limit);
  return {
    messages: projected.slice(start, end),
    hasMoreBefore: start > 0,
  };
}

export async function readLocalSessionTextPage(input: {
  sessionId: string;
  limit?: number;
  before?: string;
}): Promise<Record<string, unknown>> {
  const limit = input.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new SessionTextProjectionError(
      'SESSION_LIMIT_INVALID',
      '--limit must be an integer from 1 to 500.',
    );
  }
  const engine = getSessionEngine();
  const session = await getSessionData(input.sessionId);
  const overlay = engine.getLiveSessionOverlay(input.sessionId);
  if (!session && !overlay.isActive) {
    throw new SessionTextProjectionError(
      'SESSION_NOT_FOUND',
      'Session not found.',
    );
  }
  if (
    session &&
    !isHistoryVisibleSession(session) &&
    !(overlay.isActive && session.materializationState === 'prepared')
  ) {
    throw new SessionTextProjectionError(
      'SESSION_NOT_FOUND',
      'Session not found.',
    );
  }

  const storedMessages = session?.messages ?? [];
  const baseMessages =
    session?.transcriptFormat === 2 && overlay.isActive ? [] : storedMessages;
  const merged = mergeSessionMessagesByIdentity(
    baseMessages,
    overlay.isActive ? overlay.inMemoryMessages : undefined,
    overlay.isActive ? overlay.liveStreamingMessage : undefined,
  );
  const projected = merged
    .map(projectSessionTextMessage)
    .filter((message): message is SessionTextMessage => message !== null);

  const { messages, hasMoreBefore } = paginateSessionTextMessages(projected, {
    limit,
    before: input.before,
  });
  return {
    success: true,
    session: {
      id: input.sessionId,
      messages,
      hasMoreBefore,
      isLive: overlay.isActive,
      liveSessionState: overlay.isActive ? projectSessionActivity(engine.getLiveSessionState()) : null,
      snapshotRevision: overlay.snapshotRevision ?? 0,
    },
  };
}

export async function readSessionTextPage(input: {
  sessionId: string;
  limit?: number;
  before?: string;
}): Promise<Record<string, unknown>> {
  const ownerResult = await managementApi(
    '/api/session/text-page',
    'POST',
    input,
    { timeoutMs: 18_000 },
  );
  if (ownerResult.ok !== true) {
    const ownerCode = typeof ownerResult.code === 'string'
      ? ownerResult.code.toUpperCase()
      : 'SESSION_OWNER_UNAVAILABLE';
    throw new SessionTextProjectionError(
      ownerCode.startsWith('SESSION_')
        ? ownerCode
        : 'SESSION_OWNER_UNAVAILABLE',
      typeof ownerResult.error === 'string'
        ? ownerResult.error
        : 'The target Session owner is unavailable.',
    );
  }
  if (ownerResult.active === true) {
    const result = ownerResult.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new SessionTextProjectionError(
        'SESSION_CONTENT_UNREADABLE',
        'The target Session owner returned an invalid text projection.',
      );
    }
    return result as Record<string, unknown>;
  }
  return readLocalSessionTextPage(input);
}
