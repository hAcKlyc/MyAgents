import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  engine: {
    cancelQueuedMessage: vi.fn(),
    forceQueuedMessage: vi.fn(),
    getQueueStatus: vi.fn(),
  },
}));

vi.mock('../session-engine', () => ({
  getSessionEngine: () => mocks.engine,
}));

import { handleSessionEngineQueueRoute } from './session-engine-queue';

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe('handleSessionEngineQueueRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for unrelated routes', async () => {
    await expect(handleSessionEngineQueueRoute('/chat/send', new Request('http://local/chat/send')))
      .resolves.toBeNull();
  });

  it('validates queueId for cancel', async () => {
    const response = await handleSessionEngineQueueRoute(
      '/chat/queue/cancel',
      new Request('http://local/chat/queue/cancel', { method: 'POST', body: '{}' }),
    );

    expect(response?.status).toBe(400);
    expect(await readJson(response!)).toMatchObject({ success: false, error: 'queueId is required' });
  });

  it('maps cancel success without changing response shape', async () => {
    mocks.engine.cancelQueuedMessage.mockResolvedValueOnce({
      status: 'cancelled',
      cancelledText: 'hello',
    });

    const response = await handleSessionEngineQueueRoute(
      '/chat/queue/cancel',
      new Request('http://local/chat/queue/cancel', {
        method: 'POST',
        body: JSON.stringify({ queueId: 'q1' }),
      }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response!)).toEqual({ success: true, cancelledText: 'hello' });
  });

  it('marks a missing cancel target as stale so the renderer can converge', async () => {
    mocks.engine.cancelQueuedMessage.mockResolvedValueOnce({ status: 'not_found' });

    const response = await handleSessionEngineQueueRoute(
      '/chat/queue/cancel',
      new Request('http://local/chat/queue/cancel', {
        method: 'POST',
        body: JSON.stringify({ queueId: 'q1' }),
      }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response!)).toEqual({
      success: false,
      stale: true,
      error: 'Queue item not found',
    });
  });

  it('marks a missing force target as stale so the renderer can converge', async () => {
    mocks.engine.forceQueuedMessage.mockResolvedValueOnce(false);

    const response = await handleSessionEngineQueueRoute(
      '/chat/queue/force',
      new Request('http://local/chat/queue/force', {
        method: 'POST',
        body: JSON.stringify({ queueId: 'q1' }),
      }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response!)).toEqual({
      success: false,
      stale: true,
      error: 'Queue item not found',
    });
  });

  it('reports an unavailable force handoff without telling the renderer to remove its target', async () => {
    mocks.engine.forceQueuedMessage.mockRejectedValueOnce(new Error('Input owner is not ready; target retained'));
    const response = await handleSessionEngineQueueRoute('/chat/queue/force', new Request('http://local/chat/queue/force', {
      method: 'POST', body: JSON.stringify({ queueId: 'q1' }),
    }));
    expect(response?.status).toBe(500);
    expect(await readJson(response!)).toEqual({ success: false, error: 'Input owner is not ready; target retained' });
  });

  it('returns active engine queue status', async () => {
    mocks.engine.getQueueStatus.mockReturnValueOnce([{ id: 'q1', messagePreview: 'hello' }]);

    const response = await handleSessionEngineQueueRoute(
      '/chat/queue/status',
      new Request('http://local/chat/queue/status', { method: 'GET' }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response!)).toEqual({
      success: true,
      queue: [{ id: 'q1', messagePreview: 'hello' }],
    });
  });
});
