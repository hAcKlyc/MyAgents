import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appendMessage, resetTranscriptForTest, transcriptState } from './transcript';
import {
  accumulateCurrentTurnUsage,
  getLastSessionCompletionTerminal,
  appendCurrentTurnTextBlock,
  markAssistantMessageError,
  markCurrentTurnHasOutput,
  peekPendingOutputOwner,
  popPendingOutputOwner,
  pushPendingOutputOwner,
  resetTurnForTest,
  setCurrentTurnCompactResult,
  setCurrentTurnImTerminalEmitted,
  setCurrentTurnSourceItem,
  setCurrentTurnStartTime,
  setCurrentTurnToolCount,
  setSawCompactBoundary,
  stageCurrentOutputOwnerAssistantChannelBlock,
  waitForCurrentTurnTerminalObserver,
} from './turn';
import {
  clearInFlightSlot,
  hasQueuedOrInFlightWork,
  resetQueueForTest,
  setForceSurfaceInFlightId,
  setInFlightQueueItem,
  setInterruptingInFlightQueueId,
} from './queue';
import {
  createBuiltinTurnLifecycle,
  type BuiltinSdkResultMessage,
  type BuiltinTurnLifecycleDeps,
} from './turn-lifecycle';
import { NO_CHANNEL_DELIVERY, SESSION_BOUND_CHANNEL_DELIVERY } from '../session-core/channel-delivery';

vi.mock('../inbox/watch-deliver', () => ({
  deliverSessionWatchEvents: vi.fn(async () => undefined),
}));
import { deliverSessionWatchEvents } from '../inbox/watch-deliver';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeResult(overrides: Record<string, unknown> = {}): BuiltinSdkResultMessage {
  return ({
    type: 'result',
    subtype: 'success',
    duration_ms: 10,
    duration_api_ms: 5,
    is_error: false,
    num_turns: 1,
    result: '',
    stop_reason: null,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    terminal_reason: 'completed',
    uuid: '00000000-0000-4000-8000-000000000001',
    session_id: 'session-1',
    ...overrides,
  } as unknown) as BuiltinSdkResultMessage;
}

function makeDeps(overrides: Partial<BuiltinTurnLifecycleDeps> = {}) {
  const broadcasts: Array<{ event: string; data: unknown }> = [];
  const broadcast = vi.fn((event: string, data: unknown) => broadcasts.push({ event, data }));
  const deps: BuiltinTurnLifecycleDeps = {
    getSessionId: () => 'session-1',
    getWorkspacePath: () => '/tmp/workspace',
    getCurrentScenario: () => ({ type: 'desktop' }),
    getProviderEnv: () => undefined,
    getCurrentModel: () => 'claude-test',
    getIsInterruptingResponse: () => false,
    didInFlightSurviveInterrupt: () => null,
    setStreamingMessage: vi.fn(),
    resetInFlightToolCount: vi.fn(),
    resetWatchdogFired: vi.fn(),
    claimPostInterruptResultTerminal: vi.fn(),
    terminalEventAppliesToCurrentInFlight: () => true,
    dropInFlightQueueItem: vi.fn(() => null),
    preserveInFlightAfterTerminalBoundary: vi.fn(),
    surfaceInFlightQueueItem: vi.fn(async () => undefined),
    schedulePostTerminalQueueDrain: vi.fn(),
    endTurnAbort: vi.fn(),
    abortTurnAbort: vi.fn(),
    clearAmbientTurnId: vi.fn(),
    takeCurrentOutputOwner: vi.fn(() => popPendingOutputOwner()),
    completeOutputOwnerAfterPersistence: vi.fn(),
    failOutputOwner: vi.fn(),
    cancelCurrentImRequest: vi.fn(),
    failCurrentImRequest: vi.fn(),
    clearMirrorState: vi.fn(),
    clearStreamTurnMaps: vi.fn(),
    clearCronTaskContext: vi.fn(),
    hasQueuedOrInFlightWork: () => false,
    setSessionState: vi.fn(),
    persistTranscript: vi.fn(async () => undefined),
    snapshotTrace: () => null,
    emitTrace: vi.fn(),
    emitFirstDeltaTrace: vi.fn(),
    clearTrace: vi.fn(),
    nowMs: () => 100,
    elapsedMs: () => 1,
    broadcast,
    broadcastBuiltinContextUsage: vi.fn(async () => undefined),
    getCurrentTransientProviderRetryAttempt: () => 0,
    scheduleTransientProviderRetry: vi.fn(() => false),
    retractTransientProviderTextOutput: vi.fn(),
    clearApiRetryStatus: vi.fn(),
    trackServer: vi.fn(),
    firePostTurnTitleHook: vi.fn(),
    appendTextChunk: vi.fn(() => true),
    stageAssistantChannelBlock: vi.fn(),
    localizeImError: (error) => `localized:${error}`,
    setLastAgentError: vi.fn(),
    buildTurnProviderAnalytics: () => ({
      provider_name: null,
      api_protocol: null,
      provider_base_url: null,
      provider_api_protocol: null,
    }),
    probeForkPersistenceIfReady: vi.fn(),
    handleTerminalRecovery: vi.fn(),
    applyDeferredRestartIfNeeded: vi.fn(),
    ...overrides,
  };
  return { deps, broadcasts };
}

function pushOutputOwner(
  queueId: string,
  requestId: string | null,
  assistantChannelDelivery = NO_CHANNEL_DELIVERY.assistant,
): void {
  pushPendingOutputOwner({
    queueId,
    requestId,
    assistantChannelDelivery,
    channelSessionId: 'session-1',
  });
}

