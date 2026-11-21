// Developer Debug Panel for Cron Tasks
// Shows all active cron tasks with controls to open/stop them

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  TimerIcon,
  StopCircleIcon,
  RefreshIcon,
  ExternalIcon,
  AlertIcon,
} from '@/components/icons';

import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { getAllCronTasks, stopCronTask } from '@/api/cronTaskClient';
import type { CronTask } from '@/types/cronTask';
import { formatCronInterval, getCronStatusText } from '@/types/cronTask';
import { CUSTOM_EVENTS } from '../../../shared/constants';

interface CronTaskDebugPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function CronTaskDebugPanel({ isOpen, onClose }: CronTaskDebugPanelProps) {
  useCloseLayer(() => { if (!isOpen) return false; onClose(); return true; }, 100);
  const [tasks, setTasks] = useState<CronTask[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stoppingTaskId, setStoppingTaskId] = useState<string | null>(null);
  const [pendingStopId, setPendingStopId] = useState<string | null>(null);

  // Track mounted state to prevent setState after unmount
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Load tasks
  const loadTasks = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const allTasks = await getAllCronTasks();
      // Guard against setState after unmount
      if (!isMountedRef.current) return;
      // Filter to show only active tasks (running)
      const activeTasks = allTasks.filter(t => t.status === 'running');
      setTasks(activeTasks);
    } catch (err) {
      if (!isMountedRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load tasks');
    } finally {
      if (isMountedRef.current) setIsLoading(false);
    }
  }, []);

  // Load on open
  useEffect(() => {
    if (isOpen) {
      loadTasks();
    }
  }, [isOpen, loadTasks]);

  // Handle open task - dispatch event to jump to tab
  const handleOpenTask = useCallback((task: CronTask) => {
    // If task has a tabId, try to jump to that tab
    if (task.tabId) {
      window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.JUMP_TO_TAB, {
        detail: { targetTabId: task.tabId, sessionId: task.sessionId }
      }));
      onClose();
    } else {
      // No tab associated - show info
      alert(`该任务没有关联的标签页\n\n工作区: ${task.workspacePath}\nSession: ${task.sessionId}\n\n请手动打开对应的工作区和历史记录`);
    }
  }, [onClose]);

  // Handle stop task - show inline confirmation
  const handleStopClick = useCallback((taskId: string) => {
    setPendingStopId(taskId);
  }, []);

  const handleConfirmStop = useCallback(async () => {
    if (!pendingStopId) return;
    const taskId = pendingStopId;
    setPendingStopId(null);
    setStoppingTaskId(taskId);

    try {
      await stopCronTask(taskId);
      // Guard against setState after unmount
      if (!isMountedRef.current) return;
      // Reload tasks
      await loadTasks();
    } catch (err) {
      if (!isMountedRef.current) return;
      setError(`停止任务失败: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      if (isMountedRef.current) setStoppingTaskId(null);
    }
  }, [pendingStopId, loadTasks]);

  const handleCancelStop = useCallback(() => {
    setPendingStopId(null);
  }, []);

  if (!isOpen) return null;

  return (
    <OverlayBackdrop portal className="z-[100]" onClose={onClose}>
      {/* Panel */}
      <div className="relative z-10 w-full max-w-2xl rounded-xl bg-[var(--paper-elevated)] shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
          <div className="flex items-center gap-2">
            <TimerIcon className="h-5 w-5 text-[var(--accent)]" />
            <h2 className="text-base font-semibold text-[var(--ink)]">循环任务调试面板</h2>
            <span className="rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
              DEV
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={loadTasks}
              disabled={isLoading}
              className="rounded-lg p-1.5 text-[var(--ink-muted)] transition hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
              title="刷新"
            >
              <RefreshIcon className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-[var(--ink-muted)] transition hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="max-h-96 overflow-y-auto p-5">
          {error && (
            <div className="mb-4 flex items-center gap-2 rounded-lg bg-[var(--error-bg)] px-3 py-2 text-sm text-[var(--error)]">
              <AlertIcon className="h-4 w-4" />
              {error}
            </div>
          )}

          {isLoading && tasks.length === 0 ? (
            <div className="py-8 text-center text-sm text-[var(--ink-muted)]">
              加载中...
            </div>
          ) : tasks.length === 0 ? (
            <div className="py-8 text-center text-sm text-[var(--ink-muted)]">
              没有活跃的循环任务
            </div>
          ) : (
            <div className="space-y-3">
              {tasks.map((task) => (
                <div
                  key={task.id}
                  className="rounded-lg border border-[var(--line)] bg-[var(--paper-inset)] p-4"
                >
                  {/* Task header */}
                  <div className="mb-2 flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <code className="text-xs font-medium text-[var(--ink)]">{task.id}</code>
                        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                          task.status === 'running'
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                        }`}>
                          {getCronStatusText(task.status)}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-xs text-[var(--ink-muted)]" title={task.prompt}>
                        {task.prompt}
                      </p>
                    </div>
                    {/* Actions */}
                    <div className="ml-3 flex items-center gap-1">
                      {/* Show confirmation buttons when pending stop */}
                      {pendingStopId === task.id ? (
                        <>
                          <button
                            onClick={handleConfirmStop}
                            disabled={stoppingTaskId === task.id}
                            className="rounded-lg bg-[var(--error)] px-2 py-1 text-xs font-medium text-[var(--on-error)] transition hover:bg-[var(--error)]/80 disabled:opacity-50"
                          >
                            确认停止
                          </button>
                          <button
                            onClick={handleCancelStop}
                            className="rounded-lg bg-[var(--paper-inset)] px-2 py-1 text-xs font-medium text-[var(--ink-muted)] transition hover:bg-[var(--line)]"
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => handleOpenTask(task)}
                            className="rounded-lg p-1.5 text-[var(--ink-muted)] transition hover:bg-[var(--accent)]/10 hover:text-[var(--accent)]"
                            title="打开"
                          >
                            <ExternalIcon className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleStopClick(task.id)}
                            disabled={stoppingTaskId === task.id}
                            className="rounded-lg p-1.5 text-[var(--ink-muted)] transition hover:bg-[var(--error)]/10 hover:text-[var(--error)] disabled:opacity-50"
                            title="停止"
                          >
                            <StopCircleIcon className="h-4 w-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Task details */}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-[var(--ink-muted)]">间隔</span>
                      <span className="text-[var(--ink)]">{formatCronInterval(task.intervalMinutes)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[var(--ink-muted)]">已执行</span>
                      <span className="text-[var(--ink)]">{task.executionCount} 次</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[var(--ink-muted)]">运行模式</span>
                      <span className="text-[var(--ink)]">{task.runMode === 'new_session' ? '无记忆' : '保持上下文'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[var(--ink-muted)]">Tab</span>
                      <span className="font-mono text-[var(--ink)]">{task.tabId || '-'}</span>
                    </div>
                    <div className="col-span-2 flex justify-between">
                      <span className="text-[var(--ink-muted)]">工作区</span>
                      <span className="truncate text-[var(--ink)]" title={task.workspacePath}>
                        {task.workspacePath.split('/').pop() || task.workspacePath}
                      </span>
                    </div>
                    {task.lastExecutedAt && (
                      <div className="col-span-2 flex justify-between">
                        <span className="text-[var(--ink-muted)]">上次执行</span>
                        <span className="text-[var(--ink)]">
                          {new Date(task.lastExecutedAt).toLocaleString('zh-CN')}
                        </span>
                      </div>
                    )}
                    {task.lastError && (
                      <div className="col-span-2 mt-1 rounded bg-[var(--error-bg)] px-2 py-1 text-[var(--error)]">
                        错误: {task.lastError}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-[var(--line)] px-5 py-3">
          <p className="text-xs text-[var(--ink-faint)]">
            此面板仅供开发调试使用，显示所有运行中或暂停的循环任务
          </p>
        </div>
      </div>
    </OverlayBackdrop>
  );
}
