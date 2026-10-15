import { workspacePathsEqual } from '@/../shared/workspacePath';
import { workProgressSchema } from '@/../shared/sessionWorkProgress';
import { getSessionGoal } from '@/api/sessionGoalClient';
import { isTauriEnvironment } from '@/utils/browserMock';
import { apiPostJson } from '@/api/apiFetch';
import type { ActivitySnapshot, SessionActivity } from './projection';

/** Existing Rust owner resolver. Reading never creates a Session or model turn.
 * Call only for a bounded, visible-workspace snapshot or an archive recheck. */
async function readSessionActivity(sessionId: string): Promise<ActivitySnapshot> {
  const response = await apiPostJson<{
    success: boolean;
    session?: { sessionId: string; state: SessionActivity; execution?: ActivitySnapshot['execution']; progress?: unknown };
    error?: string;
    code?: string;
  }>('/api/admin/session/state', { sessionId });
  if (!response.success || response.session?.sessionId !== sessionId
    || !['idle', 'running', 'waiting_user_action'].includes(response.session.state)) {
    throw Object.assign(new Error(response.error || 'Session activity is unavailable'), {
      code: response.code === 'SESSION_EXECUTION_FAILED' ? response.code : undefined,
    });
  }
  const timing = response.session.execution;
  const execution = timing && typeof timing.startedAt === 'string' && Number.isFinite(Date.parse(timing.startedAt))
    && Number.isFinite(timing.elapsedMs) && timing.elapsedMs >= 0 ? timing : undefined;
  const progress = workProgressSchema.safeParse(response.session.progress);
  return { ...(progress.success ? { progress: progress.data } : {}), state: response.session.state, checkedAt: Date.now(), ...(execution ? { execution } : {}) };
}

/** Goal lifecycle is owned by Rust and outlives an individual idle turn. */
export async function readBoardSessionActivity(sessionId: string, workspacePath?: string): Promise<ActivitySnapshot> {
  if (!workspacePath || !isTauriEnvironment()) return readSessionActivity(sessionId);
  const [activity, goal] = await Promise.allSettled([
    readSessionActivity(sessionId), getSessionGoal(sessionId, workspacePath, true),
  ]);
  const snapshot: ActivitySnapshot = activity.status === 'fulfilled' ? activity.value : {
    checkedAt: Date.now(), error: String(activity.reason),
    ...(activity.reason?.code === 'SESSION_EXECUTION_FAILED' ? { errorCode: 'execution_failed' as const } : {}),
  };
  if (goal.status === 'rejected') return { ...snapshot, goal: { checkedAt: Date.now(), error: String(goal.reason) } };
  const value = goal.value;
  if (value && (value.sessionId !== sessionId || !workspacePathsEqual(value.workspacePath, workspacePath))) {
    return { ...snapshot, goal: { checkedAt: Date.now(), error: 'Goal owner mismatch' } };
  }
  return { ...snapshot, goal: { checkedAt: Date.now(), value: value ? {
    status: value.status, isExecuting: value.isExecuting,
  } : null } };
}
