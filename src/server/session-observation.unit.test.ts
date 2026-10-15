import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ history: vi.fn(), metadata: vi.fn(), management: vi.fn(), live: vi.fn(), identity: vi.fn() }));
vi.mock('./SessionStore', () => ({ getSessionData: mocks.history, getSessionMetadata: mocks.metadata, isHistoryVisibleSession: () => true }));
vi.mock('./session-engine', () => ({ getSessionEngine: () => ({getLiveSessionState: mocks.live, getRuntimeIdentity: mocks.identity}) }));
vi.mock('./utils/management-api-client', () => ({ managementApi: mocks.management }));
import { readLatestSessionResult, readSessionActivity, readLocalSessionActivity } from './session-observation';
import { projectSessionActivity, projectSessionExecution } from './session-engine/observation';

describe('Session observation truth', () => {
  beforeEach(() => vi.resetAllMocks());
  it('exposes only three activity states, including preparation and root interaction', () => {
    expect(projectSessionActivity({ sessionState: 'idle', isBusy: false })).toBe('idle');
    expect(projectSessionActivity({ sessionState: 'error', isBusy: false })).toBe('idle');
    expect(projectSessionActivity({ sessionState: 'starting', isBusy: false })).toBe('running');
    expect(projectSessionActivity({ sessionState: 'running', isBusy: true })).toBe('running');
    expect(projectSessionActivity({ sessionState: 'running', isBusy: true, waitingForUser: true })).toBe('waiting_user_action');
    expect(projectSessionActivity({ sessionState: 'idle', isBusy: false, waitingForUser: true })).toBe('idle');
    expect(projectSessionActivity({ sessionState: 'idle', isBusy: false, backgroundWorkActive: true })).toBe('running');
    expect(projectSessionActivity({ sessionState: 'running', isBusy: true, backgroundWorkActive: true, waitingForUser: true })).toBe('waiting_user_action');
  });
  it('uses only the active turn start and includes root waiting wall time', () => {
    const startedAt = '2026-10-14T12:00:00.000Z';
    const now = Date.parse(startedAt) + 750000;
    const live = { sessionState: 'running', isBusy: true, executionStartedAt: startedAt };
    expect(projectSessionExecution(live, now)).toEqual({startedAt,elapsedMs:750000});
    expect(projectSessionExecution({...live, waitingForUser: true}, now)).toEqual({startedAt,elapsedMs:750000});
    for (const executionStartedAt of [undefined, 'invalid', new Date(now + 1).toISOString()]) {
      expect(projectSessionExecution({...live,executionStartedAt}, now)).toBeUndefined();
    }
    expect(projectSessionExecution({...live,sessionState:'idle',isBusy:false}, now)).toBeUndefined();
    expect(projectSessionExecution({...live,executionStartedAt:new Date(now-1000).toISOString()}, now)?.elapsedMs).toBe(1000);
  });
  it('projects local owner timing and preserves it through the management resolver', async () => {
    mocks.identity.mockReturnValue({sessionId:'s'});
    mocks.live.mockReturnValue({sessionState:'running',isBusy:true,executionStartedAt:new Date(Date.now()-10000).toISOString()});
    const response = readLocalSessionActivity('s');
    expect(response.session.execution?.elapsedMs).toBeGreaterThanOrEqual(10000);
    mocks.management.mockResolvedValue({ok:true,active:true,result:response});
    expect(await readSessionActivity('s')).toEqual(response.session);
    expect(() => readLocalSessionActivity('other')).toThrow('SESSION_OWNER_SCOPE_MISMATCH');
  });
  it('reports children still executing after a parent terminal without inventing a root timer', () => {
    mocks.identity.mockReturnValue({ sessionId: 's' });
    mocks.live.mockReturnValue({ sessionState: 'idle', isBusy: false, backgroundWorkActive: true });
    expect(readLocalSessionActivity('s')).toEqual({ success: true, session: { sessionId: 's', state: 'running' } });
    mocks.live.mockReturnValue({ sessionState: 'idle', isBusy: false, backgroundWorkActive: false });
    expect(readLocalSessionActivity('s')).toEqual({ success: true, session: { sessionId: 's', state: 'idle' } });
  });
  it('reports a sticky root error as failed execution even when root busy policy stays true', async () => {
    mocks.identity.mockReturnValue({ sessionId: 's' });
    mocks.live.mockReturnValue({ sessionState: 'error', isBusy: true });
    expect(() => readLocalSessionActivity('s')).toThrow('SESSION_EXECUTION_FAILED');
    mocks.management.mockResolvedValue({ ok: false, code: 'SESSION_EXECUTION_FAILED' });
    await expect(readSessionActivity('s')).rejects.toMatchObject({ code: 'SESSION_EXECUTION_FAILED' });
    expect(mocks.metadata).not.toHaveBeenCalled();
  });
  it('preserves independently observed children after a root error', () => {
    mocks.identity.mockReturnValue({ sessionId: 's' });
    mocks.live.mockReturnValue({ sessionState: 'error', isBusy: true, backgroundWorkActive: true });
    expect(readLocalSessionActivity('s')).toEqual({ success: true, session: { sessionId: 's', state: 'running' } });
  });
  it('uses real live partial output without replacing it with an older successful answer', async () => {
    expect(await readLatestSessionResult('s', { latestResult: 'partial', terminalStatus: 'stopped', turnId: 't' }))
      .toEqual({ text: 'partial', source: 'live', scope: 'latest-session-result', terminalStatus: 'stopped', turnId: 't' });
    expect(mocks.history).not.toHaveBeenCalled();
  });
  it('supplements missing live text with durable history and preserves its own terminal identity', async () => {
    mocks.history.mockResolvedValue({ messages: [{ role: 'assistant', content: 'older partial', timestamp: 'then', turnId: 'old', terminalStatus: 'error' }] });
    expect(await readLatestSessionResult('s', { latestResult: '(no text response)', turnId: 'new', terminalStatus: 'complete' }))
      .toEqual({ text: 'older partial', timestamp: 'then', turnId: 'old', terminalStatus: 'error', source: 'history', scope: 'latest-session-result' });
  });
  it('distinguishes no assistant from a failed/missing history read', async () => {
    mocks.history.mockResolvedValue({ messages: [{ role: 'user', content: 'hi' }] });
    expect(await readLatestSessionResult('s')).toMatchObject({ source: 'none', text: null });
    mocks.history.mockRejectedValue(new Error('unreadable'));
    expect(await readLatestSessionResult('s')).toMatchObject({ source: 'unavailable', text: null });
    mocks.history.mockResolvedValue(null);
    expect(await readLatestSessionResult('s')).toMatchObject({ source: 'unavailable', text: null });
  });
  it('honors owner recovery and turn terminal facts rather than message sealing', async () => {
    mocks.history.mockResolvedValue({ messages: [], transcriptRecovery: 'unavailable' });
    expect(await readLatestSessionResult('s')).toMatchObject({ source: 'unavailable' });
    for (const status of ['complete', 'stopped', 'error', 'running', 'interrupted']) {
      mocks.history.mockResolvedValue({ messages: [{ role: 'assistant', content: 'partial', turnId: 'old',
        timestamp: 'then', transcriptState: 'complete' }], transcriptTurns: [{ id: 'old', status }, { id: 'new', status: 'complete' }] });
      const result = await readLatestSessionResult('s');
      expect(result).toMatchObject({ text: 'partial', source: 'history', turnId: 'old', timestamp: 'then' });
      expect(result.terminalStatus).toBe(['complete', 'stopped', 'error'].includes(status) ? status : undefined);
    }
    mocks.history.mockResolvedValue({ messages: [{ role: 'assistant', content: 'sealed', transcriptState: 'complete' }] });
    expect((await readLatestSessionResult('s')).terminalStatus).toBeUndefined();
  });

  it('queries the actual owner without waking it and refuses unreadable/mismatched state', async () => {
    mocks.management.mockResolvedValue({ ok: true, active: true, result: { success: true, session: { sessionId: 's', state: 'waiting_user_action' } } });
    expect(await readSessionActivity('s')).toEqual({ sessionId: 's', state: 'waiting_user_action' });
    expect(mocks.management.mock.calls[0][2]).toEqual({ sessionId: 's', projection: 'activity' });
    mocks.management.mockResolvedValue({ ok: false });
    await expect(readSessionActivity('s')).rejects.toThrow('SESSION_STATE_UNAVAILABLE');
    mocks.management.mockResolvedValue({ ok: true, active: true, result: { success: true, session: { sessionId: 'other', state: 'idle' } } });
    await expect(readSessionActivity('s')).rejects.toThrow('SESSION_OWNER_SCOPE_MISMATCH');
    mocks.management.mockResolvedValue({ ok: true, active: false });
    mocks.metadata.mockReturnValue({ id: 's' });
    expect(await readSessionActivity('s')).toEqual({ sessionId: 's', state: 'idle' });
  });
  it.each(['starting', 'recovering', 'dead', 'draining'])('does not reinterpret an unobservable %s owner as idle history', async phase => {
    mocks.management.mockResolvedValue({ ok: false, code: 'session_owner_unavailable', error: phase });
    mocks.metadata.mockReturnValue({ id: 's' });
    await expect(readSessionActivity('s')).rejects.toThrow('SESSION_STATE_UNAVAILABLE');
    expect(mocks.metadata).not.toHaveBeenCalled();
  });
});
