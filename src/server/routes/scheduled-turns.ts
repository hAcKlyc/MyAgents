import type { SessionEngine } from '../session-engine';
import type { SessionGoal } from '../session-engine/goal-orchestrator';
import { goalOrchestrator } from '../session-engine/goal-orchestrator';
import {
  taskTurnOrchestrator,
  type TaskExecutePayload,
} from '../session-engine/task-turn-orchestrator';

export type GoalExecutePayload = {
  goalId: string;
  objective: string;
  sessionId: string;
  turnNumber: number;
  aiCanExit: boolean;
  permissionMode: string;
  queueId: string;
  expectedControlRevision: number;
};

function validStrictRfc3339Offset(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, , offsetHourRaw, offsetMinuteRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const offsetHour = offsetHourRaw === undefined ? 0 : Number(offsetHourRaw);
  const offsetMinute = offsetMinuteRaw === undefined ? 0 : Number(offsetMinuteRaw);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maxDay = daysInMonth[month - 1] ?? 0;
  return month >= 1
    && month <= 12
    && day >= 1
    && day <= maxDay
    && hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 23
    && offsetMinute <= 59;
}

function validTaskActivationPayload(value: TaskExecutePayload['activationEvent']): boolean {
  if (value === undefined) return true;
  const record = (candidate: unknown): candidate is Record<string, unknown> => (
    typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
  );
  const exactKeys = (candidate: Record<string, unknown>, allowed: readonly string[]) => (
    Object.keys(candidate).every((key) => allowed.includes(key))
      && allowed.every((key) => Object.hasOwn(candidate, key))
  );
  const unicodeLength = (candidate: string) => [...candidate].length;
  if (!record(value)
    || !exactKeys(value, ['event', 'handoff', 'reason', 'detectedAt'])
    || !Number.isSafeInteger(value.detectedAt)
    || (value.detectedAt as number) < 0
    || !record(value.event)
    || !exactKeys(value.event, ['id', 'kind', 'occurredAt'])
    || typeof value.event.id !== 'string'
    || unicodeLength(value.event.id) < 1
    || unicodeLength(value.event.id) > 256
    || /[\p{Cc}\p{Cf}]/u.test(value.event.id)
    || typeof value.event.kind !== 'string'
    || !/^[a-zA-Z0-9._-]{1,128}$/.test(value.event.kind)
    || typeof value.event.occurredAt !== 'string'
    || !validStrictRfc3339Offset(value.event.occurredAt)
    || !record(value.reason)
    || !exactKeys(value.reason, ['code', 'message'])
    || typeof value.reason.code !== 'string'
    || !/^[a-z0-9._-]{1,64}$/.test(value.reason.code)
    || typeof value.reason.message !== 'string'
    || unicodeLength(value.reason.message) < 1
    || unicodeLength(value.reason.message) > 2_000
    || !record(value.handoff)) {
    return false;
  }
  const handoffKeys = Object.keys(value.handoff);
  if (!handoffKeys.every((key) => ['summary', 'text', 'data'].includes(key))
    || !Object.hasOwn(value.handoff, 'summary')
    || typeof value.handoff.summary !== 'string'
    || unicodeLength(value.handoff.summary) < 1
    || unicodeLength(value.handoff.summary) > 2_000
    || (value.handoff.text !== undefined && typeof value.handoff.text !== 'string')
    || (typeof value.handoff.text === 'string'
      && new TextEncoder().encode(value.handoff.text).byteLength > 32 * 1024)
    || (value.handoff.data !== undefined && !record(value.handoff.data))) {
    return false;
  }
  try {
    return new TextEncoder().encode(JSON.stringify(value.handoff)).byteLength <= 128 * 1024;
  } catch {
    return false;
  }
}

