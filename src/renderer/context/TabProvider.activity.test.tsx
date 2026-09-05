import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SseEventMetadata } from '@/api/SseConnection';
import {
  createSessionResourceTransitionState,
  tryClaimSessionResourceTransition,
} from '@/utils/sessionDeletionCoordinator';
import { useTabState } from './TabContext';
import type { Message } from '@/types/chat';
import TabProvider, {
  applySubagentLifecycleUpdate,
  finalizeMessageSubagentProjection,
  handleApiResponse,
} from './TabProvider';

type EventHandler = (
  eventName: string,
  data: unknown,
  metadata: SseEventMetadata,
) => void;
type StatusHandler = (
  status: 'connected' | 'disconnected' | 'reconnecting' | 'failed',
) => void;

const sseHarness = vi.hoisted(() => {
  const state = {
    connected: false,
    generation: 1,
    eventHandler: null as EventHandler | null,
    statusHandler: null as StatusHandler | null,
  };
  const connection = {
    setEventHandler: vi.fn((handler: EventHandler) => {
      state.eventHandler = handler;
    }),
    setStatusHandler: vi.fn((handler: StatusHandler) => {
      state.statusHandler = handler;
    }),
    connect: vi.fn(async () => {
      state.connected = true;
      state.statusHandler?.('connected');
    }),
    disconnect: vi.fn(async () => {
      state.connected = false;
    }),
    isActive: vi.fn(() => state.connected),
    getConnectionGeneration: vi.fn(() => state.generation),
  };
  return { state, connection };
});

