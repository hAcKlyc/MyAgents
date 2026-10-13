import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Message } from '@/types/chat';
import { useNextPromptSuggestion } from './useNextPromptSuggestion';
import type { NextPromptSuggestionResponse } from '../../shared/nextPromptSuggestion';

const message: Message = { id: 'a1', role: 'assistant', content: '下一步需要接入正式协议。', timestamp: new Date(), transcriptState: 'complete' };
function response(sessionId = 's1', suggestion: string | null = '请继续接入正式协议。'): NextPromptSuggestionResponse { return { sessionId, anchorMessageId: 'a1', suggestion, availability: 'supported' }; }
function deferred() { let resolve!: (value: NextPromptSuggestionResponse) => void; const promise = new Promise<NextPromptSuggestionResponse>(r => { resolve = r; }); return { promise, resolve }; }

it('posts owner IDs only and hides a late result immediately on session/scope/reply changes', async () => {
  const first = deferred();
  const second = deferred();
  const apiPost = vi.fn().mockResolvedValue(response('s2', null)).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const initial = { sessionId: 's1', messages: [message], enabled: true, scope: 'runtime-1', apiPost };
  const { result, rerender } = renderHook(props => useNextPromptSuggestion(props), { initialProps: initial });
  expect(apiPost.mock.calls[0][1]).toEqual({ sessionId: 's1', anchorMessageId: 'a1' });
  const signal = apiPost.mock.calls[0][2].signal;
  rerender({ ...initial, sessionId: 's2', scope: 'runtime-2' });
  expect(signal.aborted).toBe(true);
  await act(async () => first.resolve(response()));
  expect(result.current?.text).toBeNull();
  await act(async () => second.resolve(response('s2')));
  expect(result.current?.text).toBe('请继续接入正式协议。');
  rerender({ ...initial, sessionId: 's2', scope: 'runtime-2', messages: [{ ...message, content: '回复已修订。' }] });
  expect(result.current?.text).toBeNull();
  rerender({ ...initial, enabled: false });
  expect(result.current).toBeUndefined();
});
it('rejects mismatched IDs and suppresses failures without retrying on unrelated rerenders', async () => {
  const apiPost = vi.fn().mockResolvedValue(response('foreign'));
  const props = { sessionId: 's1', messages: [message], enabled: true, scope: 'runtime-1', apiPost };
  const { result, rerender } = renderHook(options => useNextPromptSuggestion(options), { initialProps: props });
  await act(async () => {});
  expect(result.current?.text).toBeNull();
  rerender({ ...props, messages: [{ ...message }] });
  expect(apiPost).toHaveBeenCalledOnce();
  apiPost.mockRejectedValue(new Error('offline'));
  rerender({ ...props, scope: 'runtime-2' });
  await act(async () => {});
  expect(result.current?.text).toBeNull();
});
it('only requests an idle real Session with a terminal assistant text and projects unsupported status', async () => {
  const apiPost = vi.fn().mockResolvedValue({ ...response('s1', null), availability: 'unsupported' });
  const initial = { sessionId: 'pending-tab', messages: [message], enabled: true, scope: 'runtime-1', apiPost };
  const { result, rerender } = renderHook(props => useNextPromptSuggestion(props), { initialProps: initial });
  expect(apiPost).not.toHaveBeenCalled();
  rerender({ ...initial, sessionId: 's1', messages: [{ ...message, role: 'user' }] });
  expect(apiPost).not.toHaveBeenCalled();
  rerender({ ...initial, sessionId: 's1', messages: [{ ...message, transcriptState: 'streaming' }] });
  expect(apiPost).not.toHaveBeenCalled();
  rerender({ ...initial, sessionId: 's1' });
  await waitFor(() => expect(result.current?.unavailable).toBe(true));
});