type ScheduledTurnRouteDependencies = {
  getEngine(): SessionEngine;
  getWorkspacePath(): string;
  taskOrchestrator?: Pick<typeof taskTurnOrchestrator, 'runScheduledTurn'>;
  goalOrchestrator?: Pick<typeof goalOrchestrator, 'runScheduledTurn'>;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleGoalExecuteSyncRoute(
  request: Request,
  dependencies: ScheduledTurnRouteDependencies,
): Promise<Response> {
  let payload: GoalExecutePayload;
  try {
    payload = (await request.json()) as GoalExecutePayload;
  } catch (error) {
    console.error('[goal] execute-sync: JSON parse error', error);
    return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
  }
  if (!payload.goalId?.trim()
    || !payload.objective?.trim()
    || !payload.sessionId?.trim()
    || !payload.queueId?.trim()
    || !Number.isInteger(payload.turnNumber)
    || payload.turnNumber < 1
    || !Number.isInteger(payload.expectedControlRevision)
    || payload.expectedControlRevision < 1) {
    return jsonResponse({ success: false, error: 'Invalid Goal execution payload.' }, 400);
  }

  const engine = dependencies.getEngine();
  const workspacePath = dependencies.getWorkspacePath();
  const goal: SessionGoal = {
    id: payload.goalId,
    objective: payload.objective,
    status: 'active',
    turnCount: payload.turnNumber - 1,
    revision: 0,
    controlRevision: payload.expectedControlRevision,
    sessionId: payload.sessionId,
    workspacePath,
    endConditions: { aiCanExit: payload.aiCanExit },
  };
  let result: Awaited<ReturnType<typeof goalOrchestrator.runScheduledTurn>>;
  try {
    result = await (dependencies.goalOrchestrator ?? goalOrchestrator).runScheduledTurn(engine, {
      goal,
      queueId: payload.queueId,
      expectedControlRevision: payload.expectedControlRevision,
      turnNumber: payload.turnNumber,
      permissionMode: payload.permissionMode,
    });
  } catch (error) {
    const activeSessionId = engine.getCurrentSessionContext().sessionId ?? undefined;
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      ...(activeSessionId ? { sessionId: activeSessionId } : {}),
    }, 500);
  }
  const activeSessionId = result.sessionId ?? engine.getCurrentSessionContext().sessionId ?? undefined;
  if (!result.success) {
    if (result.terminationUnconfirmed) {
      return jsonResponse({
        success: false,
        error: result.error ?? 'Goal execution termination was not confirmed',
        terminationUnconfirmed: true,
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
      }, result.status ?? 503);
    }
    return jsonResponse({
      success: false,
      error: result.error ?? (result.code === 'goal_work_pending' ? 'Session work is still running' : 'Goal execution failed'),
      ...(result.code ? { code: result.code } : {}),
      ...(activeSessionId ? { sessionId: activeSessionId } : {}),
    }, result.status ?? 503);
  }
  return jsonResponse({
    success: true,
    aiRequestedExit: false,
    outputText: result.text || undefined,
    sessionId: activeSessionId,
    goalChannelDeliveryExpected: result.channelDeliveryExpected === true,
  });
}

export async function handleTaskExecuteSyncRoute(
  request: Request,
  dependencies: ScheduledTurnRouteDependencies,
): Promise<Response> {
  let payload: TaskExecutePayload;
  try {
    payload = (await request.json()) as TaskExecutePayload;
  } catch (error) {
    console.error('[cron] execute-sync: JSON parse error', error);
    return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
  }
  if (!payload.taskId
    || !payload.queueId
    || !payload.prompt
    || !payload.sessionId
    || !validTaskActivationPayload(payload.activationEvent)) {
    return jsonResponse({
      success: false,
      error: 'Task id, queue id, session id, prompt, and Activation Event must be valid.',
    }, 400);
  }

  let result: Awaited<ReturnType<typeof taskTurnOrchestrator.runScheduledTurn>>;
  try {
    result = await (dependencies.taskOrchestrator ?? taskTurnOrchestrator).runScheduledTurn(
      dependencies.getEngine(),
      payload,
      dependencies.getWorkspacePath(),
    );
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
  if (!result.success) {
    return jsonResponse({
      success: false,
      turnDispatched: result.turnDispatched ?? false,
      error: result.error ?? 'Execution failed',
      ...(result.code ? { code: result.code } : {}),
      ...(result.terminationUnconfirmed ? { terminationUnconfirmed: true } : {}),
    }, result.status ?? 500);
  }
  return jsonResponse({
    success: true,
    turnDispatched: result.turnDispatched ?? true,
    aiRequestedExit: result.aiRequestedExit ?? false,
    exitReason: result.exitReason,
    outputText: result.outputText,
    sessionId: result.sessionId,
  });
}
