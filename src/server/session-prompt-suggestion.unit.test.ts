import { describe, expect, it, vi } from 'vitest';
vi.mock('./title-generator', () => ({ generateUtilityText: vi.fn() }));
import { createPromptSuggestionService, StalePromptSuggestionError } from './session-prompt-suggestion';
import type { SessionEngine } from './session-engine/types';
import type { SessionMessage } from '../shared/types/session-message';
function fixture() {
  const messages: SessionMessage[] = [
    { id: 'u', role: 'user', content: '请分析测试方式', timestamp: '' },
    { id: 'a', role: 'assistant', content: '已分析，可按方案执行验证。', timestamp: '', transcriptState: 'complete' },
  ];
  const state = { sessionState: 'idle', isBusy: false, waitingForUser: false };
  const identity = { kind: 'builtin', runtime: 'builtin', sessionId: 's' };
  const engine = {
    getRuntimeIdentity: () => identity,
    getLiveSessionState: () => state,
    getLiveSessionOverlay: () => ({ isActive: true, inMemoryMessages: messages }),
    getCurrentSessionContext: () => ({ sessionId: 's' }),
    getSessionCompletionTerminal: () => null,
    getSessionConfigSnapshot: () => ({ model: 'active-model' }),
    getHeldImConfigSnapshot: () => ({ providerEnv: { providerId: 'active-provider' } }),
  } as unknown as SessionEngine;
  return { engine, messages, state, identity };
}
const request = { sessionId: 's', anchorMessageId: 'a' };
describe('next prompt owner service', () => {
  it('coalesces and caches one inference including null, using real active binding and transcript', async () => {
    const { engine } = fixture();
    const generate = vi.fn(async () => null);
    const service = createPromptSuggestionService(generate);
    expect(await Promise.all([service(engine, request), service(engine, request)])).toEqual([{ ...request, suggestion: null, availability: 'supported' }, { ...request, suggestion: null, availability: 'supported' }]);
    await service(engine, request);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('请分析测试方式'), requireSuccessfulTerminal: true }), 'active-model', { providerId: 'active-provider' }, 's');
  });
  it('rejects wrong owner and busy or root waiting session before inference', async () => {
    for (const patch of [{ isBusy: true }, { waitingForUser: true }]) {
      const { engine, state } = fixture(); Object.assign(state, patch);
      const generate = vi.fn();
      await expect(createPromptSuggestionService(generate)(engine, request)).rejects.toBeInstanceOf(StalePromptSuggestionError);
      expect(generate).not.toHaveBeenCalled();
    }
    const { engine } = fixture();
    await expect(createPromptSuggestionService()(engine, { ...request, sessionId: 'other' })).rejects.toBeInstanceOf(StalePromptSuggestionError);
  });
  it('rejects a later user and mutated assistant after model resolution', async () => {
    for (const mutate of [(messages: SessionMessage[]) => { messages[1].content += ' changed'; }, (messages: SessionMessage[]) => { messages.push({ id: 'new', role: 'user', content: '新任务', timestamp: '' }); }]) {
      const { engine, messages } = fixture();
      const generate = vi.fn(async () => { mutate(messages); return '请测试'; });
      await expect(createPromptSuggestionService(generate)(engine, request)).rejects.toBeInstanceOf(StalePromptSuggestionError);
    }
  });
  it('does not borrow SDK or switch runtime for unsupported native utility paths', async () => {
    const { engine, identity } = fixture(); Object.assign(identity, { kind: 'external', runtime: 'dsh' });
    const generate = vi.fn();
    expect(await createPromptSuggestionService(generate)(engine, request)).toEqual({ ...request, suggestion: null, availability: 'unsupported', reason: 'runtime-text-utility-unavailable' });
    expect(generate).not.toHaveBeenCalled();
  });
  it.each(['codex', 'claude-code', 'dsh'])('uses %s native auxiliary generation without borrowing SDK and cleans output', async runtime => {
    const { engine, identity } = fixture(); Object.assign(identity, { kind: 'external', runtime });
    const native = vi.fn(async () => '「请验证CSV空文件。」'); engine.runTextUtility = native;
    const sdk = vi.fn();
    expect(await createPromptSuggestionService(sdk)(engine, request)).toEqual({ ...request, suggestion: '请验证CSV空文件。', availability: 'supported' });
    expect(sdk).not.toHaveBeenCalled();
    expect(native).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('请分析测试方式') }));
  });
  it('drops native utility results when owner/config changes and never uses an SDK fallback on failure', async () => {
    const { engine, identity } = fixture(); Object.assign(identity, { runtime: 'codex', runtimeSource: 'managed-provider' });
    engine.runTextUtility = vi.fn(async () => { Object.assign(identity, { runtimeSource: 'system-cli' }); return '请继续'; });
    const sdk = vi.fn();
    await expect(createPromptSuggestionService(sdk)(engine, request)).rejects.toBeInstanceOf(StalePromptSuggestionError);
    expect(sdk).not.toHaveBeenCalled();
    engine.runTextUtility = vi.fn(async () => { throw new Error('native auth unavailable'); });
    expect((await createPromptSuggestionService(sdk)(engine, request)).suggestion).toBeNull();
    expect(sdk).not.toHaveBeenCalled();
  });
  it('continues generating beyond the completed LRU bound and retains recently used anchors', async () => {
    const { engine, messages } = fixture();
    const generate = vi.fn(async () => '请按刚才方案测试');
    const service = createPromptSuggestionService(generate);
    for (let index = 0; index < 140; index += 1) {
      messages[1].id = `a-${index}`;
      expect((await service(engine, { ...request, anchorMessageId: messages[1].id })).suggestion).toBe('请按刚才方案测试');
    }
    expect(generate).toHaveBeenCalledTimes(140);
    for (const index of [139, 138, 12, 139]) {
      messages[1].id = `a-${index}`;
      await service(engine, { ...request, anchorMessageId: messages[1].id });
    }
    expect(generate).toHaveBeenCalledTimes(140);
  });
  it('never evicts an in-flight anchor while completed anchors roll over', async () => {
    const pendingFixture = fixture();
    let complete!: (value: string | null) => void;
    const generate = vi.fn().mockImplementationOnce(() => new Promise<string | null>(resolve => { complete = resolve; })).mockResolvedValue(null);
    const service = createPromptSuggestionService(generate);
    const first = service(pendingFixture.engine, request);
    const { engine, messages } = fixture();
    for (let index = 0; index < 140; index += 1) {
      messages[1].id = `other-${index}`;
      await service(engine, { ...request, anchorMessageId: messages[1].id });
    }
    const duplicate = service(pendingFixture.engine, request);
    expect(generate).toHaveBeenCalledTimes(141);
    complete('请继续验证');
    expect((await first).suggestion).toBe('请继续验证');
    expect((await duplicate).suggestion).toBe('请继续验证');
    await service(pendingFixture.engine, request);
    expect(generate).toHaveBeenCalledTimes(141);
  });

});
