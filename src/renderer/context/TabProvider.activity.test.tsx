import { TASK_ALIGNMENT_SKILL_REQUIREMENT } from "../../shared/systemSkills";
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { track } from '@/analytics';
import * as largeValueRefs from '@/api/largeValueRef';
import type { SseEventMetadata } from '@/api/SseConnection';
import {
  createSessionResourceTransitionState,
  tryClaimSessionResourceTransition,
} from '@/utils/sessionDeletionCoordinator';
import { useTabState } from './TabContext';
import { AskUserQuestionPrompt } from '@/components/AskUserQuestionPrompt';
import type { Message } from '@/types/chat';
import { ToastProvider } from '@/components/Toast';
import { NATIVE_RESUME_BOUNDARY_MESSAGE } from '../../shared/nativeResumeBoundary';
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
  useConfigData: () => ({ config: {  } }),
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
    sessionMeta,
    sessionRuntimeSessionId,
    mcpEffectiveSnapshot,
    queuedMessages,
    agentError,
    agentErrorUserMessageId,
    isConnected,
    adoptMigratedSession,
    resetSession,
    stopResponse,
    retryCurrentSessionRestore,
    sendMessage,
    cancelQueuedMessage,
    forceExecuteQueuedMessage,
    pendingAskUserQuestion,
    respondAskUserQuestion,
  } = useTabState();
  const [sendReceipt, setSendReceipt] = useState<boolean | null>(null);
  const [answerReceipt, setAnswerReceipt] = useState<boolean | null>(null);
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
      <output data-testid="session-meta">{JSON.stringify(sessionMeta ? {
        id: sessionMeta.id,
        runtime: sessionMeta.runtime,
      } : null)}</output>
      <output data-testid="live-runtime-session-id">{sessionRuntimeSessionId ?? ''}</output>
      <output data-testid="mcp-runtime-generation">{mcpEffectiveSnapshot?.runtimeGeneration ?? ''}</output>
      <output data-testid="streaming-content">{JSON.stringify(streamingMessage?.content ?? null)}</output>
      <output data-testid="session-loading">{String(isSessionLoading)}</output>
      <output data-testid="session-restore-error">{sessionRestoreError ?? ''}</output>
      <output data-testid="history-content">{JSON.stringify(historyMessages.map(message => message.content))}</output>
      <output data-testid="history-unconfirmed">{JSON.stringify(historyMessages.map(message => !!message.deliveryUnconfirmed))}</output>
      <output data-testid="history-contracts">{JSON.stringify(historyMessages.map(message => message.desktopQuery))}</output>
      <output data-testid="history-delivery">{JSON.stringify(historyMessages.map(message => message.deliveryStatus ?? null))}</output>
      <output data-testid="history-identities">{JSON.stringify(historyMessages.map(message => ({
        id: message.id,
        runtimeTurnAnchor: message.runtimeTurnAnchor ?? null,
      })))}</output>
      <output data-testid="answer-receipt">{JSON.stringify(answerReceipt)}</output>
      <output data-testid="question-replies">{JSON.stringify(historyMessages.flatMap(message => message.asyncQuestionReply ? [message.asyncQuestionReply] : []))}</output>
      <output data-testid="question-queue">{JSON.stringify(queuedMessages)}</output>
      <button type="button" onClick={() => { void sendMessage('看海', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { questionId: 'q', questionIndex: 0 }).then(setAnswerReceipt); }}>send async answer</button>
      <output data-testid="queue-ids">{JSON.stringify(queuedMessages.map(item => item.queueId))}</output>
      <output data-testid="agent-error">{agentError ?? ''}</output>
      <output data-testid="agent-error-user-message-id">{agentErrorUserMessageId ?? ''}</output>
      <output data-testid="pending-ask-id">{pendingAskUserQuestion?.requestId ?? ''}</output>
      <output data-testid="retry-restore-target-present">{JSON.stringify(retryRestoreTargetPresent)}</output>
      <button type="button" onClick={() => void sendMessage('hello', undefined, undefined, undefined, undefined, undefined, undefined, undefined, TASK_ALIGNMENT_SKILL_REQUIREMENT, undefined, undefined, { kind: 'task-discussion', input: { candidatesDir: '/data/discussion/candidates', workspaceId: 'ws', workspacePath: '/workspace', visibleUserMessage: 'hello' } }).then(setSendReceipt)}>send discussion</button>
      <output data-testid="send-receipt">{JSON.stringify(sendReceipt)}</output>
      <button type="button" onClick={() => void sendMessage('hello').then(setSendReceipt)}>send message</button>
      <button type="button" onClick={() => {
        const failed = historyMessages.find(message => message.deliveryStatus === 'failed');
        if (failed) void sendMessage('hello', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, failed.id);
      }}>resend failed message</button>
      <button type="button" onClick={() => void resetSession()}>reset session</button>
      <button type="button" onClick={() => void stopResponse()}>stop response</button>
      <button type="button" onClick={() => {
        void retryCurrentSessionRestore('m2').then(result => {
          if (result.restored) setRetryRestoreTargetPresent(result.targetMessagePresent);
        });
      }}>retry restore</button>
      <button type="button" onClick={() => void adoptMigratedSession('session-migrated-b', { sidecarAlreadyMigrated: true })}>adopt migrated session</button>
      <button type="button" onClick={() => void cancelQueuedMessage('queue-stale-cancel')}>cancel stale</button>
      <button type="button" onClick={() => void forceExecuteQueuedMessage('queue-stale-force')}>force stale</button>
      <button type="button" onClick={() => void respondAskUserQuestion(pendingAskUserQuestion?.requestId ?? '', { 0: 'One' }).catch(() => undefined)}>answer question</button>
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

  it('attributes immediate DSH tool and terminal analytics to this Tab rather than the active context', async () => {
    sseHarness.state.eventHandler = null;
    render(<TabProvider tabId="dsh-analytics-tab" agentDir="/tmp/workspace" sessionId="pending-dsh-analytics" claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    vi.mocked(track).mockClear();
    act(() => {
      sseHarness.state.eventHandler?.('chat:system-init', {
        sessionId: 'pending-dsh-analytics', runtime: 'dsh', runtimeSource: 'integrated', info: { model: 'deepseek-test', tools: [] },
      }, { connectionGeneration: sseHarness.state.generation });
      sseHarness.state.eventHandler?.('chat:tool-use-start', { id: 'runtime-tool', name: 'read', input: {} }, { connectionGeneration: sseHarness.state.generation });
      sseHarness.state.eventHandler?.('chat:server-tool-use-start', { id: 'provider-tool', name: 'web_search', input: {} }, { connectionGeneration: sseHarness.state.generation });
      sseHarness.state.eventHandler?.('chat:message-complete', { model: 'deepseek-test', output_tokens: 0 }, { connectionGeneration: sseHarness.state.generation });
      sseHarness.state.eventHandler?.('chat:message-error', { message: 'private error' }, { connectionGeneration: sseHarness.state.generation });
      sseHarness.state.eventHandler?.('chat:message-stopped', {}, { connectionGeneration: sseHarness.state.generation });
    });
    for (const name of ['tool_use', 'message_complete', 'message_error', 'message_stop']) {
      expect(track).toHaveBeenCalledWith(name, expect.objectContaining({
        source: 'desktop', session_id: 'pending-dsh-analytics', tab_id: 'dsh-analytics-tab', runtime: 'dsh', runtime_source: 'integrated',
      }));
    }
    const completion = vi.mocked(track).mock.calls.find(([event]) => event === 'message_complete')?.[1];
    expect(completion).toMatchObject({ output_tokens: 0 });
    expect(completion).not.toHaveProperty('input_tokens');
    expect(track).toHaveBeenCalledWith('tool_use', expect.objectContaining({ tool: 'read', tool_origin: 'runtime' }));
    expect(track).toHaveBeenCalledWith('tool_use', expect.objectContaining({ tool: 'web_search', tool_origin: 'provider' }));
    expect(JSON.stringify(vi.mocked(track).mock.calls)).not.toContain('private error');
  });

  it('records permission decisions only after backend acceptance', async () => {
    let tab: ReturnType<typeof useTabState>;
    function PermissionProbe() {
      const value = useTabState();
      useEffect(() => { tab = value; }, [value]);
      return null;
    }
    sseHarness.state.eventHandler = null;
    render(<TabProvider tabId="permission-analytics" agentDir="/tmp/workspace" sessionId="pending-permission-analytics" claimSessionOpeningTransition={allowSessionOpening}><PermissionProbe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('permission:request', { sessionId: 'pending-permission-analytics', requestId: 'p1', toolName: 'read', input: '{}' });
    vi.mocked(track).mockClear();
    tauriHarness.proxyFetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: 'not accepted' })));
    await act(async () => {
      await expect(tab.respondPermission('allow_once')).rejects.toThrow('not accepted');
    });
    expect(track).not.toHaveBeenCalledWith('permission_grant', expect.anything());
    expect(tab!.pendingPermission?.requestId).toBe('p1');
    tauriHarness.proxyFetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));
    await act(async () => { await tab.respondPermission('allow_once'); });
    expect(track).toHaveBeenCalledWith('permission_grant', expect.objectContaining({
      session_id: 'pending-permission-analytics', tab_id: 'permission-analytics', tool: 'read', type: 'allow_once',
    }));
    expect(tab!.pendingPermission).toBeNull();
  });

  it('shows a native resume refusal while keeping the recoverable error visible', async () => {
    sseHarness.state.eventHandler = null;
    render(<ToastProvider><TabProvider tabId="resume-refusal" agentDir="/tmp/workspace" sessionId="pending-resume-refusal" claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider></ToastProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:message-error', { message: NATIVE_RESUME_BOUNDARY_MESSAGE });
    expect(screen.getByTestId('agent-error')).toHaveTextContent(NATIVE_RESUME_BOUNDARY_MESSAGE);
    emit('chat:agent-error', { message: NATIVE_RESUME_BOUNDARY_MESSAGE });
    emit('chat:agent-error', { message: NATIVE_RESUME_BOUNDARY_MESSAGE });
    expect(screen.getByTestId('agent-error')).toHaveTextContent(NATIVE_RESUME_BOUNDARY_MESSAGE);
    expect(screen.queryAllByRole('status').filter(element => element.tagName !== 'OUTPUT' && element.textContent?.includes(NATIVE_RESUME_BOUNDARY_MESSAGE))).toHaveLength(0);
  });

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

    emit('permission:request', { sessionId, requestId: 'p1', toolName: 'Bash', input: '{}', defaultToNo: true, suppressAlwaysAllowRule: true });
    expect(tab!.pendingPermission).toMatchObject({ defaultToNo: true, suppressAlwaysAllowRule: true });
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

    emit('chat:status', { sessionState: 'idle' });
    emit('chat:message-complete', {});
    expect(tab!.getQueryElapsedSeconds()).toBe(0);
    now = 100000;
    emit('chat:status', { sessionState: 'running' });
    now = 103000;
    expect(tab!.getQueryElapsedSeconds()).toBe(3);
    emit('chat:status', { sessionState: 'error' });
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

  it.each(['chat:message-complete', 'chat:message-stopped', 'chat:message-error'])(
    'keeps queued execution active across %s until backend idle', async terminal => {
      const sessionId = 'pending-queued-activity';
      render(<TabProvider tabId="queued-activity" agentDir="/tmp/workspace" sessionId={sessionId} claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider>);
      await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
      emit('chat:status', { sessionState: 'running' });
      emit('chat:message-chunk', 'first reply');
      emit('queue:added', { sessionId, queueId: 'next', messageText: 'next query' });
      emit(terminal, { message: 'first turn ended' });
      expect(readActivity()).toMatchObject({ isLoading: true, sessionState: 'running' });
      emit('queue:started', { sessionId, queueId: 'next', userMessage: {
        id: 'next-user', role: 'user', content: 'next query', timestamp: new Date(0).toISOString(),
      } });
      expect(screen.getByTestId('history-content').textContent).toContain('next query');
      expect(readQueueIds()).toEqual([]);
      // No repeated running status and no assistant output: Stop must stay available.
      expect(readActivity()).toMatchObject({ isLoading: true, sessionState: 'running' });
      emit('chat:message-chunk', 'next reply');
      emit('chat:status', { sessionState: 'idle' });
      emit('chat:message-complete', {});
      expect(readActivity()).toMatchObject({ isLoading: false, sessionState: 'idle' });
    },
  );

  it.each([false, true])('keeps V2 queued execution active when the previous terminal is delayed (mid-turn: %s)', async midTurnBreak => {
    const sessionId = 'pending-delayed-terminal';
    render(<TabProvider tabId="delayed-terminal" agentDir="/tmp/workspace" sessionId={sessionId} claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:init', { sessionId, transcriptFormat: 2, sessionState: 'running' });
    const userMessage = { id: 'next-user', role: 'user', content: 'next query', turnId: 'next-turn', transcriptState: 'complete', timestamp: new Date(0).toISOString() };
    emit('chat:transcript-operation', { sessionId, operation: { kind: 'message-create', message: userMessage } });
    emit('queue:started', { sessionId, queueId: 'next', midTurnBreak, userMessage });
    emit('chat:message-complete', { completionTerminal: { sessionId, turnId: 'previous-turn', status: 'complete' } });
    expect(readActivity()).toMatchObject({ isLoading: true, sessionState: 'running' });
    expect(screen.getByTestId('history-content').textContent).toContain('next query');
    emit('chat:status', { sessionState: 'idle' });
    expect(readActivity()).toMatchObject({ isLoading: false, sessionState: 'idle' });
  });

  it('uses stop recovery activity even when the terminal SSE arrives later', async () => {
    const sessionId = 'pending-stop-recovery-activity';
    tauriHarness.proxyFetch.mockImplementation(async (url: string) => new Response(JSON.stringify(
      url.endsWith('/api/session-state')
        ? { sessionId, sessionState: 'idle', isBusy: false, completionTerminal: { status: 'stopped' } }
        : { success: true, alreadyStopped: true },
    )));
    render(<TabProvider tabId="stop-recovery-activity" agentDir="/tmp/workspace" sessionId={sessionId} claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:status', { sessionState: 'running' });
    fireEvent.click(screen.getByRole('button', { name: 'stop response' }));
    await waitFor(() => expect(readActivity()).toMatchObject({ isLoading: false, sessionState: 'idle' }));
    emit('chat:message-stopped', {});
    expect(readActivity()).toMatchObject({ isLoading: false, sessionState: 'idle' });
  });

  it('follows external runtime idle then running transitions before a queued user appears', async () => {
    const sessionId = 'pending-external-queued-activity';
    render(<TabProvider tabId="external-queued-activity" agentDir="/tmp/workspace" sessionId={sessionId} claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:status', { sessionState: 'running' });
    emit('chat:message-complete', {});
    emit('chat:status', { sessionState: 'idle' });
    expect(readActivity()).toMatchObject({ isLoading: false, sessionState: 'idle' });
    emit('chat:status', { sessionState: 'running' });
    emit('queue:started', { sessionId, queueId: 'next', userMessage: {
      id: 'next-user', role: 'user', content: 'next query', timestamp: new Date(0).toISOString(),
    } });
    expect(readActivity()).toMatchObject({ isLoading: true, sessionState: 'running' });
    emit('chat:status', { sessionState: 'error' });
    emit('chat:message-error', { message: 'terminal failure' });
    expect(readActivity()).toMatchObject({ isLoading: false, sessionState: 'error' });
  });

  it.each(['receipt-first', 'terminal-first'] as const)('unlocks Stop for queued continuation after %s stop acknowledgement', async order => {
    const sessionId = 'pending-stop-queued-continuation';
    let finish!: (response: Response) => void;
    tauriHarness.proxyFetch.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    render(<TabProvider tabId="stop-queued-continuation" agentDir="/tmp/workspace" sessionId={sessionId} claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:status', { sessionState: 'running' });
    fireEvent.click(screen.getByRole('button', { name: 'stop response' }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(readActivity().sessionState).toBe('stopping');
    if (order === 'receipt-first') await act(async () => finish(new Response('{"success":true}')));
    emit('chat:message-stopped', {});
    emit('queue:started', { sessionId, queueId: 'survivor', userMessage: {
      id: 'survivor-user', role: 'user', content: 'surviving input', timestamp: new Date(0).toISOString(),
    } });
    expect(readActivity()).toMatchObject({ isLoading: true, sessionState: 'running' });
    if (order === 'terminal-first') await act(async () => finish(new Response('{"success":true}')));
    expect(readActivity()).toMatchObject({ isLoading: true, sessionState: 'running' });
    emit('chat:status', { sessionState: 'idle' });
    emit('chat:message-complete', {});
  });

  it('resets query time at queue promotion without resetting execution activity', async () => {
    let now = 0;
    const time = vi.spyOn(performance, 'now').mockImplementation(() => now);
    let tab!: ReturnType<typeof useTabState>;
    function ClockProbe() {
      const value = useTabState();
      useEffect(() => { tab = value; }, [value]);
      return <Probe />;
    }
    try {
      const sessionId = 'pending-queued-clock';
      render(<TabProvider tabId="queued-clock" agentDir="/tmp/workspace" sessionId={sessionId} claimSessionOpeningTransition={allowSessionOpening}><ClockProbe /></TabProvider>);
      await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
      emit('chat:status', { sessionState: 'running' });
      now = 30000;
      expect(tab.getQueryElapsedSeconds()).toBe(30);
      emit('chat:message-complete', {});
      emit('queue:started', { sessionId, queueId: 'next' });
      expect(tab.getQueryElapsedSeconds()).toBe(0);
      expect(readActivity()).toMatchObject({ isLoading: true, sessionState: 'running' });
      now = 32000;
      expect(tab.getQueryElapsedSeconds()).toBe(2);
      // A delayed old terminal and a realtime steer must not restart this query.
      emit('chat:message-complete', {});
      emit('queue:started', { sessionId, queueId: 'steer', midTurnBreak: true });
      expect(tab.getQueryElapsedSeconds()).toBe(2);
      emit('chat:status', { sessionState: 'idle' });
      expect(tab.getQueryElapsedSeconds()).toBe(0);
    } finally { time.mockRestore(); }
  });

  it('uses the launch correlation identity for both the send and accepted user row', async () => {
    tauriHarness.proxyFetch.mockImplementation(async () => new Response(JSON.stringify({ success: true })));
    sseHarness.state.eventHandler = null;
    let tab: ReturnType<typeof useTabState>;
    function LaunchProbe() {
      const value = useTabState();
      useEffect(() => { tab = value; }, [value]);
      return null;
    }
    const sessionId = 'pending-correlated-launch';
    render(<TabProvider tabId="correlated-launch" agentDir="/tmp/workspace" sessionId={sessionId}
      claimSessionOpeningTransition={allowSessionOpening}><LaunchProbe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:init', { sessionId, transcriptFormat: 2, sessionState: 'idle' });
    const requestId = 'launch-request';
    await act(async () => {
      await tab.sendMessage('hello', undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, requestId);
    });
    const sendCall = tauriHarness.proxyFetch.mock.calls.find(([url]) => String(url).endsWith('/chat/send'));
    expect(JSON.parse(String(sendCall?.[1]?.body)).clientRequestId).toBe(requestId);
    expect(tab!.historyMessages[0]).toMatchObject({ deliveryStatus: 'sending', metadata: { clientRequestId: requestId } });
    emit('chat:transcript-operation', { sessionId, operation: { kind: 'message-create', message: {
      id: 'accepted-launch-user', role: 'user', content: 'hello', timestamp: new Date(0).toISOString(),
      metadata: { source: 'desktop', clientRequestId: requestId },
    } } });
    expect(tab!.historyMessages).toHaveLength(1);
    expect(tab!.historyMessages[0]).toMatchObject({ id: 'accepted-launch-user', metadata: { clientRequestId: requestId } });
    expect(tab!.historyMessages[0].deliveryStatus).toBeUndefined();
  });

  it.each(['echo-first', 'canonical-first'] as const)(
    'shows a send before HTTP admission and adopts it once with %s V2 events', async order => {
      const sessionId = 'pending-immediate-send';
      let respond!: (response: Response) => void;
      const receipt = new Promise<Response>(resolve => { respond = resolve; });
      tauriHarness.proxyFetch.mockImplementation(() => receipt);
      render(<TabProvider tabId="immediate-send" agentDir="/tmp/workspace" sessionId={sessionId} claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider>);
      await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
      emit('chat:init', { sessionId, transcriptFormat: 2, sessionState: 'idle' });
      fireEvent.click(screen.getByRole('button', { name: 'send message' }));
      expect(JSON.parse(screen.getByTestId('history-content').textContent!)).toEqual(['hello']);
      expect(readActivity()).toMatchObject({ isLoading: true, historyCount: 1 });
      // A cold init received while the POST is pending must not blank the send.
      emit('chat:init', { sessionId, transcriptFormat: 2, sessionState: 'idle' });
      expect(readActivity()).toMatchObject({ isLoading: true, historyCount: 1 });
      await waitFor(() => expect(tauriHarness.proxyFetch).toHaveBeenCalled());
      const sendCall = tauriHarness.proxyFetch.mock.calls.find(([url]) => String(url).endsWith('/chat/send'));
      const { clientRequestId } = JSON.parse(String(sendCall?.[1]?.body));
      expect(clientRequestId).toEqual(expect.any(String));
      const message = { id: 'server-user', role: 'user', content: 'hello', metadata: { source: 'desktop', clientRequestId }, timestamp: new Date(0).toISOString() };
      const echo = () => emit('chat:message-replay', { sessionId, replayKind: 'live-user-echo', message });
      const operation = (value: unknown) => emit('chat:transcript-operation', { sessionId, operation: value });
      if (order === 'echo-first') echo();
      expect(JSON.parse(screen.getByTestId('history-content').textContent!)).toEqual(['hello']);
      operation({ kind: 'message-create', message: { ...message, content: '', turnId: 'turn', transcriptState: 'complete' } });
      expect(JSON.parse(screen.getByTestId('history-content').textContent!)).toEqual(['hello']);
      expect(readActivity().isLoading).toBe(true);
      operation({ kind: 'text-append', messageId: message.id, field: 'text', offset: 0, text: 'hel' });
      operation({ kind: 'text-append', messageId: message.id, field: 'text', offset: 3, text: 'lo' });
      if (order === 'canonical-first') echo();
      expect(JSON.parse(screen.getByTestId('history-content').textContent!)).toEqual(['hello']);
      expect(JSON.parse(screen.getByTestId('history-identities').textContent!)).toEqual([{ id: 'server-user', runtimeTurnAnchor: null }]);
      emit('chat:message-complete', {});
      emit('chat:status', { sessionState: 'idle' });
      expect(readActivity().isLoading).toBe(false);
      await act(async () => { respond(new Response(JSON.stringify({ success: true }))); });
      expect(readActivity()).toMatchObject({ isLoading: false, historyCount: 1 });
    },
  );

  it('holds attachment and sends until pending Session birth has been reconciled', async () => {
    const props = { tabId: 'pending-birth', agentDir: '/tmp/workspace', sessionId: 'pending-birth', claimSessionOpeningTransition: allowSessionOpening };
    const view = render(<TabProvider {...props} sidecarConfigDisposition="pending"><Probe /></TabProvider>);
    await act(async () => undefined);
    expect(sseHarness.state.eventHandler).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'send message' }));
    await waitFor(() => expect(screen.getByTestId('send-receipt')).toHaveTextContent('false'));
    expect(tauriHarness.proxyFetch).not.toHaveBeenCalled();
    view.rerender(<TabProvider {...props} sessionId="prepared-birth" sidecarConfigDisposition="push"><Probe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
  });

  it.each([false, true])('preserves queued-response uncertainty and complete discussion contract (canonical first: %s)', async canonicalFirst => {
    const sessionId = 'pending-busy-loss';
    let reject!: (error: Error) => void;
    tauriHarness.proxyFetch.mockImplementation(() => new Promise<Response>((_resolve, fail) => { reject = fail; }));
    render(<TabProvider tabId="busy-loss" agentDir="/tmp/workspace" sessionId={sessionId} claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:status', { sessionState: 'running' });
    fireEvent.click(screen.getByRole('button', { name: 'send discussion' }));
    await waitFor(() => expect(tauriHarness.proxyFetch).toHaveBeenCalled());
    expect(readActivity().historyCount).toBe(0);
    const payload = JSON.parse(String(tauriHarness.proxyFetch.mock.calls[0][1]?.body));
    const accept = () => emit('chat:transcript-operation', { sessionId, operation: { kind: 'message-create', message: { id: 'canonical-busy-user', role: 'user', content: 'hello', timestamp: new Date(0).toISOString(), metadata: { source: 'desktop', clientRequestId: payload.clientRequestId } } } });
    if (canonicalFirst) accept();
    await act(async () => reject(new Error('response lost')));
    expect(readQueueIds()).toEqual([]);
    if (!canonicalFirst) {
      expect(JSON.parse(screen.getByTestId('history-unconfirmed').textContent!)).toEqual([true]);
      expect(JSON.parse(screen.getByTestId('history-contracts').textContent!)).toEqual([expect.objectContaining({ requiredSystemSkill: TASK_ALIGNMENT_SKILL_REQUIREMENT, primaryContext: payload.primaryContext })]);
      expect(screen.getByTestId('send-receipt')).toHaveTextContent('false');
      accept();
    }
    expect(JSON.parse(screen.getByTestId('history-identities').textContent!)).toEqual([{ id: 'canonical-busy-user', runtimeTurnAnchor: null }]);
    expect(JSON.parse(screen.getByTestId('history-unconfirmed').textContent!)).toEqual([false]);
    if (canonicalFirst) expect(screen.getByTestId('send-receipt')).toHaveTextContent('true');
  });

  it('does not inject a late queued failure into a sibling Session', async () => {
    let reject!: (error: Error) => void;
    tauriHarness.proxyFetch.mockImplementation(() => new Promise<Response>((_resolve, fail) => { reject = fail; }));
    const props = { tabId: 'scope-send', agentDir: '/tmp/workspace', claimSessionOpeningTransition: allowSessionOpening };
    const view = render(<TabProvider {...props} sessionId="pending-old"><Probe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:status', { sessionState: 'running' });
    fireEvent.click(screen.getByRole('button', { name: 'send discussion' }));
    await waitFor(() => expect(reject).toBeDefined());
    view.rerender(<TabProvider {...props} sessionId="pending-new"><Probe /></TabProvider>);
    await act(async () => reject(new Error('old response lost')));
    expect(readActivity()).toMatchObject({ sessionId: 'pending-new', historyCount: 0 });
    expect(readQueueIds()).toEqual([]);
    expect(screen.getByTestId('agent-error')).toHaveTextContent('');
  });

  it.each(['rejected', 'network-error'] as const)('retains a failed query after %s and ends pending loading', async failure => {
    let respond!: (response: Response) => void;
    let reject!: (error: Error) => void;
    const receipt = new Promise<Response>((resolve, fail) => { respond = resolve; reject = fail; });
    tauriHarness.proxyFetch.mockImplementation(() => receipt);
    render(<TabProvider tabId="failed-send" agentDir="/tmp/workspace" sessionId="pending-failed-send" claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'send message' }));
    expect(readActivity()).toMatchObject({ isLoading: true, historyCount: 1 });
    await waitFor(() => expect(tauriHarness.proxyFetch).toHaveBeenCalled());
    expect(screen.getByTestId('send-receipt')).toHaveTextContent('null');
    await act(async () => {
      if (failure === 'rejected') respond(new Response(JSON.stringify({ success: false, error: 'send rejected' })));
      else reject(new Error('connection closed'));
    });
    expect(readActivity()).toMatchObject({ isLoading: false, historyCount: 1 });
    expect(JSON.parse(screen.getByTestId('history-content').textContent!)).toEqual(['hello']);
    expect(JSON.parse(screen.getByTestId('history-delivery').textContent!)).toEqual(['failed']);
    expect(screen.getByTestId('send-receipt')).toHaveTextContent('false');
    expect(JSON.parse(screen.getByTestId('history-unconfirmed').textContent!)).toEqual([failure === 'network-error']);
    expect(screen.getByTestId('agent-error')).toHaveTextContent(failure === 'rejected' ? 'send rejected' : 'connection closed');
  });

  it('resends a local failure through ordinary send and replaces its failed bubble', async () => {
    const sessionId = 'pending-resend-failure';
    let respond!: (response: Response) => void;
    tauriHarness.proxyFetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: 'rejected' })));
    tauriHarness.proxyFetch.mockImplementation(() => new Promise<Response>(resolve => { respond = resolve; }));
    render(<TabProvider tabId="resend-failure" agentDir="/tmp/workspace" sessionId={sessionId} claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:init', { sessionId, transcriptFormat: 2, sessionState: 'idle' });
    fireEvent.click(screen.getByRole('button', { name: 'send message' }));
    await waitFor(() => expect(screen.getByTestId('history-delivery')).toHaveTextContent('failed'));
    const oldId = JSON.parse(screen.getByTestId('history-identities').textContent!)[0].id;
    fireEvent.click(screen.getByRole('button', { name: 'resend failed message' }));
    expect(readActivity()).toMatchObject({ isLoading: true, historyCount: 1 });
    expect(JSON.parse(screen.getByTestId('history-delivery').textContent!)).toEqual(['sending']);
    expect(JSON.parse(screen.getByTestId('history-identities').textContent!)[0].id).not.toBe(oldId);
    await waitFor(() => expect(tauriHarness.proxyFetch).toHaveBeenCalledTimes(2));
    expect(tauriHarness.proxyFetch.mock.calls.every(([url]) => String(url).endsWith('/chat/send'))).toBe(true);
    const first = JSON.parse(String(tauriHarness.proxyFetch.mock.calls[0][1]?.body));
    const second = JSON.parse(String(tauriHarness.proxyFetch.mock.calls[1][1]?.body));
    expect(second.clientRequestId).not.toBe(first.clientRequestId);
    expect(second.text).toBe('hello');
    emit('chat:transcript-operation', { sessionId, operation: { kind: 'message-create', message: { id: 'resend-user', role: 'user', content: '', timestamp: new Date(0).toISOString(), metadata: { source: 'desktop', clientRequestId: second.clientRequestId } } } });
    emit('chat:transcript-operation', { sessionId, operation: { kind: 'text-append', messageId: 'resend-user', field: 'text', offset: 0, text: 'hello' } });
    await act(async () => { respond(new Response(JSON.stringify({ success: true }))); });
    emit('chat:message-complete', {});
    emit('chat:status', { sessionState: 'idle' });
    expect(readActivity()).toMatchObject({ isLoading: false, historyCount: 1 });
    expect(JSON.parse(screen.getByTestId('history-delivery').textContent!)).toEqual([null]);
  });

  it('shows a send immediately in the existing queue while the Runtime is starting', async () => {
    tauriHarness.proxyFetch.mockImplementation(() => new Promise<Response>(() => undefined));
    render(<TabProvider tabId="starting-send" agentDir="/tmp/workspace" sessionId="pending-starting-send" claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:status', { sessionState: 'starting' });
    fireEvent.click(screen.getByRole('button', { name: 'send message' }));
    expect(readQueueIds()).toEqual([expect.stringMatching(/^opt-/)]);
    expect(screen.getByTestId('question-queue')).toHaveTextContent('hello');
    expect(readActivity().isLoading).toBe(true);
  });

  it.each(['echo-first', 'canonical-first', 'late-format'] as const)(
    'uses canonical user content exactly once with %s admission', async order => {
      const sessionId = 'pending-v2-user-admission';
      render(<TabProvider tabId="v2-user-admission" agentDir="/tmp/workspace" sessionId={sessionId} claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider>);
      await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
      if (order !== 'late-format') emit('chat:init', { sessionId, transcriptFormat: 2 });
      const message = { id: 'user-admission', role: 'user', content: 'first part; second part', timestamp: new Date(0).toISOString(), asyncQuestionReply: { questionId: 'q', questionIndex: 0 } };
      const echo = () => emit('chat:message-replay', { sessionId, replayKind: 'live-user-echo', message });
      const operation = (value: unknown) => emit('chat:transcript-operation', { sessionId, operation: value });
      if (order !== 'canonical-first') echo();
      if (order === 'echo-first') expect(readActivity().historyCount).toBe(0);
      operation({ kind: 'message-create', message: { ...message, content: '', turnId: 'turn', transcriptState: 'complete' } });
      operation({ kind: 'text-append', messageId: message.id, field: 'text', offset: 0, text: 'first part; ' });
      operation({ kind: 'text-append', messageId: message.id, field: 'text', offset: 12, text: 'second part' });
      if (order === 'canonical-first') echo();
      expect(readActivity().historyCount).toBe(1);
      expect(JSON.parse(screen.getByTestId('history-content').textContent!)).toEqual([message.content]);
      expect(JSON.parse(screen.getByTestId('question-replies').textContent!)).toEqual([message.asyncQuestionReply]);
    },
  );

  it('discards a legacy thinking preview when a new Session adopts V2 assistant messages', async () => {
    const sessionId = 'pending-v2-thinking-adoption';
    render(<TabProvider tabId="v2-thinking-adoption" agentDir="/tmp/workspace" sessionId={sessionId} claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());

    // The first DSH reasoning event can arrive before this Tab knows the new
    // Session uses V2. It creates a temporary legacy assistant row.
    emit('chat:thinking-start', { index: 0 });
    emit('chat:thinking-chunk', { index: 0, delta: 'preview' });
    expect(readStreamingContent()).toEqual([expect.objectContaining({ type: 'thinking', thinking: 'preview' })]);

    const operation = (value: unknown) => emit('chat:transcript-operation', { sessionId, operation: value });
    const assistant = (id: string, turnId?: string) => ({ id, role: 'assistant', content: [], timestamp: new Date(0).toISOString(), ...(turnId ? { turnId } : {}), transcriptState: 'streaming' });
    operation({ kind: 'message-create', message: assistant('canonical-first') });
    expect(readActivity().historyCount).toBe(0);
    expect(JSON.parse(screen.getByTestId('history-identities').textContent!)).toEqual([]);

    // A later canonical segment still moves the prior canonical row to history.
    operation({ kind: 'message-create', message: assistant('canonical-second', 'turn') });
    expect(JSON.parse(screen.getByTestId('history-identities').textContent!)).toEqual([
      { id: 'canonical-first', runtimeTurnAnchor: null },
    ]);
    emit('chat:message-complete', {});
    expect(JSON.parse(screen.getByTestId('history-identities').textContent!)).toEqual([
      { id: 'canonical-first', runtimeTurnAnchor: null },
      { id: 'canonical-second', runtimeTurnAnchor: null },
    ]);
  });

  it.each(['no-echo', 'echo-only', 'created-without-text'] as const)(
    'recovers a missed V2 user admission on SSE-native reconnect (%s)', async received => {
      const sessionId = 'pending-v2-reconnect';
      render(<TabProvider tabId="v2-reconnect" agentDir="/tmp/workspace" sessionId={sessionId} claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider>);
      await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
      emit('chat:init', { sessionId, transcriptFormat: 2 });
      const message = { id: 'reconnect-user', role: 'user', content: 'admitted while disconnected', timestamp: new Date(0).toISOString(), turnId: 'turn', transcriptState: 'complete' };
      // Keep an earlier visible row: reconnect init must preserve this Tab.
      emit('chat:transcript-operation', { sessionId, operation: { kind: 'message-create', message: { ...message, id: 'earlier', content: 'earlier' } } });
      if (received !== 'no-echo') emit('chat:message-replay', { sessionId, replayKind: 'live-user-echo', message });
      if (received === 'created-without-text') emit('chat:transcript-operation', { sessionId, operation: { kind: 'message-create', message: { ...message, content: '' } } });
      act(() => {
        sseHarness.state.statusHandler?.('disconnected');
        sseHarness.state.generation += 1;
        sseHarness.state.statusHandler?.('connected');
      });
      emit('chat:init', { sessionId, transcriptFormat: 2, sessionState: 'idle' });
      emit('chat:message-replay', { sessionId, replayKind: 'cold-history', message });
      expect(JSON.parse(screen.getByTestId('history-content').textContent!)).toEqual(['earlier', message.content]);
      expect(tauriHarness.proxyFetch).not.toHaveBeenCalled();
    },
  );

  it.each(['echo-first', 'canonical-first'] as const)('keeps local attachment previews with %s V2 admission', async order => {
    const sessionId = 'pending-v2-preview';
    let tab!: ReturnType<typeof useTabState>;
    function PreviewProbe() {
      const value = useTabState();
      useEffect(() => { tab = value; }, [value]);
      return <Probe />;
    }
    tauriHarness.proxyFetch.mockImplementation(async () => new Response(JSON.stringify({ success: true })));
    render(<TabProvider tabId="v2-preview" agentDir="/tmp/workspace" sessionId={sessionId} claimSessionOpeningTransition={allowSessionOpening}><PreviewProbe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:init', { sessionId, transcriptFormat: 2 });
    await act(async () => {
      await tab.sendMessage('image', [{ id: 'image-1', name: 'test.png', file: new File(['image'], 'test.png', { type: 'image/png' }), preview: 'data:image/png;base64,aW1hZ2U=' }]);
    });
    const sendCall = tauriHarness.proxyFetch.mock.calls.find(([url, init]) => String(url).endsWith('/chat/send') && init?.method === 'POST');
    const { clientRequestId } = JSON.parse(String(sendCall?.[1]?.body));
    const message = { id: 'image-user', role: 'user', content: 'image', metadata: { source: 'desktop', clientRequestId }, timestamp: new Date(0).toISOString(), attachments: [{ id: 'image-1', name: 'test.png', mimeType: 'image/png', relativePath: 'attachments/test.png', size: 5 }] };
    const echo = () => emit('chat:message-replay', { sessionId, replayKind: 'live-user-echo', message });
    if (order === 'echo-first') echo();
    emit('chat:transcript-operation', { sessionId, operation: { kind: 'message-create', message: { ...message, content: '', turnId: 'turn', transcriptState: 'complete' } } });
    emit('chat:transcript-operation', { sessionId, operation: { kind: 'text-append', messageId: message.id, field: 'text', offset: 0, text: 'image' } });
    if (order === 'canonical-first') echo();
    expect(tab.historyMessages).toHaveLength(1);
    expect(tab.historyMessages[0]).toMatchObject({ content: 'image', attachments: [{ id: 'image-1', relativePath: 'attachments/test.png', previewUrl: 'data:image/png;base64,aW1hZ2U=' }] });
  });

  it('keeps pending image previews on their own message when full cold history replays older users first', async () => {
    const sessionId = 'pending-v2-preview-reconnect';
    let tab!: ReturnType<typeof useTabState>;
    function PreviewProbe() {
      const value = useTabState();
      useEffect(() => { tab = value; }, [value]);
      return <Probe />;
    }
    tauriHarness.proxyFetch.mockImplementation(async () => new Response(JSON.stringify({ success: true })));
    render(<TabProvider tabId="preview-reconnect" agentDir="/tmp/workspace" sessionId={sessionId} claimSessionOpeningTransition={allowSessionOpening}><PreviewProbe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:init', { sessionId, transcriptFormat: 2 });
    const base = { role: 'user', timestamp: new Date(0).toISOString(), turnId: 'turn', transcriptState: 'complete' };
    const earlier = { ...base, id: 'older-user', content: 'earlier text only' };
    const sameNameImage = { ...base, id: 'older-image', content: 'older image', attachments: [{ id: 'old-image', name: 'test.png', mimeType: 'image/png', relativePath: 'attachments/old.png', size: 5 }] };
    emit('chat:transcript-operation', { sessionId, operation: { kind: 'message-create', message: earlier } });
    await act(async () => {
      await tab.sendMessage('new image', [{ id: 'new-image', name: 'test.png', file: new File(['image'], 'test.png', { type: 'image/png' }), preview: 'data:image/png;base64,aW1hZ2U=' }]);
    });
    const sendCall = tauriHarness.proxyFetch.mock.calls.find(([url, init]) => String(url).endsWith('/chat/send') && init?.method === 'POST');
    const { clientRequestId } = JSON.parse(String(sendCall?.[1]?.body));
    const newest = { ...base, id: 'new-user', content: 'new image', metadata: { source: 'desktop', clientRequestId }, attachments: [{ id: 'new-image', name: 'test.png', mimeType: 'image/png', relativePath: 'attachments/new.png', size: 5 }] };
    emit('chat:message-replay', { sessionId, replayKind: 'live-user-echo', message: newest });
    emit('chat:init', { sessionId, transcriptFormat: 2, sessionState: 'idle' });
    for (const message of [earlier, sameNameImage, newest]) emit('chat:message-replay', { sessionId, replayKind: 'cold-history', message });
    expect(tab.historyMessages[0].attachments).toBeUndefined();
    expect(tab.historyMessages[1].attachments?.[0].previewUrl).not.toBe('data:image/png;base64,aW1hZ2U=');
    expect(tab.historyMessages[2]).toMatchObject({ content: 'new image', attachments: [{ id: 'new-image', previewUrl: 'data:image/png;base64,aW1hZ2U=' }] });
    expect(tab.historyMessages).toHaveLength(3);
    emit('chat:transcript-operation', { sessionId, operation: { kind: 'message-create', message: { ...base, id: 'later-text', content: 'next plain text' } } });
    expect(tab.historyMessages[3].attachments).toBeUndefined();
  });

  it('keeps V2 interleaved segments and late original-tool results without duplicate legacy chunks', async () => {
    render(<TabProvider tabId="v2-stream" agentDir="/tmp/workspace" sessionId="pending-v2-stream" claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    const sessionId = 'pending-v2-stream';
    emit('chat:init', { sessionId, transcriptFormat: 2 });
    const operation = (value: unknown) => emit('chat:transcript-operation', { sessionId, generation: 'g', instanceId: 'i', operation: value });
    const create = (id: string, role: 'user' | 'assistant', content: string | unknown[]) => operation({ kind: 'message-create', message: { id, role, content, timestamp: new Date(0).toISOString(), turnId: 'turn', transcriptState: role === 'assistant' ? 'streaming' : 'complete' } });
    act(() => {
      create('u1', 'user', 'first');
      create('a1', 'assistant', []);
      operation({ kind: 'block-upsert', messageId: 'a1', block: { id: 't1', type: 'text', text: '' } });
      operation({ kind: 'text-append', messageId: 'a1', blockId: 't1', field: 'text', offset: 0, text: 'before steer' });
      emit('chat:message-chunk', 'before steer');
      operation({ kind: 'block-upsert', messageId: 'a1', block: { id: 'tool-block', type: 'tool_use', tool: { id: 'late-tool', name: 'Read', isLoading: true } } });
      emit('chat:tool-use-start', { id: 'late-tool', name: 'Read', input: { file_path: 'first' } });
      create('u2', 'user', 'steer');
      emit('queue:started', { sessionId, queueId: 'q', midTurnBreak: true, userMessage: { id: 'u2', role: 'user', content: 'steer', timestamp: new Date(0).toISOString() } });
      create('a2', 'assistant', []);
      operation({ kind: 'block-upsert', messageId: 'a2', block: { id: 't2', type: 'text', text: '' } });
      operation({ kind: 'text-append', messageId: 'a2', blockId: 't2', field: 'text', offset: 0, text: 'partial' });
      operation({ kind: 'block-upsert', messageId: 'a2', block: { id: 't2', type: 'text', text: 'complete correction', isComplete: true } });
      operation({ kind: 'block-update', messageId: 'a1', blockId: 'tool-block', target: 'tool', details: { isLoading: false } });
      emit('chat:tool-result-complete', { toolUseId: 'late-tool', content: 'late result' });
      emit('chat:message-complete', { assistant_message_id: 'legacy-wrong-id' });
    });
    const identities = JSON.parse(screen.getByTestId('history-identities').textContent!);
    expect(identities.map((message: { id: string }) => message.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    const content = JSON.parse(screen.getByTestId('history-content').textContent!);
    expect(content[1]).toEqual([
      expect.objectContaining({ id: 't1', text: 'before steer' }),
      expect.objectContaining({ id: 'tool-block', tool: expect.objectContaining({ result: 'late result', input: { file_path: 'first' }, isLoading: false }) }),
    ]);
    expect(content[3]).toEqual([expect.objectContaining({ text: 'complete correction' })]);
    expect(readStreamingContent()).toBeNull();
  });

  it.each(['root', 'nested'])('preserves %s final input when its reference resolves before an older page', async kind => {
    const sessionId = 'session-v2-ref-page';
    let tab!: ReturnType<typeof useTabState>;
    function PagingProbe() {
      const value = useTabState();
      useEffect(() => { tab = value; }, [value]);
      return <Probe />;
    }
    const input = { content: 'resolved before page' };
    const fetchRef = vi.spyOn(largeValueRefs, 'fetchJsonLargeValueRef').mockResolvedValue(input);
    const message = (id: string, role: 'user' | 'assistant', content: unknown) => ({ id, role, content, timestamp: new Date(0).toISOString() });
    const snapshot = (messages: unknown[], hasMoreBefore: boolean) => new Response(JSON.stringify({ success: true, session: {
      id: sessionId, transcriptFormat: 2, runtime: 'builtin', title: 'History', agentDir: '/tmp/workspace',
      messages, snapshotRevision: 10, hasMoreBefore, liveSessionState: 'idle',
    } }));
    let resolvePage!: (response: Response) => void;
    tauriHarness.proxyFetch.mockImplementation(async (url: string) => url.includes('&before=')
      ? new Promise<Response>(resolve => { resolvePage = resolve; })
      : snapshot([message('u2', 'user', 'latest')], true));
    render(<TabProvider tabId="ref-page" agentDir="/tmp/workspace" sessionId={sessionId} claimSessionOpeningTransition={allowSessionOpening}><PagingProbe /></TabProvider>);
    await waitFor(() => expect(screen.getByTestId('session-loading')).toHaveTextContent('false'));
    let loading!: Promise<void>;
    act(() => { loading = tab.loadOlderMessages(); });
    await waitFor(() => expect(resolvePage).toBeDefined());
    emit(kind === 'root' ? 'chat:content-block-stop' : 'chat:subagent-tool-use', kind === 'root'
      ? { type: 'tool_use', toolId: 'parent', inputRef: { id: 'ref' } }
      : { parentToolUseId: 'parent', tool: { id: 'child', name: 'Read' }, inputRef: { id: 'ref' }, finalInput: true },
    { sessionId, liveRevision: 11 });
    await waitFor(() => expect(fetchRef).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolvePage(snapshot([message('u1', 'user', 'old'), message('a1', 'assistant', [{ id: 'block', type: 'tool_use', tool: {
        id: 'parent', name: 'Task', input: {}, subagentCalls: [{ id: 'child', name: 'Read', input: {} }],
      } }])], false));
      await loading;
    });
    const rows = JSON.parse(screen.getByTestId('history-content').textContent!);
    expect(rows[1][0].tool).toMatchObject(kind === 'root' ? { input } : { subagentCalls: [{ input }] });
    fetchRef.mockRestore();
  });

  it('updates a page that arrives after an old tool changed and refreshes the retained prefix on a SSE gap', async () => {
    const sessionId = 'session-v2-paging';
    let tab!: ReturnType<typeof useTabState>;
    function PagingProbe() {
      const value = useTabState();
      useEffect(() => { tab = value; }, [value]);
      return <Probe />;
    }
    const message = (id: string, role: 'user' | 'assistant', content: unknown) => ({ id, role, content, timestamp: new Date(0).toISOString() });
    const oldTool = (result: string) => message('a1', 'assistant', [{ id: 'old-block', type: 'tool_use', tool: { id: 'old-tool', name: 'Read', input: {}, result, isLoading: false } }]);
    const snapshot = (messages: unknown[], snapshotRevision: number, hasMoreBefore: boolean) => new Response(JSON.stringify({ success: true, session: {
      id: sessionId, transcriptFormat: 2, runtime: 'builtin', title: 'History', agentDir: '/tmp/workspace',
      messages, snapshotRevision, hasMoreBefore, liveSessionState: 'running',
      liveStreamingMessage: message('a2', 'assistant', [{ id: 'live-text', type: 'text', text: 'still running' }]),
    } }));
    let resolvePage!: (response: Response) => void;
    const requests: string[] = [];
    tauriHarness.proxyFetch.mockImplementation(async (url: string) => {
      requests.push(url);
      if (url.includes('&before=')) return new Promise<Response>(resolve => { resolvePage = resolve; });
      if (url.includes('&from=u1')) return snapshot([message('u1', 'user', 'first'), oldTool('after gap'), message('u2', 'user', 'steer')], 14, false);
      return snapshot([message('u2', 'user', 'steer')], 10, true);
    });
    render(<TabProvider tabId="v2-paging" agentDir="/tmp/workspace" sessionId={sessionId} claimSessionOpeningTransition={allowSessionOpening}><PagingProbe /></TabProvider>);
    await waitFor(() => expect(screen.getByTestId('session-loading')).toHaveTextContent('false'));
    let loading!: Promise<void>;
    act(() => { loading = tab.loadOlderMessages(); });
    await waitFor(() => expect(resolvePage).toBeDefined());
    emit('chat:transcript-operation', { sessionId, operation: { kind: 'block-update', messageId: 'a1', blockId: 'old-block', target: 'tool', details: { isLoading: false } } }, { sessionId, liveRevision: 11 });
    emit('chat:tool-result-complete', { toolUseId: 'old-tool', content: 'late final' }, { sessionId, liveRevision: 12 });
    await act(async () => {
      resolvePage(snapshot([message('u1', 'user', 'first'), oldTool('stale')], 10, false));
      await loading;
    });
    expect(screen.getByTestId('history-content')).toHaveTextContent('late final');
    expect(screen.getByTestId('history-content')).not.toHaveTextContent('stale');
    emit('chat:tool-result-complete', { toolUseId: 'old-tool', content: 'after gap' }, { sessionId, liveRevision: 14 });
    await waitFor(() => expect(requests.some(url => url.includes('&from=u1'))).toBe(true));
    await waitFor(() => expect(screen.getByTestId('history-content')).toHaveTextContent('after gap'));
    expect(readStreamingContent()).toEqual([expect.objectContaining({ text: 'still running' })]);
  });

  it('closes an async question-only text item before subsequent commentary', async () => {
    tauriHarness.proxyFetch.mockResolvedValue(new Response(JSON.stringify({ success: true })));
    render(<TabProvider tabId="async-boundary" agentDir="/tmp/workspace" sessionId="pending-async-boundary" claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    fireEvent.click(screen.getByText('send message'));
    const asyncQuestions = { id: 'q', questions: [{ title: '去哪？', options: ['看海'] }] };
    emit('chat:content-block-stop', { type: 'text', asyncQuestions });
    emit('chat:message-chunk', '随后继续说明');
    emit('chat:content-block-stop', { type: 'text' });
    expect(readStreamingContent()).toEqual([
      { type: 'text', text: '', isComplete: true, asyncQuestions },
      { type: 'text', text: '随后继续说明', isComplete: true },
    ]);
  });

  it('awaits async-answer admission and allows retry after a rejected send', async () => {
    let respond!: (response: Response) => void;
    tauriHarness.proxyFetch.mockImplementation(() => new Promise<Response>(resolve => { respond = resolve; }));
    render(<TabProvider tabId="async-receipt" agentDir="/tmp/workspace" sessionId="pending-async-receipt" claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    fireEvent.click(screen.getByText('send async answer'));
    await waitFor(() => expect(respond).toBeDefined());
    expect(screen.getByTestId('answer-receipt')).toHaveTextContent('null');
    expect(JSON.parse(screen.getByTestId('question-queue').textContent!)[0].asyncQuestionReply).toEqual({ questionId: 'q', questionIndex: 0 });
    await act(async () => { respond(new Response(JSON.stringify({ success: false, error: 'rejected' }))); });
    expect(screen.getByTestId('answer-receipt')).toHaveTextContent('false');
    expect(readQueueIds()).toEqual([]);
    expect(screen.getByTestId('question-replies')).toHaveTextContent('[]');
  });

  it('does not resurrect an async queue item cancelled before the HTTP receipt', async () => {
    let respond!: (response: Response) => void;
    tauriHarness.proxyFetch.mockImplementation(() => new Promise<Response>(resolve => { respond = resolve; }));
    render(<TabProvider tabId="async-cancel" agentDir="/tmp/workspace" sessionId="pending-async-cancel" claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    fireEvent.click(screen.getByText('send async answer'));
    await waitFor(() => expect(respond).toBeDefined());
    emit('queue:added', { queueId: 'real-q', messageText: '看海', asyncQuestionReply: { questionId: 'q', questionIndex: 0 } });
    expect(readQueueIds()).toEqual(['real-q']);
    emit('queue:cancelled', { queueId: 'real-q' });
    await act(async () => { respond(new Response(JSON.stringify({ success: true, queued: true, queueId: 'real-q' }))); });
    expect(readQueueIds()).toEqual([]);
    expect(screen.getByTestId('question-replies')).toHaveTextContent('[]');
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

  it('retains an AskUserQuestion card until the backend acknowledges its response', async () => {
    render(
      <TabProvider
        tabId="tab-ask-ack"
        agentDir="/tmp/workspace"
        sessionId="pending-ask-ack"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('ask-user-question:request', {
      requestId: 'ask-ack-1',
      sessionId: 'pending-ask-ack',
      questions: [{
        question: 'Choose one',
        header: 'Choice',
        options: [
          { label: 'One', description: 'First' },
          { label: 'Two', description: 'Second' },
        ],
        multiSelect: false,
      }],
    });
    expect(screen.getByTestId('pending-ask-id')).toHaveTextContent('ask-ack-1');

    tauriHarness.proxyFetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: 'not applied' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'answer question' }));
    await waitFor(() => expect(tauriHarness.proxyFetch).toHaveBeenCalled());
    expect(screen.getByTestId('pending-ask-id')).toHaveTextContent('ask-ack-1');

    tauriHarness.proxyFetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'answer question' }));
    await waitFor(() => expect(screen.getByTestId('pending-ask-id')).toBeEmptyDOMElement());
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
    expect(screen.getByTestId('agent-error-user-message-id')).toBeEmptyDOMElement();

    emit('chat:status', { sessionState: 'starting' });
    expect(readActivity().isLoading).toBe(true);
    emit('chat:agent-error', { message: 'Startup failed' });
    expect(readActivity()).toMatchObject({ isLoading: false, sessionState: 'idle' });

    fireEvent.click(screen.getByRole('button', { name: 'send message' }));
    expect(screen.getByTestId('agent-error')).toBeEmptyDOMElement();

    emit('chat:agent-error', { message: 'New turn auth failure', userMessageId: 'failed-user-turn' });
    expect(screen.getByTestId('agent-error-user-message-id')).toHaveTextContent('failed-user-turn');
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
    expect(screen.getByTestId('agent-error-user-message-id')).toBeEmptyDOMElement();
  });

  it('keeps root activity authoritative when a desktop send becomes queued work', async () => {
    tauriHarness.proxyFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/chat/send') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          success: true,
          queued: true,
          queueId: 'queue-recovery-follow-up',
          isInFlight: false,
          deliveryMode: 'turn',
          canCancel: true,
          canForceExecute: true,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected proxyFetch call: ${init?.method ?? 'GET'} ${url}`);
    });
    render(
      <TabProvider
        tabId="tab-queued-loading"
        agentDir="/tmp/workspace"
        sessionId="pending-queued-loading"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:status', { sessionState: 'starting' });
    expect(readActivity().isLoading).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'send message' }));

    await waitFor(() => expect(readQueueIds()).toContain('queue-recovery-follow-up'));
    expect(readActivity()).toMatchObject({
      isLoading: true,
      sessionState: 'starting',
    });
  });

  it('renders Provider activity without acquiring root Composer loading', async () => {
    render(
      <TabProvider
        tabId="tab-provider-tool"
        agentDir="/tmp/workspace"
        sessionId="pending-provider-tool"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    expect(readActivity().isLoading).toBe(false);

    emit('chat:server-tool-use-start', {
      id: 'provider-call-1',
      name: 'web_search',
      input: { query: 'public reference' },
      providerRouteId: 'fixture-provider',
      providerBlockType: 'server_tool_use',
    });

    expect(readActivity().isLoading).toBe(false);
    expect(readStreamingContent()).toEqual([expect.objectContaining({
      type: 'server_tool_use',
      providerRouteId: 'fixture-provider',
      providerBlockType: 'server_tool_use',
      tool: expect.objectContaining({ id: 'provider-call-1', isLoading: true }),
    })]);

    emit('chat:tool-result-complete', {
      toolUseId: 'provider-call-1',
      content: '[{"title":"Reference"}]',
      isError: false,
      providerRouteId: 'fixture-provider',
      providerBlockType: 'web_search_tool_result',
    });

    expect(readActivity().isLoading).toBe(false);
    expect(readStreamingContent()).toEqual([expect.objectContaining({
      type: 'server_tool_use',
      resultProviderBlockType: 'web_search_tool_result',
      tool: expect.objectContaining({
        id: 'provider-call-1',
        isLoading: false,
        result: '[{"title":"Reference"}]',
      }),
    })]);
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
    expect(tauriHarness.proxyFetch.mock.calls.some(([url]) =>
      url.includes('/sessions/real-refused-upgrade'),
    )).toBe(false);
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

  it('loads the frozen metadata for an SSE-native birth after App adopts its id', async () => {
    const onSessionIdChange = vi.fn(async () => true);
    tauriHarness.proxyFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/sessions/real-birth?limit=1')) {
        return new Response(JSON.stringify({
          success: true,
          session: { id: 'real-birth', agentDir: '/tmp/workspace', runtime: 'dsh', runtimeSource: 'integrated' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(
      <TabProvider
        tabId="tab-birth-metadata"
        agentDir="/tmp/workspace"
        sessionId="pending-birth-metadata"
        onSessionIdChange={onSessionIdChange}
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:system-init', {
      info: { timestamp: '2026-07-15T00:00:00.000Z', model: 'model-a' },
      sessionId: 'real-birth',
      runtime: 'dsh',
      runtimeSource: 'integrated',
    });

    await waitFor(() => expect(screen.getByTestId('session-meta')).toHaveTextContent(
      JSON.stringify({ id: 'real-birth', runtime: 'dsh' }),
    ));
    expect(screen.getByTestId('live-runtime-session-id')).toHaveTextContent('real-birth');
    expect(onSessionIdChange).toHaveBeenCalledWith('real-birth');
    expect(tauriHarness.proxyFetch.mock.calls.some(([url]) =>
      url === 'http://127.0.0.1:1234/sessions/real-birth?limit=1',
    )).toBe(true);
  });

  it('retries birth metadata after the first turn when Runtime init precedes persistence', async () => {
    let reads = 0;
    tauriHarness.proxyFetch.mockImplementation(async (url: string) => {
      if (!url.endsWith('/sessions/real-delayed-metadata?limit=1')) {
        throw new Error(`Unexpected request: ${url}`);
      }
      reads += 1;
      return new Response(JSON.stringify({
        success: true,
        session: reads === 1
          ? { id: 'real-delayed-metadata', runtime: 'dsh' }
          : { id: 'real-delayed-metadata', agentDir: '/tmp/workspace', runtime: 'dsh' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    render(
      <TabProvider
        tabId="tab-delayed-metadata"
        agentDir="/tmp/workspace"
        sessionId="pending-delayed-metadata"
        onSessionIdChange={vi.fn(async () => true)}
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Probe />
      </TabProvider>,
    );

    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:system-init', {
      info: { timestamp: '2026-07-15T00:00:00.000Z', model: 'model-a' },
      sessionId: 'real-delayed-metadata', runtime: 'dsh', runtimeSource: 'integrated',
    });
    await waitFor(() => expect(reads).toBe(1));
    expect(screen.getByTestId('session-meta')).toHaveTextContent('null');

    emit('chat:message-complete', {});
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(screen.getByTestId('session-meta')).toHaveTextContent(
      JSON.stringify({ id: 'real-delayed-metadata', runtime: 'dsh' }),
    ));
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

  it('keeps history and identity when reset is rejected', async () => {
    tauriHarness.proxyFetch.mockImplementation(async (url: string) => new Response(JSON.stringify(
      url.endsWith('/api/session-state') ? { sessionId: 'pending-reset-rejected', sessionState: 'idle', isBusy: false } : { success: false, error: 'reset rejected' }
    ), { status: 200 }));
    render(<TabProvider tabId="reset-rejected" agentDir="/tmp/workspace" sessionId="pending-reset-rejected" claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:message-replay', { replayKind: 'live-user-echo', sessionId: 'pending-reset-rejected', message: { id: 'retained-user', role: 'user', content: 'retain this', timestamp: new Date(0).toISOString() } });
    expect(readActivity().historyCount).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'reset session' }));
    await waitFor(() => expect(screen.getByTestId('agent-error')).toHaveTextContent('reset rejected'));
    expect(readActivity().historyCount).toBe(1);
    expect(readActivity().sessionId).toBe('pending-reset-rejected');
  });

  it('does not declare idle when a stop fails and the backend is still running', async () => {
    tauriHarness.proxyFetch.mockImplementation(async (url: string) => new Response(JSON.stringify(
      url.endsWith('/api/session-state') ? { sessionId: 'pending-stop-rejected', sessionState: 'running', isBusy: true } : { success: false, error: 'termination unconfirmed' }
    ), { status: 200 }));
    render(<TabProvider tabId="stop-rejected" agentDir="/tmp/workspace" sessionId="pending-stop-rejected" claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:status', { sessionState: 'running' });
    fireEvent.click(screen.getByRole('button', { name: 'stop response' }));
    await waitFor(() => expect(screen.getByTestId('agent-error')).toHaveTextContent('termination unconfirmed'));
    expect(readActivity().sessionState).toBe('running');
    expect(readActivity().isLoading).toBe(true);
  });

  it.each([
    { observed: 'running', busy: true, newer: 'idle', newerBusy: false },
    { observed: 'idle', busy: false, newer: 'running', newerBusy: true },
  ])('ignores delayed stop recovery $observed after newer $newer SSE', async ({ observed, busy, newer, newerBusy }) => {
    let finish!: (response: Response) => void;
    const read = new Promise<Response>(resolve => { finish = resolve; });
    tauriHarness.proxyFetch.mockImplementation(async (url: string) => url.endsWith('/api/session-state')
      ? read : new Response(JSON.stringify({ success: true, alreadyStopped: true }), { status: 200 }));
    render(<TabProvider tabId="stop-late" agentDir="/tmp/workspace" sessionId="pending-stop-late" claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('chat:status', { sessionState: 'running' });
    fireEvent.click(screen.getByRole('button', { name: 'stop response' }));
    await waitFor(() => expect(tauriHarness.proxyFetch.mock.calls.some(([url]) => url.endsWith('/api/session-state'))).toBe(true));
    emit('chat:status', { sessionState: newer });
    await act(async () => finish(new Response(JSON.stringify({ sessionId: 'pending-stop-late', sessionState: observed, isBusy: busy, completionTerminal: busy ? null : { status: 'stopped' } }), { status: 200 })));
    expect(readActivity()).toMatchObject({ sessionState: newer, isLoading: newerBusy });
  });

  it('adopts the authoritative binding after a lost reset response', async () => {
    tauriHarness.proxyFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/chat/reset')) throw new Error('response lost');
      return new Response(JSON.stringify({ sessionId: 'session-reset-committed', sessionState: 'idle', isBusy: false }), { status: 200 });
    });
    const onSessionIdChange = vi.fn().mockResolvedValue(true);
    render(<TabProvider tabId="reset-lost" agentDir="/tmp/workspace" sessionId="pending-reset-lost" onSessionIdChange={onSessionIdChange} claimSessionOpeningTransition={allowSessionOpening}><Probe /></TabProvider>);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'reset session' }));
    await waitFor(() => expect(readActivity().sessionId).toBe('session-reset-committed'));
    expect(onSessionIdChange).toHaveBeenCalledWith('session-reset-committed', { newConversation: true });
    expect(tauriHarness.proxyFetch.mock.calls.filter(([url]) => url.endsWith('/chat/reset'))).toHaveLength(1);
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

    await waitFor(() => expect(onSessionIdChange).toHaveBeenCalledWith('session-reset-b', { newConversation: true }));
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

    await waitFor(() => expect(onSessionIdChange).toHaveBeenCalledWith('session-reset-race-b', { newConversation: true }));
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

describe('TabProvider question receipts and Task history ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sseHarness.state.connected = false;
    sseHarness.state.generation = 1;
    sseHarness.state.eventHandler = null;
    sseHarness.state.statusHandler = null;
    tauriHarness.listeners.clear();
    tauriHarness.isTauri = true;
    tauriHarness.proxyFetch.mockRejectedValue(new Error('submission unavailable'));
  });
  function capture(strict = false, showForm = false) {
    let value: ReturnType<typeof useTabState>;
    function Capture() {
      const v = useTabState();
      useEffect(() => {
        value = v;
      }, [v]);
      return showForm && v.pendingAskUserQuestion ? <AskUserQuestionPrompt
        request={v.pendingAskUserQuestion} onSubmit={v.respondAskUserQuestion}
        onCancel={requestId => v.respondAskUserQuestion(requestId, null)} /> : null;
    }
    const tree = (
      <TabProvider
        tabId="receipt-test"
        agentDir="/tmp/workspace"
        sessionId="pending-receipt"
        claimSessionOpeningTransition={allowSessionOpening}
      >
        <Capture />
      </TabProvider>
    );
    const view = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
    return { get: () => value!, ...view };
  }
  it('keeps separate notification history rows for resumed task runs', async () => {
    const { get } = capture();
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    const scope = { sessionId: 'pending-receipt', taskId: 'resume-test-agent', toolUseId: 'resume-test-tool' };
    emit('chat:task-started', { ...scope, runId: 'run-1' });
    emit('chat:task-notification', { ...scope, runId: 'run-1', status: 'completed', summary: 'first' });
    emit('chat:task-started', { ...scope, runId: 'run-2' });
    emit('chat:task-notification', { ...scope, runId: 'run-1', status: 'failed', summary: 'late' });
    emit('chat:task-notification', { ...scope, runId: 'run-2', status: 'completed', summary: '' });
    emit('chat:task-notification', { ...scope, runId: 'run-2', status: 'completed', summary: 'second' });
    const records = get().historyMessages.filter(message => message.id.startsWith('task-notification-resume-test-agent'));
    expect(records).toHaveLength(2);
    expect(records[0].content).toContain('first');
    expect(records[1].content).toContain('second');
    expect(records.map(message => message.id)).toEqual(['task-notification-resume-test-agent-run-run-1', 'task-notification-resume-test-agent-run-run-2']);
  });

  const question = (requestId: string) => ({
    sessionId: 'pending-receipt',
    requestId,
    questions: [
      {
        question: 'Continue?',
        header: 'Choice',
        options: [{ label: 'Yes', description: 'Continue' }],
        multiSelect: false,
      },
    ],
  });
  it('queues simultaneous questions in FIFO order and sends each answer to its own caller', async () => {
    const { get } = capture(true);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('ask-user-question:request', question('first'));
    emit('ask-user-question:request', question('second'));
    emit('ask-user-question:request', question('first')); // reconnect replay must not duplicate it
    expect(get().pendingAskUserQuestion?.requestId).toBe('first');
    await act(async () => { await expect(get().respondAskUserQuestion('first', { '0': 'Yes' })).rejects.toThrow(); });
    expect(get().pendingAskUserQuestion?.requestId).toBe('first');
    tauriHarness.proxyFetch.mockImplementation(async () => new Response(JSON.stringify({ success: true })));
    await act(async () => { await get().respondAskUserQuestion('first', { '0': 'Yes' }); });
    expect(get().pendingAskUserQuestion?.requestId).toBe('second');
    await act(async () => { await get().respondAskUserQuestion('second', { '0': 'Second answer' }); });
    expect(get().pendingAskUserQuestion).toBeNull();
    const bodies = tauriHarness.proxyFetch.mock.calls.map(call => JSON.parse(call[1].body as string));
    expect(bodies.slice(-2)).toEqual([{ requestId: 'first', answers: { '0': 'Yes' } },
      { requestId: 'second', answers: { '0': 'Second answer' } }]);
  });
  it('shows and submits each queued form through the real component and Tab response owner', async () => {
    const { get } = capture(true, true);
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    for (const id of ['First question?', 'Second question?']) {
      const input = question(id);
      emit('ask-user-question:request', { ...input, questions: [{ ...input.questions[0], question: id }] });
    }
    expect(screen.getByText('First question?')).toBeVisible();
    expect(screen.queryByText('Second question?')).toBeNull();
    tauriHarness.proxyFetch.mockImplementation(async () => new Response(JSON.stringify({ success: true })));
    fireEvent.click(screen.getByRole('button', { name: 'Yes Continue' }));
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await screen.findByText('Second question?');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Custom return to caller' } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await waitFor(() => expect(get().pendingAskUserQuestion).toBeNull());
    expect(tauriHarness.proxyFetch.mock.calls.map(call => JSON.parse(call[1].body as string))).toEqual([
      { requestId: 'First question?', answers: { '0': { selected: ['Yes'] } } },
      { requestId: 'Second question?', answers: { '0': { selected: [], custom: 'Custom return to caller' } } },
    ]);
  });
  it('clears queued questions on session adoption and ignores late events from the old session', async () => {
    const { get } = capture();
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('ask-user-question:request', question('old-first'));
    emit('ask-user-question:request', question('old-second'));
    await act(async () => { await get().adoptMigratedSession('session-next', { sidecarAlreadyMigrated: true }); });
    expect(get().pendingAskUserQuestion).toBeNull();
    emit('ask-user-question:request', question('old-replay'));
    expect(get().pendingAskUserQuestion).toBeNull();
    emit('ask-user-question:request', { ...question('new-first'), sessionId: 'session-next' });
    emit('ask-user-question:expired', { requestId: 'new-first', sessionId: 'pending-receipt' });
    expect(get().pendingAskUserQuestion?.requestId).toBe('new-first');
  });
  it('expires only the matching queued request and reveals the next unanswered question', async () => {
    const { get } = capture();
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    for (const id of ['first', 'removed', 'third']) emit('ask-user-question:request', question(id));
    emit('ask-user-question:expired', { sessionId: 'pending-receipt', requestId: 'removed' });
    expect(get().pendingAskUserQuestion?.requestId).toBe('first');
    emit('ask-user-question:expired', { sessionId: 'pending-receipt', requestId: 'first' });
    expect(get().pendingAskUserQuestion?.requestId).toBe('third');
    emit('ask-user-question:expired', { sessionId: 'pending-receipt', requestId: 'first' });
    expect(get().pendingAskUserQuestion?.requestId).toBe('third');
  });
  it('normalizes missing multiSelect and rejects malformed replay without mounting a broken form', async () => {
    const { get } = capture();
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    const raw = question('legacy');
    emit('ask-user-question:request', { ...raw, questions: raw.questions.map(({ multiSelect: _unused, ...q }) => q) });
    expect(get().pendingAskUserQuestion?.questions[0].multiSelect).toBe(false);
    emit('ask-user-question:request', { ...question('broken'), questions: [{ ...raw.questions[0], options: [null] }] });
    expect(get().pendingAskUserQuestion?.requestId).toBe('legacy');
    expect(get().agentError).toContain('options[0]');
  });
  it.each(['reject', 'false'] as const)('keeps the same question retryable on %s', async (mode) => {
    const { get } = capture();
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('ask-user-question:request', question('q1'));
    if (mode === 'false')
      tauriHarness.proxyFetch.mockResolvedValue(new Response(JSON.stringify({ success: false })));
    await act(async () => {
      await expect(get().respondAskUserQuestion('q1', { '0': 'Yes' })).rejects.toThrow();
    });
    expect(get().pendingAskUserQuestion?.requestId).toBe('q1');
    tauriHarness.proxyFetch.mockResolvedValue(new Response(JSON.stringify({ success: true })));
    await act(async () => {
      await get().respondAskUserQuestion('q1', { '0': 'Yes' });
    });
    expect(get().pendingAskUserQuestion).toBeNull();
    const payload = JSON.parse(tauriHarness.proxyFetch.mock.calls.at(-1)![1].body as string);
    expect(payload).toEqual({ requestId: 'q1', answers: { '0': 'Yes' } });
  });
  it('does not dismiss a new question with an old successful receipt', async () => {
    const { get } = capture();
    await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
    emit('ask-user-question:request', question('old'));
    let resolve!: (r: Response) => void;
    tauriHarness.proxyFetch.mockImplementation(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );
    let response!: Promise<void>;
    act(() => {
      response = get().respondAskUserQuestion('old', null);
    });
    await waitFor(() => expect(resolve).toBeDefined());
    emit('ask-user-question:request', question('new'));
    await act(async () => {
      resolve(new Response(JSON.stringify({ success: true })));
      await response;
    });
    expect(get().pendingAskUserQuestion?.requestId).toBe('new');
  });
  it.each(['success', 'reject', 'missing-baseline'] as const)(
    'ignores old Task history after identity adoption (%s)',
    async (outcome) => {
      const { get } = capture();
      await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
      await act(async () => {
        await get().adoptMigratedSession('session-old', { sidecarAlreadyMigrated: true });
        get().setMessages([{ id: 'old-user', role: 'user', content: 'old', timestamp: new Date(0) }]);
      });
      let resolve!: (r: Response) => void;
      let reject!: (e: Error) => void;
      tauriHarness.proxyFetch.mockImplementation(
        () =>
          new Promise<Response>((r, j) => {
            resolve = r;
            reject = j;
          }),
      );
      act(() => {
        tauriHarness.listeners.get('cron:execution-complete')!({
          payload: { internalSessionId: 'session-old', taskId: 't', success: true, executionCount: 1 },
        });
      });
      await waitFor(() => expect(resolve).toBeDefined());
      await act(async () => {
        await get().adoptMigratedSession('session-new', { sidecarAlreadyMigrated: true });
      });
      const calls = tauriHarness.proxyFetch.mock.calls.length;
      await act(async () => {
        if (outcome === 'reject') reject(new Error('late failure'));
        else
          resolve(
            new Response(
              JSON.stringify({
                success: true,
                fromIndex: outcome === 'missing-baseline' ? -1 : 0,
                messages: [
                  {
                    id: 'old-result',
                    role: 'assistant',
                    content: 'STALE',
                    timestamp: new Date(0).toISOString(),
                  },
                ],
                session: {
                  id: 'session-old',
                  messages: [
                    {
                      id: 'old-result',
                      role: 'assistant',
                      content: 'STALE',
                      timestamp: new Date(0).toISOString(),
                    },
                  ],
                },
              }),
            ),
          );
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(get().sessionId).toBe('session-new');
      expect(get().historyMessages).toHaveLength(0);
      expect(tauriHarness.proxyFetch.mock.calls.length).toBe(calls);
      expect(get().sessionRestoreError).toBeNull();
    },
  );
  it.each(['normal', 'rewind', 'replacement'] as const)(
    'routes Task refresh through the restore owner (%s)',
    async (scenario) => {
      const { get } = capture();
      await waitFor(() => expect(sseHarness.state.eventHandler).not.toBeNull());
      await act(async () => {
        await get().adoptMigratedSession('session-cron', { sidecarAlreadyMigrated: true });
        get().setMessages([{ id: 'prefix', role: 'user', content: 'keep', timestamp: new Date(0) }]);
      });
      emit('chat:init', { sessionId: 'session-cron', transcriptFormat: 2, sessionState: 'idle' });
      const responses: Array<(value: Response) => void> = [];
      tauriHarness.proxyFetch.mockImplementation(
        () => new Promise<Response>((resolve) => responses.push(resolve)),
      );
      act(() => {
        tauriHarness.listeners.get('cron:execution-complete')!({
          payload: { internalSessionId: 'session-cron', taskId: 'task', success: true, executionCount: 1 },
        });
      });
      await waitFor(() => expect(responses).toHaveLength(1));
      const row = (id: string) => ({
        id,
        role: 'user',
        content: id,
        timestamp: new Date(0).toISOString(),
        transcriptState: 'complete',
        turnId: id,
      });
      const snapshot = (ids: string[], revision: number) =>
        new Response(
          JSON.stringify({
            success: true,
            session: {
              id: 'session-cron',
              transcriptFormat: 2,
              messages: ids.map(row),
              snapshotRevision: revision,
              liveSessionState: 'idle',
              hasMoreBefore: false,
            },
          }),
        );
      if (scenario === 'rewind') {
        emit(
          'chat:transcript-operation',
          { sessionId: 'session-cron', operation: { kind: 'messages-remove', messageIds: ['tail'] } },
          { sessionId: 'session-cron', connectionGeneration: 1, liveRevision: 2 },
        );
      }
      if (scenario === 'replacement') {
        act(() => {
          sseHarness.state.generation = 2;
          sseHarness.state.statusHandler?.('connected');
        });
        await waitFor(() => expect(responses).toHaveLength(2));
      }
      await act(async () => {
        responses[0](snapshot(['prefix', 'tail'], 1));
      });
      if (scenario === 'replacement') {
        expect(get().historyMessages.map((message) => message.id)).toEqual(['prefix']);
        await act(async () => {
          responses[1](snapshot(['prefix', 'current'], 2));
        });
      }
      await waitFor(() => expect(get().isSessionLoading).toBe(false));
      expect(get().historyMessages.map((message) => message.id)).toEqual(
        scenario === 'rewind'
          ? ['prefix']
          : scenario === 'replacement'
            ? ['prefix', 'current']
            : ['prefix', 'tail'],
      );
      expect(tauriHarness.proxyFetch.mock.calls.every(([url]) => !url.includes('/since/'))).toBe(true);
    },
  );
  it('releases an SSE connection whose attachment finishes after unmount', async () => {
    let finish!: () => void;
    sseHarness.connection.connect.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      sseHarness.state.connected = true;
    });
    const { unmount } = capture();
    await waitFor(() => expect(finish).toBeDefined());
    unmount();
    await act(async () => {
      finish();
    });
    expect(sseHarness.state.connected).toBe(false);
  });
  it('connects after StrictMode effect replay and releases on real unmount', async () => {
    const { unmount } = capture(true);
    await waitFor(() => expect(sseHarness.state.connected).toBe(true));
    unmount();
    await waitFor(() => expect(sseHarness.state.connected).toBe(false));
  });
});