const tauriHarness = vi.hoisted(() => ({
  proxyFetch: vi.fn(),
  ensureSessionSidecar: vi.fn(async () => undefined),
  isTauri: false,
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock('@/api/SseConnection', () => ({
  createSseConnection: () => sseHarness.connection,
}));

vi.mock('@/config/useConfigData', () => ({
  useConfigData: () => ({ config: { multiAgentRuntime: false } }),
}));

vi.mock('@/config/services/agentConfigService', () => ({
  getProjectAgent: () => undefined,
}));

vi.mock('@/config/services/appConfigService', () => ({
  notifyConfigChanged: vi.fn(),
}));

vi.mock('@/analytics', () => ({
  track: vi.fn(),
  consumePendingSessionBirth: vi.fn((_tabId: string, fallback: unknown) => fallback),
  peekPendingSessionBirth: vi.fn((_tabId: string, fallback: unknown) => fallback),
  setPendingSessionBirth: vi.fn(),
  hashAgentNameSync: () => null,
  birthContextForSurface: vi.fn((surface: string) => ({
    surface,
    entryIntent: 'unknown',
    hasInitialMessage: false,
  })),
}));

vi.mock('@/utils/frontendLogger', () => ({
  subscribeFrontendLogs: () => () => undefined,
  setCurrentTabId: vi.fn(),
  setFocusedTabId: vi.fn(),
}));

vi.mock('@/api/tauriClient', () => ({
  getTabServerUrl: vi.fn(async () => 'http://127.0.0.1:1234'),
  sessionSidecarFetch: vi.fn(async (
    _sessionId: string,
    _owner: { type: 'tab'; id: string },
    path: string,
    init?: RequestInit,
  ) => tauriHarness.proxyFetch(`http://127.0.0.1:1234${path}`, init)),
  isTauri: () => tauriHarness.isTauri,
  getSessionActivation: vi.fn(async () => null),
  getSessionPort: vi.fn(async () => null),
  ensureSessionSidecar: tauriHarness.ensureSessionSidecar,
  resetTabServerUrlCache: vi.fn(),
  setActiveCorrelation: vi.fn(),
  setFocusedCorrelationTabId: vi.fn(),
}));

vi.mock('@/utils/tauriListen', () => ({
  listenWithCleanup: vi.fn(async (
    eventName: string,
    listener: (event: { payload: unknown }) => void,
  ) => {
    tauriHarness.listeners.set(eventName, listener);
    return {
      unlisten: () => tauriHarness.listeners.delete(eventName),
      isRegistered: () => tauriHarness.listeners.has(eventName),
    };
  }),
}));

function Probe() {
  const {
    sessionId,
    isLoading,
    isSessionLoading,
    sessionRestoreError,
    sessionState,
    historyMessages,
    streamingMessage,
    systemInitInfo,
    mcpEffectiveSnapshot,
    queuedMessages,
    agentError,
    isConnected,
    adoptMigratedSession,
    resetSession,
    retryCurrentSessionRestore,
    sendMessage,
    cancelQueuedMessage,
    forceExecuteQueuedMessage,
  } = useTabState();
  const [retryRestoreTargetPresent, setRetryRestoreTargetPresent] = useState<boolean | null>(null);
  return (
    <>
      <output data-testid="activity">
        {JSON.stringify({
          sessionId,
          isLoading,
          sessionState,
          historyCount: historyMessages.length,
          initModel: systemInitInfo?.model ?? null,
        })}
      </output>
      <output data-testid="connected">{String(isConnected)}</output>
      <output data-testid="init-tools">{JSON.stringify(systemInitInfo?.tools ?? [])}</output>
      <output data-testid="mcp-runtime-generation">{mcpEffectiveSnapshot?.runtimeGeneration ?? ''}</output>
      <output data-testid="streaming-content">{JSON.stringify(streamingMessage?.content ?? null)}</output>
      <output data-testid="session-loading">{String(isSessionLoading)}</output>
      <output data-testid="session-restore-error">{sessionRestoreError ?? ''}</output>
      <output data-testid="history-content">{JSON.stringify(historyMessages.map(message => message.content))}</output>
      <output data-testid="history-identities">{JSON.stringify(historyMessages.map(message => ({
        id: message.id,
        runtimeTurnAnchor: message.runtimeTurnAnchor ?? null,
      })))}</output>
      <output data-testid="queue-ids">{JSON.stringify(queuedMessages.map(item => item.queueId))}</output>
      <output data-testid="agent-error">{agentError ?? ''}</output>
      <output data-testid="retry-restore-target-present">{JSON.stringify(retryRestoreTargetPresent)}</output>
      <button type="button" onClick={() => void sendMessage('hello')}>send message</button>
      <button type="button" onClick={() => void resetSession()}>reset session</button>
      <button type="button" onClick={() => {
        void retryCurrentSessionRestore('m2').then(result => {
          if (result.restored) setRetryRestoreTargetPresent(result.targetMessagePresent);
        });
      }}>retry restore</button>
      <button type="button" onClick={() => void adoptMigratedSession('session-migrated-b', { sidecarAlreadyMigrated: true })}>adopt migrated session</button>
      <button type="button" onClick={() => void cancelQueuedMessage('queue-stale-cancel')}>cancel stale</button>
      <button type="button" onClick={() => void forceExecuteQueuedMessage('queue-stale-force')}>force stale</button>
    </>
  );
}

function readActivity(): {
  sessionId: string | null;
  isLoading: boolean;
  sessionState: string;
  historyCount: number;
  initModel: string | null;
} {
  return JSON.parse(screen.getByTestId('activity').textContent ?? '{}') as {
    sessionId: string | null;
    isLoading: boolean;
    sessionState: string;
    historyCount: number;
    initModel: string | null;
  };
}

function emit(eventName: string, data: unknown, metadata?: Partial<SseEventMetadata>): void {
  const handler = sseHarness.state.eventHandler;
  if (!handler) throw new Error('SSE event handler is not installed');
  act(() => {
    handler(eventName, data, {
      connectionGeneration: sseHarness.state.generation,
      ...metadata,
    });
  });
}

function readQueueIds(): string[] {
  return JSON.parse(screen.getByTestId('queue-ids').textContent ?? '[]') as string[];
}

function readInitTools(): string[] {
  return JSON.parse(screen.getByTestId('init-tools').textContent ?? '[]') as string[];
}

function readStreamingContent(): string | unknown[] | null {
  return JSON.parse(screen.getByTestId('streaming-content').textContent ?? 'null') as string | unknown[] | null;
}

const allowSessionOpening = () => () => undefined;

describe('Tab-owned query clock integration', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps query time through tool updates and pauses only for unresolved human requests', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    let tab: ReturnType<typeof useTabState>;
    function ClockProbe() {
      const value = useTabState();
      useEffect(() => { tab = value; }, [value]);
      return null;
    }
    sseHarness.state.connected = false;
    sseHarness.state.eventHandler = null;
    sseHarness.state.statusHandler = null;
    const sessionId = 'pending-query-clock';
    render(<TabProvider tabId="query-clock" agentDir="/tmp/workspace" sessionId={sessionId} claimSessionOpeningTransition={allowSessionOpening}><ClockProbe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    // Same optimistic loading edge used by Chat before /chat/send.
    act(() => tab.setIsLoading(true));
    now = 2500;
    expect(tab!.getQueryElapsedSeconds()).toBe(2);
    emit('chat:status', { sessionState: 'running' });
    emit('chat:system-status', { status: 'api_retry:1:3' });
    now = 4000;
    expect(tab!.getQueryElapsedSeconds()).toBe(4);

    emit('permission:request', { sessionId, requestId: 'p1', toolName: 'Bash', input: '{}' });
    emit('permission:request', { sessionId, requestId: 'p2', toolName: 'Write', input: '{}' });
    now = 14000;
    expect(tab!.getQueryElapsedSeconds()).toBe(4);
    emit('permission:expired', { sessionId, requestId: 'p1' });
    now = 24000;
    expect(tab!.getQueryElapsedSeconds()).toBe(4);
    emit('permission:expired', { sessionId, requestId: 'p2' });
    now = 26000;
    expect(tab!.getQueryElapsedSeconds()).toBe(6);

    emit('ask-user-question:request', { sessionId, requestId: 'q1', questions: [{ question: 'Continue?', header: 'Choice', options: [{ label: 'Yes', description: 'Continue' }], multiSelect: false }] });
    now = 56000;
    expect(tab!.getQueryElapsedSeconds()).toBe(6);
    emit('ask-user-question:expired', { sessionId, requestId: 'q1' });
    now = 58000;
    expect(tab!.getQueryElapsedSeconds()).toBe(8);

    emit('enter-plan-mode:request', { sessionId, requestId: 'enter', autoApproved: true });
    now = 60000;
    expect(tab!.getQueryElapsedSeconds()).toBe(10);
    emit('exit-plan-mode:request', { sessionId, requestId: 'exit' });
    now = 90000;
    expect(tab!.getQueryElapsedSeconds()).toBe(10);
    // The resolved plan card remains visible; its presence must not keep time paused.
    tauriHarness.proxyFetch.mockResolvedValue(new Response('{"success":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await act(async () => { await tab.respondExitPlanMode(true); });
    expect(tab!.pendingExitPlanMode?.resolved).toBe('approved');
    now = 92000;
    expect(tab!.getQueryElapsedSeconds()).toBe(12);

    emit('chat:message-complete', {});
    expect(tab!.getQueryElapsedSeconds()).toBe(0);
    now = 100000;
    emit('chat:status', { sessionState: 'running' });
    now = 103000;
    expect(tab!.getQueryElapsedSeconds()).toBe(3);
    emit('chat:message-error', { message: 'test terminal' });
    expect(tab!.getQueryElapsedSeconds()).toBe(0);
  });
});

function collabMessage(status: 'running' | 'completed' = 'running'): Message {
  return {
    id: 'assistant-collab',
    role: 'assistant',
    timestamp: new Date(0),
    content: [{
      type: 'tool_use',
      tool: {
        id: 'spawn-card',
        name: 'CollabAgent',
        input: { tool: 'spawnAgent' },
        streamIndex: 0,
        subagentLifecycle: status === 'running'
          ? { status, startedAt: 100 }
          : { status, startedAt: 100, finishedAt: 200 },
        subagentCalls: [{ id: 'nested', name: 'Thinking', input: {}, isLoading: true }],
      },
    }],
  };
}

describe('TabProvider sub-agent lifecycle projection', () => {
  it('applies a lifecycle update to archived message content and ignores a late regression', () => {
    const completed = applySubagentLifecycleUpdate(
      collabMessage(),
      'spawn-card',
      { status: 'completed', startedAt: 100, finishedAt: 250 },
    );
    expect(completed?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: expect.objectContaining({
          subagentLifecycle: { status: 'completed', startedAt: 100, finishedAt: 250 },
        }),
      }),
    ]));
    expect(applySubagentLifecycleUpdate(
      completed!,
      'spawn-card',
      { status: 'running', startedAt: 300 },
    )).toBe(completed);
  });

  it('fails closed on root success and recursively closes residual nested calls', () => {
    const finalized = finalizeMessageSubagentProjection(collabMessage(), 'completed', 500);
    const content = finalized.content as Exclude<Message['content'], string>;
    expect(content[0].tool?.subagentLifecycle).toEqual({
      status: 'failed',
      startedAt: 100,
      finishedAt: 500,
    });
    expect(content[0].tool?.subagentCalls?.[0]).toMatchObject({
      isLoading: false,
      isError: true,
    });
  });

  it('preserves an explicit child terminal while closing stale nested trace flags', () => {
    const finalized = finalizeMessageSubagentProjection(collabMessage('completed'), 'failed', 500);
    const content = finalized.content as Exclude<Message['content'], string>;
    expect(content[0].tool?.subagentLifecycle?.status).toBe('completed');
    expect(content[0].tool?.subagentCalls?.[0].isLoading).toBe(false);
  });

  it('renders a resultless nested call as interrupted when the root is stopped', () => {
    const finalized = finalizeMessageSubagentProjection(collabMessage(), 'stopped', 500);
    const content = finalized.content as Exclude<Message['content'], string>;
    expect(content[0].tool?.subagentLifecycle?.status).toBe('interrupted');
    expect(content[0].tool?.subagentCalls?.[0]).toMatchObject({
      isLoading: false,
      isError: true,
      result: 'Interrupted',
    });
  });
});

