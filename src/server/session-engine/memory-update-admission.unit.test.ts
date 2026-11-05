import { describe, expect, it, vi } from 'vitest';
import { createMemoryUpdateDispatchGuard } from './memory-update-admission';
import { hasRecentSessionActivity } from '../session-core/session-activity-policy';

describe('automatic memory promotion', () => {
  it('defers when a Task finishes after candidate collection or during authority lookup', async () => {
    let lastActiveAt = '2026-11-05T00:00:00Z';
    const now = Date.parse('2026-11-06T00:00:00Z');
    const deferred = vi.fn();
    const authority = Object.assign(async () => {
      lastActiveAt = new Date(now - 19_000).toISOString();
      return { accepted: true };
    }, { cancel: vi.fn() });
    const guard = createMemoryUpdateDispatchGuard(authority, () => hasRecentSessionActivity(lastActiveAt, now), deferred);
    expect(hasRecentSessionActivity(lastActiveAt, now)).toBe(false);
    expect(await guard()).toMatchObject({ accepted: false, code: 'session_busy' });
    expect(deferred).toHaveBeenCalledOnce();
    await guard.cancel?.();
    expect(authority.cancel).toHaveBeenCalledOnce();
  });

  it('retains cancellation and permits a sufficiently idle legacy session', async () => {
    const deferred = vi.fn();
    const rejected = { accepted: false, code: 'task_dispatch_canceled' };
    const authority = vi.fn().mockResolvedValueOnce(rejected).mockResolvedValueOnce({ accepted: true });
    const guard = createMemoryUpdateDispatchGuard(authority, () => hasRecentSessionActivity(undefined), deferred);
    expect(await guard()).toBe(rejected);
    expect(await guard()).toEqual({ accepted: true });
    expect(deferred).not.toHaveBeenCalled();
  });
});
