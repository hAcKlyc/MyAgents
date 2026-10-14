import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ profile: false, credential: false, next: vi.fn(), title: vi.fn() }));
vi.mock('../../shared/updaterQa', () => ({ isModelQaBuild: () => state.profile }));
vi.mock('../external-cli-admission', () => ({ hasValidInternalCliCredential: () => state.credential }));
vi.mock('./next-prompt', () => ({ modelqaNextPromptHandler: state.next }));
vi.mock('./title', () => ({ modelqaTitleHandler: state.title }));
import { isModelQaRoute, modelQaRequest } from './routes';

beforeEach(() => {
  state.profile = true; state.credential = false;
  state.next.mockReset().mockResolvedValue(new Response('next'));
  state.title.mockReset().mockResolvedValue(new Response('title'));
});

describe('compiled modelqa control-plane admission', () => {
  it('does not expose any model utility when the compiled profile is disabled', async () => {
    state.profile = false; state.credential = true;
    for (const path of ['/api/modelqa/next-prompt', '/api/modelqa/title']) {
      for (const method of ['GET', 'POST', 'DELETE']) {
        expect(isModelQaRoute(path, method)).toBe(false);
        expect(await modelQaRequest(new Request(`http://localhost${path}`, { method }))).toBeNull();
      }
    }
    expect(state.next).not.toHaveBeenCalled(); expect(state.title).not.toHaveBeenCalled();
  });
  it('requires the native internal caller before dispatching a paid utility', async () => {
    for (const path of ['/api/modelqa/next-prompt', '/api/modelqa/title']) {
      const result = await modelQaRequest(new Request(`http://localhost${path}`, { headers: { Authorization: 'Bearer synthetic-not-an-internal-token' } }));
      expect(result?.status).toBe(401);
    }
    expect(state.next).not.toHaveBeenCalled(); expect(state.title).not.toHaveBeenCalled();
  });
  it('dispatches only exact method/path pairs and preserves DELETE cancellation queries', async () => {
    state.credential = true;
    for (const method of ['GET', 'POST']) {
      expect((await modelQaRequest(new Request('http://localhost/api/modelqa/next-prompt', { method })))?.status).toBe(200);
    }
    const cancel = new Request('http://localhost/api/modelqa/title?requestId=synthetic', { method: 'DELETE' });
    await modelQaRequest(cancel);
    expect(state.title).toHaveBeenCalledWith(cancel);
    for (const [path, method] of [['/api/modelqa/next-prompt', 'DELETE'], ['/api/modelqa/title/', 'POST'], ['/api/modelqa/title', 'PUT'], ['/api/modelqa/title/extra', 'GET']]) {
      expect(await modelQaRequest(new Request(`http://localhost${path}`, { method }))).toBeNull();
    }
    expect(state.next).toHaveBeenCalledTimes(2); expect(state.title).toHaveBeenCalledTimes(1);
  });
});
