import { randomUUID } from 'node:crypto';
import { classifyContextTurnFailure } from '../utils/context-budget';

import {
  GOAL_CONTEXT_TAG,
  GOAL_CONTINUATION_TAG,
  buildGoalContextReminder,
  buildGoalContinuationReminder,
  parseLeadingSystemReminder,
} from '../../shared/systemReminder';
import { workspacePathsEqual } from '../../shared/workspacePath';
import { normalizeSessionOrigin } from '../../shared/session-origin';
import { managementApi } from '../utils/management-api-client';
import type {
  DesktopAdmissionResult,
  DesktopMessageRequest,
  ImAdmissionResult,
  ImMessageRequest,
  InjectedTurnResult,
  SessionEngine,
} from './types';
import type {
  DispatchGuard,
  TurnTerminalOutcome,
} from '../session-core/turn-queue';
import { getSessionMetadata } from '../SessionStore';
import { clearCronTaskContext } from '../tools/cron-tools';
import { withScheduledTurnDispatchLock } from './scheduled-turn-lock';

export type SessionGoalStatus =
  | 'active'
  | 'paused'
  | 'complete'
  | 'blocked'
  | 'canceled';

export type SessionGoal = {
  id: string;
  objective: string;
  status: SessionGoalStatus;
  turnCount: number;
  revision: number;
  controlRevision: number;
  sessionId: string;
  workspacePath: string;
  endConditions: { aiCanExit: boolean };
  updatedAt?: string;
};

export type GoalObjectiveUpdateResult = {
  success: boolean;
  goal?: SessionGoal;
  delivery?: 'persisted';
  error?: string;
  code?: string;
  status?: number;
};

type ManagementClient = typeof managementApi;
type GoalTurnKind = 'user_query' | 'continuation';

type GoalLookupResult =
  | { success: true; goal: SessionGoal | null }
  | { success: false; goal: null; error: string; code?: string };

type GoalTurnLifecycle = {
  beforeDispatch: DispatchGuard;
  onTerminal: (outcome: TurnTerminalOutcome) => Promise<void>;
  abort(): Promise<void>;
};

const GOAL_SETTLEMENT_RETRY_MS = 100;

function waitForGoalSettlementRetry(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, GOAL_SETTLEMENT_RETRY_MS));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function normalizeGoal(value: unknown): SessionGoal | null {
  if (!isRecord(value) || !isRecord(value.endConditions)) return null;
  const status = value.status;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const objective = typeof value.objective === 'string' ? value.objective.trim() : '';
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : '';
  const workspacePath = typeof value.workspacePath === 'string' ? value.workspacePath.trim() : '';
  if (
    !id
    || !objective
    || !sessionId
    || !workspacePath
    || !Number.isInteger(value.turnCount)
    || (value.turnCount as number) < 0
    || !Number.isInteger(value.revision)
    || (value.revision as number) < 0
    || !Number.isInteger(value.controlRevision)
    || (value.controlRevision as number) < 0
    || typeof value.endConditions.aiCanExit !== 'boolean'
    || (status !== 'active'
      && status !== 'paused'
      && status !== 'complete'
      && status !== 'blocked'
      && status !== 'canceled')
  ) {
    return null;
  }
  return {
    id,
    objective,
    status,
    turnCount: value.turnCount as number,
    revision: value.revision as number,
    controlRevision: value.controlRevision as number,
    sessionId,
    workspacePath,
    endConditions: { aiCanExit: value.endConditions.aiCanExit },
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : undefined,
  };
}

function goalMatches(
  goal: SessionGoal | null,
  goalId: string,
  sessionId: string,
  workspacePath: string,
): goal is SessionGoal {
  return Boolean(
    goal
      && goal.id === goalId
      && goal.sessionId === sessionId
      && workspacePathsEqual(goal.workspacePath, workspacePath),
  );
}

function isUnfinished(goal: SessionGoal | null): goal is SessionGoal {
  return goal?.status === 'active' || goal?.status === 'paused';
}

function isSlashCommand(text: string): boolean {
  return text.trimStart().startsWith('/');
}

