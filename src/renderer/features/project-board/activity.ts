import { apiPostJson } from '@/api/apiFetch';
import type { ActivitySnapshot, SessionActivity } from './projection';

/** Existing Rust owner resolver. Reading never creates a Session or model turn.
 * Call only for a bounded, user-visible workspace snapshot (not a poller). */
export async function readBoardSessionActivity(sessionId: string): Promise<ActivitySnapshot> {
  const response = await apiPostJson<{
    success: boolean;
    session?: { sessionId: string; state: SessionActivity };
    error?: string;
  }>('/api/admin/session/state', { sessionId });
  if (!response.success || response.session?.sessionId !== sessionId
    || !['idle', 'running', 'waiting_user_action'].includes(response.session.state)) {
    throw new Error(response.error || 'Session activity is unavailable');
  }
  return { state: response.session.state, checkedAt: Date.now() };
}
