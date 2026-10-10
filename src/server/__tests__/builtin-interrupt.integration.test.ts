import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { BuiltinTurnLifecycleDeps, BuiltinTurnLifecycle } from '../builtin-session/turn-lifecycle';

const captured = vi.hoisted(() => ({
  deps: null as BuiltinTurnLifecycleDeps | null,
  lifecycle: null as BuiltinTurnLifecycle | null,
}));
vi.mock('../builtin-session/turn-lifecycle', async importOriginal => {
  const actual = await importOriginal<typeof import('../builtin-session/turn-lifecycle')>();
  return {
    ...actual,
    createBuiltinTurnLifecycle: (deps: BuiltinTurnLifecycleDeps) => {
      captured.deps = deps;
      captured.lifecycle = actual.createBuiltinTurnLifecycle({
        ...deps,
        persistTranscript: vi.fn(async () => undefined),
        trackServer: vi.fn(),
        firePostTurnTitleHook: vi.fn(),
        broadcastBuiltinContextUsage: vi.fn(async () => undefined),
      });
      return captured.lifecycle;
    },
  };
});
vi.mock('../sse', async importOriginal => ({
  ...await importOriginal<typeof import('../sse')>(),
  broadcast: vi.fn(),
  broadcastLive: vi.fn(),
}));

import { cancelImRequest, cancelQueueItem, forceExecuteQueueItem, getAgentState, interruptCurrentResponse } from '../agent-session';
import { broadcast } from '../sse';
import { getQuerySession, resetLifecycleForTest, setQuerySession, waitForMessage } from '../builtin-session/lifecycle';
import { beginPromotedItem, getInFlightQueueId, getMessageQueue, getPendingMidTurnQueue, getTurnAdmissionTicket, getTurnBoundaryQueue, isPromotedItemCanceled, pushMessage, pushPendingMidTurn, pushTurnBoundary, resetQueueForTest, setInFlightQueueItem, setTurnAdmissionTicket } from '../builtin-session/queue';
import { resetTurnForTest } from '../builtin-session/turn';
import { resetTranscriptForTest } from '../builtin-session/transcript';
import { NO_CHANNEL_DELIVERY } from '../session-core/channel-delivery';
import type { MessageQueueItem } from '../builtin-session/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('builtin interrupt facade terminal ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetLifecycleForTest();
    resetQueueForTest();
    resetTurnForTest();
    resetTranscriptForTest();
    captured.deps!.setStreamingMessage(false);
    captured.deps!.setSessionState('idle');
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('sends Stop for B after A terminal even while A receipt is pending', async () => {
    const receiptA = deferred<undefined>();
    const receiptB = deferred<undefined>();
    const query = { interrupt: vi.fn()
      .mockReturnValueOnce(receiptA.promise).mockReturnValueOnce(receiptB.promise), close: vi.fn() };
    setQuerySession(query as unknown as Query);
    captured.deps!.setStreamingMessage(true);
    const stopA = interruptCurrentResponse();
    // Same synchronous terminal hook used by the real SDK result owner.
    captured.deps!.claimPostInterruptResultTerminal();
    captured.deps!.setStreamingMessage(true);
    const stopB = interruptCurrentResponse();
    const issued = query.interrupt.mock.calls.length;
    captured.deps!.claimPostInterruptResultTerminal();
    receiptA.resolve(undefined);
    receiptB.resolve(undefined);
    await Promise.all([stopA, stopB]);
    expect(issued).toBe(2);
    expect(query.close).not.toHaveBeenCalled();
  });

  it('does not classify a real SDK execution error as cancellation during Stop', async () => {
    const receipt = deferred<undefined>();
    const query = { interrupt: vi.fn(() => receipt.promise), close: vi.fn() };
    setQuerySession(query as unknown as Query);
    captured.deps!.setStreamingMessage(true);
    const stop = interruptCurrentResponse();
    await captured.lifecycle!.handleSdkResult({
      type: 'result', subtype: 'error_during_execution', is_error: true,
      errors: ['provider unavailable'], terminal_reason: 'failed',
      duration_ms: 10, duration_api_ms: 10, num_turns: 1, session_id: 'test',
    } as never);
    receipt.resolve(undefined);
    await stop;
    expect(vi.mocked(broadcast).mock.calls.some(([event]) => event === 'chat:agent-error')).toBe(true);
    expect(vi.mocked(broadcast).mock.calls.some(([event]) => event === 'chat:message-stopped')).toBe(false);
  });

  it('cancels an admitted desktop send before turn_start', async () => {
    const terminal = vi.fn();
    setTurnAdmissionTicket({
      queueId: 'desktop-startup',
      createdAt: Date.now(),
      messageText: 'run a tool',
      onTerminal: terminal,
      canceled: false,
    });

    await expect(interruptCurrentResponse()).resolves.toBe(true);

    expect(getTurnAdmissionTicket()).toBeNull();
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'stopped' }));
    expect(broadcast).toHaveBeenCalledWith('chat:message-stopped', null);
  });
});

