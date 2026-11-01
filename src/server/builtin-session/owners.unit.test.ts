import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  awaitSessionTermination,
  claimQueryMcpMutation,
  clearAbortFlag,
  completeQueryBackgroundTask,
  getQueryBackgroundTask,
  getPreWarmFailCount,
  hasQueryBackgroundTask,
  hasQueryBackgroundTasks,
  hasQueryBackgroundWork,
  replaceQueryBackgroundActivity,
  hasMessageResolver,
  incrementPreWarmFailCount,
  isAbortRequested,
  isCurrentQueryAuthority,
  getQueryMcpMutation,
  getQueryMcpPrewarmOwner,
  getSessionMutationBarrier,
  getSystemInitAuthority,
  getSystemInitInfo,
  requestAbort,
  resetLifecycleForTest,
  runSerializedSessionMutation,
  setQuerySession,
  setQuerySessionWithAuthority,
  setQueryMcpPrewarmOwner,
  settleQueryMcpPrewarmOwner,
  readQueryMcpStatuses,
  recordQueryBackgroundTask,
  registerSessionAbortCleanup,
  setSessionProcessing,
  setSessionTerminationPromise,
  setSystemInitInfo,
  snapshotLifecycle,
  takeQueryBackgroundTasks,
  waitForQueryExit,
  waitForMessage,
  wakeGenerator,
} from './lifecycle';
import {
  drainQueuedItems,
  findQueuedItemLocation,
  getQueueStatus,
  moveQueuedItemToFront,
  pushMessage,
  pushPendingMidTurn,
  pushTurnBoundary,
  releaseTurnAdmissionTicket,
  removeQueuedItemByQueueId,
  removeQueuedItemByRequestId,
  rescuePendingMidTurnToMessageFront,
  resetQueueForTest,
  setInFlightQueueItem,
  setTurnAdmissionTicket,
  snapshotQueue,
} from './queue';
import {
  beginTurn,
  consumePendingInboxInput,
  admitPendingOutputOwnerForYield,
  clearPendingOutputOwners,
  clearCurrentOutputOwnerAssistantChannelBlocks,
  getCurrentTurnIdentity,
  getCurrentTurnQueueId,
  getCurrentTurnText,
  getPendingImRequestIds,
  hasPendingOutputOwnerByQueueId,
  notifyCurrentTurnTerminal,
  notifyQueuedTurnStopped,
  pushPendingOutputOwner,
  popPendingOutputOwner,
  stageCurrentOutputOwnerAssistantChannelBlock,
  replaceCurrentTurnUsage,
  removePendingOutputOwnerByQueueId,
  resetTurnForTest,
  setCurrentTurnSourceItem,
  snapshotTurn,
  terminalCleanup,
  waitForCurrentTurnTerminalObserver,
  appendCurrentTurnTextBlock,
  setAssistantMessagePresent,
} from './turn';
import {
  applyAgentDefinitionsUpdate,
  applyMcpServersUpdate,
  applyModelUpdate,
  applyProviderEnvUpdate,
  consumePendingProviderHistoryBoundaryReset,
  getCurrentAgentDefinitions,
  drainDeferredRestart,
  getModel,
  getPermissionMode,
  hasDeferredRestart,
  resetConfigForTest,
  scheduleDeferredRestart,
  setCurrentMcpServers,
  setModel,
  setPendingProviderHistoryBoundaryReset,
  setPermissionPlanState,
  snapshotConfig,
} from './config';
import {
  addCurrentSessionUuid,
  bindSdkUuidToUserInput,
  bindSdkUuidToMessage,
  clearTranscriptState,
  getCurrentSessionUuids,
  getMessages,
  nextMessageSequence,
  replaceMessages,
  resetTranscriptForTest,
  snapshotTranscript,
} from './transcript';
import type { MessageQueueItem } from './types';
import { NO_CHANNEL_DELIVERY } from '../session-core/channel-delivery';

function queueItem(id: string, requestId = id): MessageQueueItem {
  return {
    id,
    requestId,
    message: { role: 'user', content: 'hello' },
    messageText: `message ${id}`,
    wasQueued: true,
    resolve: vi.fn(),
    channelDelivery: NO_CHANNEL_DELIVERY,
  };
}

function pendingItem(id: string, requestId = id) {
  return {
    queueId: id,
    userMessage: { id: `u-${id}`, role: 'user' as const, content: `message ${id}`, timestamp: 'now' },
    sourceItem: queueItem(id, requestId),
  };
}

