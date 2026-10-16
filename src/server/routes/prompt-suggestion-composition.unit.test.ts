import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEngine } from '../session-engine/types';
import { composeSidecarRequestHandler, resolveSidecarComposition } from '../sidecar-composition';

const mocks = vi.hoisted(() => ({ engine: {} as SessionEngine, generate: vi.fn() }));
vi.mock('../session-engine', () => ({ getSessionEngine: () => mocks.engine }));
vi.mock('../title-generator', () => ({ generateUtilityText: mocks.generate }));
import { handlePromptSuggestionRoute } from './prompt-suggestion';

const path = '/api/chat/next-prompt';
const suggestion = '请把刚才的方案整理成待办清单。';
let sessionNumber = 0;
let sessionId: string;
let state: { sessionState: string; isBusy: boolean; waitingForUser: boolean };

function post(body: unknown = { sessionId, anchorMessageId: 'answer' }, route = path) {
  return new Request(`http://127.0.0.1${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

function composed(role: 'session' | 'global' | 'development-union') {
  const handler = vi.fn(async (request: Request) =>
    await handlePromptSuggestionRoute(new URL(request.url).pathname, request)
      ?? new Response('Not Found', { status: 404 }));
  return {
    handler,
    dispatch: composeSidecarRequestHandler(
      role === 'development-union' ? resolveSidecarComposition(null, true) : resolveSidecarComposition(role, false),
      handler,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionId = `composed-suggestion-${++sessionNumber}`;
  state = { sessionState: 'idle', isBusy: false, waitingForUser: false };
  mocks.generate.mockResolvedValue(suggestion);
  mocks.engine = {
    getRuntimeIdentity: () => ({ kind: 'builtin', runtime: 'builtin', sessionId }),
    getLiveSessionState: () => state,
    getLiveSessionOverlay: () => ({ isActive: true, inMemoryMessages: [
      { id: 'human', role: 'user', content: '请分析下一阶段工作方案。', timestamp: '' },
      { id: 'answer', role: 'assistant', content: '方案已列出，可以进一步拆分待办。', timestamp: '', transcriptState: 'complete', turnId: 'turn' },
    ] }),
    getCurrentSessionContext: () => ({ sessionId }),
    getSessionCompletionTerminal: () => ({ sessionId, turnId: 'turn', status: 'complete' }),
    getSessionConfigSnapshot: () => ({ model: 'fixture-model' }),
    getHeldImConfigSnapshot: () => ({ providerEnv: {} }),
  } as unknown as SessionEngine;
});

describe('next prompt through the production Sidecar composition and real owner service', () => {
  it.each(['session', 'development-union'] as const)('%s reaches generation after a completed human turn', async role => {
    const { dispatch, handler } = composed(role);
    const request = post();
    const response = await dispatch(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessionId, anchorMessageId: 'answer', suggestion, availability: 'supported' });
    expect(handler).toHaveBeenCalledExactlyOnceWith(request);
    expect(mocks.generate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ requireSuccessfulTerminal: true, prompt: expect.stringContaining('下一阶段工作方案') }),
      'fixture-model', {}, sessionId,
    );
  });

  it.each(['codex', 'claude-code', 'dsh'] as const)('retains the %s Session utility owner through the production gate', async runtime => {
    const native = vi.fn(async () => suggestion);
    mocks.engine.getRuntimeIdentity = () => ({ kind: 'external', runtime, sessionId }) as ReturnType<SessionEngine['getRuntimeIdentity']>;
    mocks.engine.runTextUtility = native;
    const response = await composed('session').dispatch(post());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ suggestion, availability: 'supported' });
    expect(native).toHaveBeenCalledOnce();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('keeps the Session-only utility inaccessible from Global', async () => {
    const { dispatch, handler } = composed('global');
    expect((await dispatch(post())).status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('reaches real payload validation without invoking a model', async () => {
    const { dispatch, handler } = composed('session');
    expect((await dispatch(post({}))).status).toBe(400);
    expect(handler).toHaveBeenCalledOnce();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('preserves busy-session admission without touching the active task', async () => {
    state.isBusy = true;
    state.sessionState = 'running';
    const response = await composed('session').dispatch(post());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Conversation changed or is busy.' });
    expect(state).toEqual({ sessionState: 'running', isBusy: true, waitingForUser: false });
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('does not broaden the API prefix or allow non-POST generation', async () => {
    const { dispatch, handler } = composed('session');
    for (const route of [`${path}/other`, '/api/chat/future-owner']) {
      expect((await dispatch(post(undefined, route))).status).toBe(404);
    }
    expect(handler).not.toHaveBeenCalled();
    expect((await dispatch(new Request(`http://127.0.0.1${path}`))).status).toBe(404);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