async function lookupGoal(
  client: ManagementClient,
  sessionId: string,
  workspacePath: string,
): Promise<GoalLookupResult> {
  const query = new URLSearchParams({ sessionId, workspacePath });
  let response: Record<string, unknown>;
  try {
    response = await client(`/api/goal/get?${query.toString()}`);
  } catch (error) {
    return {
      success: false,
      goal: null,
      error: error instanceof Error ? error.message : String(error),
      code: 'goal_lookup_unavailable',
    };
  }
  if (response.ok !== true) {
    return {
      success: false,
      goal: null,
      error: String(response.error ?? 'Goal state lookup failed'),
      code: typeof response.code === 'string' ? response.code : undefined,
    };
  }
  if (response.goal == null) return { success: true, goal: null };
  const goal = normalizeGoal(response.goal);
  if (
    !goal
    || goal.sessionId !== sessionId
    || !workspacePathsEqual(goal.workspacePath, workspacePath)
  ) {
    return {
      success: false,
      goal: null,
      error: 'Management API returned an invalid Goal',
      code: 'invalid_goal_payload',
    };
  }
  return { success: true, goal };
}

function visibleGoalMessage(text: string): string {
  const parsed = parseLeadingSystemReminder(text);
  return parsed.hasReminder
    && (parsed.kind === GOAL_CONTEXT_TAG || parsed.kind === GOAL_CONTINUATION_TAG)
    ? parsed.visibleText
    : text;
}

function goalContext(goal: SessionGoal, text: string, firstUserTurn: boolean): string {
  const visibleUserMessage = visibleGoalMessage(text);
  if (firstUserTurn) {
    return buildGoalContinuationReminder({
      objective: goal.objective,
      goalId: goal.id,
      goalStatus: goal.status,
      turnNumber: 1,
      aiCanExit: goal.endConditions.aiCanExit,
      visibleUserMessage,
    });
  }
  return buildGoalContextReminder({
    objective: goal.objective,
    goalId: goal.id,
    goalStatus: goal.status,
    turnNumber: goal.turnCount + 1,
    aiCanExit: goal.endConditions.aiCanExit,
    visibleUserMessage,
  });
}

function goalContinuationScenario(sessionId: string): import('../system-prompt').InteractionScenario {
  const metadata = getSessionMetadata(sessionId);
  const origin = normalizeSessionOrigin(metadata?.origin);
  if (origin?.kind !== 'agent-channel') return { type: 'desktop' };
  const parts = (typeof metadata?.source === 'string' ? metadata.source : '')
    .split('_')
    .filter(Boolean);
  const tail = parts[parts.length - 1];
  return {
    type: 'agent-channel',
    platform: parts.length > 1 ? parts.slice(0, -1).join('_') : (parts[0] || 'unknown'),
    sourceType: tail === 'group' ? 'group' : 'private',
  };
}