function localInput(id: string, extra: Partial<MessageQueueItem> = {}): MessageQueueItem {
  return { id, message: { role: 'user', content: 'synthetic input' }, messageText: 'synthetic input',
    wasQueued: false, channelDelivery: NO_CHANNEL_DELIVERY, resolve: vi.fn(), ...extra };
}
function retainedQuery() {
  const query = { interrupt: vi.fn(async () => undefined), close: vi.fn() };
  setQuerySession(query as unknown as Query);
  captured.deps!.setStreamingMessage(false);
  captured.deps!.setSessionState('running');
  return query;
}

describe('builtin local input cancellation and force ownership (#648)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetLifecycleForTest(); resetQueueForTest(); resetTurnForTest(); resetTranscriptForTest();
    captured.deps!.setStreamingMessage(false); captured.deps!.setSessionState('idle');
    vi.clearAllMocks();
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('settles Stop only after local cancellation observers, retaining the idle Query', async () => {
    const query = retainedQuery();
    const observer = deferred<undefined>();
    const item = localInput('ordinary', { onTerminal: vi.fn(() => observer.promise) });
    pushMessage(item);
    pushTurnBoundary({ queueId: 'boundary', ready: true, messageText: 'synthetic', sourceItem: localInput('boundary') });
    const stop = interruptCurrentResponse();
    await Promise.resolve();
    expect(getMessageQueue()).toHaveLength(0);
    expect(getAgentState().sessionState).toBe('running');
    observer.resolve(undefined);
    await expect(stop).resolves.toBe(true);
    expect(getTurnBoundaryQueue()).toHaveLength(0);
    expect(getAgentState().sessionState).toBe('idle');
    expect(getQuerySession()).toBe(query);
    expect(query.interrupt).not.toHaveBeenCalled();
    expect(query.close).not.toHaveBeenCalled();
    expect(item.resolve).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith('chat:message-stopped', null);
  });

  it('settles historical running with no remaining input and keeps repeated Stop idempotent', async () => {
    retainedQuery();
    await expect(interruptCurrentResponse()).resolves.toBe(true);
    expect(getAgentState().sessionState).toBe('idle');
    await expect(interruptCurrentResponse()).resolves.toBe(false);
  });

  it.each(['queue-id', 'im-request'] as const)('settles final ordinary input through %s cancellation', async mode => {
    retainedQuery(); pushMessage(localInput('local', { requestId: 'im-local' }));
    if (mode === 'queue-id') await expect(cancelQueueItem('local')).resolves.toMatchObject({ status: 'cancelled' });
    else await expect(cancelImRequest('im-local')).resolves.toEqual({ aborted: true, mode: 'queued' });
    expect(getAgentState().sessionState).toBe('idle');
  });

  it('cancels a promoted ordinary input before commit without treating Query presence as a turn', async () => {
    const query = retainedQuery(); const item = localInput('promoted'); beginPromotedItem(item);
    await expect(interruptCurrentResponse()).resolves.toBe(true);
    expect(isPromotedItemCanceled(item.id)).toBe(true);
    // The generator still owns its pre-commit cleanup; no premature idle.
    expect(getAgentState().sessionState).toBe('running');
    expect(query.interrupt).not.toHaveBeenCalled();
  });

  it('does not idle a new admission created while an older cancellation observer settles', async () => {
    retainedQuery(); const observer = deferred<undefined>();
    pushMessage(localInput('older', { onTerminal: () => observer.promise }));
    const stop = interruptCurrentResponse(); await Promise.resolve();
    pushMessage(localInput('newer')); observer.resolve(undefined);
    await expect(stop).resolves.toBe(true);
    expect(getMessageQueue().map(item => item.id)).toEqual(['newer']);
    expect(getAgentState().sessionState).toBe('running');
    expect(vi.mocked(broadcast).mock.calls.some(([event]) => event === 'chat:message-stopped')).toBe(false);
  });

  it('preserves an SDK-accepted future input when stopping only local work', async () => {
    const query = retainedQuery(); setInFlightQueueItem('native-owned', null);
    pushMessage(localInput('local'));
    await expect(interruptCurrentResponse()).resolves.toBe(true);
    expect(getInFlightQueueId()).toBe('native-owned');
    expect(getAgentState().sessionState).toBe('running');
    expect(query.close).not.toHaveBeenCalled(); expect(query.interrupt).not.toHaveBeenCalled();
  });

  it('force hands a retained local target to a parked generator without cancelling other input', async () => {
    const query = retainedQuery(); const target = localInput('target'); const received = vi.fn();
    const parked = waitForMessage(() => undefined).then(received);
    pushMessage(localInput('other')); pushMessage(target);
    await expect(forceExecuteQueueItem(target.id)).resolves.toBe(true);
    await Promise.resolve();
    expect(received).toHaveBeenCalledWith(target);
    expect(getMessageQueue().map(item => item.id)).toEqual(['other']);
    expect(query.interrupt).not.toHaveBeenCalled();
    expect(vi.mocked(broadcast).mock.calls.some(([event]) => event === 'queue:cancelled')).toBe(false);
    // Avoid awaiting an unresolved promise on the old implementation.
    if (received.mock.calls.length) await parked;
  });

  it.each(['running', 'starting'] as const)('force retains all local input and reports unavailable handoff during %s', async state => {
    const query = retainedQuery(); captured.deps!.setSessionState(state);
    pushMessage(localInput('other')); pushMessage(localInput('target'));
    await expect(forceExecuteQueueItem('target')).rejects.toThrow();
    expect(getMessageQueue().map(item => item.id).sort()).toEqual(['other', 'target']);
    expect(query.interrupt).not.toHaveBeenCalled(); expect(query.close).not.toHaveBeenCalled();
  });

  it('force keeps an unready boundary target and reports failure rather than a stale identity', async () => {
    retainedQuery(); waitForMessage(() => undefined);
    pushTurnBoundary({ queueId: 'unready', ready: false, messageText: 'synthetic' });
    await expect(forceExecuteQueueItem('unready')).rejects.toThrow();
    expect(getTurnBoundaryQueue()).toHaveLength(1);
  });

  it('force promotes a pending local target through the existing lockstep owner', async () => {
    retainedQuery(); const target = localInput('pending', { wasQueued: true }); const received = vi.fn();
    waitForMessage(() => undefined).then(received);
    pushPendingMidTurn({ queueId: target.id, userMessage: { id: 'synthetic', role: 'user', content: 'synthetic', timestamp: '' }, sourceItem: target });
    await expect(forceExecuteQueueItem(target.id)).resolves.toBe(true);
    await Promise.resolve();
    expect(received).toHaveBeenCalledWith(target);
    expect(getPendingMidTurnQueue()).toHaveLength(0);
    expect(getInFlightQueueId()).toBe(target.id);
  });
  it.each(['pending', 'boundary'] as const)('settles final IM %s input through its exact cancellation owner', async location => {
    retainedQuery(); const source = localInput('local', { requestId: 'im-local' });
    if (location === 'pending') pushPendingMidTurn({ queueId: source.id, userMessage: { id: 'synthetic', role: 'user', content: 'synthetic', timestamp: '' }, sourceItem: source });
    else pushTurnBoundary({ queueId: source.id, ready: true, messageText: source.messageText, sourceItem: source });
    await expect(cancelImRequest('im-local')).resolves.toEqual({ aborted: true, mode: 'queued' });
    expect(getAgentState().sessionState).toBe('idle');
    expect(source.resolve).toHaveBeenCalledOnce();
  });

  it('cancels promoted input locally even with a provisional SDK slot', async () => {
    const query = retainedQuery(); const source = localInput('promoted', { requestId: 'im-promoted' });
    beginPromotedItem(source); setInFlightQueueItem(source.id, null);
    await expect(cancelImRequest('im-promoted')).resolves.toEqual({ aborted: true, mode: 'queued' });
    expect(isPromotedItemCanceled(source.id)).toBe(true);
    expect(getInFlightQueueId()).toBeNull();
    expect(query.interrupt).not.toHaveBeenCalled();
  });

  it('force retains an SDK-accepted future target without claiming handoff', async () => {
    const query = retainedQuery(); setInFlightQueueItem('native-owned', null);
    await expect(forceExecuteQueueItem('native-owned')).rejects.toThrow();
    expect(getInFlightQueueId()).toBe('native-owned');
    expect(query.interrupt).not.toHaveBeenCalled();
  });

  it('cancels the complete local snapshot alongside a desktop admission, preserving later input (#648 review)', async () => {
    const query = retainedQuery(); const observer = deferred<undefined>();
    setTurnAdmissionTicket({ queueId: 'admission', messageText: 'synthetic', createdAt: Date.now(), canceled: false, onTerminal: () => observer.promise });
    pushMessage(localInput('ordinary'));
    pushTurnBoundary({ queueId: 'boundary', ready: true, messageText: 'synthetic', sourceItem: localInput('boundary') });
    const stop = interruptCurrentResponse(); await Promise.resolve();
    pushMessage(localInput('later'));
    observer.resolve(undefined);
    await expect(stop).resolves.toBe(true);
    expect(getMessageQueue().map(item => item.id)).toEqual(['later']);
    expect(getTurnBoundaryQueue()).toHaveLength(0);
    expect(getTurnAdmissionTicket()).toBeNull();
    expect(getAgentState().sessionState).toBe('running');
    expect(query.interrupt).not.toHaveBeenCalled();
  });

});
