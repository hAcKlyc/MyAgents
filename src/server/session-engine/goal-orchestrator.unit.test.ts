import { composeQueryReminder } from '../../shared/agentMentions';
import { describe, expect, it, vi } from 'vitest';

import {
  parseLeadingSystemReminder,
  GOAL_CONTEXT_TAG,
  GOAL_CONTINUATION_TAG,
} from '../../shared/systemReminder';
import { createGoalOrchestrator, type SessionGoal } from './goal-orchestrator';
import type {
  DesktopMessageRequest,
  ImMessageRequest,
  InjectedTurnRequest,
} from './types';
import type { TurnTerminalOutcome } from '../session-core/turn-queue';

const scheduledMocks = vi.hoisted(() => ({
  metadata: { origin: { kind: 'desktop', surface: 'unknown' }, source: '' } as Record<string, unknown>,
}));

vi.mock('../SessionStore', () => ({
  getSessionMetadata: vi.fn(() => scheduledMocks.metadata),
}));
vi.mock('../tools/cron-tools', () => ({
  clearCronTaskContext: vi.fn(),
}));

function goal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    id: 'goal-1',
    objective: 'Ship the feature',
    status: 'active',
    turnCount: 2,
    revision: 7,
    controlRevision: 3,
    sessionId: 'session-1',
    workspacePath: '/workspace',
    endConditions: { aiCanExit: true },
    ...overrides,
  };
}

function desktopRequest(text = 'Please continue'): DesktopMessageRequest {
  return {
    text,
    sessionId: 'session-1',
    workspacePath: '/workspace',
    scenario: { type: 'desktop', surface: 'chat' },
  };
}

function imRequest(message = 'Please continue'): ImMessageRequest {
  return {
    message,
    requestId: 'request-1',
    sessionId: 'session-1',
    workspacePath: '/workspace',
    scenario: { type: 'im', platform: 'telegram', sourceType: 'private' },
  };
}

