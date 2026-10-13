import { getSessionEngine } from '../session-engine';
import { parseNextPromptSuggestionRequest } from '../../shared/nextPromptSuggestion';
import { StalePromptSuggestionError, suggestNextPrompt } from '../session-prompt-suggestion';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function handlePromptSuggestionRoute(pathname: string, request: Request): Promise<Response | null> {
  if (pathname !== '/api/chat/next-prompt' || request.method !== 'POST') return null;
  const body = parseNextPromptSuggestionRequest(await request.json().catch(() => null));
  if (!body) return json({ error: 'Invalid next prompt request.' }, 400);
  try {
    return json(await suggestNextPrompt(getSessionEngine(), body, request.signal));
  } catch (error) {
    return json({ error: error instanceof StalePromptSuggestionError ? 'Conversation changed or is busy.' : 'Unable to suggest next prompt.' }, error instanceof StalePromptSuggestionError ? 409 : 500);
  }
}