function createGoalTurnLifecycle(
  client: ManagementClient,
  input: {
    goal: SessionGoal;
    sessionId: string;
    workspacePath: string;
    queueId: string;
    kind: GoalTurnKind;
    channelDeliveryExpected?: boolean;
  },
): GoalTurnLifecycle {
  let canceled = false;
  let claimed = false;
  let claimRequest: Promise<Record<string, unknown>> | null = null;
  let settlement: Promise<'aborted' | 'finalized'> | null = null;

  const settleUntilAcknowledged = async (
    path: '/api/goal/turn/abort' | '/api/goal/turn/finalize',
    body: Record<string, unknown>,
    settled: 'aborted' | 'finalized',
  ): Promise<'aborted' | 'finalized'> => {
    for (;;) {
      try {
        const response = await client(path, 'POST', body);
        if (response.ok === true || response.code === 'goal_changed') {
          claimed = false;
          return settled;
        }
        console.warn(
          `[goal] ${settled} settlement for ${input.queueId} was rejected: ${String(response.error ?? response.code ?? 'unknown error')}`,
        );
      } catch (error) {
        console.warn(`[goal] ${settled} settlement for ${input.queueId} is unavailable:`, error);
      }
      await waitForGoalSettlementRetry();
    }
  };

  const abort = async (): Promise<void> => {
    canceled = true;
    if (claimRequest) {
      await claimRequest.catch(() => undefined);
    }
    settlement ??= settleUntilAcknowledged('/api/goal/turn/abort', {
        sessionId: input.sessionId,
        workspacePath: input.workspacePath,
        goalId: input.goal.id,
        queueId: input.queueId,
      }, 'aborted');
    await settlement;
  };

  const beforeDispatch: DispatchGuard = async () => {
    if (canceled) {
      return { accepted: false, code: 'dispatch_canceled', error: 'Goal turn was canceled before dispatch' };
    }
    let response: Record<string, unknown> | null = null;
    while (!response) {
      if (canceled) {
        await abort();
        return {
          accepted: false,
          code: 'dispatch_canceled',
          error: 'Goal turn was canceled before dispatch',
        };
      }
      claimRequest = client('/api/goal/turn/claim', 'POST', {
          sessionId: input.sessionId,
          workspacePath: input.workspacePath,
          goalId: input.goal.id,
          queueId: input.queueId,
          kind: input.kind,
          expectedControlRevision: input.goal.controlRevision,
        });
      try {
        response = await claimRequest;
      } catch (error) {
        if (canceled) {
          claimRequest = null;
          await abort();
          return {
            accepted: false,
            code: 'dispatch_canceled',
            error: 'Goal turn was canceled before dispatch',
          };
        }
        console.warn(`[goal] claim for ${input.queueId} is unavailable:`, error);
        await waitForGoalSettlementRetry();
      } finally {
        claimRequest = null;
      }
    }
    const claimedGoal = normalizeGoal(response.goal);
    const turn = isRecord(response.turn) ? response.turn : null;
    if (
      response.ok !== true
      || !goalMatches(
        claimedGoal,
        input.goal.id,
        input.sessionId,
        input.workspacePath,
      )
      || claimedGoal.status !== 'active'
      || turn?.queueId !== input.queueId
      || !Number.isInteger(turn.turnNumber)
    ) {
      await abort();
      return {
        accepted: false,
        code: typeof response.code === 'string' ? response.code : 'invalid_goal_claim',
        error: String(response.error ?? 'Goal turn claim was rejected'),
      };
    }
    claimed = true;
    if (canceled) {
      await abort();
      return { accepted: false, code: 'dispatch_canceled', error: 'Goal turn was canceled before dispatch' };
    }
    return { accepted: true };
  };
  beforeDispatch.cancel = () => {
    canceled = true;
    // Cancellation may arrive after the claim guard returned accepted but
    // before the runtime's synchronous commit seam (for example an MCP lease
    // replacement). Settle the durable Goal reservation as aborted; merely
    // flipping the local flag would strand the claimed turn.
    return abort();
  };

  const finalize = async (outcome: TurnTerminalOutcome): Promise<void> => {
    if (!claimed) return;
    const consumedTokens = (outcome.usage?.inputTokens ?? 0)
      + (outcome.usage?.outputTokens ?? 0);
    settlement ??= settleUntilAcknowledged('/api/goal/turn/finalize', {
        sessionId: input.sessionId,
        workspacePath: input.workspacePath,
        goalId: input.goal.id,
        queueId: input.queueId,
        success: outcome.status === 'complete',
        error: outcome.error,
        code: outcome.code,
        outputText: outcome.text,
        durationMs: Math.max(0, Math.round(outcome.durationMs ?? 0)),
        consumedTokens: Math.max(0, Math.round(consumedTokens)),
        channelDeliveryExpected: input.channelDeliveryExpected === true,
      }, 'finalized');
    await settlement;
  };

  return {
    beforeDispatch,
    onTerminal: finalize,
    abort,
  };
}

function withoutDispatchAcceptance<T extends { dispatchAcceptance?: unknown }>(result: T): Omit<T, 'dispatchAcceptance'> {
  const { dispatchAcceptance: _dispatchAcceptance, ...publicResult } = result;
  return publicResult;
}