function clientWithGoal(currentGoal: SessionGoal | null = goal()) {
  return vi.fn(async (
    path: string,
    _method?: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    if (path.startsWith('/api/goal/get?')) return { ok: true, goal: currentGoal };
    if (path === '/api/goal/turn/claim') {
      return {
        ok: true,
        goal: { ...currentGoal, status: 'active', revision: 8 },
        turn: { queueId: body?.queueId, turnNumber: 3 },
      };
    }
    if (path === '/api/goal/turn/finalize') return { ok: true, applied: true, goal: currentGoal };
    if (path === '/api/goal/turn/abort') return { ok: true, goal: currentGoal };
    throw new Error(`Unexpected management route: ${path}`);
  });
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Goal orchestrator', () => {
  it('preserves the same Goal and stable recovery code without redispatching business input', async () => {
    const client = clientWithGoal();
    let terminal: ((outcome: TurnTerminalOutcome) => void | Promise<void>) | undefined;
    const sendDesktopMessage = vi.fn(async (request: DesktopMessageRequest) => {
      await request.beforeDispatch?.(); terminal = request.onTerminal;
      return { success: true, queued: false, queueId: request.queueId };
    });
    await createGoalOrchestrator(client).sendDesktopMessage({ sendDesktopMessage }, desktopRequest());
    await terminal?.({ status: 'error', code: 'context_recovery_required', error: 'Recovery exhausted',
      text: 'Prior progress retained', assistantMessagePresent: true });
    await terminal?.({ status: 'error', code: 'context_recovery_required', error: 'Recovery exhausted',
      text: 'Prior progress retained', assistantMessagePresent: true });
    const finals = client.mock.calls.filter(([path]) => path === '/api/goal/turn/finalize');
    expect(finals).toHaveLength(1);
    expect(finals[0][2]).toMatchObject({ goalId: 'goal-1', success: false, code: 'context_recovery_required' });
    expect(sendDesktopMessage).toHaveBeenCalledTimes(1);
  });
  it('sends ordinary messages unchanged when the Session has no Goal', async () => {
    const client = clientWithGoal(null);
    client.mockImplementation(async (path: string): Promise<Record<string, unknown>> => {
      if (path.startsWith('/api/goal/get?')) return { ok: true, goal: null };
      throw new Error(`Unexpected management route: ${path}`);
    });
    const sendDesktopMessage = vi.fn(async (request: DesktopMessageRequest) => ({
      success: true,
      queued: false,
      queueId: request.queueId,
    }));

    await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage },
      desktopRequest('plain user message'),
    );

    expect(sendDesktopMessage).toHaveBeenCalledWith(desktopRequest('plain user message'));
  });

  it('keeps the first Goal query visible and uses its queue id for claim and finalize', async () => {
    const client = clientWithGoal();
    let terminal: ((outcome: TurnTerminalOutcome) => void | Promise<void>) | undefined;
    const sendDesktopMessage = vi.fn(async (request: DesktopMessageRequest) => {
      const accepted = await request.beforeDispatch?.();
      expect(accepted).toEqual({ accepted: true });
      terminal = request.onTerminal;
      return {
        success: true,
        queued: false,
        queueId: request.queueId,
        dispatchAcceptance: Promise.resolve({ accepted: true }),
      };
    });

    const result = await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage },
      desktopRequest('Ship the feature'),
    );
    const dispatched = sendDesktopMessage.mock.calls[0][0];
    expect(dispatched.text).toBe("Ship the feature");
    expect(dispatched.queryPrimaryContext).toMatchObject({kind:"goal",firstTurn:false});
    const parsed = parseLeadingSystemReminder(composeQueryReminder({visibleText:dispatched.text,primaryContext:dispatched.queryPrimaryContext}));
    expect(parsed.kind).toBe(GOAL_CONTEXT_TAG);
    expect(parsed.visibleText).toBe('Ship the feature');
    expect(dispatched.turnOwner).toEqual({ kind: 'goal', id: 'goal-1' });
    expect(dispatched.turnBoundaryOnly).toBe(true);
    expect(result).not.toHaveProperty('dispatchAcceptance');

    await terminal?.({
      status: 'complete',
      text: 'done',
      assistantMessagePresent: true,
      durationMs: 4_200,
      usage: { inputTokens: 1_200, outputTokens: 300 },
    });
    await flushPromises();

    const claim = client.mock.calls.find(([path]) => path === '/api/goal/turn/claim');
    const finalize = client.mock.calls.find(([path]) => path === '/api/goal/turn/finalize');
    expect(claim?.[2]).toMatchObject({
      goalId: 'goal-1',
      queueId: dispatched.queueId,
      kind: 'user_query',
      expectedControlRevision: 3,
    });
    expect(finalize?.[2]).toMatchObject({
      goalId: 'goal-1',
      queueId: dispatched.queueId,
      success: true,
      outputText: 'done',
      durationMs: 4_200,
      consumedTokens: 1_500,
    });
  });

  it('uses GOAL_CONTINUATION with a visible tail for the first Goal turn', async () => {
    const client = clientWithGoal(goal({ turnCount: 0 }));
    const sendDesktopMessage = vi.fn(async (request: DesktopMessageRequest) => ({
      success: true,
      queued: false,
      queueId: request.queueId,
    }));

    await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage },
      desktopRequest('Ship the feature'),
    );

    const parsed = parseLeadingSystemReminder(composeQueryReminder({visibleText:sendDesktopMessage.mock.calls[0][0].text,primaryContext:sendDesktopMessage.mock.calls[0][0].queryPrimaryContext}));
    expect(parsed.kind).toBe(GOAL_CONTINUATION_TAG);
    expect(parsed.visibleText).toBe('Ship the feature');
  });

  it('rejects a stale Goal claim without creating a parallel authority', async () => {
    const client = clientWithGoal();
    client.mockImplementation(async (path: string): Promise<Record<string, unknown>> => {
      if (path.startsWith('/api/goal/get?')) return { ok: true, goal: goal() };
      if (path === '/api/goal/turn/claim') {
        return { ok: false, code: 'stale_revision', error: 'Goal changed' };
      }
      if (path === '/api/goal/turn/abort') return { ok: true };
      throw new Error(`Unexpected management route: ${path}`);
    });
    const sendDesktopMessage = vi.fn(async (request: DesktopMessageRequest) => {
      const accepted = await request.beforeDispatch?.();
      return {
        success: true,
        queued: true,
        queueId: request.queueId,
        dispatchAcceptance: Promise.resolve(accepted ?? { accepted: true }),
      };
    });

    await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage },
      desktopRequest(),
    );
    await flushPromises();

    expect(client.mock.calls.filter(([path]) => path === '/api/goal/turn/claim')).toHaveLength(1);
    expect(client.mock.calls.some(([path]) => path === '/api/goal/turn/finalize')).toBe(false);
  });

  it('aborts a durable Goal claim when the runtime commit seam cancels its guard', async () => {
    const client = clientWithGoal();
    const sendDesktopMessage = vi.fn(async (request: DesktopMessageRequest) => {
      const acceptance = await request.beforeDispatch?.() ?? { accepted: true };
      request.beforeDispatch?.cancel?.();
      return {
        success: true,
        queued: true,
        queueId: request.queueId,
        dispatchAcceptance: Promise.resolve(acceptance),
      };
    });

    await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage },
      desktopRequest(),
    );
    await flushPromises();

    expect(client.mock.calls.some(([path]) => path === '/api/goal/turn/claim')).toBe(true);
    expect(client.mock.calls.some(([path]) => path === '/api/goal/turn/abort')).toBe(true);
  });

  it('acknowledges a pre-claim admission failure so Rust can continue the Goal', async () => {
    const client = clientWithGoal(goal({ turnCount: 0 }));
    const sendDesktopMessage = vi.fn(async () => ({
      success: false,
      error: 'provider unavailable',
      status: 503,
    }));

    const result = await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage },
      desktopRequest('Ship the feature'),
    );

    expect(result.success).toBe(false);
    expect(client.mock.calls.find(([path]) => path === '/api/goal/turn/abort')?.[2]).toMatchObject({
      goalId: 'goal-1',
    });
    expect(client.mock.calls.some(([path]) => path === '/api/goal/turn/claim')).toBe(false);
  });

  it('uses the Rust-provided queue id for an automatic continuation', async () => {
    const client = clientWithGoal();
    scheduledMocks.metadata = {
      origin: { kind: 'agent-channel', surface: 'channel_message' },
      source: 'telegram_group',
    };
    const prepareScheduledTurn = vi.fn(async () => ({
      success: true,
      sessionId: 'session-1',
      runtime: 'builtin' as const,
      permissionMode: 'fullAgency',
    }));
    const runInjectedTurn = vi.fn(async (request: InjectedTurnRequest) => {
      expect(await request.beforeDispatch?.()).toMatchObject({ accepted: true });
      await request.onTerminal?.({
        status: 'complete',
        text: 'progress',
        assistantMessagePresent: true,
      });
      return {
        success: true,
        enqueued: true,
        assistantMessagePresent: true,
        text: 'progress',
      };
    });

    const result = await createGoalOrchestrator(client).runScheduledTurn(
      { prepareScheduledTurn, runInjectedTurn, getLiveSessionState: () => ({ sessionState: 'idle', isBusy: false }) },
      {
        goal: goal(),
        queueId: 'goal-queue-3',
        expectedControlRevision: 3,
        turnNumber: 3,
        permissionMode: 'fullAgency',
      },
    );

    expect(result.success).toBe(true);
    expect(runInjectedTurn.mock.calls[0][0]).toMatchObject({
      queueId: 'goal-queue-3',
      turnOwner: { kind: 'goal', id: 'goal-1' },
    });
    expect(client.mock.calls.find(([path]) => path === '/api/goal/turn/finalize')?.[2]).toMatchObject({
      queueId: 'goal-queue-3',
      channelDeliveryExpected: true,
    });
  });

  it.each(['background', 'foreground'] as const)('defers automatic continuation during %s work without claiming or counting a turn', async (work) => {
    const client = clientWithGoal();
    const prepareScheduledTurn = vi.fn(async () => ({ success: true }));
    const runInjectedTurn = vi.fn(async () => ({ success: true }));
    const getLiveSessionState = vi.fn(() => ({
      sessionState: work === 'foreground' ? 'running' : 'idle',
      isBusy: work === 'foreground',
      hasBackgroundWork: work === 'background',
    }));
    const orchestrator = createGoalOrchestrator(client);
    for (let i = 0; i < 470; i++) {
      expect(await orchestrator.runScheduledTurn({ prepareScheduledTurn, runInjectedTurn, getLiveSessionState }, {
        goal: goal(), queueId: `wait-${i}`, expectedControlRevision: 3, turnNumber: 3,
      })).toMatchObject({ success: false, code: 'goal_work_pending' });
    }
    expect(prepareScheduledTurn).not.toHaveBeenCalled();
    expect(runInjectedTurn).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
    getLiveSessionState.mockReturnValue({ sessionState: 'idle', isBusy: false, hasBackgroundWork: false });
    expect(await orchestrator.runScheduledTurn({ prepareScheduledTurn, runInjectedTurn, getLiveSessionState }, {
      goal: goal(), queueId: 'resumed', expectedControlRevision: 3, turnNumber: 3,
    })).toMatchObject({ success: true });
    expect(runInjectedTurn).toHaveBeenCalledOnce();
  });

  it.each(['preparation', 'promotion', 'claim', 'commit'] as const)('rechecks background work at %s and releases only authority it acquired', async (stage) => {
    const client = clientWithGoal();
    let hasBackgroundWork = false;
    const release = vi.fn();
    const prepareScheduledTurn = vi.fn(async () => {
      if (stage === 'preparation') hasBackgroundWork = true;
      return { success: true, release };
    });
    const baseClient = client.getMockImplementation()!;
    client.mockImplementation(async (...args) => {
      const result = await baseClient(...args);
      if (stage === 'claim' && args[0] === '/api/goal/turn/claim') hasBackgroundWork = true;
      return result;
    });
    const runInjectedTurn = vi.fn(async (request: InjectedTurnRequest) => {
      if (stage === 'promotion') hasBackgroundWork = true;
      let decision = await request.beforeDispatch!();
      if (stage === 'commit') {
        expect(decision.accepted).toBe(true);
        hasBackgroundWork = true;
        decision = decision.validateAtCommit!();
        await decision.rollbackBeforeReject;
      }
      expect(decision).toMatchObject({ accepted: false, code: 'goal_work_pending' });
      await request.beforeDispatch!.cancel?.();
      return { success: false, enqueued: false };
    });
    const result = await createGoalOrchestrator(client).runScheduledTurn({
      prepareScheduledTurn, runInjectedTurn,
      getLiveSessionState: () => ({ sessionState: 'idle', isBusy: false, hasBackgroundWork }),
    }, { goal: goal(), queueId: 'deferred', expectedControlRevision: 3, turnNumber: 3 });
    expect(result).toMatchObject({ success: false, code: 'goal_work_pending' });
    expect(release).toHaveBeenCalledOnce();
    const claimed = stage === 'claim' || stage === 'commit';
    expect(client.mock.calls.filter(([path]) => path === '/api/goal/turn/claim')).toHaveLength(claimed ? 1 : 0);
    expect(client.mock.calls.filter(([path]) => path === '/api/goal/turn/abort')).toHaveLength(claimed ? 1 : 0);
    expect(client.mock.calls.some(([path]) => path === '/api/goal/turn/finalize')).toBe(false);
  });

  it('keeps a claimed Goal turn authoritative when runtime termination is unconfirmed', async () => {
    const client = clientWithGoal();
    scheduledMocks.metadata = { origin: { kind: 'desktop', surface: 'unknown' }, source: '' };
    const prepareScheduledTurn = vi.fn(async () => ({
      success: true,
      sessionId: 'session-1',
      runtime: 'builtin' as const,
      permissionMode: 'fullAgency',
    }));
    const runInjectedTurn = vi.fn(async (request: InjectedTurnRequest) => {
      expect(await request.beforeDispatch?.()).toMatchObject({ accepted: true });
      return {
        success: false,
        enqueued: true,
        status: 408,
        error: 'runtime process did not stop',
        terminationUnconfirmed: true,
      };
    });

    const result = await createGoalOrchestrator(client).runScheduledTurn(
      { prepareScheduledTurn, runInjectedTurn, getLiveSessionState: () => ({ sessionState: 'idle', isBusy: false }) },
      {
        goal: goal(),
        queueId: 'goal-orphan-turn',
        expectedControlRevision: 3,
        turnNumber: 3,
        permissionMode: 'fullAgency',
      },
    );

    expect(result).toMatchObject({
      success: false,
      terminationUnconfirmed: true,
    });
    expect(client.mock.calls.some(([path]) => path === '/api/goal/turn/claim')).toBe(true);
    expect(client.mock.calls.some(([path]) => path === '/api/goal/turn/abort')).toBe(false);
    expect(client.mock.calls.some(([path]) => path === '/api/goal/turn/finalize')).toBe(false);
  });

  it('replays an idempotent claim after a lost response', async () => {
    const client = clientWithGoal();
    let claimAttempts = 0;
    client.mockImplementation(async (
      path: string,
      _method?: string,
      body?: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      if (path.startsWith('/api/goal/get?')) return { ok: true, goal: goal() };
      if (path === '/api/goal/turn/claim') {
        claimAttempts += 1;
        if (claimAttempts === 1) throw new Error('response lost');
        return {
          ok: true,
          goal: goal({ revision: 8 }),
          turn: { queueId: body?.queueId, turnNumber: 3 },
        };
      }
      if (path === '/api/goal/turn/finalize') return { ok: true, applied: true };
      if (path === '/api/goal/turn/abort') return { ok: true };
      throw new Error(`Unexpected management route: ${path}`);
    });
    const sendDesktopMessage = vi.fn(async (request: DesktopMessageRequest) => ({
      success: true,
      queued: false,
      dispatchAcceptance: Promise.resolve(await request.beforeDispatch?.() ?? { accepted: true }),
    }));

    await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage },
      desktopRequest(),
    );

    expect(claimAttempts).toBe(2);
  });

  it('does not release the terminal barrier until finalize is acknowledged', async () => {
    const client = clientWithGoal();
    let finalizeAttempts = 0;
    client.mockImplementation(async (
      path: string,
      _method?: string,
      body?: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      if (path.startsWith('/api/goal/get?')) return { ok: true, goal: goal() };
      if (path === '/api/goal/turn/claim') {
        return {
          ok: true,
          goal: goal({ revision: 8 }),
          turn: { queueId: body?.queueId, turnNumber: 3 },
        };
      }
      if (path === '/api/goal/turn/finalize') {
        finalizeAttempts += 1;
        if (finalizeAttempts === 1) throw new Error('response lost');
        return { ok: true, applied: false };
      }
      if (path === '/api/goal/turn/abort') return { ok: true };
      throw new Error(`Unexpected management route: ${path}`);
    });
    let terminal: ((outcome: TurnTerminalOutcome) => void | Promise<void>) | undefined;
    const sendDesktopMessage = vi.fn(async (request: DesktopMessageRequest) => {
      expect(await request.beforeDispatch?.()).toEqual({ accepted: true });
      terminal = request.onTerminal;
      return { success: true, queued: false };
    });

    await createGoalOrchestrator(client).sendDesktopMessage(
      { sendDesktopMessage },
      desktopRequest(),
    );
    await terminal?.({ status: 'complete', text: 'done', assistantMessagePresent: true });

    expect(finalizeAttempts).toBe(2);
  });

  it('wraps Goal IM messages with the same visible-tail protocol', async () => {
    const client = clientWithGoal();
    const enqueueImMessage = vi.fn(async (request: ImMessageRequest) => ({
      success: true,
      queued: true,
      dispatchAcceptance: Promise.resolve(await request.beforeDispatch?.() ?? { accepted: true }),
    }));

    await createGoalOrchestrator(client).enqueueImMessage(
      { enqueueImMessage },
      imRequest('new evidence'),
    );

    const request = enqueueImMessage.mock.calls[0][0];
    expect(parseLeadingSystemReminder(request.message).visibleText).toBe('new evidence');
    expect(request.turnOwner).toEqual({ kind: 'goal', id: 'goal-1' });
  });

  it('persists one objective CAS and leaves restart ownership to Rust', async () => {
    const client = clientWithGoal();
    client.mockImplementation(async (
      path: string,
      _method?: string,
      body?: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      if (path.startsWith('/api/goal/get?')) return { ok: true, goal: goal() };
      if (path === '/api/goal/objective') {
        return {
          ok: true,
          goal: goal({ objective: String(body?.objective ?? ''), revision: 8, controlRevision: 4 }),
        };
      }
      throw new Error(`Unexpected management route: ${path}`);
    });
    const result = await createGoalOrchestrator(client).updateObjective(
      { hasQueuedTurnOwnedBy: () => false },
      {
        sessionId: 'session-1',
        workspacePath: '/workspace',
        objective: 'Ship and verify the feature',
      },
    );

    expect(result).toMatchObject({ success: true, delivery: 'persisted' });
    expect(client.mock.calls.find(([path]) => path === '/api/goal/objective')?.[2]).toMatchObject({
      expectedRevision: 7,
      objective: 'Ship and verify the feature',
    });
  });

  it('rejects objective edits while a Goal-owned user turn is queued', async () => {
    const client = clientWithGoal();
    const result = await createGoalOrchestrator(client).updateObjective(
      { hasQueuedTurnOwnedBy: () => true },
      {
        sessionId: 'session-1',
        workspacePath: '/workspace',
        objective: 'Replace the objective',
      },
    );

    expect(result).toMatchObject({ success: false, code: 'turn_conflict', status: 409 });
    expect(client).toHaveBeenCalledTimes(1);
  });
});
