import { apiPostJson } from '@/api/apiFetch';
import type { ActivitySnapshot, SessionActivity } from './projection';

/** Existing Rust owner resolver. Reading never creates a Session or model turn.
 * Call only for a bounded, user-visible workspace snapshot (not a poller). */
export async function readBoardSessionActivity(sessionId: string): Promise<ActivitySnapshot> {
  const response = await apiPostJson<{
    success: boolean;
    session?: { sessionId: string; state: SessionActivity; execution?: ActivitySnapshot['execution'] };
    error?: string;
  }>('/api/admin/session/state', { sessionId });
  if (!response.success || response.session?.sessionId !== sessionId
    || !['idle', 'running', 'waiting_user_action'].includes(response.session.state)) {
    throw new Error(response.error || 'Session activity is unavailable');
  }
  const timing = response.session.execution;
  const execution = timing && typeof timing.startedAt === 'string' && Number.isFinite(Date.parse(timing.startedAt))
    && Number.isFinite(timing.elapsedMs) && timing.elapsedMs >= 0 ? timing : undefined;
  return { state: response.session.state, checkedAt: Date.now(), ...(execution ? { execution } : {}) };
}