export function createGoalOrchestrator(client: ManagementClient = managementApi) {
  return {
    async sendDesktopMessage(
      engine: Pick<SessionEngine, 'sendDesktopMessage'>
        & Partial<Pick<SessionEngine, 'getCurrentTurnIdentity' | 'hasQueuedTurnOwnedBy'>>,
      request: DesktopMessageRequest,
    ): Promise<DesktopAdmissionResult> {
      if (isSlashCommand(request.text)) {
        return withoutDispatchAcceptance(await engine.sendDesktopMessage(request));
      }
      const lookup = await lookupGoal(client, request.sessionId, request.workspacePath);
      if (!lookup.success) {
        return { success: false, error: lookup.error, status: 503 };
      }
      if (!isUnfinished(lookup.goal)) {
        return withoutDispatchAcceptance(await engine.sendDesktopMessage(request));
      }

      const queueId = randomUUID();
      const owner = { kind: 'goal' as const, id: lookup.goal.id };
      const current = engine.getCurrentTurnIdentity?.() ?? null;
      const firstUserTurn = lookup.goal.turnCount === 0
        && !(engine.hasQueuedTurnOwnedBy?.(owner) ?? false)
        && !(current?.owner.kind === owner.kind && current.owner.id === owner.id);
      const lifecycle = createGoalTurnLifecycle(client, {
        goal: lookup.goal,
        sessionId: request.sessionId,
        workspacePath: request.workspacePath,
        queueId,
        kind: 'user_query',
      });
      const result = await engine.sendDesktopMessage({
        ...request,
        text: visibleGoalMessage(request.text),
        queryPrimaryContext: {kind:'goal',firstTurn:firstUserTurn,input:{
          objective:lookup.goal.objective,goalId:lookup.goal.id,goalStatus:lookup.goal.status,
          turnNumber:firstUserTurn?1:lookup.goal.turnCount+1,aiCanExit:lookup.goal.endConditions.aiCanExit,
          visibleUserMessage:visibleGoalMessage(request.text),
        }, desktopContext: request.queryPrimaryContext?.kind === 'goal'
          ? request.queryPrimaryContext.desktopContext : request.queryPrimaryContext},
        queueId,
        turnOwner: owner,
        onTerminal: lifecycle.onTerminal,
        beforeDispatch: lifecycle.beforeDispatch,
        turnBoundaryOnly: true,
      });
      if (!result.success || result.error) {
        await lifecycle.abort();
      } else if (result.dispatchAcceptance) {
        void result.dispatchAcceptance.then((accepted) => {
          if (!accepted.accepted) void lifecycle.abort();
        });
      }
      return withoutDispatchAcceptance(result);
    },

    async enqueueImMessage(
      engine: Pick<SessionEngine, 'enqueueImMessage'>
        & Partial<Pick<SessionEngine, 'getCurrentTurnIdentity' | 'hasQueuedTurnOwnedBy'>>,
      request: ImMessageRequest,
    ): Promise<ImAdmissionResult> {
      if (isSlashCommand(request.message)) {
        return withoutDispatchAcceptance(await engine.enqueueImMessage(request));
      }
      const lookup = await lookupGoal(client, request.sessionId, request.workspacePath);
      if (!lookup.success) {
        return { success: false, error: lookup.error, status: 503 };
      }
      if (!isUnfinished(lookup.goal)) {
        return withoutDispatchAcceptance(await engine.enqueueImMessage(request));
      }

      const queueId = randomUUID();
      const owner = { kind: 'goal' as const, id: lookup.goal.id };
      const current = engine.getCurrentTurnIdentity?.() ?? null;
      const firstUserTurn = lookup.goal.turnCount === 0
        && !(engine.hasQueuedTurnOwnedBy?.(owner) ?? false)
        && !(current?.owner.kind === owner.kind && current.owner.id === owner.id);
      const lifecycle = createGoalTurnLifecycle(client, {
        goal: lookup.goal,
        sessionId: request.sessionId,
        workspacePath: request.workspacePath,
        queueId,
        kind: 'user_query',
      });
      const result = await engine.enqueueImMessage({
        ...request,
        message: goalContext(lookup.goal, request.message, firstUserTurn),
        queueId,
        turnOwner: owner,
        onTerminal: lifecycle.onTerminal,
        beforeDispatch: lifecycle.beforeDispatch,
        turnBoundaryOnly: true,
      });
      if (!result.success || result.error) {
        await lifecycle.abort();
      } else if (result.dispatchAcceptance) {
        void result.dispatchAcceptance.then((accepted) => {
          if (!accepted.accepted) void lifecycle.abort();
        });
      }
      return withoutDispatchAcceptance(result);
    },

    async runScheduledTurn(
      engine: Pick<SessionEngine, 'prepareScheduledTurn' | 'runInjectedTurn'>,
      request: {
        goal: SessionGoal;
        queueId: string;
        expectedControlRevision: number;
        turnNumber: number;
        permissionMode?: string;
      },
    ): Promise<InjectedTurnResult & { sessionId?: string; channelDeliveryExpected?: boolean }> {
      return withScheduledTurnDispatchLock(async () => {
        clearCronTaskContext();
        const scenario = goalContinuationScenario(request.goal.sessionId);
        const metadata = getSessionMetadata(request.goal.sessionId);
        const turnOrigin = normalizeSessionOrigin(metadata?.origin)
          ?? { kind: 'desktop' as const, surface: 'unknown' as const };
        const channelDeliveryExpected = turnOrigin.kind === 'agent-channel';
        const prepared = await engine.prepareScheduledTurn({
          sessionId: request.goal.sessionId,
          workspacePath: request.goal.workspacePath,
          scenario,
          operation: { kind: 'goal', permissionMode: request.permissionMode },
        });
        if (!prepared.success) {
          clearCronTaskContext();
          if (prepared.code === 'session_bind_failed') {
            return {
              success: false,
              error: `Goal Sidecar is not bound to its owning session ${request.goal.sessionId}.`,
              status: 409,
            };
          }
          return {
            success: false,
            error: prepared.error ?? 'Failed to restore Goal session configuration',
            status: prepared.status ?? 503,
          };
        }

        const lifecycle = createGoalTurnLifecycle(client, {
          goal: { ...request.goal, controlRevision: request.expectedControlRevision },
          sessionId: request.goal.sessionId,
          workspacePath: request.goal.workspacePath,
          queueId: request.queueId,
          kind: 'continuation',
          channelDeliveryExpected,
        });
        try {
          const result = await engine.runInjectedTurn({
            prompt: buildGoalContinuationReminder({
              objective: request.goal.objective,
              goalId: request.goal.id,
              goalStatus: 'active',
              turnNumber: request.turnNumber,
              aiCanExit: request.goal.endConditions.aiCanExit,
            }),
            sessionId: prepared.sessionId ?? request.goal.sessionId,
            workspacePath: request.goal.workspacePath,
            scenario,
            permissionMode: prepared.permissionMode,
            runtimeConfig: null,
            analyticsOrigin: turnOrigin,
            timeoutMs: 3_600_000,
            pollMs: 1_000,
            assistantChannelDelivery: channelDeliveryExpected
              ? 'caller-owned'
              : 'session-binding',
            queueId: request.queueId,
            turnOwner: { kind: 'goal', id: request.goal.id },
            onTerminal: lifecycle.onTerminal,
            beforeDispatch: lifecycle.beforeDispatch,
          });
          if (!result.success && !result.terminationUnconfirmed) await lifecycle.abort();
          return {
            ...result,
            sessionId: request.goal.sessionId,
            channelDeliveryExpected,
          };
        } catch (error) {
          await lifecycle.abort();
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            code: classifyContextTurnFailure({ errorText: error instanceof Error ? error.message : String(error) }),
            status: 500,
            sessionId: request.goal.sessionId,
            channelDeliveryExpected,
          };
        } finally {
          clearCronTaskContext();
          await prepared.release?.();
        }
      });
    },

    async updateObjective(
      engine: Pick<SessionEngine, 'hasQueuedTurnOwnedBy'>,
      request: {
        sessionId: string;
        workspacePath: string;
        objective: string;
      },
    ): Promise<GoalObjectiveUpdateResult> {
      const lookup = await lookupGoal(client, request.sessionId, request.workspacePath);
      if (!lookup.success) {
        return { success: false, error: lookup.error, code: lookup.code, status: 503 };
      }
      if (!isUnfinished(lookup.goal)) {
        return {
          success: false,
          goal: lookup.goal ?? undefined,
          error: 'No active Goal in current session',
          code: 'goal_changed',
          status: 409,
        };
      }
      if (engine.hasQueuedTurnOwnedBy({ kind: 'goal', id: lookup.goal.id })) {
        return {
          success: false,
          goal: lookup.goal,
          error: 'A user message is already queued for this Goal. Let it run or cancel it before editing the objective.',
          code: 'turn_conflict',
          status: 409,
        };
      }
      let response: Record<string, unknown>;
      try {
        response = await client('/api/goal/objective', 'POST', {
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          goalId: lookup.goal.id,
          objective: request.objective,
          expectedRevision: lookup.goal.revision,
        });
      } catch (error) {
        return {
          success: false,
          goal: lookup.goal,
          error: error instanceof Error ? error.message : String(error),
          code: 'goal_update_unavailable',
          status: 503,
        };
      }
      const updated = normalizeGoal(response.goal);
      if (response.ok !== true || !updated) {
        return {
          success: false,
          goal: updated ?? lookup.goal,
          error: String(response.error ?? 'Failed to update Goal objective'),
          code: typeof response.code === 'string' ? response.code : undefined,
          status: 409,
        };
      }
      return { success: true, goal: updated, delivery: 'persisted' };
    },
  };
}

export const goalOrchestrator = createGoalOrchestrator();
