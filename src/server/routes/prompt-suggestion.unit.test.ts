import { describe, expect, it, vi } from 'vitest';
vi.mock('../session-engine', () => ({ getSessionEngine: () => ({}) }));
vi.mock('../session-prompt-suggestion', () => ({ suggestNextPrompt: vi.fn(), StalePromptSuggestionError: class extends Error {} }));
import { handlePromptSuggestionRoute } from './prompt-suggestion';
import { suggestNextPrompt, StalePromptSuggestionError } from '../session-prompt-suggestion';
const request = () => new Request('http://localhost/api/chat/next-prompt', { method: 'POST', body: JSON.stringify({ sessionId: 's', anchorMessageId: 'a' }) });
describe('prompt suggestion route', () => {
  it('ignores unrelated paths and rejects malformed renderer payloads', async () => {
    expect(await handlePromptSuggestionRoute('/other', request())).toBeNull();
    expect((await handlePromptSuggestionRoute('/api/chat/next-prompt', new Request('http://localhost', { method: 'POST', body: '{' })))?.status).toBe(400);
  });
  it('returns scoped suggestion and translates stale/error without sensitive exception text', async () => {
    vi.mocked(suggestNextPrompt).mockResolvedValue({ sessionId: 's', anchorMessageId: 'a', suggestion: '请继续测试', availability: 'supported' });
    expect(await (await handlePromptSuggestionRoute('/api/chat/next-prompt', request()))?.json()).toEqual({ sessionId: 's', anchorMessageId: 'a', suggestion: '请继续测试', availability: 'supported' });
    for (const [error, status] of [[new StalePromptSuggestionError('secret'), 409], [new Error('secret'), 500]] as const) {
      vi.mocked(suggestNextPrompt).mockRejectedValue(error);
      const response = await handlePromptSuggestionRoute('/api/chat/next-prompt', request());
      expect(response?.status).toBe(status); expect(await response?.text()).not.toContain('secret');
    }
  });
});
