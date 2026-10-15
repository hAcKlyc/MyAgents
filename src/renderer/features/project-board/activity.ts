import { apiPostJson } from '@/api/apiFetch';
import type { ActivitySnapshot, SessionActivity } from './projection';

/** Existing Rust owner resolver. Reading never creates a Session or model turn.
 * Call only for a bounded, visible-workspace snapshot or an archive recheck. */
export async function readBoardSessionActivity(sessionId: string): Promise<ActivitySnapshot> {
  const response = await apiPostJson<{
    success: boolean;
    session?: { sessionId: string; state: SessionActivity; execution?: ActivitySnapshot['execution'] };
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
  return { state: response.session.state, checkedAt: Date.now(), ...(execution ? { execution } : {}) };
}
