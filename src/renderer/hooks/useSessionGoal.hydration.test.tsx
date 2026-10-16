import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { SessionGoal } from '@/types/sessionGoal';
import { useSessionGoal } from './useSessionGoal';

const fixture = vi.hoisted(() => ({ get: vi.fn(), create: vi.fn() }));
vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => true }));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: vi.fn(async () => ({ unlisten: vi.fn() })) }));
vi.mock('@/api/sessionGoalClient', () => ({ getSessionGoal: fixture.get, createSessionGoal: fixture.create,
  markSessionGoalTerminal: vi.fn(), pauseSessionGoal: vi.fn(), resumeSessionGoal: vi.fn() }));

const goal = { id: 'synthetic-goal', sessionId: 'A', workspacePath: '/synthetic', status: 'paused',
  revision: 1, controlRevision: 1, isExecuting: false } as SessionGoal;
beforeEach(() => { vi.clearAllMocks(); fixture.get.mockResolvedValue(null); });

it('keeps draft restoration closed while a Goal read is pending, then exposes the Goal and readiness together', async () => {
  let finish!: (goal: SessionGoal | null) => void;
  fixture.get.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const frames: Array<{ ready: boolean; goal: SessionGoal | null }> = [];
  const { result } = renderHook(() => {
    const state = useSessionGoal({ sessionId: 'A', workspacePath: '/synthetic' });
    frames.push({ ready: state.restorationReady, goal: state.state.goal });
    return state;
  });
  await waitFor(() => expect(fixture.get).toHaveBeenCalledTimes(1));
  expect(result.current.restorationReady).toBe(false);
  await act(async () => finish(goal));
  expect(result.current.restorationReady).toBe(true);
  expect(result.current.state.goal).toEqual(goal);
  expect(frames.some(frame => frame.ready && !frame.goal)).toBe(false);
  expect(fixture.create).not.toHaveBeenCalled();
});

it('authorizes an empty Goal owner only after the read succeeds', async () => {
  const { result } = renderHook(() => useSessionGoal({ sessionId: 'A', workspacePath: '/synthetic' }));
  expect(result.current.restorationReady).toBe(false);
  await waitFor(() => expect(result.current.restorationReady).toBe(true));
  expect(result.current.state.goal).toBeNull(); expect(fixture.create).not.toHaveBeenCalled();
});

it('does not treat an unavailable Goal as absent', async () => {
  fixture.get.mockRejectedValueOnce(new Error('synthetic unknown state'));
  const { result } = renderHook(() => useSessionGoal({ sessionId: 'A', workspacePath: '/synthetic' }));
  await waitFor(() => expect(fixture.get).toHaveBeenCalledTimes(1));
  await act(async () => {});
  expect(result.current.restorationReady).toBe(false); expect(fixture.create).not.toHaveBeenCalled();
});

it('a late read cannot authorize a different Session or overwrite its Goal state', async () => {
  let finish!: (goal: SessionGoal | null) => void;
  fixture.get.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const { result, rerender } = renderHook(({ sessionId }) => useSessionGoal({ sessionId, workspacePath: '/synthetic' }), { initialProps: { sessionId: 'A' } });
  await waitFor(() => expect(fixture.get).toHaveBeenCalledTimes(1));
  rerender({ sessionId: 'B' });
  await waitFor(() => expect(result.current.restorationReady).toBe(true));
  await act(async () => finish(goal));
  expect(result.current.state.goal).toBeNull(); expect(fixture.create).not.toHaveBeenCalled();
});

it('revisiting A after B has not settled requires a new A read before restoring drafts', async () => {
  let finishB!: (goal: SessionGoal | null) => void;
  let finishA!: (goal: SessionGoal | null) => void;
  fixture.get.mockResolvedValueOnce(null)
    .mockReturnValueOnce(new Promise(resolve => { finishB = resolve; }))
    .mockReturnValueOnce(new Promise(resolve => { finishA = resolve; }));
  const { result, rerender } = renderHook(({ sessionId }) => useSessionGoal({ sessionId, workspacePath: '/synthetic' }), { initialProps: { sessionId: 'A' } });
  await waitFor(() => expect(result.current.restorationReady).toBe(true));
  rerender({ sessionId: 'B' }); await waitFor(() => expect(fixture.get).toHaveBeenCalledTimes(2));
  expect(result.current.restorationReady).toBe(false);
  rerender({ sessionId: 'A' }); await waitFor(() => expect(fixture.get).toHaveBeenCalledTimes(3));
  expect(result.current.restorationReady).toBe(false);
  await act(async () => { finishB({ ...goal, sessionId: 'B' }); });
  expect(result.current.restorationReady).toBe(false); expect(result.current.state.goal).toBeNull();
  await act(async () => finishA(goal));
  expect(result.current.restorationReady).toBe(true); expect(result.current.state.goal).toEqual(goal);
});