describe('TabProvider session activity ownership', () => {
  it('preserves structured operation error codes across the Tab API boundary', async () => {
    const response = new Response(JSON.stringify({
      success: false,
      error: 'Wait for the current Session operation to finish',
      errorCode: 'session_busy',
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(handleApiResponse(response)).rejects.toMatchObject({
      message: 'Wait for the current Session operation to finish',
      status: 409,
      errorCode: 'session_busy',
    });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    sseHarness.state.connected = false;
    sseHarness.state.generation = 1;
    sseHarness.state.eventHandler = null;
    sseHarness.state.statusHandler = null;
    tauriHarness.proxyFetch.mockRejectedValue(new Error('Unexpected proxyFetch call'));
    tauriHarness.isTauri = false;
    tauriHarness.listeners.clear();
  });

  it('marks the live connection down across a Rust-owned Sidecar replacement', async () => {
    tauriHarness.isTauri = true;
    render(
      <TabProvider
        tabId="tab-sidecar-restart"
        agentDir="/tmp/workspace"
        sessionId="pending-sidecar-restart"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('connected')).toHaveTextContent('true'));
    emit('chat:mcp-effective-snapshot', {
      sessionId: 'pending-sidecar-restart',
      runtime: 'builtin',
      runtimeGeneration: 9,
      configGeneration: 3,
      configFingerprint: 'before-restart',
      catalogGeneration: 2,
      revision: 7,
      observedAt: Date.now(),
      dispatch: { state: 'settled', releaseReason: 'ready' },
      servers: [],
      tools: [],
    });
    expect(screen.getByTestId('mcp-runtime-generation')).toHaveTextContent('9');
    const restartListener = await waitFor(() => {
      const listener = tauriHarness.listeners.get('session-sidecar:restarted');
      expect(listener).toBeDefined();
      return listener!;
    });

    act(() => {
      restartListener({
        payload: { sessionId: 'pending-sidecar-restart', port: 43210 },
      });
    });
    expect(screen.getByTestId('connected')).toHaveTextContent('false');
    expect(screen.getByTestId('mcp-runtime-generation')).toBeEmptyDOMElement();

    act(() => {
      sseHarness.state.generation = 2;
      sseHarness.state.statusHandler?.('connected');
    });
    expect(screen.getByTestId('connected')).toHaveTextContent('true');
  });

  it('does not reacquire a Tab owner from an SSE status failure', async () => {
    const claimSessionOpeningTransition = vi.fn(() => null);
    render(
      <TabProvider
        tabId="tab-delete-race"
        agentDir="/tmp/workspace"
        sessionId="pending-delete-race"
        claimSessionOpeningTransition={claimSessionOpeningTransition}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.statusHandler).not.toBeNull());
    act(() => {
      sseHarness.state.connected = false;
      sseHarness.state.statusHandler?.('failed');
    });

    await waitFor(() => expect(readActivity().isLoading).toBe(false));
    expect(claimSessionOpeningTransition).not.toHaveBeenCalled();
    expect(tauriHarness.ensureSessionSidecar).not.toHaveBeenCalled();
  });

  it('does not submit a turn while App is deleting the Session', () => {
    const claimSessionOpeningTransition = vi.fn(() => null);
    render(
      <TabProvider
        tabId="tab-delete-send"
        agentDir="/tmp/workspace"
        sessionId="pending-delete-send"
        claimSessionOpeningTransition={claimSessionOpeningTransition}
      >
        <Probe />
      </TabProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'send message' }));

    expect(claimSessionOpeningTransition).toHaveBeenCalledWith('pending-delete-send');
    expect(tauriHarness.proxyFetch.mock.calls.some(
      ([url]) => String(url).includes('/chat/send'),
    )).toBe(false);
  });

  it('clears a prior terminal agent error when a new desktop or IM turn is admitted', async () => {
    tauriHarness.proxyFetch.mockResolvedValue(new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    render(
      <TabProvider
        tabId="tab-agent-error-lifecycle"
        agentDir="/tmp/workspace"
        sessionId="pending-agent-error-lifecycle"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:agent-error', { message: 'Not logged in' });
    expect(screen.getByTestId('agent-error')).toHaveTextContent('Not logged in');

    fireEvent.click(screen.getByRole('button', { name: 'send message' }));
    expect(screen.getByTestId('agent-error')).toBeEmptyDOMElement();

    emit('chat:agent-error', { message: 'New turn auth failure' });
    emit('chat:message-complete', {
      assistant_message_id: 'failed-turn-completion',
    });
    expect(screen.getByTestId('agent-error')).toHaveTextContent('New turn auth failure');

    emit('chat:agent-error', { message: 'Old provider error' });
    emit('chat:message-replay', {
      replayKind: 'live-user-echo',
      sessionId: 'pending-agent-error-lifecycle',
      message: {
        id: 'im-turn-after-error',
        role: 'user',
        content: 'new IM turn',
        timestamp: '2026-08-11T14:35:00.000Z',
      },
    });
    expect(screen.getByTestId('agent-error')).toBeEmptyDOMElement();
  });

  it('keeps the prior terminal agent error when desktop turn admission is refused', async () => {
    const refuseSessionOpening = vi.fn(() => null);
    render(
      <TabProvider
        tabId="tab-agent-error-refused"
        agentDir="/tmp/workspace"
        sessionId="pending-agent-error-refused"
        claimSessionOpeningTransition={refuseSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:agent-error', { message: 'Keep this error' });
    fireEvent.click(screen.getByRole('button', { name: 'send message' }));

    expect(refuseSessionOpening).toHaveBeenCalledWith('pending-agent-error-refused');
    expect(screen.getByTestId('agent-error')).toHaveTextContent('Keep this error');
  });

  it('holds turn admission until the backend accepts the send', async () => {
    let resolveSend!: (response: Response) => void;
    const sendResponse = new Promise<Response>((resolve) => {
      resolveSend = resolve;
    });
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/sessions/session-send-admission?') && !init?.method) {
        return new Response(JSON.stringify({
          success: true,
          session: {
            id: 'session-send-admission',
            agentDir: '/tmp/workspace',
            title: 'Admission',
            createdAt: '2026-07-15T00:00:00.000Z',
            lastActiveAt: '2026-07-15T00:00:00.000Z',
            runtime: 'builtin',
            messages: [],
            snapshotRevision: 0,
            liveSessionState: 'idle',
            liveStreamingMessage: null,
            hasMoreBefore: false,
          },
        }), { status: 200 });
      }
      if (url.endsWith('/chat/send') && init?.method === 'POST') return sendResponse;
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });
    const releaseSendTransition = vi.fn();
    const claimSessionOpeningTransition = vi.fn(() => releaseSendTransition);
    render(
      <TabProvider
        tabId="tab-send-admission"
        agentDir="/tmp/workspace"
        sessionId="session-send-admission"
        claimSessionOpeningTransition={claimSessionOpeningTransition}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('session-loading')).toHaveTextContent('false'));
    fireEvent.click(screen.getByRole('button', { name: 'send message' }));
    await waitFor(() => {
      expect(tauriHarness.proxyFetch).toHaveBeenCalledWith(
        expect.stringContaining('/chat/send'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(releaseSendTransition).not.toHaveBeenCalled();

    await act(async () => {
      resolveSend(new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      await sendResponse;
    });
    await waitFor(() => expect(releaseSendTransition).toHaveBeenCalledOnce());
  });

  it.each([false, true])(
    'keeps system-init metadata-only when prewarm=%s',
    async (prewarm) => {
      render(
        <TabProvider
          tabId="tab-activity"
          agentDir="/tmp/workspace"
          sessionId="pending-activity"
          claimSessionOpeningTransition={allowSessionOpening}
        >
          <Probe />
        </TabProvider>,
      );

      await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
      expect(readActivity()).toEqual({
        sessionId: 'pending-activity',
        isLoading: false,
        sessionState: 'idle',
        historyCount: 0,
        initModel: null,
      });

      emit('chat:system-init', {
        info: { timestamp: '2026-07-15T00:00:00.000Z', model: 'model-a' },
        prewarm,
        runtime: 'builtin',
      });
      expect(readActivity()).toEqual({
        sessionId: 'pending-activity',
        isLoading: false,
        sessionState: 'idle',
        historyCount: 0,
        initModel: 'model-a',
      });

      emit('chat:status', { sessionState: 'starting' });
      expect(readActivity()).toMatchObject({
        isLoading: true,
        sessionState: 'starting',
        historyCount: 0,
      });

      emit('chat:system-init', {
        info: { timestamp: '2026-07-15T00:00:01.000Z', model: 'model-b' },
        prewarm,
        runtime: 'builtin',
      });
      expect(readActivity()).toEqual({
        sessionId: 'pending-activity',
        isLoading: true,
        sessionState: 'starting',
        historyCount: 0,
        initModel: 'model-b',
      });

      emit('chat:status', { sessionState: 'idle' });
      expect(readActivity()).toEqual({
        sessionId: 'pending-activity',
        isLoading: false,
        sessionState: 'idle',
        historyCount: 0,
        initModel: 'model-b',
      });
    },
  );

  it('keeps the pending identity when App refuses system-init adoption', async () => {
    const onSessionIdChange = vi.fn(async () => false);
    render(
      <TabProvider
        tabId="tab-refused-upgrade"
        agentDir="/tmp/workspace"
        sessionId="pending-refused-upgrade"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:system-init', {
      info: { timestamp: '2026-07-15T00:00:00.000Z', model: 'model-a' },
      sessionId: 'real-refused-upgrade',
      runtime: 'builtin',
    });

    await waitFor(() => expect(onSessionIdChange).toHaveBeenCalledWith('real-refused-upgrade'));
    expect(readActivity().sessionId).toBe('pending-refused-upgrade');
  });

  it('commits system-init identity only after App accepts adoption', async () => {
    let resolveAdoption!: (accepted: boolean) => void;
    const onSessionIdChange = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveAdoption = resolve;
    }));
    render(
      <TabProvider
        tabId="tab-delayed-upgrade"
        agentDir="/tmp/workspace"
        sessionId="pending-delayed-upgrade"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:system-init', {
      info: { timestamp: '2026-07-15T00:00:00.000Z', model: 'model-a' },
      sessionId: 'real-delayed-upgrade',
      runtime: 'builtin',
    });

    await waitFor(() => expect(onSessionIdChange).toHaveBeenCalledWith('real-delayed-upgrade'));
    expect(readActivity().sessionId).toBe('pending-delayed-upgrade');

    await act(async () => {
      resolveAdoption(true);
    });
    await waitFor(() => expect(readActivity().sessionId).toBe('real-delayed-upgrade'));
  });

  it('keeps the live SSE owner when an active pending session receives its real id', async () => {
    const view = render(
      <TabProvider
        tabId="tab-upgrade"
        agentDir="/tmp/workspace"
        sessionId="pending-upgrade"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.connected).toBe(true));
    emit('chat:status', { sessionState: 'starting' });
    expect(readActivity()).toMatchObject({
      sessionId: 'pending-upgrade',
      isLoading: true,
      sessionState: 'starting',
    });

    sseHarness.connection.disconnect.mockClear();
    tauriHarness.proxyFetch.mockClear();
    view.rerender(
      <TabProvider
        tabId="tab-upgrade"
        agentDir="/tmp/workspace"
        sessionId="session-upgrade"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => {
      expect(readActivity()).toMatchObject({
        sessionId: 'session-upgrade',
        isLoading: true,
        sessionState: 'starting',
      });
    });
    expect(sseHarness.connection.disconnect).not.toHaveBeenCalled();
    expect(tauriHarness.proxyFetch).not.toHaveBeenCalled();
  });

  it('keeps the live SSE owner when reset upgrades a real session on the same sidecar', async () => {
    let resolveSessionC!: (response: Response) => void;
    const sessionCResponse = new Promise<Response>((resolve) => {
      resolveSessionC = resolve;
    });
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const sessionMatch = url.match(/\/sessions\/(session-reset-[abc])\?/);
      if (sessionMatch?.[1] === 'session-reset-c' && !init?.method) {
        return sessionCResponse;
      }
      if (sessionMatch && !init?.method) {
        return new Response(JSON.stringify({
          success: true,
          session: {
            id: sessionMatch[1],
            agentDir: '/tmp/workspace',
            title: 'Reset source',
            createdAt: '2026-07-15T00:00:00.000Z',
            lastActiveAt: '2026-07-15T00:00:00.000Z',
            runtime: 'builtin',
            messages: [],
            snapshotRevision: 0,
            liveSessionState: 'idle',
            liveStreamingMessage: null,
            hasMoreBefore: false,
          },
        }), { status: 200 });
      }
      if (url.endsWith('/chat/reset') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          success: true,
          sessionId: 'session-reset-b',
        }), { status: 200 });
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    const onSessionIdChange = vi.fn(async (nextSessionId: string) => {
      view.rerender(
        <TabProvider
          tabId="tab-reset"
          agentDir="/tmp/workspace"
          sessionId={nextSessionId}
          onSessionIdChange={onSessionIdChange}
          claimSessionOpeningTransition={allowSessionOpening}
        >
          <Probe />
        </TabProvider>,
      );
      return true;
    });

    const view = render(
      <TabProvider
        tabId="tab-reset"
        agentDir="/tmp/workspace"
        sessionId="session-reset-a"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(readActivity().sessionId).toBe('session-reset-a'));
    await waitFor(() => expect(sseHarness.state.connected).toBe(true));
    sseHarness.connection.disconnect.mockClear();
    sseHarness.connection.connect.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'reset session' }));

    await waitFor(() => expect(onSessionIdChange).toHaveBeenCalledWith('session-reset-b'));
    await waitFor(() => expect(readActivity().sessionId).toBe('session-reset-b'));
    expect(sseHarness.connection.disconnect).not.toHaveBeenCalled();
    expect(sseHarness.connection.connect).not.toHaveBeenCalled();

    const firstUserMessage = {
      id: '0',
      role: 'user',
      content: 'hello after reset',
      timestamp: '2026-07-15T00:00:01.000Z',
    };
    emit('chat:message-replay', {
      replayKind: 'cold-history',
      sessionId: 'session-reset-b',
      message: firstUserMessage,
    });
    expect(readActivity().historyCount).toBe(1);

    emit('chat:message-replay', {
      replayKind: 'live-user-echo',
      sessionId: 'session-reset-b',
      message: firstUserMessage,
    });
    expect(readActivity().historyCount).toBe(1);

    emit('chat:status', { sessionState: 'running' }, {
      sessionId: 'session-reset-a',
      liveRevision: 1,
    });
    expect(readActivity().sessionState).toBe('idle');

    sseHarness.connection.disconnect.mockClear();
    sseHarness.connection.connect.mockClear();
    view.rerender(
      <TabProvider
        tabId="tab-reset"
        agentDir="/tmp/workspace"
        sessionId="session-reset-c"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );
    await waitFor(() => expect(sseHarness.connection.disconnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sseHarness.connection.connect).toHaveBeenCalledTimes(1));

    sseHarness.connection.disconnect.mockClear();
    sseHarness.connection.connect.mockClear();
    view.rerender(
      <TabProvider
        tabId="tab-reset"
        agentDir="/tmp/workspace"
        sessionId="session-reset-b"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );
    await waitFor(() => expect(sseHarness.connection.disconnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sseHarness.connection.connect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(
      tauriHarness.proxyFetch.mock.calls.some(([url]) => (
        typeof url === 'string' && url.includes('/sessions/session-reset-b?')
      )),
    ).toBe(true));

    resolveSessionC(new Response(JSON.stringify({
      success: true,
      session: {
        id: 'session-reset-c',
        agentDir: '/tmp/workspace',
        title: 'Slow switch target',
        createdAt: '2026-07-15T00:00:00.000Z',
        lastActiveAt: '2026-07-15T00:00:00.000Z',
        runtime: 'builtin',
        messages: [],
        snapshotRevision: 0,
        liveSessionState: 'idle',
        liveStreamingMessage: null,
        hasMoreBefore: false,
      },
    }), { status: 200 }));
  });

  it('moves reset scope before parent adoption without letting connected status relabel it', async () => {
    let resolveAdoption!: (accepted: boolean) => void;
    const adoption = new Promise<boolean>((resolve) => {
      resolveAdoption = resolve;
    });
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/sessions/session-reset-race-a?') && !init?.method) {
        return new Response(JSON.stringify({
          success: true,
          session: {
            id: 'session-reset-race-a',
            agentDir: '/tmp/workspace',
            title: 'Reset race source',
            createdAt: '2026-07-15T00:00:00.000Z',
            lastActiveAt: '2026-07-15T00:00:00.000Z',
            runtime: 'builtin',
            messages: [],
            snapshotRevision: 0,
            liveSessionState: 'idle',
            liveStreamingMessage: null,
            hasMoreBefore: false,
          },
        }), { status: 200 });
      }
      if (url.endsWith('/chat/reset') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          success: true,
          sessionId: 'session-reset-race-b',
        }), { status: 200 });
      }
      if (url.endsWith('/chat/send') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    const transitions = createSessionResourceTransitionState();
    const transitionOwnerId = 'tab-reset-race';
    const claimSessionOpeningTransition = vi.fn((sessionId: string) => (
      tryClaimSessionResourceTransition(
        transitions,
        sessionId,
        'opening',
        transitionOwnerId,
      )
    ));
    const onSessionIdChange = vi.fn(() => {
      const releaseAdoption = tryClaimSessionResourceTransition(
        transitions,
        'session-reset-race-b',
        'opening',
        transitionOwnerId,
      );
      if (!releaseAdoption) return Promise.resolve(false);
      return adoption.finally(releaseAdoption);
    });
    const view = render(
      <TabProvider
        tabId="tab-reset-race"
        agentDir="/tmp/workspace"
        sessionId="session-reset-race-a"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={claimSessionOpeningTransition}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.connected).toBe(true));
    sseHarness.connection.disconnect.mockClear();
    sseHarness.connection.connect.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'reset session' }));

    await waitFor(() => expect(onSessionIdChange).toHaveBeenCalledWith('session-reset-race-b'));
    expect(readActivity().sessionId).toBe('session-reset-race-b');

    act(() => {
      sseHarness.state.statusHandler?.('connected');
    });
    emit('chat:message-replay', {
      replayKind: 'live-user-echo',
      sessionId: 'session-reset-race-b',
      message: {
        id: 'reset-race-user',
        role: 'user',
        content: 'accepted during adoption',
        timestamp: '2026-07-15T00:00:01.000Z',
      },
    });
    emit('chat:status', { sessionState: 'running' }, {
      sessionId: 'session-reset-race-a',
      liveRevision: 1,
    });
    expect(readActivity()).toMatchObject({
      sessionId: 'session-reset-race-b',
      historyCount: 1,
      sessionState: 'idle',
    });

    claimSessionOpeningTransition.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'send message' }));
    expect(claimSessionOpeningTransition).toHaveBeenCalledWith('session-reset-race-b');
    await waitFor(() => expect(
      tauriHarness.proxyFetch.mock.calls.some(([url, init]) => (
        String(url).endsWith('/chat/send') && init?.method === 'POST'
      )),
    ).toBe(true));

    view.rerender(
      <TabProvider
        tabId="tab-reset-race"
        agentDir="/tmp/workspace"
        sessionId="session-reset-race-b"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={claimSessionOpeningTransition}
      >
        <Probe />
      </TabProvider>,
    );
    await act(async () => {
      resolveAdoption(true);
      await adoption;
    });

    expect(sseHarness.connection.disconnect).not.toHaveBeenCalled();
    expect(sseHarness.connection.connect).not.toHaveBeenCalled();
    expect(transitions.claims.size).toBe(0);
  });

  it('reconciles chat-init assistant snapshots instead of appending them as deltas', async () => {
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/sessions/session-stream-snapshot?') && !init?.method) {
        return new Response(JSON.stringify({
          success: true,
          session: {
            id: 'session-stream-snapshot',
            agentDir: '/tmp/workspace',
            title: 'Streaming snapshot',
            createdAt: '2026-07-15T00:00:00.000Z',
            lastActiveAt: '2026-07-15T00:00:00.000Z',
            runtime: 'builtin',
            messages: [],
            snapshotRevision: 0,
            liveSessionState: 'idle',
            liveStreamingMessage: null,
            hasMoreBefore: false,
          },
        }), { status: 200 });
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    render(
      <TabProvider
        tabId="tab-stream-snapshot"
        agentDir="/tmp/workspace"
        sessionId="session-stream-snapshot"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.connected).toBe(true));
    emit('chat:init', {
      sessionId: 'session-stream-snapshot',
      sessionState: 'running',
      liveStreamingMessage: {
        id: 'assistant-stream',
        role: 'assistant',
        content: 'Hel',
        timestamp: '2026-07-15T00:00:01.000Z',
      },
    });
    expect(readStreamingContent()).toBe('Hel');

    emit('chat:init', {
      sessionId: 'session-stream-snapshot',
      sessionState: 'running',
      liveStreamingMessage: {
        id: 'assistant-stream',
        role: 'assistant',
        content: 'Hello',
        timestamp: '2026-07-15T00:00:01.000Z',
      },
    });
    expect(readStreamingContent()).toBe('Hello');

    emit('chat:message-chunk', '!');
    expect(readStreamingContent()).toBe('Hello!');

    const structuredContent = [
      { type: 'thinking', thinking: 'checking', isComplete: false },
      { type: 'text', text: 'Structured answer' },
    ];
    emit('chat:init', {
      sessionId: 'session-stream-snapshot',
      sessionState: 'running',
      liveStreamingMessage: {
        id: 'assistant-stream',
        role: 'assistant',
        content: structuredContent,
        timestamp: '2026-07-15T00:00:01.000Z',
      },
    });
    expect(readStreamingContent()).toEqual(structuredContent);
  });

  it.each([
    ['a newly streamed reply', false],
    ['a live-recovery snapshot', true],
  ] as const)('reconciles the persisted assistant identity for %s', async (_label, fromLiveRecovery) => {
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/sessions/session-assistant-identity?') && !init?.method) {
        return new Response(JSON.stringify({
          success: true,
          session: {
            id: 'session-assistant-identity',
            agentDir: '/tmp/workspace',
            title: 'Assistant identity',
            createdAt: '2026-07-15T00:00:00.000Z',
            lastActiveAt: '2026-07-15T00:00:00.000Z',
            runtime: 'codex',
            messages: [],
            snapshotRevision: 0,
            liveSessionState: 'idle',
            liveStreamingMessage: null,
            hasMoreBefore: false,
          },
        }), { status: 200 });
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    render(
      <TabProvider
        tabId={`tab-assistant-identity-${String(fromLiveRecovery)}`}
        agentDir="/tmp/workspace"
        sessionId="session-assistant-identity"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.connected).toBe(true));
    if (fromLiveRecovery) {
      emit('chat:init', {
        sessionId: 'session-assistant-identity',
        sessionState: 'running',
        liveStreamingMessage: {
          id: 'external-live-provisional',
          role: 'assistant',
          content: 'Recovered answer',
          timestamp: '2026-07-15T00:00:01.000Z',
        },
      });
    } else {
      emit('chat:message-chunk', 'Fresh answer');
    }

    emit('chat:message-complete', {
      assistant_message_id: 'assistant-canonical',
      runtime_turn_anchor: {
        turnId: 'turn-native-1',
        rootUserMessageId: 'user-root-1',
      },
    });

    await waitFor(() => expect(screen.getByTestId('history-identities')).toHaveTextContent(
      JSON.stringify([{
        id: 'assistant-canonical',
        runtimeTurnAnchor: {
          turnId: 'turn-native-1',
          rootUserMessageId: 'user-root-1',
        },
      }]),
    ));
  });

  it('rolls back a refused migration relabel before a later real-session switch', async () => {
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const match = url.match(/\/sessions\/(session-refused-[ab])\?/);
      if (match && !init?.method) {
        return new Response(JSON.stringify({
          success: true,
          session: {
            id: match[1],
            agentDir: '/tmp/workspace',
            title: match[1],
            createdAt: '2026-07-15T00:00:00.000Z',
            lastActiveAt: '2026-07-15T00:00:00.000Z',
            runtime: 'builtin',
            messages: [],
            snapshotRevision: 0,
            liveSessionState: 'idle',
            liveStreamingMessage: null,
            hasMoreBefore: false,
          },
        }), { status: 200 });
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    const onSessionIdChange = vi.fn(async () => false);
    const view = render(
      <TabProvider
        tabId="tab-refused-migration"
        agentDir="/tmp/workspace"
        sessionId="session-refused-a"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(readActivity().sessionId).toBe('session-refused-a'));
    await waitFor(() => expect(sseHarness.state.connected).toBe(true));
    sseHarness.connection.disconnect.mockClear();
    sseHarness.connection.connect.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'adopt migrated session' }));
    await waitFor(() => expect(onSessionIdChange).toHaveBeenCalled());
    expect(sseHarness.connection.disconnect).not.toHaveBeenCalled();

    view.rerender(
      <TabProvider
        tabId="tab-refused-migration"
        agentDir="/tmp/workspace"
        sessionId="session-refused-b"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.connection.disconnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sseHarness.connection.connect).toHaveBeenCalledTimes(1));
  });

  it('keeps the live SSE owner when an accepted surface migration upgrades the same sidecar', async () => {
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/sessions/session-migrated-a?') && !init?.method) {
        return new Response(JSON.stringify({
          success: true,
          session: {
            id: 'session-migrated-a',
            agentDir: '/tmp/workspace',
            title: 'Migration source',
            createdAt: '2026-07-15T00:00:00.000Z',
            lastActiveAt: '2026-07-15T00:00:00.000Z',
            runtime: 'builtin',
            messages: [],
            snapshotRevision: 0,
            liveSessionState: 'idle',
            liveStreamingMessage: null,
            hasMoreBefore: false,
          },
        }), { status: 200 });
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    const onSessionIdChange = vi.fn(async (nextSessionId: string) => {
      view.rerender(
        <TabProvider
          tabId="tab-migration"
          agentDir="/tmp/workspace"
          sessionId={nextSessionId}
          onSessionIdChange={onSessionIdChange}
          claimSessionOpeningTransition={allowSessionOpening}
        >
          <Probe />
        </TabProvider>,
      );
      return true;
    });

    const view = render(
      <TabProvider
        tabId="tab-migration"
        agentDir="/tmp/workspace"
        sessionId="session-migrated-a"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(readActivity().sessionId).toBe('session-migrated-a'));
    await waitFor(() => expect(sseHarness.state.connected).toBe(true));
    sseHarness.connection.disconnect.mockClear();
    sseHarness.connection.connect.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'adopt migrated session' }));

    await waitFor(() => expect(onSessionIdChange).toHaveBeenCalledWith(
      'session-migrated-b',
      { sidecarAlreadyMigrated: true },
    ));
    await waitFor(() => expect(readActivity().sessionId).toBe('session-migrated-b'));
    expect(sseHarness.connection.disconnect).not.toHaveBeenCalled();
    expect(sseHarness.connection.connect).not.toHaveBeenCalled();
  });

  it('replaces the SSE subscription for an ordinary real-session switch', async () => {
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const match = url.match(/\/sessions\/(session-switch-[ab])\?/);
      if (match && !init?.method) {
        return new Response(JSON.stringify({
          success: true,
          session: {
            id: match[1],
            agentDir: '/tmp/workspace',
            title: match[1],
            createdAt: '2026-07-15T00:00:00.000Z',
            lastActiveAt: '2026-07-15T00:00:00.000Z',
            runtime: 'builtin',
            messages: [],
            snapshotRevision: 0,
            liveSessionState: 'idle',
            liveStreamingMessage: null,
            hasMoreBefore: false,
          },
        }), { status: 200 });
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    const view = render(
      <TabProvider
        tabId="tab-switch"
        agentDir="/tmp/workspace"
        sessionId="session-switch-a"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(readActivity().sessionId).toBe('session-switch-a'));
    await waitFor(() => expect(sseHarness.state.connected).toBe(true));
    sseHarness.connection.disconnect.mockClear();
    sseHarness.connection.connect.mockClear();

    view.rerender(
      <TabProvider
        tabId="tab-switch"
        agentDir="/tmp/workspace"
        sessionId="session-switch-b"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.connection.disconnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sseHarness.connection.connect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(readActivity().sessionId).toBe('session-switch-b'));
  });

  it('clears runtime tool metadata when switching to another session', async () => {
    const view = render(
      <TabProvider tabId="tab-tools" agentDir="/tmp/workspace" sessionId="pending-tools-a" claimSessionOpeningTransition={allowSessionOpening}>
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:system-init', {
      info: {
        timestamp: '2026-07-15T00:00:00.000Z',
        model: 'codex-model',
        tools: ['mcp__playwright__browser_click'],
      },
      prewarm: false,
      runtime: 'codex',
    });
    expect(readInitTools()).toEqual(['mcp__playwright__browser_click']);

    view.rerender(
      <TabProvider tabId="tab-tools" agentDir="/tmp/workspace" sessionId="pending-tools-b" claimSessionOpeningTransition={allowSessionOpening}>
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(readInitTools()).toEqual([]));
  });

  it('keeps cold history invisible until the normalized REST snapshot is ready', async () => {
    let resolveSnapshot!: (response: Response) => void;
    const snapshot = new Promise<Response>((resolve) => {
      resolveSnapshot = resolve;
    });
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/sessions/session-single-reveal?') && !init?.method) {
        return snapshot;
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    render(
      <TabProvider
        tabId="tab-single-reveal"
        agentDir="/tmp/workspace"
        sessionId="session-single-reveal"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(tauriHarness.proxyFetch).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('session-loading')).toHaveTextContent('true');

    emit('chat:message-replay', {
      replayKind: 'cold-history',
      sessionId: 'session-single-reveal',
      message: {
        id: 'raw-first-frame',
        role: 'assistant',
        content: '**raw markdown**',
        timestamp: '2026-07-15T00:00:00.000Z',
      },
    });
    expect(readActivity().historyCount).toBe(0);

    await act(async () => {
      resolveSnapshot(new Response(JSON.stringify({
        success: true,
        session: {
          id: 'session-single-reveal',
          agentDir: '/tmp/workspace',
          title: 'Single reveal',
          createdAt: '2026-07-15T00:00:00.000Z',
          lastActiveAt: '2026-07-15T00:00:01.000Z',
          runtime: 'builtin',
          messages: [{
            id: 'normalized',
            role: 'assistant',
            content: JSON.stringify([{ type: 'text', text: '**final**' }]),
            timestamp: '2026-07-15T00:00:01.000Z',
          }],
          snapshotRevision: 1,
          liveSessionState: 'idle',
          liveStreamingMessage: null,
          hasMoreBefore: false,
        },
      }), { status: 200 }));
      await snapshot;
    });

    await waitFor(() => expect(readActivity().historyCount).toBe(1));
    expect(screen.getByTestId('history-content')).toHaveTextContent(
      JSON.stringify([[{ type: 'text', text: '**final**' }]]),
    );
    expect(screen.getByTestId('session-loading')).toHaveTextContent('false');
    expect(tauriHarness.proxyFetch).toHaveBeenCalledTimes(1);
  });

  it('replays a buffered live echo after the initial REST snapshot becomes visible', async () => {
    let resolveSnapshot!: (response: Response) => void;
    const snapshot = new Promise<Response>((resolve) => {
      resolveSnapshot = resolve;
    });
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/sessions/session-buffered-echo?') && !init?.method) return snapshot;
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    render(
      <TabProvider
        tabId="tab-buffered-echo"
        agentDir="/tmp/workspace"
        sessionId="session-buffered-echo"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(tauriHarness.proxyFetch).toHaveBeenCalledTimes(1));
    emit('chat:message-replay', {
      replayKind: 'live-user-echo',
      sessionId: 'session-buffered-echo',
      message: {
        id: 'live-echo',
        role: 'user',
        content: JSON.stringify([{ type: 'text', text: '**live**' }]),
        timestamp: '2026-07-15T00:00:01.000Z',
      },
    }, {
      sessionId: 'session-buffered-echo',
      liveRevision: 1,
      connectionGeneration: 1,
    });
    expect(readActivity().historyCount).toBe(0);

    await act(async () => {
      resolveSnapshot(new Response(JSON.stringify({
        success: true,
        session: {
          id: 'session-buffered-echo',
          agentDir: '/tmp/workspace',
          title: 'Buffered echo',
          createdAt: '2026-07-15T00:00:00.000Z',
          lastActiveAt: '2026-07-15T00:00:01.000Z',
          runtime: 'builtin',
          messages: [],
          snapshotRevision: 0,
          liveSessionState: 'idle',
          liveStreamingMessage: null,
          hasMoreBefore: false,
        },
      }), { status: 200 }));
      await snapshot;
    });

    await waitFor(() => expect(readActivity().historyCount).toBe(1));
    expect(screen.getByTestId('history-content')).toHaveTextContent(
      JSON.stringify([[{ type: 'text', text: '**live**' }]]),
    );
    expect(screen.getByTestId('session-loading')).toHaveTextContent('false');
  });

  it('lets only the current transport generation commit its REST snapshot', async () => {
    const snapshotResolvers: Array<(response: Response) => void> = [];
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/sessions/session-generation-fence?') && !init?.method) {
        return new Promise<Response>((resolve) => snapshotResolvers.push(resolve));
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    render(
      <TabProvider
        tabId="tab-generation-fence"
        agentDir="/tmp/workspace"
        sessionId="session-generation-fence"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(snapshotResolvers).toHaveLength(1));
    act(() => {
      sseHarness.state.generation = 2;
      sseHarness.state.statusHandler?.('connected');
    });
    await waitFor(() => expect(snapshotResolvers).toHaveLength(2));

    const responseFor = (id: string, content: string) => new Response(JSON.stringify({
      success: true,
      session: {
        id: 'session-generation-fence',
        agentDir: '/tmp/workspace',
        title: 'Generation fence',
        createdAt: '2026-07-15T00:00:00.000Z',
        lastActiveAt: '2026-07-15T00:00:01.000Z',
        runtime: 'builtin',
        messages: [{ id, role: 'assistant', content, timestamp: '2026-07-15T00:00:01.000Z' }],
        snapshotRevision: 0,
        liveSessionState: 'idle',
        liveStreamingMessage: null,
        hasMoreBefore: false,
      },
    }), { status: 200 });

    await act(async () => {
      snapshotResolvers[0](responseFor('stale', 'stale generation'));
      await Promise.resolve();
    });
    expect(readActivity().historyCount).toBe(0);
    expect(screen.getByTestId('session-loading')).toHaveTextContent('true');

    await act(async () => {
      snapshotResolvers[1](responseFor('current', 'current generation'));
      await Promise.resolve();
    });
    await waitFor(() => expect(readActivity().historyCount).toBe(1));
    expect(screen.getByTestId('history-content')).toHaveTextContent('current generation');
    expect(screen.getByTestId('history-content')).not.toHaveTextContent('stale generation');
  });

  it('restores a running session as active before any assistant chunk exists', async () => {
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/sessions/session-rest?') && !init?.method) {
        return new Response(JSON.stringify({
          success: true,
          session: {
            id: 'session-rest',
            agentDir: '/tmp/workspace',
            title: 'Restored session',
            createdAt: '2026-07-15T00:00:00.000Z',
            lastActiveAt: '2026-07-15T00:00:01.000Z',
            runtime: 'builtin',
            messages: [],
            snapshotRevision: 0,
            liveSessionState: 'running',
            liveStreamingMessage: null,
            hasMoreBefore: false,
          },
        }), { status: 200 });
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    render(
      <TabProvider
        tabId="tab-rest"
        agentDir="/tmp/workspace"
        sessionId="session-rest"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => {
      expect(readActivity()).toEqual({
        sessionId: 'session-rest',
        isLoading: true,
        sessionState: 'running',
        historyCount: 0,
        initModel: null,
      });
    });

    expect(tauriHarness.proxyFetch).toHaveBeenCalledTimes(1);
  });

  it('continues a stable reconnect without REST reload or loading chrome', async () => {
    let sessionGetCount = 0;
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/sessions/session-recovery?') && !init?.method) {
        sessionGetCount += 1;
        return new Response(JSON.stringify({
          success: true,
          session: {
            id: 'session-recovery',
            agentDir: '/tmp/workspace',
            title: 'Recovery session',
            createdAt: '2026-07-15T00:00:00.000Z',
            lastActiveAt: '2026-07-15T00:00:01.000Z',
            runtime: 'builtin',
            messages: [
              { id: 'm1', role: 'user', content: 'one', timestamp: '2026-07-15T00:00:00.000Z' },
              { id: 'm2', role: 'assistant', content: 'two', timestamp: '2026-07-15T00:00:01.000Z' },
            ],
            snapshotRevision: 2,
            liveSessionState: 'idle',
            liveStreamingMessage: null,
            hasMoreBefore: true,
          },
        }), { status: 200 });
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    render(
      <TabProvider
        tabId="tab-recovery"
        agentDir="/tmp/workspace"
        sessionId="session-recovery"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );
    await waitFor(() => expect(readActivity().historyCount).toBe(2));

    act(() => {
      sseHarness.state.generation = 2;
      sseHarness.state.statusHandler?.('connected');
    });
    emit('chat:message-replay', {
      replayKind: 'live-user-echo',
      sessionId: 'session-recovery',
      message: {
        id: 'm3',
        role: 'user',
        content: 'three',
        timestamp: '2026-07-15T00:00:02.000Z',
      },
    }, {
      sessionId: 'session-recovery',
      liveRevision: 3,
      connectionGeneration: 2,
    });

    await waitFor(() => expect(readActivity().historyCount).toBe(3));
    expect(sessionGetCount).toBe(1);
    expect(screen.getByTestId('session-loading')).toHaveTextContent('false');
  });

  it('walks older persisted pages before deciding whether a rewind target still exists', async () => {
    let olderPageCount = 0;
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!url.includes('/sessions/session-deep-rewind?') || init?.method) {
        throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
      }
      const before = new URL(url).searchParams.get('before');
      if (before === 'm81') {
        olderPageCount += 1;
        return new Response(JSON.stringify({
          success: true,
          session: {
            messages: [
              { id: 'm1', role: 'user', content: 'oldest', timestamp: '2026-07-15T00:00:00.000Z' },
              { id: 'm2', role: 'user', content: 'rewind target', timestamp: '2026-07-15T00:00:01.000Z' },
            ],
            hasMoreBefore: false,
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        success: true,
        session: {
          id: 'session-deep-rewind',
          agentDir: '/tmp/workspace',
          title: 'Deep rewind session',
          createdAt: '2026-07-15T00:00:00.000Z',
          lastActiveAt: '2026-07-15T00:01:22.000Z',
          runtime: 'codex',
          messages: [
            { id: 'm81', role: 'user', content: 'recent', timestamp: '2026-07-15T00:01:21.000Z' },
            { id: 'm82', role: 'assistant', content: 'latest', timestamp: '2026-07-15T00:01:22.000Z' },
          ],
          snapshotRevision: 82,
          liveSessionState: 'idle',
          liveStreamingMessage: null,
          hasMoreBefore: true,
        },
      }), { status: 200 });
    });

    render(
      <TabProvider
        tabId="tab-deep-rewind"
        agentDir="/tmp/workspace"
        sessionId="session-deep-rewind"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );
    await waitFor(() => expect(readActivity().historyCount).toBe(2));

    fireEvent.click(screen.getByRole('button', { name: 'retry restore' }));

    await waitFor(() => expect(screen.getByTestId('retry-restore-target-present')).toHaveTextContent('true'));
    expect(olderPageCount).toBe(1);
  });

  it('fails a revision-gap restore closed and retries only on user action', async () => {
    let sessionGetCount = 0;
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/sessions/session-retry?') && !init?.method) {
        sessionGetCount += 1;
        const recovered = sessionGetCount === 4;
        return new Response(JSON.stringify({
          success: true,
          session: {
            id: 'session-retry',
            agentDir: '/tmp/workspace',
            title: 'Retry session',
            createdAt: '2026-07-15T00:00:00.000Z',
            lastActiveAt: '2026-07-15T00:00:02.000Z',
            runtime: 'builtin',
            messages: recovered
              ? [
                  { id: 'm1', role: 'user', content: 'one', timestamp: '2026-07-15T00:00:00.000Z' },
                  { id: 'm2', role: 'assistant', content: 'two', timestamp: '2026-07-15T00:00:01.000Z' },
                  { id: 'm3', role: 'assistant', content: 'recovered', timestamp: '2026-07-15T00:00:02.000Z' },
                ]
              : [
                  { id: 'm1', role: 'user', content: 'one', timestamp: '2026-07-15T00:00:00.000Z' },
                  { id: 'm2', role: 'assistant', content: 'two', timestamp: '2026-07-15T00:00:01.000Z' },
                ],
            snapshotRevision: recovered ? 4 : 2,
            liveSessionState: 'idle',
            liveStreamingMessage: null,
            hasMoreBefore: false,
          },
        }), { status: 200 });
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    render(
      <TabProvider
        tabId="tab-retry"
        agentDir="/tmp/workspace"
        sessionId="session-retry"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );
    await waitFor(() => expect(readActivity().historyCount).toBe(2));

    act(() => {
      sseHarness.state.generation = 2;
    });
    emit('chat:status', { sessionState: 'idle' }, {
      sessionId: 'session-retry',
      liveRevision: 4,
      connectionGeneration: 2,
    });

    await waitFor(() => expect(sessionGetCount).toBe(3));
    await waitFor(() => expect(screen.getByTestId('session-restore-error').textContent).not.toBe(''));
    expect(screen.getByTestId('session-loading')).toHaveTextContent('true');
    expect(readActivity().historyCount).toBe(2);

    emit('chat:status', { sessionState: 'idle' }, {
      sessionId: 'session-retry',
      liveRevision: 5,
      connectionGeneration: 2,
    });
    emit('chat:message-replay', {
      replayKind: 'cold-history',
      message: {
        id: 'untrusted-reconnect-row',
        role: 'assistant',
        content: 'must stay hidden',
        timestamp: '2026-07-15T00:00:03.000Z',
      },
    });
    await act(async () => { await Promise.resolve(); });
    expect(sessionGetCount).toBe(3);
    expect(readActivity().historyCount).toBe(2);
    expect(screen.getByTestId('history-content')).not.toHaveTextContent('must stay hidden');

    fireEvent.click(screen.getByRole('button', { name: 'retry restore' }));

    await waitFor(() => expect(sessionGetCount).toBe(4));
    await waitFor(() => expect(readActivity().historyCount).toBe(3));
    expect(screen.getByTestId('retry-restore-target-present')).toHaveTextContent('true');
    expect(screen.getByTestId('session-loading')).toHaveTextContent('false');
    expect(sseHarness.connection.connect).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['queue-stale-cancel', 'cancel stale', '/chat/queue/cancel'],
    ['queue-stale-force', 'force stale', '/chat/queue/force'],
  ] as const)(
    'removes stale queue replica %s after the authority reports not-found',
    async (queueId, actionLabel, route) => {
      tauriHarness.proxyFetch.mockImplementation(async (url: string) => {
        if (url.endsWith(route)) {
          return new Response(JSON.stringify({
            success: false,
            stale: true,
            error: 'Queue item not found',
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error(`Unexpected proxyFetch call: ${url}`);
      });

      render(
        <TabProvider
          tabId={`tab-${queueId}`}
          agentDir="/tmp/workspace"
          sessionId={`pending-${queueId}`}
          claimSessionOpeningTransition={allowSessionOpening}
        >
          <Probe />
        </TabProvider>,
      );

      await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
      emit('queue:added', { queueId, messageText: 'stale queued request' });
      expect(readQueueIds()).toContain(queueId);

      fireEvent.click(screen.getByRole('button', { name: actionLabel }));

      await waitFor(() => expect(readQueueIds()).not.toContain(queueId));
    },
  );
});
