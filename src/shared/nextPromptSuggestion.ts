import type { SessionMessage } from './types/session-message';
import { isLikelyErrorTitle } from './titleFilters';

export interface NextPromptSuggestionRequest { sessionId: string; anchorMessageId: string }
export interface NextPromptSuggestionResponse extends NextPromptSuggestionRequest { suggestion: string | null; availability: 'supported' | 'unsupported'; reason?: 'runtime-text-utility-unavailable' }
export const NEXT_PROMPT_MAX_CODEPOINTS = 420;

export function parseNextPromptSuggestionRequest(value: unknown): NextPromptSuggestionRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== 'sessionId' && key !== 'anchorMessageId')) return null;
  return typeof input.sessionId === 'string' && input.sessionId.trim().length > 0 && input.sessionId.length <= 256
    && typeof input.anchorMessageId === 'string' && input.anchorMessageId.trim().length > 0 && input.anchorMessageId.length <= 256
    ? { sessionId: input.sessionId, anchorMessageId: input.anchorMessageId } : null;
}

export function nextPromptMessageText(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim();
  } catch { /* plain text */ }
  return content.trim();
}

/** A suggestion belongs only to the last completed human round. Never skip a newer row. */
export function eligibleNextPromptAnchor(messages: readonly SessionMessage[], anchorId: string): SessionMessage | null {
  const last = messages.at(-1);
  if (!last || last.id !== anchorId || last.role !== 'assistant' || last.messageKind === 'diagnostic'
    || last.completionState || last.terminalStatus || last.transcriptState === 'streaming'
    || last.transcriptState === 'interrupted' || !nextPromptMessageText(last.content)
    || isLikelyErrorTitle(nextPromptMessageText(last.content))) return null;
  return last;
}

export function cleanNextPromptSuggestion(raw: string): string | null {
  const text = raw.trim().replace(/^```(?:text)?\s*\n?|\n?```$/g, '').trim().replace(/^["「『]|["」』]$/g, '').trim();
  if (!text || text.toLowerCase() === 'null' || text === 'NONE' || isLikelyErrorTitle(text)
    || text.includes('\n') || Array.from(text).length > NEXT_PROMPT_MAX_CODEPOINTS) return null;
  return text;
}

/** Bounded tail; only visible text enters the utility turn, never tool payloads. */
export function buildNextPromptContext(messages: readonly SessionMessage[]): string {
  const rows = messages.slice(-6).map(message => ({ role: message.role, text: Array.from(nextPromptMessageText(message.content)).slice(-2000).join('') }));
  const encodedSize = () => new TextEncoder().encode(JSON.stringify(rows)).length;
  while (rows.length > 1 && encodedSize() > 10_000) rows.shift();
  // JSON escaping and non-ASCII UTF-8 can exceed a character cap even for one row.
  while (rows.length && encodedSize() > 10_000) rows[0].text = Array.from(rows[0].text).slice(100).join('');
  return JSON.stringify(rows);
}
