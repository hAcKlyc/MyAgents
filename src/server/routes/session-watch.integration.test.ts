/** Real route handlers and loopback delivery; no pre-existing server or user data. */
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { handleSessionReadRoute } from './session-read';
import { watchStreamManager } from '../inbox/watch-stream';
import { manageLocalSessionWatches } from '../inbox/watch-registry';

const sessionId = 'test-session-integration';
vi.mock('../session-engine', () => ({ getSessionEngine: () => ({
  getRuntimeIdentity: () => ({ sessionId: 'test-session-integration' }),
  getLiveSessionState: () => ({ isBusy: true, sessionState: 'running' }),
  getExecutionTurnId: () => 'turn-1',
}) }));
vi.mock('../SessionStore', () => ({
  getSessionMetadata: () => null, getSessionData: async () => null, isHistoryVisibleSession: () => true,
}));
let server: Server;
const delivered: Array<{ message: { sessionEvent: { type: string; turnId?: string } } }> = [];
async function post(action: string, body: Record<string, unknown>) {
  const url = new URL(`http://127.0.0.1/api/session-watch/${action}`);
  const response = await handleSessionReadRoute(url.pathname,
    new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), url);
  expect(response).not.toBeNull();
  return response!.json();
}
const registration = (extra = {}) => ({ watchId: 'watch-fixture', watcherSessionId: sessionId, targetSessionId: sessionId, mode: 'continuous', ...extra });

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    delivered.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  vi.stubEnv('MYAGENTS_MANAGEMENT_PORT', String(address.port));
});
afterEach(() => {
  watchStreamManager.removeStream(sessionId);
  manageLocalSessionWatches(sessionId, undefined, true);
  delivered.length = 0;
});
afterAll(async () => {
  vi.unstubAllEnvs(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('Session Watch Integration', () => {
  it('registers continuous subscriptions through the real route', async () => {
    expect(await post('register', registration({ mode: 'continuous' }))).toMatchObject({ accepted: true, mode: 'continuous' });
  });
  it('delivers turn.started through a real loopback receiver', async () => {
    await post('register', registration());
    await watchStreamManager.getStream(sessionId).notifyTurnStarted('turn-1', 0);
    expect(delivered.at(-1)?.message.sessionEvent).toMatchObject({ type: 'turn.started', turnId: 'turn-1' });
  });
  it('keeps continuous delivery across multiple completed turns', async () => {
    await post('register', registration());
    const stream = watchStreamManager.getStream(sessionId);
    await stream.notifyTurnCompleted('turn-1', { text: 'first' }, 'success');
    await stream.notifyTurnCompleted('turn-2', { text: 'second' }, 'success');
    expect(delivered.map(value => value.message.sessionEvent.turnId)).toEqual(['turn-1', 'turn-2']);
  });
  it('unsubscribes without further event delivery', async () => {
    await post('register', registration());
    expect(await post('unsubscribe', { watchId: 'watch-fixture', targetSessionId: sessionId })).toMatchObject({ accepted: true, removed: true });
    await watchStreamManager.getStream(sessionId).notifyTurnStarted('turn-2', 1);
    expect(delivered).toHaveLength(0);
  });
  it('retains explicit single-turn registration', async () => {
    expect(await post('register', registration({ mode: 'single-turn', turnId: 'turn-1' }))).toMatchObject({ accepted: true, mode: 'single-turn', turnId: 'turn-1' });
  });
  it('rejects a different session identity', async () => {
    expect(await post('register', registration({ targetSessionId: 'other-session' }))).toMatchObject({ accepted: false, reason: 'target session mismatch' });
  });
});
