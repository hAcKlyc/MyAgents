import { useEffect, useState } from 'react';
import type { Message } from '@/types/chat';
import { isPendingSessionId } from '../../shared/constants';
import { cleanNextPromptSuggestion, type NextPromptSuggestionResponse } from '../../shared/nextPromptSuggestion';

export interface NextPromptDraft {
  key: string;
  sessionId: string;
  text: string | null;
  unavailable?: boolean;
}

interface Options {
  sessionId: string | null;
  messages: readonly Message[];
  enabled: boolean;
  /** Runtime/provider/workspace identity changes invalidate an in-flight result. */
  scope: string;
  apiPost: <T>(path: string, body?: unknown, opts?: { signal?: AbortSignal }) => Promise<T>;
}

/** A utility result never enters chat history or the executable composer value. */
export function useNextPromptSuggestion({ sessionId, messages, enabled, scope, apiPost }: Options): NextPromptDraft | undefined {
  const last = messages.at(-1);
  const anchorId = enabled && sessionId && !isPendingSessionId(sessionId)
    && last?.role === 'assistant' && last.transcriptState !== 'streaming'
    && last.transcriptState !== 'interrupted' && !last.streamingTextActive
    && (typeof last.content === 'string' ? last.content.trim() : last.content.some(block => block.type === 'text' && block.text?.trim()))
    ? last.id : null;
  // Content revision matters even if the row ID is reused by restoration.
  const key = anchorId ? JSON.stringify([scope, sessionId, anchorId, last?.content]) : null;
  const [result, setResult] = useState<NextPromptDraft>();

  useEffect(() => {
    if (!key || !sessionId || !anchorId) return;
    const controller = new AbortController();
    void apiPost<NextPromptSuggestionResponse>('/api/chat/next-prompt', { sessionId, anchorMessageId: anchorId }, { signal: controller.signal })
      .then(response => {
        if (controller.signal.aborted || response.sessionId !== sessionId || response.anchorMessageId !== anchorId) return;
        setResult({ key, sessionId, text: typeof response.suggestion === 'string' ? cleanNextPromptSuggestion(response.suggestion) : null, unavailable: response.availability === 'unsupported' });
      }).catch(() => { /* A failed optional suggestion leaves the ordinary composer usable. */ });
    return () => controller.abort();
  }, [key, sessionId, anchorId, apiPost]);

  if (!key || !sessionId) return undefined;
  return result?.key === key ? result : { key, sessionId, text: null };
}
