import type { DispatchGuard } from '../session-core/turn-queue';

/** Recheck live activity after authority lookup and immediately before promotion. */
export function createMemoryUpdateDispatchGuard(
  authority: DispatchGuard,
  hasRecentActivity: () => boolean,
  onDeferred: () => void,
): DispatchGuard {
  const guard: DispatchGuard = async () => {
    const authorized = await authority();
    if (!authorized.accepted) return authorized;
    if (hasRecentActivity()) {
      onDeferred();
      return { accepted: false, code: 'session_busy', error: 'Session recently active' };
    }
    return authorized;
  };
  guard.cancel = () => authority.cancel?.();
  return guard;
}