describe('builtin-session owners', () => {
  beforeEach(() => {
    resetLifecycleForTest();
    resetQueueForTest();
    resetTurnForTest();
    resetConfigForTest();
    resetTranscriptForTest();
  });

  it('uses exact Query level activity for Goal waits, excluding ambient and foreground edge records', () => {
    const query = { close: vi.fn() } as never;
    const next = { close: vi.fn() } as never;
    setQuerySession(query);
    recordQueryBackgroundTask(query, 'foreground-agent', {});
    expect(hasQueryBackgroundWork()).toBe(false);
    replaceQueryBackgroundActivity(query, [{ task_id: 'watcher', task_type: 'monitor', description: '', ambient: true }]);
    expect(hasQueryBackgroundWork()).toBe(false);
    // Includes a task backgrounded without a new start edge.
    replaceQueryBackgroundActivity(query, [{ task_id: 'foreground-agent', task_type: 'local_agent', description: '' }]);
    expect(hasQueryBackgroundWork()).toBe(true);
    // No terminal edge is required to clear a replace-level observation.
    replaceQueryBackgroundActivity(query, []);
    expect(hasQueryBackgroundWork()).toBe(false);
    replaceQueryBackgroundActivity(query, [{ task_id: 'bash', task_type: 'local_bash', description: '' }]);
    expect(hasQueryBackgroundWork()).toBe(true);
    setQuerySession(next);
    expect(hasQueryBackgroundWork()).toBe(false);
    replaceQueryBackgroundActivity(query, [{ task_id: 'late', task_type: 'local_agent', description: '' }]);
    expect(hasQueryBackgroundWork()).toBe(false);
    replaceQueryBackgroundActivity(next, [{ task_id: 'current', task_type: 'workflow', description: '' }]);
    replaceQueryBackgroundActivity(query, []);
    expect(hasQueryBackgroundWork()).toBe(true);
    setQuerySession(null);
    expect(hasQueryBackgroundWork()).toBe(false);
  });

  it('lifecycle owns abort flag and wakes the persistent generator', async () => {
    const pending = waitForMessage(() => undefined);
    expect(hasMessageResolver()).toBe(true);

    wakeGenerator(queueItem('q1'));
    await expect(pending).resolves.toMatchObject({ id: 'q1' });
    expect(hasMessageResolver()).toBe(false);

    requestAbort();
    await expect(waitForMessage(() => undefined)).resolves.toBeNull();
    expect(isAbortRequested()).toBe(true);

    clearAbortFlag();
    expect(isAbortRequested()).toBe(false);
  });

  it('keeps Query-rebuild waiters isolated from messages and releases on owner exit', async () => {
    const query = { close: vi.fn() } as never;
    setQuerySession(query);
    let released = false;
    const queryExitBarrier = waitForQueryExit(query).then(() => { released = true; });

    wakeGenerator(queueItem('unrelated-message'));
    await Promise.resolve();
    expect(released).toBe(false);

    setQuerySession(null);
    await queryExitBarrier;
    expect(released).toBe(true);
    await expect(waitForQueryExit(query)).resolves.toBeUndefined();
  });

  it('keeps resumed runs live across old and duplicate task terminal events', () => {
    const query = {} as never;
    setQuerySession(query);
    recordQueryBackgroundTask(query, 'agent', { runId: 'run-1', toolUseId: 'tool-1' });
    expect(completeQueryBackgroundTask(query, 'agent', { runId: 'run-1', rich: false })).toMatchObject({ removed: true, broadcast: true });
    expect(completeQueryBackgroundTask(query, 'agent', { runId: 'run-1', rich: true })).toMatchObject({ removed: false, broadcast: true, enriching: true });
    recordQueryBackgroundTask(query, 'agent', { runId: 'run-2', toolUseId: 'tool-2' });
    expect(completeQueryBackgroundTask(query, 'agent', { runId: 'run-1', rich: true })).toMatchObject({ removed: false, broadcast: false });
    expect(completeQueryBackgroundTask(query, 'agent')).toMatchObject({ removed: false, broadcast: false });
    expect(hasQueryBackgroundTasks(query)).toBe(true);
    expect(recordQueryBackgroundTask(query, 'agent', { runId: 'run-1' })).toBe(false);
    expect(completeQueryBackgroundTask(query, 'agent', { runId: 'run-2', rich: true })).toMatchObject({ removed: true, broadcast: true, becameQuiescent: true });
    expect(completeQueryBackgroundTask(query, 'agent', { runId: 'run-2', rich: true })).toMatchObject({ removed: false, broadcast: false });
    expect(takeQueryBackgroundTasks(query)).toEqual([]);
  });

  it('reconciles terminal-before-start without reviving an ended run', () => {
    const query = {} as never;
    setQuerySession(query);
    completeQueryBackgroundTask(query, 'agent', { runId: 'run-2', rich: false });
    expect(recordQueryBackgroundTask(query, 'agent', { runId: 'run-1' })).toBe(false);
    expect(recordQueryBackgroundTask(query, 'agent', { runId: 'run-2', toolUseId: 'tool-2' })).toBe(true);
    expect(hasQueryBackgroundTasks(query)).toBe(false);
    expect(completeQueryBackgroundTask(query, 'agent', { runId: 'run-2', rich: true }).info?.toolUseId).toBe('tool-2');
    recordQueryBackgroundTask(query, 'agent', { runId: 'run-3', toolUseId: 'tool-3' });
    expect(takeQueryBackgroundTasks(query)).toEqual([['agent', { runId: 'run-3', toolUseId: 'tool-3' }]]);
  });

  it('owns background tasks by exact Query and releases quiescence only on the last terminal', () => {
    const firstQuery = { close: vi.fn() } as never;
    const replacementQuery = { close: vi.fn() } as never;
    setQuerySession(firstQuery);
    expect(recordQueryBackgroundTask(firstQuery, 'same-task', {
      toolUseId: 'tool-first',
      description: 'first',
    })).toBe(true);
    expect(recordQueryBackgroundTask(firstQuery, 'second-task', {
      toolUseId: 'tool-second',
    })).toBe(true);
    expect(hasQueryBackgroundTasks(firstQuery)).toBe(true);

    setQuerySession(replacementQuery);
    expect(recordQueryBackgroundTask(replacementQuery, 'same-task', {
      toolUseId: 'tool-replacement',
      description: 'replacement',
    })).toBe(true);
    expect(recordQueryBackgroundTask(firstQuery, 'late-task', {})).toBe(false);

    expect(completeQueryBackgroundTask(firstQuery, 'same-task')).toMatchObject({
      removed: true,
      becameQuiescent: false,
      info: { toolUseId: 'tool-first' },
    });
    expect(hasQueryBackgroundTask(replacementQuery, 'same-task')).toBe(true);
    expect(getQueryBackgroundTask(replacementQuery, 'same-task')?.toolUseId).toBe('tool-replacement');

    expect(completeQueryBackgroundTask(firstQuery, 'second-task')).toMatchObject({
      removed: true,
      becameQuiescent: true,
    });
    expect(hasQueryBackgroundTasks(firstQuery)).toBe(false);
    expect(hasQueryBackgroundTasks(replacementQuery)).toBe(true);

    expect(takeQueryBackgroundTasks(replacementQuery)).toEqual([
      ['same-task', { toolUseId: 'tool-replacement', description: 'replacement' }],
    ]);
    expect(hasQueryBackgroundTasks(replacementQuery)).toBe(false);
  });

  it('serializes session mutations and keeps the barrier through the final queued mutation', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });

    const first = runSerializedSessionMutation(async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
    });
    const second = runSerializedSessionMutation(async () => {
      order.push('second:start');
      await secondGate;
      order.push('second:end');
    });
    const barrier = getSessionMutationBarrier();

    await vi.waitFor(() => expect(order).toEqual(['first:start']));
    expect(barrier).not.toBeNull();
    releaseFirst();
    await first;
    await vi.waitFor(() => expect(order).toEqual(['first:start', 'first:end', 'second:start']));
    expect(getSessionMutationBarrier()).not.toBeNull();
    releaseSecond();
    await Promise.all([second, barrier]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(getSessionMutationBarrier()).toBeNull();
  });

  it('lifecycle awaitSessionTermination force-cleans process state on timeout', async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    setQuerySession({ close } as never);
    setSessionProcessing(true);
    setSessionTerminationPromise(new Promise(() => undefined));

    const cleanup = vi.fn();
    const result = awaitSessionTermination({
      timeoutMs: 10,
      label: 'unit',
      onTimeoutForceCleanup: cleanup,
    });

    await vi.advanceTimersByTimeAsync(10);
    await result;

    const snapshot = snapshotLifecycle();
    expect(snapshot.querySession).toBeNull();
    expect(snapshot.isProcessing).toBe(false);
    expect(close).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('keeps Session termination behind the durable pre-dispatch rollback barrier', async () => {
    let releaseCleanup!: () => void;
    registerSessionAbortCleanup(new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    }));
    setSessionTerminationPromise(Promise.resolve());

    let settled = false;
    const termination = awaitSessionTermination({ label: 'durable-rollback' }).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(snapshotLifecycle().abortCleanupInFlight).toBe(true);

    releaseCleanup();
    await termination;
    expect(settled).toBe(true);
    expect(snapshotLifecycle().abortCleanupInFlight).toBe(false);
  });

  it('binds the installed MCP map to one Query generation and invalidates it on replacement', () => {
    const first = { close: vi.fn() } as never;
    const second = { close: vi.fn() } as never;
    setQuerySession(first);
    expect(setQueryMcpPrewarmOwner({
      query: first,
      fingerprint: 'fs,search',
      requiredServerIds: ['search', 'fs'],
    })).toBe(true);
    expect(getQueryMcpPrewarmOwner()).toMatchObject({
      query: first,
      generation: 1,
      revision: 1,
      fingerprint: 'fs,search',
      requiredServerIds: ['fs', 'search'],
    });

    setQuerySession(second);
    expect(getQueryMcpPrewarmOwner()).toBeNull();
    expect(setQueryMcpPrewarmOwner({
      query: first,
      fingerprint: 'fs',
      requiredServerIds: ['fs'],
    })).toBe(false);
    expect(snapshotLifecycle().queryGeneration).toBe(2);
  });

  it('advances the installed MCP revision for same-id replacement on one Query', () => {
    const query = { close: vi.fn() } as never;
    setQuerySession(query);
    setQueryMcpPrewarmOwner({ query, fingerprint: 'fs', requiredServerIds: ['fs'] });
    const first = getQueryMcpPrewarmOwner();
    setQueryMcpPrewarmOwner({ query, fingerprint: 'fs', requiredServerIds: ['fs'] });
    const second = getQueryMcpPrewarmOwner();

    expect(second?.revision).toBe((first?.revision ?? 0) + 1);
    expect(second?.generation).toBe(first?.generation);
    expect(second?.fingerprint).toBe(first?.fingerprint);
  });

  it('owns one absolute pre-warm window and one terminal outcome per map revision', () => {
    const query = { close: vi.fn() } as never;
    setQuerySession(query);
    setQueryMcpPrewarmOwner({
      query,
      fingerprint: 'fs',
      requiredServerIds: ['fs'],
      startedAt: 1_000,
      deadlineAt: 11_000,
    });
    const owner = getQueryMcpPrewarmOwner();
    expect(owner).toMatchObject({ startedAt: 1_000, deadlineAt: 11_000 });
    expect(owner?.outcome).toBeUndefined();

    const settlement = {
      query,
      generation: owner?.generation ?? 0,
      revision: owner?.revision ?? 0,
      outcome: { state: 'ready' as const, elapsedMs: 2_000 },
    };
    expect(settleQueryMcpPrewarmOwner(settlement)).toBe(true);
    expect(settleQueryMcpPrewarmOwner(settlement)).toBe(false);
    expect(getQueryMcpPrewarmOwner()?.outcome).toEqual(settlement.outcome);

    setQueryMcpPrewarmOwner({
      query,
      fingerprint: 'fs',
      requiredServerIds: ['fs'],
      startedAt: 12_000,
      deadlineAt: 22_000,
    });
    expect(getQueryMcpPrewarmOwner()).toMatchObject({
      revision: (owner?.revision ?? 0) + 1,
      startedAt: 12_000,
      deadlineAt: 22_000,
    });
    expect(getQueryMcpPrewarmOwner()?.outcome).toBeUndefined();
  });

  it('single-flights MCP status control reads for one Query owner', async () => {
    let release!: (value: Array<{ name: string; status: 'connected' }>) => void;
    const mcpServerStatus = vi.fn(() => new Promise<Array<{ name: string; status: 'connected' }>>(
      resolve => { release = resolve; },
    ));
    const query = { close: vi.fn(), mcpServerStatus } as never;
    setQuerySession(query);
    setQueryMcpPrewarmOwner({
      query,
      fingerprint: 'fs',
      requiredServerIds: ['fs'],
    });

    const first = readQueryMcpStatuses(query);
    const second = readQueryMcpStatuses(query);
    expect(second).toBe(first);
    expect(mcpServerStatus).toHaveBeenCalledTimes(1);

    release([{ name: 'fs', status: 'connected' }]);
    await expect(first).resolves.toEqual([{ name: 'fs', status: 'connected' }]);
    await Promise.resolve();

    void readQueryMcpStatuses(query);
    expect(mcpServerStatus).toHaveBeenCalledTimes(2);
  });

  it('owns one MCP transport mutation per Query generation and settles it on replacement', async () => {
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve;
    }).then(() => ({ ok: true as const })));
    const firstQuery = { close: vi.fn() } as never;
    const secondQuery = { close: vi.fn() } as never;
    setQuerySession(firstQuery);

    const first = claimQueryMcpMutation(firstQuery, run);
    const shared = claimQueryMcpMutation(firstQuery, run);

    expect(first.claimed).toBe(true);
    expect(shared.claimed).toBe(false);
    expect(shared.promise).toBe(first.promise);
    expect(run).toHaveBeenCalledTimes(1);
    expect(getQueryMcpMutation()?.promise).toBe(first.promise);

    setQuerySession(secondQuery);
    await expect(first.promise).resolves.toMatchObject({
      ok: false,
      reason: 'query_replaced',
    });
    expect(getQueryMcpMutation()).toBeNull();

    release();
    await Promise.resolve();
    expect(getQueryMcpMutation()).toBeNull();
  });

  it('queue owner covers queued pending turn-boundary and in-flight locations', () => {
    pushMessage(queueItem('q1', 'r1'));
    pushPendingMidTurn(pendingItem('q2', 'r2'));
    pushTurnBoundary({ queueId: 'q3', ready: true, messageText: 'turn', requestId: 'r3' });
    setInFlightQueueItem('q4', {
      messageText: 'flight',
      requestId: 'r4',
      channelDelivery: NO_CHANNEL_DELIVERY,
    });

    expect(findQueuedItemLocation('q1')?.location).toBe('message');
    expect(findQueuedItemLocation('q2')?.location).toBe('pending-mid-turn');
    expect(findQueuedItemLocation('q3')?.location).toBe('turn-boundary');
    expect(findQueuedItemLocation('q4')?.location).toBe('in-flight');

    expect(removeQueuedItemByRequestId('r2').location).toBe('pending-mid-turn');
    expect(removeQueuedItemByQueueId('q3').location).toBe('turn-boundary');
    expect(removeQueuedItemByRequestId('r4').location).toBe('in-flight');
  });

  it('queue owner drains/rescues and keeps admission ticket scoped', () => {
    pushMessage(queueItem('q1'));
    pushPendingMidTurn(pendingItem('q2'));
    pushTurnBoundary({ queueId: 'q3', ready: true, messageText: 'turn' });
    setTurnAdmissionTicket({
      queueId: 'q3',
      createdAt: 1,
      messageText: 'third',
      canceled: false,
    });

    expect(rescuePendingMidTurnToMessageFront()).toBe(1);
    expect(snapshotQueue().messageQueue.map(item => item.id)).toEqual(['q2', 'q1']);
    releaseTurnAdmissionTicket('other');
    expect(snapshotQueue().turnAdmissionTicket?.queueId).toBe('q3');
    releaseTurnAdmissionTicket('q3');
    expect(snapshotQueue().turnAdmissionTicket).toBeNull();

    const drained = drainQueuedItems();
    expect(drained.messages.map(item => item.id)).toEqual(['q2', 'q1']);
    expect(drained.turnBoundary.map(item => item.queueId)).toEqual(['q3']);
    expect(getQueueStatus()).toEqual([]);
  });

  it('queue owner force-start reorders non-in-flight locations', () => {
    pushMessage(queueItem('q1'));
    pushMessage(queueItem('q2'));

    expect(moveQueuedItemToFront('q2')).toEqual({ found: true, isInFlight: false });
    expect(snapshotQueue().messageQueue.map(item => item.id)).toEqual(['q2', 'q1']);
  });

  it('turn owner keeps the output-owner FIFO and notifies the current queue item once', async () => {
    pushPendingOutputOwner({
      queueId: 'q1',
      requestId: 'r1',
      assistantChannelDelivery: 'reply-router',
      channelSessionId: 'session-1',
    });
    pushPendingOutputOwner({
      queueId: 'q2',
      requestId: 'r2',
      assistantChannelDelivery: 'reply-router',
      channelSessionId: 'session-1',
    });
    expect(getPendingImRequestIds()).toEqual(['r1', 'r2']);
    expect(hasPendingOutputOwnerByQueueId('q1')).toBe(true);
    expect(hasPendingOutputOwnerByQueueId('missing')).toBe(false);
    expect(removePendingOutputOwnerByQueueId('q2')).toBe(true);
    expect(hasPendingOutputOwnerByQueueId('q2')).toBe(false);
    expect(clearPendingOutputOwners()).toEqual(['r1']);

    const onTerminal = vi.fn();
    const item = queueItem('turn-a');
    item.turnOwner = { kind: 'goal', id: 'goal-1' };
    item.onTerminal = onTerminal;
    beginTurn({ startedAt: 100 });
    replaceCurrentTurnUsage({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    setCurrentTurnSourceItem(item);
    appendCurrentTurnTextBlock('hello');
    setAssistantMessagePresent(true);
    expect(getCurrentTurnIdentity()).toEqual({
      queueId: 'turn-a',
      owner: { kind: 'goal', id: 'goal-1' },
    });
    expect(getCurrentTurnQueueId()).toBe('turn-a');
    notifyCurrentTurnTerminal('complete', { durationMs: 3_500 });
    await waitForCurrentTurnTerminalObserver();
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'complete',
      text: 'hello',
      assistantMessagePresent: true,
      durationMs: 3_500,
      usage: { inputTokens: 120, outputTokens: 30 },
    }));
    notifyCurrentTurnTerminal('complete');
    await waitForCurrentTurnTerminalObserver();
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it('reuses one output owner across a transient provider retry and drops retracted blocks', () => {
    const owner = {
      queueId: 'original-turn',
      requestId: null,
      assistantChannelDelivery: 'session-binding' as const,
      channelSessionId: 'session-1',
    };
    pushPendingOutputOwner(owner);
    expect(stageCurrentOutputOwnerAssistantChannelBlock('[Error]: retryable')).toBe(true);

    clearCurrentOutputOwnerAssistantChannelBlocks();
    admitPendingOutputOwnerForYield({ ...owner, queueId: 'retry-yield' }, true);
    expect(stageCurrentOutputOwnerAssistantChannelBlock('final answer')).toBe(true);

    expect(popPendingOutputOwner()).toMatchObject({
      queueId: 'original-turn',
      assistantChannelTextBlocks: ['final answer'],
    });
    expect(popPendingOutputOwner()).toBeNull();
  });

  it('keeps an exact accepted queue id for ownerless maintenance turns', () => {
    const item = queueItem('ownerless-heartbeat');
    item.turnOwner = undefined;
    setCurrentTurnSourceItem(item);

    expect(getCurrentTurnIdentity()).toBeNull();
    expect(getCurrentTurnQueueId()).toBe('ownerless-heartbeat');
  });

  it('keeps the terminal boundary closed until an async observer settles', async () => {
    let release!: () => void;
    const item = queueItem('turn-a');
    item.onTerminal = () => new Promise<void>((resolve) => {
      release = resolve;
    });
    setCurrentTurnSourceItem(item);

    notifyCurrentTurnTerminal('complete');
    notifyCurrentTurnTerminal('complete');
    let settled = false;
    void waitForCurrentTurnTerminalObserver().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await waitForCurrentTurnTerminalObserver();
    expect(settled).toBe(true);
  });

  it('settles a pre-dispatch cancellation exactly once and awaits its observer', async () => {
    let release!: () => void;
    const onTerminal = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const item = queueItem('queued-goal');
    item.onTerminal = onTerminal;

    let settled = false;
    const first = notifyQueuedTurnStopped(item).then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(onTerminal).toHaveBeenCalledOnce();
    expect(onTerminal).toHaveBeenCalledWith({
      status: 'stopped',
      text: '',
      assistantMessagePresent: false,
      error: 'Queue item was cancelled before dispatch',
    });

    await notifyQueuedTurnStopped(item);
    expect(onTerminal).toHaveBeenCalledOnce();

    release();
    await first;
    expect(settled).toBe(true);
  });

  it('turn owner keeps terminal inbox cleanup local to the active turn', () => {
    beginTurn({
      startedAt: 100,
      inboxMeta: {
        fromSessionId: 's1',
        fromLabel: 'source',
        originalMessageId: 'm1',
        originalSnippet: 'late',
        replyBack: true,
      },
    });
    appendCurrentTurnTextBlock('late');

    expect(getCurrentTurnText()).toBe('late');
    const cleanup = terminalCleanup();
    expect(cleanup.replyText).toBe('late');
    expect(cleanup.inboxMetas[0]?.fromSessionId).toBe('s1');
    expect(snapshotTurn().currentTurnTextBlocks).toEqual([]);
  });

  it('binds queued Inbox requests only on consumption, sharing the real result owner', () => {
    const root = queueItem('root');
    setCurrentTurnSourceItem(root);
    pushPendingOutputOwner({ queueId: root.id, sourceItem: root, requestId: null,
      assistantChannelDelivery: 'none', channelSessionId: 'session' });
    for (const id of ['one', 'two']) {
      const input = { ...queueItem(id), inputSource: 'inbox' as const,
        inboxMeta: { fromSessionId: id, fromLabel: id, originalMessageId: id, originalSnippet: id, replyBack: true } };
      pushPendingOutputOwner({ queueId: id, sourceItem: input, requestId: null,
        assistantChannelDelivery: 'none', channelSessionId: 'session' });
    }
    expect(snapshotTurn().currentTurnInboxMetas).toEqual([]);
    consumePendingInboxInput('one', true);
    consumePendingInboxInput('one', true); // duplicate receipt cannot double bind
    consumePendingInboxInput('two', true);
    expect(snapshotTurn().currentTurnSourceItem).toBe(root);
    expect(popPendingOutputOwner()?.queueId).toBe('root');
    expect(popPendingOutputOwner()).toBeNull();
    expect(terminalCleanup().inboxMetas.map(meta => meta.originalMessageId)).toEqual(['one', 'two']);
    expect(terminalCleanup().inboxMetas).toEqual([]);
  });

  it('keeps an unconsumed Inbox input out of the current turn and binds it to the next one', () => {
    const input = { ...queueItem('next'), inputSource: 'inbox' as const,
      inboxMeta: { fromSessionId: 'caller', fromLabel: 'caller', originalMessageId: 'next', originalSnippet: '', replyBack: true } };
    pushPendingOutputOwner({ queueId: input.id, sourceItem: input, requestId: null,
      assistantChannelDelivery: 'none', channelSessionId: 'session' });
    expect(terminalCleanup().inboxMetas).toEqual([]);
    consumePendingInboxInput('next', false);
    expect(snapshotTurn().currentTurnSourceItem).toBe(input);
    expect(terminalCleanup().inboxMetas).toEqual([input.inboxMeta]);
  });

  it('config owner drains deferred restarts and consumes provider boundary once', () => {
    scheduleDeferredRestart('mcp');
    scheduleDeferredRestart('agents');
    expect(hasDeferredRestart()).toBe(true);
    expect(drainDeferredRestart()).toBe('mcp,agents');
    expect(hasDeferredRestart()).toBe(false);

    setModel('claude-test');
    setPermissionPlanState({ permissionMode: 'plan', prePlanPermissionMode: 'auto' });
    setPendingProviderHistoryBoundaryReset(true);
    expect(getModel()).toBe('claude-test');
    expect(getPermissionMode()).toBe('plan');
    expect(snapshotConfig().prePlanPermissionMode).toBe('auto');
    expect(consumePendingProviderHistoryBoundaryReset()).toBe(true);
    expect(consumePendingProviderHistoryBoundaryReset()).toBe(false);
  });

  it('config owner applies policy decisions before state mutation', () => {
    setCurrentMcpServers([{ id: 'old', name: 'old', command: 'node', args: [], type: 'stdio', isBuiltin: false }]);
    const changedMcp = applyMcpServersUpdate(
      [{ id: 'new', name: 'new', command: 'node', args: [], type: 'stdio', isBuiltin: false }],
      { hasQuerySession: true },
    );
    expect(changedMcp).toMatchObject({
      applied: true,
      changed: true,
      shouldRestart: true,
      reason: 'fingerprint-changed',
    });
    expect(snapshotConfig().mcpServers?.map(server => server.id)).toEqual(['new']);

    const refreshedMcp = applyMcpServersUpdate(
      [{ id: 'new', name: 'new', command: 'new-command', args: [], type: 'stdio', isBuiltin: false }],
      { hasQuerySession: true },
    );
    expect(refreshedMcp).toMatchObject({
      applied: true,
      changed: true,
      shouldRestart: true,
      reason: 'fingerprint-changed',
    });
    expect(snapshotConfig().mcpServers?.[0]?.command).toBe('new-command');

    const skippedModel = applyModelUpdate('im-model', { source: 'im-sync', isSnapshotted: true });
    expect(skippedModel).toMatchObject({ applied: false, reason: 'snapshot-authoritative' });
    expect(getModel()).toBeUndefined();

    const appliedModel = applyModelUpdate('desktop-model', { source: 'desktop', isSnapshotted: true });
    expect(appliedModel).toMatchObject({ applied: true, oldModel: undefined, newModel: 'desktop-model' });
    expect(getModel()).toBe('desktop-model');

    const skippedProvider = applyProviderEnvUpdate(
      { baseUrl: 'https://channel.example.com', apiKey: 'k' },
      { source: 'im-sync', isSnapshotted: true },
    );
    expect(skippedProvider).toMatchObject({ applied: false, reason: 'snapshot-authoritative' });
    expect(snapshotConfig().providerEnv).toBeUndefined();

    const initialAgents = {
      existing: {
        description: 'existing',
        prompt: 'existing prompt',
        tools: [],
      },
    };
    const nextAgents = {
      changed: {
        description: 'changed',
        prompt: 'changed prompt',
        tools: [],
      },
    };
    expect(applyAgentDefinitionsUpdate(initialAgents, { hasQuerySession: false, isSnapshotted: false }))
      .toMatchObject({ applied: true, reason: 'no-active-session' });
    expect(Object.keys(getCurrentAgentDefinitions() ?? {})).toEqual(['existing']);

    const skippedAgents = applyAgentDefinitionsUpdate(nextAgents, {
      hasQuerySession: true,
      isSnapshotted: true,
    });
    expect(skippedAgents).toMatchObject({
      applied: false,
      changed: true,
      shouldRestart: false,
      reason: 'snapshot-authoritative',
    });
    expect(Object.keys(getCurrentAgentDefinitions() ?? {})).toEqual(['existing']);
  });

  it('transcript owner owns sequence cursor and uuid freshness', () => {
    expect(nextMessageSequence()).toBe(1);
    const assistant = { id: 'm2', role: 'assistant' as const, content: 'hi', timestamp: 'now' };
    replaceMessages([
      { id: 'm1', role: 'user', content: 'hello', timestamp: 'now', sdkInputUuid: 'input-1' },
      assistant,
    ]);
    addCurrentSessionUuid('uuid-1');

    expect(bindSdkUuidToUserInput('input-1', 'user-uuid')).toBe('m1');
    expect(bindSdkUuidToUserInput('input-1', 'user-uuid')).toBeNull();
    expect(bindSdkUuidToUserInput('unrelated-input', 'unrelated-uuid')).toBeNull();
    expect(bindSdkUuidToMessage(assistant, 'assistant-uuid')).toBe('m2');
    expect(getMessages()).toHaveLength(2);
    expect(getMessages().map(message => message.sdkUuid)).toEqual(['user-uuid', 'assistant-uuid']);
    expect(getCurrentSessionUuids().has('uuid-1')).toBe(true);

    clearTranscriptState();
    expect(snapshotTranscript()).toMatchObject({
      messages: [],
      messageSequence: 0,
      transcriptCursor: null,
    });
  });

  it('prewarm fail count is owned by lifecycle', () => {
    expect(getPreWarmFailCount()).toBe(0);
    expect(incrementPreWarmFailCount()).toBe(1);
  });

  it('revokes Query identity authority synchronously on abort and replacement', () => {
    const firstQuery = {} as never;
    const first = setQuerySessionWithAuthority(firstQuery, {
      productSessionId: 'product-a',
      expectedSdkSessionId: 'sdk-a',
    });
    expect(isCurrentQueryAuthority(first)).toBe(true);
    setSystemInitInfo({
      session_id: 'sdk-a',
      tools: [],
      mcp_servers: [],
      timestamp: 'now',
    });
    expect(getSystemInitInfo()?.session_id).toBe('sdk-a');
    expect(getSystemInitAuthority()).toBe(first);

    requestAbort();
    expect(first.revoked).toBe(true);
    expect(isCurrentQueryAuthority(first)).toBe(false);
    expect(getSystemInitInfo()).toBeNull();
    expect(getSystemInitAuthority()).toBeNull();

    clearAbortFlag();
    const second = setQuerySessionWithAuthority({} as never, {
      productSessionId: 'product-b',
      expectedSdkSessionId: 'sdk-b',
    });
    expect(isCurrentQueryAuthority(first)).toBe(false);
    expect(isCurrentQueryAuthority(second)).toBe(true);

    const replacementForSameQuery = setQuerySessionWithAuthority(second.query, {
      productSessionId: 'product-b',
      expectedSdkSessionId: 'sdk-b',
    });
    expect(second.revoked).toBe(true);
    expect(isCurrentQueryAuthority(second)).toBe(false);
    expect(isCurrentQueryAuthority(replacementForSameQuery)).toBe(true);
  });
});
