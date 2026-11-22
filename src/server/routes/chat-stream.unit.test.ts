import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  engine: {
    getStreamReplaySnapshot: vi.fn(() => ({
      sessionId: 'session-live',
      snapshotRevision: 42,
      initState: { sessionState: 'idle' },
      replayMessages: [
        { id: 'm1', role: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00.000Z' },
      ],
      liveStreamingMessage: {
        id: 'live-1',
        role: 'assistant',
        content: 'partial answer',
        timestamp: '2026-01-01T00:00:01.000Z',
      },
      systemInitPayload: { info: { model: 'claude' } },
      agentPlan: [{ key: 'check', content: 'Check', activeForm: 'Checking', status: 'in_progress' as const }],
      pendingInteractiveRequests: [
        { type: 'chat:permission-request', data: { requestId: 'perm-1' } },
      ],
    })),
  },
}));

vi.mock('../session-engine', () => ({
  getSessionEngine: () => mocks.engine,
}));

import { handleChatStreamRoute } from './chat-stream';

describe('handleChatStreamRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends live state and a revision boundary without replaying cold history', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sent: Array<{ event: string; data: unknown }> = [];
    const response = new Response('stream');
    const createSseClient = vi.fn(() => ({
      client: {
        send(event: string, data: unknown) {
          sent.push({ event, data });
        },
      },
      response,
    }));

    const result = await handleChatStreamRoute(
      '/chat/stream',
      new Request('http://local/chat/stream'),
      {
        createSseClient,
        getLogLines: () => ['log-1'],
      },
    );

    expect(result).toBe(response);
    expect(mocks.engine.getStreamReplaySnapshot).toHaveBeenCalledWith({ includeHistory: false });
    expect(mocks.engine.getStreamReplaySnapshot.mock.invocationCallOrder[0])
      .toBeLessThan(createSseClient.mock.invocationCallOrder[0]);
    expect(sent).toEqual([
      {
        event: 'chat:init',
        data: {
          sessionState: 'idle',
          sessionId: 'session-live',
          snapshotRevision: 42,
          liveStreamingMessage: {
            id: 'live-1',
            role: 'assistant',
            content: 'partial answer',
            timestamp: '2026-01-01T00:00:01.000Z',
          },
        },
      },
      { event: 'chat:logs', data: { lines: ['log-1'] } },
      { event: 'chat:system-init', data: { info: { model: 'claude' }, sessionId: 'session-live', snapshotRevision: 42 } },
      {
        event: 'chat:agent-plan-update',
        data: {
          sessionId: 'session-live',
          todos: [{ key: 'check', content: 'Check', activeForm: 'Checking', status: 'in_progress' }],
        },
      },
      { event: 'chat:permission-request', data: { requestId: 'perm-1' } },
    ]);
    expect(log).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).not.toContain('session-live');
    expect(log.mock.calls.flat().join(' ')).not.toContain('hello');
  });

  it('does not enumerate cold transcript rows during stream attachment', async () => {
    const snapshot = mocks.engine.getStreamReplaySnapshot();
    Object.defineProperty(snapshot, 'replayMessages', { get() {
      throw new Error('Cold history must be paginated, not sent through SSE');
    } });
    mocks.engine.getStreamReplaySnapshot.mockReturnValueOnce(snapshot);
    const send = vi.fn();
    await handleChatStreamRoute('/chat/stream', new Request('http://local/chat/stream'), {
      createSseClient: () => ({ client: { send }, response: new Response() }), getLogLines: () => [],
    });
    expect(send.mock.calls.map(([event]) => event)).not.toContain('chat:message-replay');
  });

  it('ignores non-stream paths', async () => {
    await expect(handleChatStreamRoute(
      '/chat/send',
      new Request('http://local/chat/send'),
      {
        createSseClient: () => ({ client: { send: vi.fn() }, response: new Response() }),
        getLogLines: () => [],
      },
    )).resolves.toBeNull();
  });
});