describe('turn-lifecycle owner', () => {
  beforeEach(() => {
    resetTranscriptForTest();
    resetTurnForTest();
    resetQueueForTest();
  });

  it('publishes the legacy Stop terminal before persistence and never overwrites a successor from its callback', async () => {
    const persist = deferred();
    const { deps, broadcasts } = makeDeps({ persistTranscript: vi.fn(() => persist.promise) });
    const lifecycle = createBuiltinTurnLifecycle(deps);
    const source = (id: string) => ({
      id, message: { role: 'user' as const, content: id }, messageText: id,
      wasQueued: false, resolve: vi.fn(), channelDelivery: NO_CHANNEL_DELIVERY,
    });
    setCurrentTurnSourceItem(source('A'));
    appendMessage({ id: 'answer-A', role: 'assistant', content: 'partial', timestamp: 't' });
    markCurrentTurnHasOutput();
    await lifecycle.handleSdkResult(makeResult({ terminal_reason: 'aborted_streaming' }));
    expect(getLastSessionCompletionTerminal()).toMatchObject({ turnId: 'A', status: 'stopped' });
    expect(broadcasts.some(({ event }) => event === 'chat:message-stopped')).toBe(false);
    setCurrentTurnSourceItem(source('B'));
    lifecycle.failTurn('B failed');
    persist.resolve();
    await lifecycle.getLastTurnEndPersist();
    await new Promise<void>(resolve => queueMicrotask(() => resolve()));
    expect(getLastSessionCompletionTerminal()).toMatchObject({ turnId: 'B', status: 'error' });
    expect(broadcasts.find(({ event }) => event === 'chat:message-stopped')?.data).toMatchObject({
      completionTerminal: { turnId: 'A', status: 'stopped' },
    });
  });

  it('broadcasts successful result, persists, then fires title hook after persist settles', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const persist = deferred();
    const { deps, broadcasts } = makeDeps({
      persistTranscript: vi.fn(() => persist.promise),
    });
    const lifecycle = createBuiltinTurnLifecycle(deps);
    appendMessage({
      id: '1',
      role: 'assistant',
      content: 'hello',
      timestamp: '2026-06-21T00:00:00.000Z',
    });
    markCurrentTurnHasOutput();
    appendCurrentTurnTextBlock('hello streamed answer');
    setCurrentTurnStartTime(90);
    const onTerminal = vi.fn();
    setCurrentTurnSourceItem({
      id: 'goal-turn',
      message: { role: 'user', content: 'run' },
      messageText: 'run',
      wasQueued: false,
      resolve: vi.fn(),
      turnOwner: { kind: 'goal', id: 'goal-1' },
      onTerminal,
      channelDelivery: NO_CHANNEL_DELIVERY,
      activityFacts: {
        origin: { kind: 'desktop', surface: 'launcher_input' },
        inputText: 'run',
      },
    });
    accumulateCurrentTurnUsage({ inputTokens: 100, outputTokens: 20 });

    lifecycle.handleSdkResult(makeResult({
      result: 'hello',
      usage: {
        input_tokens: 12,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 2,
      },
    }));

    expect(broadcasts.map(item => item.event)).not.toContain('chat:message-complete');
    expect(transcriptState.messages[0]).toMatchObject({
      usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 2 },
    });
    expect(onTerminal).not.toHaveBeenCalled();
    expect(deps.firePostTurnTitleHook).not.toHaveBeenCalled();
    expect(deps.completeOutputOwnerAfterPersistence).toHaveBeenCalledOnce();
    expect(deps.setSessionState).toHaveBeenCalledWith('idle');
    expect(deps.persistTranscript).toHaveBeenCalledWith(undefined, expect.any(String));

    persist.resolve();
    await persist.promise;
    await lifecycle.getLastTurnEndPersist();
    await waitForCurrentTurnTerminalObserver();

    expect(deps.completeOutputOwnerAfterPersistence).toHaveBeenCalledWith(
      null,
      expect.any(Object),
      expect.any(Promise),
      true,
    );

    expect(broadcasts.map(item => item.event)).toContain('chat:message-complete');
    expect(broadcasts.find(item => item.event === 'chat:message-complete')?.data).toMatchObject({
      completionTerminal: {
        sessionId: 'session-1',
        workspacePath: '/tmp/workspace',
        turnId: 'goal-turn',
        turnOwner: { kind: 'goal', id: 'goal-1' },
        origin: { kind: 'desktop', surface: 'launcher_input' },
        status: 'complete',
      },
    });
    const completeCall = vi.mocked(deps.broadcast).mock.calls.findIndex(([event]) => event === 'chat:message-complete');
    expect(vi.mocked(deps.setSessionState).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.broadcast).mock.invocationCallOrder[completeCall],
    );
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'complete',
      usage: { inputTokens: 12, outputTokens: 5 },
    }));
    expect(deps.firePostTurnTitleHook).toHaveBeenCalledWith(
      'session-1',
      'builtin',
      'claude-test',
      undefined,
    );
    expect(logSpy).toHaveBeenCalledWith(
      '[assistant-output] runtime=builtin status=complete text="hello streamed answer" chars=21',
    );
    logSpy.mockRestore();
  });

  it('routes empty successful result to message-error instead of message-complete', () => {
    const { deps, broadcasts } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);

    lifecycle.handleSdkResult(makeResult());

    expect(broadcasts.map(item => item.event)).toContain('chat:message-error');
    expect(broadcasts.map(item => item.event)).not.toContain('chat:message-complete');
    expect(deps.failCurrentImRequest).toHaveBeenCalledWith({
      finalPayloads: [{ text: expect.stringContaining('AI 未返回任何内容'), isError: true }],
    });
    expect(transcriptState.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('AI 未返回任何内容'),
    });
  });

  it('suppresses IM error forwarding for aborted SDK diagnostic results', async () => {
    const { deps } = makeDeps({
      getIsInterruptingResponse: () => true,
    });
    const lifecycle = createBuiltinTurnLifecycle(deps);
    pushOutputOwner('queue-1', 'req-1');

    lifecycle.handleSdkResult(makeResult({
      subtype: 'error_during_execution',
      is_error: true,
      result: '[ede_diagnostic] result_type=user abort',
      terminal_reason: 'aborted_streaming',
      errors: ['internal abort'],
    }));
    await lifecycle.getLastTurnEndPersist();

    expect(deps.failCurrentImRequest).not.toHaveBeenCalled();
    expect(deps.cancelCurrentImRequest).toHaveBeenCalledWith({
      finalPayloads: [{ text: '🛑 已取消' }],
    });
    expect(deps.completeOutputOwnerAfterPersistence).not.toHaveBeenCalled();
    expect(deps.claimPostInterruptResultTerminal).toHaveBeenCalledOnce();
  });

  it.each([
    { label: 'successful', result: makeResult({ result: 'fallback answer' }) },
    {
      label: 'error',
      result: makeResult({
        subtype: 'error_during_execution',
        is_error: true,
        result: 'provider error',
      }),
    },
  ])('consumes one non-IM output owner for a $label no-output result', async ({ result }) => {
    const { deps } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);
    pushOutputOwner('desktop-a', null);
    pushOutputOwner('queue-b', 'request-b');

    lifecycle.handleSdkResult(result);
    await lifecycle.getLastTurnEndPersist();

    if (result.is_error) {
      expect(deps.failOutputOwner).toHaveBeenCalledOnce();
    } else {
      expect(deps.completeOutputOwnerAfterPersistence).toHaveBeenCalledOnce();
    }
    expect(peekPendingOutputOwner()).toMatchObject({ queueId: 'queue-b', requestId: 'request-b' });
  });

  it('stages builtin result-only text and releases Session delivery only on success', async () => {
    const { deps } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);
    pushOutputOwner('desktop-result-only', null, SESSION_BOUND_CHANNEL_DELIVERY.assistant);

    lifecycle.handleSdkResult(makeResult({ result: 'result-only answer' }));
    await lifecycle.getLastTurnEndPersist();

    expect(deps.stageAssistantChannelBlock).toHaveBeenCalledWith('result-only answer');
    expect(deps.completeOutputOwnerAfterPersistence).toHaveBeenCalledWith(
      expect.objectContaining({ queueId: 'desktop-result-only' }),
      expect.any(Object),
      expect.any(Promise),
      true,
    );
  });

  it('detaches the completed output owner before slow persistence so the next yield owns output', async () => {
    const persist = deferred();
    const { deps } = makeDeps({ persistTranscript: vi.fn(() => persist.promise) });
    const lifecycle = createBuiltinTurnLifecycle(deps);
    pushOutputOwner('desktop-a', null, SESSION_BOUND_CHANNEL_DELIVERY.assistant);
    expect(stageCurrentOutputOwnerAssistantChannelBlock('answer a')).toBe(true);
    pushOutputOwner('im-b', 'request-b', 'reply-router');
    markCurrentTurnHasOutput();

    lifecycle.handleSdkResult(makeResult({ result: 'answer a' }));

    expect(peekPendingOutputOwner()).toMatchObject({ queueId: 'im-b', requestId: 'request-b' });
    expect(deps.completeOutputOwnerAfterPersistence).toHaveBeenCalledWith(
      expect.objectContaining({
        queueId: 'desktop-a',
        assistantChannelTextBlocks: ['answer a'],
      }),
      expect.any(Object),
      expect.any(Promise),
      true,
    );
    expect(stageCurrentOutputOwnerAssistantChannelBlock('answer b')).toBe(false);

    persist.resolve();
    await lifecycle.getLastTurnEndPersist();
  });

  it('does not release staged Session delivery for a failed builtin terminal', async () => {
    const { deps } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);
    pushOutputOwner('desktop-failed', null, SESSION_BOUND_CHANNEL_DELIVERY.assistant);
    markCurrentTurnHasOutput();

    lifecycle.handleSdkResult(makeResult({
      subtype: 'error_during_execution',
      is_error: true,
      result: 'failed after completed block',
      terminal_reason: 'error',
    }));
    await lifecycle.getLastTurnEndPersist();

    expect(deps.completeOutputOwnerAfterPersistence).not.toHaveBeenCalled();
    expect(deps.failOutputOwner).toHaveBeenCalledWith(
      expect.objectContaining({ queueId: 'desktop-failed' }),
      expect.any(Object),
    );
  });

  it('fails a non-completed terminal reason even when the SDK leaves is_error false', async () => {
    const { deps, broadcasts } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);
    pushOutputOwner('desktop-incomplete', null, SESSION_BOUND_CHANNEL_DELIVERY.assistant);
    markCurrentTurnHasOutput();
    setCurrentTurnSourceItem({
      id: 'task-turn',
      message: { role: 'user', content: 'run task' },
      messageText: 'run task',
      wasQueued: false,
      resolve: vi.fn(),
      turnOwner: { kind: 'task', id: 'task-1' },
      channelDelivery: NO_CHANNEL_DELIVERY,
    });

    lifecycle.handleSdkResult(makeResult({
      is_error: false,
      result: 'partial output before setup failure',
      terminal_reason: 'turn_setup_failed',
    }));
    await lifecycle.getLastTurnEndPersist();

    expect(deps.failOutputOwner).toHaveBeenCalledOnce();
    expect(deps.completeOutputOwnerAfterPersistence).not.toHaveBeenCalled();
    expect(deps.schedulePostTerminalQueueDrain).toHaveBeenCalledWith('error');
    expect(deps.trackServer).not.toHaveBeenCalledWith('ai_turn_complete', expect.anything());
    expect(broadcasts.find(item => item.event === 'chat:message-complete')?.data).toMatchObject({
      completionTerminal: { status: 'error' },
    });
  });

  it('lets a graceful interrupt result claim exactly one IM terminal owner', async () => {
    const persist = deferred();
    const cancelCurrentImRequest = vi.fn(() => {
      popPendingOutputOwner();
    });
    const { deps, broadcasts } = makeDeps({
      getIsInterruptingResponse: () => true,
      persistTranscript: vi.fn(() => persist.promise),
      cancelCurrentImRequest,
    });
    const lifecycle = createBuiltinTurnLifecycle(deps);
    pushOutputOwner('queue-a', 'request-a');
    pushOutputOwner('queue-b', 'request-b');
    markCurrentTurnHasOutput();

    lifecycle.handleSdkResult(makeResult({
      terminal_reason: 'aborted_streaming',
      result: 'partial answer',
    }));

    expect(cancelCurrentImRequest).toHaveBeenCalledOnce();
    expect(deps.completeOutputOwnerAfterPersistence).not.toHaveBeenCalled();
    expect(deps.claimPostInterruptResultTerminal).toHaveBeenCalledOnce();
    expect(peekPendingOutputOwner()).toMatchObject({ queueId: 'queue-b', requestId: 'request-b' });

    persist.resolve();
    await lifecycle.getLastTurnEndPersist();

    expect(cancelCurrentImRequest).toHaveBeenCalledOnce();
    expect(peekPendingOutputOwner()).toMatchObject({ queueId: 'queue-b', requestId: 'request-b' });
    expect(broadcasts.map(item => item.event)).toContain('chat:message-stopped');
    expect(broadcasts.map(item => item.event)).not.toContain('chat:message-complete');
  });

  it('preserves an older FIFO owner when an exact request already claimed graceful cancellation', () => {
    const { deps } = makeDeps({
      getIsInterruptingResponse: () => true,
    });
    const lifecycle = createBuiltinTurnLifecycle(deps);
    pushOutputOwner('older-queue', 'older-request');
    setCurrentTurnImTerminalEmitted(true);
    markCurrentTurnHasOutput();

    lifecycle.handleSdkResult(makeResult({
      terminal_reason: 'aborted_streaming',
      result: 'partial answer',
    }));

    expect(deps.cancelCurrentImRequest).not.toHaveBeenCalled();
    expect(deps.claimPostInterruptResultTerminal).toHaveBeenCalledOnce();
    expect(peekPendingOutputOwner()).toMatchObject({
      queueId: 'older-queue',
      requestId: 'older-request',
    });
  });

  it('surfaces missing native anchors instead of silently replaying with full history', async () => {
    const { deps, broadcasts } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);
    await lifecycle.handleSdkResult(makeResult({
      subtype: 'error_during_execution', is_error: true,
      result: 'Execution failed',
      errors: ['No message found with message.uuid of: rejected-anchor'], terminal_reason: 'error',
    }));
    expect(broadcasts.map(item => item.event)).toContain('chat:agent-error');
    expect(broadcasts.find(item => item.event === 'chat:agent-error')?.data).toMatchObject({
      message: expect.stringContaining('会话恢复点已失效'),
    });
    expect(deps.handleTerminalRecovery).toHaveBeenCalledWith(undefined);
  });

  it.each([0, 1])('offers rejected reload recovery only before a model turn (num_turns=%s)', async numTurns => {
    const { deps, broadcasts } = makeDeps();
    const recover = vi.fn(() => true);
    const lifecycle = createBuiltinTurnLifecycle(deps);
    const outcome = await lifecycle.handleSdkResult(makeResult({
      subtype: 'error_during_execution', is_error: true, num_turns: numTurns,
      result: 'SDK initialization failed',
      errors: ['No message found with message.uuid of: rejected-anchor'], terminal_reason: 'error',
    }), recover);
    if (numTurns === 0) {
      expect(recover).toHaveBeenCalledWith(expect.stringContaining('No message found with message.uuid of: rejected-anchor'));
      expect(outcome).toBe('retrying');
      expect(broadcasts.map(item => item.event)).not.toContain('chat:agent-error');
    } else {
      expect(recover).not.toHaveBeenCalled();
      expect(outcome).toBe('terminal');
      expect(broadcasts.map(item => item.event)).toContain('chat:agent-error');
    }
  });


  it('does not title a completed turn when turn-end persistence fails', async () => {
    const { deps, broadcasts } = makeDeps({
      persistTranscript: vi.fn(async () => {
        throw new Error('durable write failed');
      }),
    });
    const lifecycle = createBuiltinTurnLifecycle(deps);
    appendMessage({
      id: '1',
      role: 'assistant',
      content: 'hello',
      timestamp: '2026-06-21T00:00:00.000Z',
    });
    markCurrentTurnHasOutput();

    lifecycle.handleSdkResult(makeResult({ result: 'hello' }));

    expect(broadcasts.map(item => item.event)).not.toContain('chat:message-complete');
    await expect(lifecycle.getLastTurnEndPersist()).rejects.toThrow('durable write failed');
    await Promise.resolve();
    expect(broadcasts.map(item => item.event)).not.toContain('chat:message-complete');
    expect(deps.firePostTurnTitleHook).not.toHaveBeenCalled();
    expect(deps.completeOutputOwnerAfterPersistence).toHaveBeenCalledWith(
      null,
      expect.any(Object),
      expect.any(Promise),
      true,
    );
    expect(deps.emitTrace).toHaveBeenCalledWith(
      'persist_done',
      expect.objectContaining({ status: 'error' }),
      null,
    );
  });

  it('treats compact control turns as successful even when the SDK result has no visible text', async () => {
    const { deps, broadcasts } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);
    setCurrentTurnCompactResult('success');
    setSawCompactBoundary(true);

    lifecycle.handleSdkResult(makeResult());
    await lifecycle.getLastTurnEndPersist();

    expect(broadcasts.map(item => item.event)).toContain('chat:message-complete');
    expect(broadcasts.map(item => item.event)).not.toContain('chat:message-error');
    expect(deps.failCurrentImRequest).not.toHaveBeenCalled();
  });

  it.each(['', 'Error during compaction: API Error: 400 request rejected'])(
    'settles explicit native compaction failure as error despite outer SDK success: %s', async result => {
      const { deps } = makeDeps();
      const terminal = vi.fn();
      setCurrentTurnSourceItem({ id: 'compact-queue', message: { role: 'user', content: '/compact' },
        messageText: '/compact', wasQueued: false, resolve: () => {}, channelDelivery: NO_CHANNEL_DELIVERY,
        turnOwner: { kind: 'goal', id: 'same-goal' }, onTerminal: terminal });
      setCurrentTurnCompactResult('failed');
      markAssistantMessageError('Native compaction failed');
      const lifecycle = createBuiltinTurnLifecycle(deps);
      const frame = makeResult({ result, num_turns: 0 });
      expect(lifecycle.canMaterializeRewindResult(frame)).toBe(false);
      await lifecycle.handleSdkResult(frame);
      await lifecycle.getLastTurnEndPersist();
      await waitForCurrentTurnTerminalObserver();
      expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', code: 'compaction_failed' }));
      expect(deps.emitTrace).toHaveBeenCalledWith('final', expect.objectContaining({ status: 'error' }));
      expect(deps.firePostTurnTitleHook).not.toHaveBeenCalled();
    });

  it('auto-retries success-shaped transient provider text instead of completing the turn', async () => {
    const { deps, broadcasts } = makeDeps({
      scheduleTransientProviderRetry: vi.fn(() => true),
    });
    const lifecycle = createBuiltinTurnLifecycle(deps);
    const transientResult = makeResult({
      result: '[Error]: Concurrency limit exceeded for account, please retry later',
    });

    expect(lifecycle.canMaterializeRewindResult(transientResult)).toBe(false);
    await expect(lifecycle.handleSdkResult(transientResult)).resolves.toBe('retrying');

    expect(deps.retractTransientProviderTextOutput).toHaveBeenCalledWith(
      '[Error]: Concurrency limit exceeded for account, please retry later',
    );
    expect(deps.scheduleTransientProviderRetry).toHaveBeenCalledWith(expect.objectContaining({
      retry: true,
      attempt: 1,
      maxRetries: 3,
      delayMs: 15_000,
      error: expect.objectContaining({ kind: 'concurrency_limit' }),
    }));
    expect(broadcasts.map(item => item.event)).not.toContain('chat:message-complete');
    expect(broadcasts.map(item => item.event)).not.toContain('chat:message-error');
    expect(deps.persistTranscript).not.toHaveBeenCalled();
  });

  it('does not auto-retry transient provider text after tool side effects', async () => {
    const { deps, broadcasts } = makeDeps({
      scheduleTransientProviderRetry: vi.fn(() => true),
    });
    const lifecycle = createBuiltinTurnLifecycle(deps);
    setCurrentTurnToolCount(1);

    await lifecycle.handleSdkResult(makeResult({
      result: '[Error]: Concurrency limit exceeded for account, please retry later',
    }));

    expect(deps.scheduleTransientProviderRetry).not.toHaveBeenCalled();
    expect(deps.retractTransientProviderTextOutput).toHaveBeenCalledWith(
      '[Error]: Concurrency limit exceeded for account, please retry later',
    );
    expect(broadcasts.map(item => item.event)).toContain('chat:message-error');
    expect(broadcasts.map(item => item.event)).not.toContain('chat:message-complete');
    expect(deps.setLastAgentError).toHaveBeenCalledWith(expect.stringContaining('无法安全自动重试'));
  });

  it('surfaces a clear terminal error after transient provider text retries are exhausted', async () => {
    const { deps, broadcasts } = makeDeps({
      getCurrentTransientProviderRetryAttempt: () => 3,
    });
    const lifecycle = createBuiltinTurnLifecycle(deps);

    await lifecycle.handleSdkResult(makeResult({
      result: '[Error]: Concurrency limit exceeded for account, please retry later',
      modelUsage: { 'test-model': { inputTokens: 8, outputTokens: 2 } },
    }));

    expect(deps.retractTransientProviderTextOutput).toHaveBeenCalled();
    expect(deps.scheduleTransientProviderRetry).not.toHaveBeenCalled();
    expect(broadcasts.map(item => item.event)).toContain('chat:message-error');
    expect(broadcasts.map(item => item.event)).not.toContain('chat:message-complete');
    expect(deps.setLastAgentError).toHaveBeenCalledWith(expect.stringContaining('已自动重试 3 次仍失败'));
    expect(transcriptState.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('Error: 上游模型服务达到账号并发限制'),
      usage: { inputTokens: 8, outputTokens: 2,
        sdkCumulativeModelUsage: { 'test-model': { inputTokens: 8, outputTokens: 2 } } },
    });
  });

  it('surfaces provider error detail as agent-error even with output + tools (PRD 0.4.10)', async () => {
    const { deps, broadcasts } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);
    markCurrentTurnHasOutput();
    setCurrentTurnToolCount(6);

    await lifecycle.handleSdkResult(makeResult({
      is_error: true,
      terminal_reason: 'api_error',
      api_error_status: 429,
      result: 'rate_limit: API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。]',
    }));

    const agentErrors = broadcasts.filter((item) => item.event === 'chat:agent-error');
    expect(agentErrors).toHaveLength(1);
    expect(deps.setLastAgentError).toHaveBeenCalledWith(
      '(429) 限流 / 额度受限 - rate_limit: API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。]',
    );
  });

  it('surfaces provisional assistant error as agent-error even without a status code', async () => {
    const { deps, broadcasts } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);
    markAssistantMessageError('model overloaded');

    await lifecycle.handleSdkResult(makeResult({
      is_error: true,
      terminal_reason: 'model_error',
    }));

    const agentErrors = broadcasts.filter((item) => item.event === 'chat:agent-error');
    expect(agentErrors).toHaveLength(1);
    expect(deps.setLastAgentError).toHaveBeenCalledWith('model overloaded');
  });

  it('does NOT surface enum-only terminal reasons (max_turns) as agent-error', async () => {
    const { deps, broadcasts } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);

    await lifecycle.handleSdkResult(makeResult({
      is_error: false,
      terminal_reason: 'max_turns',
      result: 'partial answer that hit the turn limit',
    }));

    expect(broadcasts.map((item) => item.event)).not.toContain('chat:agent-error');
    expect(deps.setLastAgentError).not.toHaveBeenCalled();
  });

  it('emits exactly one chat:agent-error for a provider failure (no double broadcast)', async () => {
    const { deps, broadcasts } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);

    await lifecycle.handleSdkResult(makeResult({
      is_error: true,
      terminal_reason: 'api_error',
      api_error_status: 500,
      result: 'upstream overloaded',
    }));

    const agentErrors = broadcasts.filter((item) => item.event === 'chat:agent-error');
    expect(agentErrors).toHaveLength(1);
    expect(agentErrors[0].data).toEqual({ message: '(500) 供应商服务器错误 - upstream overloaded' });
  });

  it('surfaces image_error delivered as SDKResultError (errors-only, no status) with rewind text', async () => {
    const { deps, broadcasts } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);

    await lifecycle.handleSdkResult(makeResult({
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'image_error',
      errors: ['image dimensions exceed max allowed size: 8000 pixels'],
    }));

    const agentErrors = broadcasts.filter((item) => item.event === 'chat:agent-error');
    expect(agentErrors).toHaveLength(1);
    expect(deps.setLastAgentError).toHaveBeenCalledWith(
      'image dimensions exceed max allowed size: 8000 pixels',
    );
    expect(deps.handleTerminalRecovery).toHaveBeenCalledWith('image');
  });

  it('does NOT surface policy-limit subtypes (error_max_turns) even with a non-empty errors array', async () => {
    const { deps, broadcasts } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);

    await lifecycle.handleSdkResult(makeResult({
      subtype: 'error_max_turns',
      is_error: true,
      terminal_reason: 'max_turns',
      errors: ['max turns exceeded'],
    }));

    expect(broadcasts.map((item) => item.event)).not.toContain('chat:agent-error');
    expect(deps.setLastAgentError).not.toHaveBeenCalled();
  });

  it('does NOT surface a terminal failure whose only text is the ambiguous result field', async () => {
    const { deps, broadcasts } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);

    await lifecycle.handleSdkResult(makeResult({
      is_error: true,
      terminal_reason: 'turn_setup_failed',
      result: 'setup failed for an unknown reason',
    }));

    expect(broadcasts.map((item) => item.event)).not.toContain('chat:agent-error');
    expect(deps.setLastAgentError).not.toHaveBeenCalled();
  });

  it('does NOT surface a provisional error recovered by a completed result', async () => {
    const { deps, broadcasts } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);
    markAssistantMessageError('transient hiccup');

    await lifecycle.handleSdkResult(makeResult({
      is_error: false,
      terminal_reason: 'completed',
      result: 'final answer',
    }));

    expect(broadcasts.map((item) => item.event)).not.toContain('chat:agent-error');
    expect(deps.setLastAgentError).not.toHaveBeenCalled();
  });

  it('feeds the unified resultErrorText (incl. provisional) into sessionEventError', async () => {
    const { deps } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);
    markAssistantMessageError('upstream overloaded');

    await lifecycle.handleSdkResult(makeResult({
      is_error: true,
      terminal_reason: 'model_error',
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(vi.mocked(deliverSessionWatchEvents)).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        error: expect.objectContaining({ code: 'turn_failed', message: 'upstream overloaded' }),
      }),
      [],
    );
  });

  it('finalizes stopped turns with queue cleanup, IM completion, and persistence', async () => {
    const { deps } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);
    const onTerminal = vi.fn();
    setCurrentTurnSourceItem({
      id: 'goal-turn',
      message: { role: 'user', content: 'run' },
      messageText: 'run',
      wasQueued: false,
      resolve: vi.fn(),
      onTerminal,
      channelDelivery: NO_CHANNEL_DELIVERY,
      activityFacts: {
        origin: { kind: 'desktop', surface: 'launcher_input' },
        inputText: 'run',
      },
    });
    accumulateCurrentTurnUsage({ inputTokens: 120, outputTokens: 30 });
    accumulateCurrentTurnUsage({ inputTokens: 80, outputTokens: 20 });

    lifecycle.stopTurn();

    await waitForCurrentTurnTerminalObserver();
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'stopped',
      usage: { inputTokens: 200, outputTokens: 50 },
    }));
    expect(deps.schedulePostTerminalQueueDrain).toHaveBeenCalledWith('stopped');
    expect(deps.endTurnAbort).toHaveBeenCalledWith('session-1');
    expect(deps.completeOutputOwnerAfterPersistence).not.toHaveBeenCalled();
    expect(deps.cancelCurrentImRequest).toHaveBeenCalledWith({
      finalPayloads: [{ text: '🛑 已取消' }],
    });
    expect(deps.persistTranscript).toHaveBeenCalledTimes(1);
    expect(deps.persistTranscript).toHaveBeenCalledWith(undefined, expect.any(String));
  });

  it('does not pop the output-owner FIFO after an exact request already emitted its terminal', () => {
    const { deps } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);
    pushOutputOwner('older-queue', 'older-request');
    setCurrentTurnImTerminalEmitted(true);

    lifecycle.stopTurn();

    expect(deps.cancelCurrentImRequest).not.toHaveBeenCalled();
    expect(peekPendingOutputOwner()).toMatchObject({
      queueId: 'older-queue',
      requestId: 'older-request',
    });
  });

  it('persists unexpected errors and commits terminal metadata for expected terminations', async () => {
    const { deps } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);

    lifecycle.failTurn('boom');
    await waitForCurrentTurnTerminalObserver();
    expect(deps.schedulePostTerminalQueueDrain).toHaveBeenCalledWith('error');
    expect(deps.abortTurnAbort).toHaveBeenCalledWith('session-1', 'error');
    expect(deps.failCurrentImRequest).toHaveBeenCalledWith({
      finalPayloads: [{ text: 'localized:boom', isError: true }],
    });
    expect(deps.persistTranscript).toHaveBeenCalledTimes(1);
    expect(transcriptState.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Error: boom',
    });

    resetTranscriptForTest();
    vi.mocked(deps.persistTranscript).mockClear();
    lifecycle.failTurn('AbortError: interrupted');
    await waitForCurrentTurnTerminalObserver();
    expect(deps.persistTranscript).toHaveBeenCalledWith(undefined, undefined);
    expect(transcriptState.messages).toEqual([]);
  });

  it('drains deferred restart ownership after accepted setup fails before SDK dispatch', async () => {
    const { deps } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);
    setCurrentTurnSourceItem({
      id: 'admitted-persist-failure',
      requestId: 'request-persist-failure',
      message: { role: 'user', content: 'persist me' },
      messageText: 'persist me',
      wasQueued: false,
      resolve: vi.fn(),
      channelDelivery: NO_CHANNEL_DELIVERY,
    });

    lifecycle.failAdmittedTurnSetup('metadata setup failed');

    await waitForCurrentTurnTerminalObserver();
    expect(deps.schedulePostTerminalQueueDrain).toHaveBeenCalledWith('error');
    expect(deps.applyDeferredRestartIfNeeded).toHaveBeenCalledOnce();
    expect(deps.failCurrentImRequest).toHaveBeenCalledWith({
      finalPayloads: [{ text: 'localized:metadata setup failed', isError: true }],
    });
    expect(deps.persistTranscript).toHaveBeenCalledOnce();
    expect(deps.setSessionState).toHaveBeenCalledWith('idle');
  });

  it('surfaces forced in-flight items but preserves natural completions for SDK replay', () => {
    const { deps } = makeDeps({
      getIsInterruptingResponse: () => true,
    });
    const lifecycle = createBuiltinTurnLifecycle(deps);
    setInFlightQueueItem('queued-1', {
      messageText: 'run now',
      channelDelivery: NO_CHANNEL_DELIVERY,
    });
    setForceSurfaceInFlightId('queued-1');
    setInterruptingInFlightQueueId('queued-1');
    appendMessage({ id: '1', role: 'assistant', content: 'done', timestamp: 't1' });
    markCurrentTurnHasOutput();

    lifecycle.handleSdkResult(makeResult({ result: 'done' }));

    expect(deps.claimPostInterruptResultTerminal).toHaveBeenCalledOnce();
    expect(deps.surfaceInFlightQueueItem).toHaveBeenCalledWith(
      'queued-1',
      { messageText: 'run now', channelDelivery: NO_CHANNEL_DELIVERY },
      expect.objectContaining({ reason: 'force-send #289', midTurnBreak: true }),
    );
    expect(deps.dropInFlightQueueItem).not.toHaveBeenCalled();

    resetTranscriptForTest();
    resetTurnForTest();
    resetQueueForTest();
    vi.clearAllMocks();
    const natural = makeDeps();
    const naturalLifecycle = createBuiltinTurnLifecycle(natural.deps);
    setInFlightQueueItem('queued-2', {
      messageText: 'wait for replay',
      channelDelivery: NO_CHANNEL_DELIVERY,
    });
    appendMessage({ id: '1', role: 'assistant', content: 'done', timestamp: 't1' });
    markCurrentTurnHasOutput();

    naturalLifecycle.handleSdkResult(makeResult({ result: 'done' }));

    expect(natural.deps.preserveInFlightAfterTerminalBoundary).toHaveBeenCalledWith('natural result');
    expect(natural.deps.surfaceInFlightQueueItem).not.toHaveBeenCalled();
    expect(natural.deps.dropInFlightQueueItem).not.toHaveBeenCalled();
  });

  it('does not broadcast message-stopped on force-surface (loading stays continuous)', async () => {
    const { deps } = makeDeps({
      getIsInterruptingResponse: () => true,
    });
    const lifecycle = createBuiltinTurnLifecycle(deps);
    setInFlightQueueItem('queued-force', {
      messageText: 'run now',
      channelDelivery: NO_CHANNEL_DELIVERY,
    });
    setForceSurfaceInFlightId('queued-force');
    setInterruptingInFlightQueueId('queued-force');
    appendMessage({ id: '1', role: 'assistant', content: 'done', timestamp: 't1' });
    markCurrentTurnHasOutput();

    await lifecycle.handleSdkResult(makeResult({
      result: 'done',
      terminal_reason: 'aborted_streaming',
    }));
    // Flush the afterPersist microtask chain (persistTranscript -> afterPersist).
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(deps.surfaceInFlightQueueItem).toHaveBeenCalledOnce();
    expect(deps.broadcast).not.toHaveBeenCalledWith(
      'chat:message-stopped',
      expect.anything(),
    );
  });

  it.each(['sync-v2', 'deferred-v1'] as const)(
    'keeps accepted force execution active after its queue slot is cleared (%s)', async surfaceTiming => {
      let interrupting = true;
      let streaming = true;
      let streamingAtSurface = false;
      const surfaceReady = deferred();
      const surface = vi.fn(async () => {
        if (surfaceTiming === 'deferred-v1') await surfaceReady.promise;
        // Real surface clears the last queue slot, then checks whether a
        // deferred config restart is safe. The accepted turn must own activity
        // already, before either operation can observe an empty queue.
        streamingAtSurface = streaming;
        clearInFlightSlot();
      });
      const { deps } = makeDeps({
        getIsInterruptingResponse: () => interrupting,
        hasQueuedOrInFlightWork,
        setStreamingMessage: vi.fn(value => { streaming = value; }),
        surfaceInFlightQueueItem: surface,
      });
      const lifecycle = createBuiltinTurnLifecycle(deps);
      setInFlightQueueItem('forced-last-item', {
        messageText: 'run now', channelDelivery: NO_CHANNEL_DELIVERY,
      });
      setForceSurfaceInFlightId('forced-last-item');
      setInterruptingInFlightQueueId('forced-last-item');
      appendMessage({ id: '1', role: 'assistant', content: 'partial', timestamp: 't1' });
      markCurrentTurnHasOutput();

      lifecycle.handleSdkResult(makeResult({ terminal_reason: 'aborted_streaming' }));
      surfaceReady.resolve();
      await surface.mock.results[0].value;
      await lifecycle.getLastTurnEndPersist();
      expect(hasQueuedOrInFlightWork()).toBe(false);
      expect(streaming).toBe(true);
      expect(deps.setSessionState).not.toHaveBeenCalledWith('idle');
      expect(streamingAtSurface).toBe(true);
      expect(deps.broadcast).not.toHaveBeenCalledWith('chat:message-stopped', expect.anything());

      // No sticky busy state: the accepted turn's own terminal releases it.
      interrupting = false;
      lifecycle.handleSdkResult(makeResult({ result: 'next turn done' }));
      await lifecycle.getLastTurnEndPersist();
      expect(streaming).toBe(false);
      expect(deps.setSessionState).toHaveBeenLastCalledWith('idle');
    },
  );

  it('still broadcasts message-stopped on a plain stop without force-surface', async () => {
    const { deps } = makeDeps({
      getIsInterruptingResponse: () => true,
    });
    const lifecycle = createBuiltinTurnLifecycle(deps);
    appendMessage({ id: '1', role: 'assistant', content: 'done', timestamp: 't1' });
    markCurrentTurnHasOutput();

    await lifecycle.handleSdkResult(makeResult({
      result: 'done',
      terminal_reason: 'aborted_streaming',
    }));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(deps.broadcast).toHaveBeenCalledWith('chat:message-stopped', null);
  });

  it('preserves a plain-stop in-flight item when the interrupt receipt says it will run', () => {
    const { deps } = makeDeps({
      getIsInterruptingResponse: () => true,
      didInFlightSurviveInterrupt: queueId => queueId === 'queued-survivor',
    });
    const lifecycle = createBuiltinTurnLifecycle(deps);
    setInFlightQueueItem('queued-survivor', {
      messageText: 'continue after stop',
      channelDelivery: NO_CHANNEL_DELIVERY,
    });
    setInterruptingInFlightQueueId('queued-survivor');
    appendMessage({ id: '1', role: 'assistant', content: 'partial', timestamp: 't1' });
    markCurrentTurnHasOutput();

    lifecycle.handleSdkResult(makeResult({
      result: 'partial',
      terminal_reason: 'aborted_streaming',
    }));

    expect(deps.preserveInFlightAfterTerminalBoundary).toHaveBeenCalledWith(
      'interrupt receipt confirms queued survivor',
    );
    expect(deps.dropInFlightQueueItem).not.toHaveBeenCalled();
  });
});
