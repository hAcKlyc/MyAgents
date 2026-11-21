import { toStoredTranscriptMessage, type TranscriptProjection } from '../../shared/sessionTranscript';
import type { SessionMessage } from '../types/session';

export interface MessagePageRequest {
  limit: number;
  before: string | null;
  from: string | null;
}

export function messagePageRequest(url: URL): MessagePageRequest {
  const value = parseInt(url.searchParams.get('limit') ?? '0', 10);
  return { limit: Number.isFinite(value) && value > 0 ? Math.min(value, 500) : 0,
    before: url.searchParams.get('before'), from: url.searchParams.get('from') };
}

export function selectMessagePage<T>(rows: T[], request: MessagePageRequest, idOf: (row: T) => string) {
  const { from, before, limit } = request;
  const totalCount = rows.length;
  if (from) {
    const start = rows.findIndex(row => idOf(row) === from);
    if (start >= 0) return { messages: rows.slice(start), totalCount, hasMoreBefore: start > 0 };
  }
  if (!limit) return { messages: rows, totalCount, hasMoreBefore: false };
  const end = before ? rows.findIndex(row => idOf(row) === before) : totalCount;
  const start = Math.max(0, end - limit);
  return { messages: end < 0 ? [] : rows.slice(start, end), totalCount, hasMoreBefore: start > 0 };
}

export function projectMessagePage(projection: TranscriptProjection, request: MessagePageRequest,
    liveId?: string | null, pending: SessionMessage[] = []) {
  const ids = [...projection.messages.keys()].filter(id => id !== liveId);
  const extra = new Map<string, SessionMessage>();
  for (const row of pending) {
    if (row.id !== liveId && !projection.messages.has(row.id) && !extra.has(row.id)) {
      extra.set(row.id, row);
      ids.push(row.id);
    }
  }
  const page = selectMessagePage(ids, request, id => id);
  return { ...page, messages: page.messages.map(id =>
    extra.get(id) ?? toStoredTranscriptMessage(projection.messages.get(id)!)) };
}
