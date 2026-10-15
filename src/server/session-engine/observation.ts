import type { SessionEngineLiveState } from './types';

export type SessionActivityState = 'idle' | 'running' | 'waiting_user_action';

/** Projection of facts owned by the adapter. Failures are query errors; an
 * idle/error runtime terminal is not evidence of successful completion. */
export function projectSessionActivity(state: SessionEngineLiveState): SessionActivityState {
  if (!state.isBusy && !state.backgroundWorkActive && state.sessionState !== 'running' && state.sessionState !== 'starting') return 'idle';
  return state.waitingForUser ? 'waiting_user_action' : 'running';
}

/** Wall time belongs to the active product turn, never to lastActiveAt or
 * Sidecar uptime. Compute at the owner so client clock skew is irrelevant. */
export function projectSessionExecution(state: SessionEngineLiveState, now: number) {
  if (projectSessionActivity(state) === 'idle' || !state.executionStartedAt) return undefined;
  const startedAt = Date.parse(state.executionStartedAt);
  if (!Number.isFinite(startedAt) || startedAt > now) return undefined;
  return { startedAt: state.executionStartedAt, elapsedMs: now - startedAt };
}
