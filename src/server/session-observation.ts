import { z } from 'zod';
import { getSessionEngine } from './session-engine';
import { projectSessionActivity, projectSessionExecution } from './session-engine/observation';
import { getSessionMetadata, getSessionData, isHistoryVisibleSession } from './SessionStore';
import { managementApi } from './utils/management-api-client';
import { strictAssistantText } from './session-text-projection';

const activitySchema = z.strictObject({
  sessionId: z.string(),
  state: z.enum(['idle', 'running', 'waiting_user_action']),
  execution: z.strictObject({ startedAt: z.iso.datetime({ offset: true }), elapsedMs: z.number().finite().nonnegative() }).optional(),
});

function sessionExecutionFailed(): Error & { code: string } {
  return Object.assign(new Error('SESSION_EXECUTION_FAILED'), { code: 'SESSION_EXECUTION_FAILED' });
}

export function readLocalSessionActivity(sessionId: string) {
  const engine = getSessionEngine();
  if (engine.getRuntimeIdentity().sessionId !== sessionId) throw new Error('SESSION_OWNER_SCOPE_MISMATCH');
  const live = engine.getLiveSessionState();
  // Root busy policy includes the sticky error state. It cannot establish
  // execution, while exact-Query children can still be independently active.
  if (live.sessionState === 'error' && !live.backgroundWorkActive) throw sessionExecutionFailed();
  return { success: true, session: activitySchema.parse({ sessionId, state: projectSessionActivity(live), execution: projectSessionExecution(live, Date.now()) }) };
}

/** Same Rust owner resolver as text pages. No Sidecar creation or model turn. */
export async function readSessionActivity(sessionId: string) {
  const result = await managementApi('/api/session/text-page', 'POST', {
    sessionId, projection: 'activity',
  }, { timeoutMs: 18_000 });
  if (result.ok !== true) {
    if (result.code === 'SESSION_EXECUTION_FAILED') throw sessionExecutionFailed();
    throw new Error('SESSION_STATE_UNAVAILABLE');
  }
  if (result.active === true) {
    const response = result.result as { success?: boolean; session?: unknown } | undefined;
    if (response?.success !== true) throw new Error('SESSION_STATE_UNAVAILABLE');
    const state = activitySchema.parse(response.session);
    if (state.sessionId !== sessionId) throw new Error('SESSION_OWNER_SCOPE_MISMATCH');
    return state;
  }
  if (result.active !== false) throw new Error('SESSION_STATE_UNAVAILABLE');
  const metadata = getSessionMetadata(sessionId);
  if (!metadata || !isHistoryVisibleSession(metadata)) throw new Error('SESSION_NOT_FOUND');
  return { sessionId, state: 'idle' as const };
}

export type LatestSessionResult = {
  text: string | null;
  source: 'live' | 'history' | 'none' | 'unavailable';
  scope: 'latest-session-result';
  timestamp?: string;
  terminalStatus?: 'complete' | 'stopped' | 'error';
  turnId?: string;
};

/** The target history owner supplements a missing live answer. A failed read
 * is deliberately distinct from a Session that never produced an assistant. */
export async function readLatestSessionResult(sessionId: string, live?: {
  latestResult?: string; terminalStatus?: LatestSessionResult['terminalStatus']; turnId?: string;
}): Promise<LatestSessionResult> {
  const base = { scope: 'latest-session-result' as const,
    ...(live?.terminalStatus ? { terminalStatus: live.terminalStatus } : {}),
    ...(live?.turnId ? { turnId: live.turnId } : {}),
  };
  if (live?.latestResult?.trim() && live.latestResult !== '(no text response)') {
    return { ...base, text: live.latestResult, source: 'live' };
  }
  try {
    const data = await getSessionData(sessionId);
    if (!data || data.transcriptRecovery === 'unavailable') return { ...base, text: null, source: 'unavailable' };
    const message = [...data.messages].reverse().find(item => item.role === 'assistant');
    if (!message) return { ...base, text: null, source: 'none' };
    const text = strictAssistantText(message.content).trim();
    const turnStatus = data.transcriptTurns?.find(turn => turn.id === message.turnId)?.status;
    const terminalStatus = turnStatus === 'complete' || turnStatus === 'stopped' || turnStatus === 'error'
      ? turnStatus : data.transcriptTurns ? undefined : message.terminalStatus;
    return { scope: 'latest-session-result', text: text || null, source: text ? 'history' : 'none', timestamp: message.timestamp,
      ...(message.turnId ? { turnId: message.turnId } : {}),
      ...(terminalStatus ? { terminalStatus } : {}),
    };
  } catch {
    return { ...base, text: null, source: 'unavailable' };
  }
}
