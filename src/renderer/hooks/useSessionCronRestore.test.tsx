import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSessionCronTask, isTaskExecuting } from '@/api/cronTaskClient';
import type { CronTask } from '@/types/cronTask';
import { useSessionCronRestore } from './useSessionCronRestore';

vi.mock('@/api/cronTaskClient', () => ({ getSessionCronTask: vi.fn(), isTaskExecuting: vi.fn() }));
vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => true }));
const task = (sessionId: string) => ({ id: `task-${sessionId}`, sessionId, status: 'running' }) as CronTask;
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((r) => {
      resolve = r;
    }),
    resolve: (value: T) => resolve(value),
  };
}

describe('Session Task hydration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getSessionCronTask).mockResolvedValue(null);
    vi.mocked(isTaskExecuting).mockResolvedValue(false);
  });
  it.each(['task', 'execution'] as const)(
    'discards a late %s read after switching Session',
    async (phase) => {
      const pendingTask = deferred<CronTask | null>();
      const pendingExecution = deferred<boolean>();
      vi.mocked(getSessionCronTask).mockImplementationOnce(() =>
        phase === 'task' ? pendingTask.promise : Promise.resolve(task('A')),
      );
      vi.mocked(isTaskExecuting).mockReturnValueOnce(pendingExecution.promise);
      const onRestore = vi.fn();
      const onClear = vi.fn();
      const { rerender } = renderHook(
        ({ sessionId }) => useSessionCronRestore({ sessionId, tabId: 'tab', task: null, onRestore, onClear }),
        { initialProps: { sessionId: 'A' } },
      );
      await waitFor(() =>
        expect(phase === 'task' ? getSessionCronTask : isTaskExecuting).toHaveBeenCalledTimes(1),
      );
      rerender({ sessionId: 'B' });
      await act(async () => {
        pendingTask.resolve(task('A'));
        pendingExecution.resolve(true);
      });
      expect(onRestore).not.toHaveBeenCalled();
      expect(onClear).not.toHaveBeenCalled();
    },
  );
  it('commits the current task and execution state once both reads complete', async () => {
    vi.mocked(getSessionCronTask).mockResolvedValue(task('A'));
    vi.mocked(isTaskExecuting).mockResolvedValue(true);
    const onRestore = vi.fn();
    const onClear = vi.fn();
    const { rerender } = renderHook(
      ({ currentTask }) =>
        useSessionCronRestore({ sessionId: 'A', tabId: 'tab', task: currentTask, onRestore, onClear }),
      { initialProps: { currentTask: null as CronTask | null } },
    );
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith(task('A'), true));
    rerender({ currentTask: task('A') });
    expect(getSessionCronTask).toHaveBeenCalledTimes(1);
  });
  it('keeps workflow restoration closed until the exact Session hydration succeeds', async () => {
    const pending = deferred<CronTask | null>();
    vi.mocked(getSessionCronTask).mockReturnValueOnce(pending.promise);
    const onRestore = vi.fn(), onClear = vi.fn();
    const { result, rerender } = renderHook(({ sessionId }) => useSessionCronRestore({ sessionId, tabId: 'tab', task: null, onRestore, onClear }), { initialProps: { sessionId: 'A' } });
    expect(result.current).toBe(false);
    rerender({ sessionId: 'B' });
    await waitFor(() => expect(result.current).toBe(true));
    await act(async () => { pending.resolve(task('A')); });
    expect(onRestore).not.toHaveBeenCalled(); expect(result.current).toBe(true);
  });
  it('does not authorize consuming a saved workflow after a failed Task read', async () => {
    vi.mocked(getSessionCronTask).mockRejectedValueOnce(new Error('synthetic read failure'));
    const { result } = renderHook(() => useSessionCronRestore({ sessionId: 'A', tabId: 'tab', task: null, onRestore: vi.fn(), onClear: vi.fn() }));
    await act(async () => {}); expect(result.current).toBe(false);
  });
  it('revisiting A cannot reuse its previous readiness while a new hydration is pending', async () => {
    const secondA = deferred<CronTask | null>(), pendingB = deferred<CronTask | null>();
    vi.mocked(getSessionCronTask).mockResolvedValueOnce(null).mockReturnValueOnce(pendingB.promise).mockReturnValueOnce(secondA.promise);
    const onRestore = vi.fn(), onClear = vi.fn();
    const { result, rerender } = renderHook(({ sessionId }) => useSessionCronRestore({ sessionId, tabId: 'tab', task: null, onRestore, onClear }), { initialProps: { sessionId: 'A' } });
    await waitFor(() => expect(result.current).toBe(true));
    rerender({ sessionId: 'B' }); await waitFor(() => expect(getSessionCronTask).toHaveBeenCalledTimes(2));
    expect(result.current).toBe(false);
    rerender({ sessionId: 'A' }); await waitFor(() => expect(getSessionCronTask).toHaveBeenCalledTimes(3));
    expect(result.current).toBe(false);
    await act(async () => pendingB.resolve(task('B'))); expect(result.current).toBe(false); expect(onRestore).not.toHaveBeenCalled();
    await act(async () => secondA.resolve(null)); expect(result.current).toBe(true);
  });
  it('does not overwrite a task installed while hydration was pending', async () => {
    const pending = deferred<CronTask | null>();
    vi.mocked(getSessionCronTask).mockReturnValueOnce(pending.promise);
    const onRestore = vi.fn();
    const onClear = vi.fn();
    const { rerender } = renderHook(
      ({ currentTask }) =>
        useSessionCronRestore({ sessionId: 'A', tabId: 'tab', task: currentTask, onRestore, onClear }),
      { initialProps: { currentTask: null as CronTask | null } },
    );
    rerender({ currentTask: task('A') });
    await act(async () => {
      pending.resolve(task('A'));
    });
    expect(onRestore).not.toHaveBeenCalled();
  });
});
