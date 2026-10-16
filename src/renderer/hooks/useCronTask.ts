// Hook for managing cron task state within a Tab
import { useState, useCallback, useRef, useEffect } from 'react';
import type { CronTask, CronTaskConfig, CronTaskDraftConfig, ScheduledTaskKind } from '@/types/cronTask';
import {
  createAndStartCronTask,
  stopCronTask,
  getCronTask,
} from '@/api/cronTaskClient';
import { track } from '@/analytics';
import { isTauriEnvironment } from '@/utils/browserMock';
import { isDebugMode } from '@/utils/debug';
import { createSyncStateRef } from '@/utils/syncStateRef';
import { listenWithCleanup } from '@/utils/tauriListen';
import { coerceRuntimeBirthPermissionMode } from '@/../shared/runtimeBirthFields';
import { isPendingSessionId } from '@/../shared/constants';

export interface CronTaskState {
  /** Whether cron mode is enabled (before task is created) */
  isEnabled: boolean;
  /** Cron task configuration (set before task creation) */
  config: CronTaskDraftConfig | null;
  /** Active cron task (after creation) */
  task: CronTask | null;
  /** Whether task is currently being created/started */
  isStarting: boolean;
  /** Whether the current task is inside one scheduler execution turn */
  isExecuting: boolean;
  /** 1-based scheduler execution number for the active turn */
  executionNumber?: number;
  /** Error message if any */
  error: string | null;
}

export interface CronTaskStopResult {
  task: CronTask;
  prompt: string | null;
}

const initialState: CronTaskState = {
  isEnabled: false,
  config: null,
  task: null,
  isStarting: false,
  isExecuting: false,
  executionNumber: undefined,
  error: null,
};

function stateWithTaskSnapshot(
  prev: CronTaskState,
  task: CronTask,
  patch: Partial<CronTaskState> = {},
): CronTaskState {
  return { ...prev, ...patch, task };
}

export interface UseCronTaskOptions {
  workspacePath: string;
  sessionId: string;
  /** Resolve the owning Tab to a durable Session before single-session Task creation. */
  materializeOwner: () => Promise<{ sessionId: string; workspacePath: string }>;
  /** Callback when task completes (stops) */
  onComplete?: (task: CronTask, reason?: string) => void;
  /** Callback when a single execution completes (task may continue running) */
  onExecutionComplete?: (task: CronTask, success: boolean) => void;
}

export function useCronTask(options: UseCronTaskOptions) {
  const { workspacePath, sessionId } = options;

  const [state, setStateRaw] = useState<CronTaskState>(initialState);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // `stateRef` is the canonical "latest" snapshot, synchronously written by
  // `setState` BEFORE the React update is scheduled. This is the single
  // mechanism preventing the `enableCronMode → startTask same-tick race`
  // bug — see `createSyncStateRef` for the rationale and unit tests.
  //
  // Rule for this file: NEVER call `setStateRaw` directly. Always
  // `setState(...)`. The wrapper guarantees ref/state stay coupled. Both
  // `stateRef` and `setState` come from a `useRef`-stashed instance, so
  // both are referentially stable across renders — safe to omit from
  // useCallback dep arrays (and consistently included where listed for
  // ESLint's exhaustive-deps satisfaction).
  const stateRef = useRef(createSyncStateRef(state, setStateRaw)).current;
  const setState = stateRef.set;

  // Track component mount state to prevent setState after unmount
  const mountedRef = useRef(true);
  const pendingStartRef = useRef<{ canceled: boolean } | null>(null);

  // Refs for Tauri event handlers to avoid recreating listeners on handler changes
  // These refs are updated when handlers change, but the listeners always call through refs
  const handleSchedulerStartedRef = useRef<((payload: { taskId: string; intervalMinutes: number; executionCount: number }) => void) | null>(null);
  const handleExecutionStartingRef = useRef<((payload: { taskId: string; executionNumber: number }) => void) | null>(null);
  const handleDebugEventRef = useRef<((payload: { taskId: string; message: string; error?: boolean }) => void) | null>(null);
  const handleExecutionCompleteRef = useRef<((payload: { taskId: string; success: boolean; executionCount: number }) => Promise<void>) | null>(null);
  const handleExecutionErrorRef = useRef<((payload: { taskId: string; error: string }) => void) | null>(null);
  const handleTaskStoppedRef = useRef<((payload: { taskId: string; exitReason?: string | null }) => Promise<void>) | null>(null);

  // Enable cron mode with initial config
  // Capture new-Session initialization policy when scheduling is enabled.
  const enableCronMode = useCallback((config: Omit<CronTaskConfig, 'workspacePath' | 'sessionId'> & {
    taskKind: ScheduledTaskKind;
    executionTarget?: 'current_session' | 'new_task';
  }) => {
    const permissionMode = coerceRuntimeBirthPermissionMode(
      config.permissionMode,
      config.runtime ?? 'builtin',
    );
    setState({
      isEnabled: true,
      config: {
        taskKind: config.taskKind,
        prompt: config.prompt,
        intervalMinutes: config.intervalMinutes,
        endConditions: config.endConditions,
        runMode: config.runMode,
        notifyEnabled: config.notifyEnabled,
        model: config.model,
        permissionMode,
        providerId: config.providerId,
        runtime: config.runtime,
        runtimeConfig: config.runtimeConfig,
        schedule: config.schedule,
        executionTarget: config.executionTarget,
        delivery: config.delivery,
        mcpEnabledServers: config.mcpEnabledServers,
      },
      task: null,
      isStarting: false,
      isExecuting: false,
      executionNumber: undefined,
      error: null,
    });
  }, [setState]);

  // Disable cron mode (cancel before starting)
  const disableCronMode = useCallback(() => {
    if (pendingStartRef.current) pendingStartRef.current.canceled = true;
    setState(initialState);
  }, [setState]);

  // Update config while in cron mode (before task starts)
  const updateConfig = useCallback((config: Partial<CronTaskState['config']>) => {
    setState(prev => ({
      ...prev,
      config: prev.config ? { ...prev.config, ...config } : null,
    }));
  }, [setState]);

  // Update config for a running task (preserves task state)
  // Note: Some config changes (like intervalMinutes) won't affect the currently running scheduler
  // They will take effect on the next task start. Only notifyEnabled takes effect immediately.
  const updateRunningConfig = useCallback((config: Partial<CronTaskState['config']>) => {
    setState(prev => {
      if (!prev.task) return prev; // No running task, do nothing
      return {
        ...prev,
        config: prev.config ? { ...prev.config, ...config } : null,
      };
    });
  }, [setState]);

  const setExecutionState = useCallback((taskId: string, isExecuting: boolean, executionNumber?: number) => {
    if (stateRef.current.task?.id !== taskId) return;
    setState(prev => (
      prev.task?.id === taskId
        ? {
            ...prev,
            isExecuting,
            executionNumber: isExecuting ? executionNumber : undefined,
          }
        : prev
    ));
  }, [setState, stateRef]);

  // Create and start the cron task
  // Optional prompt parameter allows caller to pass the prompt directly,
  // avoiding React state update timing issues (stale closure problem).
  //
  // Throws on:
  //  - missing config (caller didn't enableCronMode first)
  //  - missing prompt
  //  - re-entry (a previous startTask is still in flight)
  // The thrown error propagates to the caller so the UI layer (e.g.
  // `Chat.tsx` autoSend's catch path) can restore the launcher draft
  // instead of silently consuming the user's input. (Codex review
  // Medium #1: previously this returned silently, leaving Chat.tsx to
  // mark `initialMessage` consumed even though no task was created.)
  const startTask = useCallback(async (promptOverride?: string) => {
    // Reads from `stateRef.current` (synchronously written by `setState`
    // above) — safe even if the caller invoked enableCronMode in the same
    // tick, because every mutation goes through the wrapper.
    const currentConfig = stateRef.current.config;
    if (!currentConfig) {
      throw new Error(
        '[useCronTask] startTask called with no config — caller must enableCronMode first'
      );
    }

    // Re-entry guard (Codex review adversarial): without this, two rapid
    // sends would each create and start duplicate scheduled Tasks, producing
    // duplicate Rust-side tasks running the same prompt. Throwing forces
    // the caller (typically the send-button handler) to await the first
    // start before issuing a second.
    if (stateRef.current.isStarting) {
      throw new Error('[useCronTask] startTask is already in flight');
    }

    // Use promptOverride if provided, otherwise fall back to config.prompt
    // This fixes the timing issue where updateConfig() hasn't updated the ref yet
    const effectivePrompt = promptOverride ?? currentConfig.prompt;

    if (!effectivePrompt) {
      setState(prev => ({
        ...prev,
        error: 'Prompt is required to start the task',
      }));
      throw new Error('[useCronTask] Cannot start task: prompt is empty');
    }

    if (currentConfig.taskKind !== 'cron') {
      throw new Error('[useCronTask] Goal drafts must be started through useSessionGoal');
    }

    const attempt = { canceled: false };
    pendingStartRef.current = attempt;
    setState(prev => ({ ...prev, isStarting: true, error: null }));

    try {
      const owner = currentConfig.runMode === 'single_session'
        ? await optionsRef.current.materializeOwner()
        : { sessionId, workspacePath };

      // Closing the Tab or canceling Cron mode while pending materialization
      // wins before any durable Task row is created.
      if (!mountedRef.current || attempt.canceled) return;
      if (
        currentConfig.runMode === 'single_session'
        && (!owner.sessionId.trim() || isPendingSessionId(owner.sessionId))
      ) {
        throw new Error(
          '[useCronTask] single-session task requires a materialized session identity'
        );
      }

      const permissionMode = coerceRuntimeBirthPermissionMode(
        currentConfig.permissionMode,
        currentConfig.runtime ?? 'builtin',
      );
      const taskConfig: CronTaskConfig = {
        workspacePath: owner.workspacePath,
        sessionId: owner.sessionId,
        prompt: effectivePrompt,
        intervalMinutes: currentConfig.intervalMinutes,
        endConditions: currentConfig.endConditions,
        runMode: currentConfig.runMode,
        notifyEnabled: currentConfig.notifyEnabled,
        model: currentConfig.model,
        permissionMode,
        providerId: currentConfig.providerId,
        runtime: currentConfig.runtime,
        runtimeConfig: currentConfig.runtimeConfig,
        schedule: currentConfig.schedule,
        delivery: currentConfig.delivery,
        // This initializes MCP only when the Task creates a Session. A
        // pre-existing Session keeps its own MCP authority.
        mcpEnabledServers: currentConfig.mcpEnabledServers,
      };

      const result = await createAndStartCronTask(taskConfig);
      if (attempt.canceled) {
        // Explicit user cancellation stops the accepted operation; it does not
        // erase the Task or reinterpret a startup error as an uncommitted row.
        await stopCronTask(result.task.id);
        return;
      }
      if (!mountedRef.current || pendingStartRef.current !== attempt) return;
      const startedTask = result.task;
      setState(prev => stateWithTaskSnapshot(prev, startedTask, { isStarting: false }));
      if (result.error) throw new Error(result.error);

      // Log state after update for debugging
      if (isDebugMode()) {
        console.log('[useCronTask] Task created:', startedTask.id);
      }

      console.log('[useCronTask] Task scheduler started successfully:', startedTask.id);
    } catch (error) {
      console.error('[useCronTask] Failed to start task:', error);
      // Reset only if state still reflects this in-flight start. If
      // disableCronMode already reset to initialState during the await,
      // don't overwrite that reset with our error.
      if (pendingStartRef.current === attempt && !attempt.canceled && stateRef.current.isStarting) {
        setState(prev => ({
          ...prev,
          isStarting: false,
          error: error instanceof Error ? error.message : 'Failed to start task',
        }));
      }
      // Re-throw so the caller's catch path runs (Codex review Medium #1).
      throw error;
    } finally {
      if (pendingStartRef.current === attempt) pendingStartRef.current = null;
    }
  }, [workspacePath, sessionId, setState, stateRef]);

  // A late read belongs to the captured Task and Session, not whichever UI is current.
  const ownsTaskSnapshot = useCallback((task: CronTask, ownerSessionId: string) => (
    mountedRef.current
    && optionsRef.current.sessionId === ownerSessionId
    // Match Rust get_active_task_for_session: IM history can use the internal ID.
    && (task.sessionId === ownerSessionId || task.internalSessionId === ownerSessionId)
    && stateRef.current.task?.id === task.id
  ), [stateRef]);

  // Helper to calculate task duration in minutes
  const getTaskDurationMinutes = (task: CronTask): number => {
    if (!task.createdAt) return 0;
    const createdAt = new Date(task.createdAt).getTime();
    const now = Date.now();
    return Math.round((now - createdAt) / (1000 * 60));
  };

  // Helper to map exit reason to tracking reason
  const mapExitReason = (exitReason?: string): string => {
    if (!exitReason) return 'manual';
    if (exitReason.includes('time') || exitReason.includes('duration')) return 'time_limit';
    if (exitReason.includes('count') || exitReason.includes('execution')) return 'count_limit';
    if (exitReason.includes('AI') || exitReason.includes('exit_cron_task')) return 'ai_exit';
    if (exitReason.includes('error')) return 'error';
    return 'manual';
  };

  // Stop the task
  // Returns the original prompt so it can be restored to the input field
  const stop = useCallback(async (): Promise<CronTaskStopResult | null> => {
    const currentTask = stateRef.current.task;
    const ownerSessionId = optionsRef.current.sessionId;
    const currentConfig = stateRef.current.config;
    if (!currentTask) return null;

    // Get the original prompt before resetting state
    const originalPrompt = currentTask.prompt || currentConfig?.prompt || null;

    try {
      const stoppedTask = await stopCronTask(currentTask.id);
      // Track cron_stop event (manual stop)
      track('cron_stop', {
        reason: 'manual',
        execution_count: stoppedTask.executionCount ?? currentTask.executionCount ?? 0,
        duration_minutes: getTaskDurationMinutes(currentTask),
      });
      // An earlier terminal event may already have cleared this projection.
      // Preserve the successful receipt; only its UI mutation needs ownership.
      if (ownsTaskSnapshot(currentTask, ownerSessionId)) setState(initialState);
      console.log('[useCronTask] Task stopped:', stoppedTask.id);
      return {
        task: stoppedTask,
        prompt: originalPrompt,
      };
    } catch (error) {
      console.error('[useCronTask] Failed to stop task:', error);
      return null;
    }
  }, [setState, stateRef, ownsTaskSnapshot]);

  // Refresh task state from server
  const refresh = useCallback(async () => {
    const currentTask = stateRef.current.task;
    const ownerSessionId = optionsRef.current.sessionId;
    if (!currentTask) return;

    try {
      const task = await getCronTask(currentTask.id);
      if (!ownsTaskSnapshot(currentTask, ownerSessionId)) return;
      setState(prev => stateWithTaskSnapshot(prev, task));

      // Check if task is stopped (end conditions met or AI exit)
      if (task.status === 'stopped' && task.exitReason) {
        if (optionsRef.current.onComplete) {
          optionsRef.current.onComplete(task, task.exitReason ?? undefined);
        }
        setState(initialState);
      }
    } catch (error) {
      console.error('[useCronTask] Failed to refresh task:', error);
    }
  }, [setState, stateRef, ownsTaskSnapshot]);

  // Handle Rust scheduler execution complete event
  // This is emitted after Rust directly executes via Sidecar (not via frontend)
  const handleExecutionComplete = useCallback(async (payload: { taskId: string; success: boolean; executionCount: number }) => {
    const currentTask = stateRef.current.task;
    const ownerSessionId = optionsRef.current.sessionId;

    // Debug logging (only in debug mode to avoid production noise)
    if (isDebugMode()) {
      console.log('[useCronTask] cron:execution-complete received:', payload.taskId, 'eventCount:', payload.executionCount);
      console.log('[useCronTask] handleExecutionComplete state:', {
        hasCurrentTask: !!currentTask,
        currentTaskId: currentTask?.id,
        payloadTaskId: payload.taskId,
      });
    }

    // If task ID doesn't match, this event is for a different Tab - ignore it
    // cron:execution-complete is a global event, all Tabs receive it
    if (currentTask && currentTask.id !== payload.taskId) {
      return;
    }

    // If no current task, ignore the event
    // We don't do fallback refresh because:
    // 1. The event's taskId might belong to a different Tab
    // 2. Without currentTask, we can't verify ownership
    // 3. The Tab that owns this task will handle the event
    if (!currentTask) {
      return;
    }


    // Refresh task state from server to get updated lastExecutedAt and executionCount
    try {
      const task = await getCronTask(currentTask.id);
      // Check if component is still mounted before updating state
      if (!ownsTaskSnapshot(currentTask, ownerSessionId)) return;
      setState(prev => stateWithTaskSnapshot(prev, task, {
        isExecuting: false,
        executionNumber: undefined,
      }));

      // Notify caller that execution completed (for UI refresh, loading state reset, etc.)
      // Pass success flag so caller can decide whether to refresh (e.g., skip on timeout)
      if (optionsRef.current.onExecutionComplete) {
        optionsRef.current.onExecutionComplete(task, payload.success);
      }

      // Check if task stopped (end conditions met or AI exit)
      if (task.status === 'stopped') {
        // Track cron_stop event (end conditions met via Rust execution)
        track('cron_stop', {
          reason: mapExitReason(task.exitReason),
          execution_count: task.executionCount ?? 0,
          duration_minutes: getTaskDurationMinutes(task),
        });
        if (optionsRef.current.onComplete) {
          optionsRef.current.onComplete(task, task.exitReason ?? undefined);
        }
        setState(initialState);
      }
    } catch (error) {
      console.error('[useCronTask] Failed to refresh task after execution:', error);
      if (!ownsTaskSnapshot(currentTask, ownerSessionId)) return;
      setState(prev => (
        prev.task?.id === payload.taskId
          ? { ...prev, isExecuting: false, executionNumber: undefined }
          : prev
      ));
    }
  }, [setState, stateRef, ownsTaskSnapshot]);

  // Handle Rust scheduler execution error event
  const handleExecutionError = useCallback((payload: { taskId: string; error: string }) => {
    const currentTask = stateRef.current.task;
    const ownerSessionId = optionsRef.current.sessionId;
    if (!currentTask || currentTask.id !== payload.taskId) return;

    console.error('[useCronTask] Execution error from Rust scheduler:', payload);
    // Task will continue to next interval, just log the error
    // Optionally refresh to get updated lastError
    getCronTask(currentTask.id).then(task => {
      if (!ownsTaskSnapshot(currentTask, ownerSessionId)) return;
      setState(prev => stateWithTaskSnapshot(prev, task, {
        isExecuting: false,
        executionNumber: undefined,
      }));
    }).catch(() => {
      if (!ownsTaskSnapshot(currentTask, ownerSessionId)) return;
      setState(prev => (
        prev.task?.id === payload.taskId
          ? { ...prev, isExecuting: false, executionNumber: undefined }
          : prev
      ));
      // Ignore refresh errors
    });
  }, [setState, stateRef, ownsTaskSnapshot]);

  const handleTaskStopped = useCallback(async (payload: { taskId: string; exitReason?: string | null }) => {
    const currentTask = stateRef.current.task;
    const ownerSessionId = optionsRef.current.sessionId;
    if (!currentTask || currentTask.id !== payload.taskId) return;

    try {
      const task = await getCronTask(currentTask.id);
      if (!ownsTaskSnapshot(currentTask, ownerSessionId)) return;
      if (optionsRef.current.onComplete) {
        optionsRef.current.onComplete(task, payload.exitReason ?? task.exitReason ?? undefined);
      }
      setState(initialState);
    } catch (error) {
      console.error('[useCronTask] Failed to refresh stopped task:', error);
      if (!ownsTaskSnapshot(currentTask, ownerSessionId)) return;
      setState(prev => (
        prev.task?.id === payload.taskId
          ? { ...prev, isExecuting: false, executionNumber: undefined }
          : prev
      ));
    }
  }, [setState, stateRef, ownsTaskSnapshot]);

  // Handle scheduler started event (for debugging visibility)
  const handleSchedulerStarted = useCallback((payload: { taskId: string; intervalMinutes: number; executionCount: number }) => {
    const currentTask = stateRef.current.task;
    if (!currentTask || currentTask.id !== payload.taskId) return;
    console.log('[useCronTask] Scheduler started:', payload);
  }, [stateRef]);

  // Handle execution starting event (for debugging visibility)
  const handleExecutionStarting = useCallback((payload: { taskId: string; executionNumber: number }) => {
    const currentTask = stateRef.current.task;
    if (!currentTask || currentTask.id !== payload.taskId) return;
    console.log('[useCronTask] Execution starting:', payload);
    setState(prev => ({
      ...prev,
      isExecuting: true,
      executionNumber: payload.executionNumber,
    }));
  }, [setState, stateRef]);

  // Handle debug events from Rust (for debugging visibility)
  const handleDebugEvent = useCallback((payload: { taskId: string; message: string; error?: boolean }) => {
    const currentTask = stateRef.current.task;
    if (!currentTask || currentTask.id !== payload.taskId) return;
    if (payload.error) {
      console.error('[useCronTask] Debug:', payload.message);
    } else {
      console.log('[useCronTask] Debug:', payload.message);
    }
  }, [stateRef]);

  // Update refs with latest handler functions
  // This ensures listeners always call the latest handlers without needing to re-subscribe
  handleSchedulerStartedRef.current = handleSchedulerStarted;
  handleExecutionStartingRef.current = handleExecutionStarting;
  handleDebugEventRef.current = handleDebugEvent;
  handleExecutionCompleteRef.current = handleExecutionComplete;
  handleExecutionErrorRef.current = handleExecutionError;
  handleTaskStoppedRef.current = handleTaskStopped;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Listen for presentation events emitted by the Task scheduler through the
  // legacy cron UI adapter.
  // Note: We use refs for handlers so this effect only runs once (on mount) and doesn't need
  // to re-subscribe when tab state changes
  useEffect(() => {
    if (!isTauriEnvironment()) return;
    const ac = new AbortController();

    Promise.all([
      // Scheduler started event (for debugging)
      listenWithCleanup<{ taskId: string; intervalMinutes: number; executionCount: number }>(
        'cron:scheduler-started',
        (event) => { handleSchedulerStartedRef.current?.(event.payload); },
        ac.signal,
      ),
      // Execution starting event (for debugging)
      listenWithCleanup<{ taskId: string; executionNumber: number }>(
        'cron:execution-starting',
        (event) => { handleExecutionStartingRef.current?.(event.payload); },
        ac.signal,
      ),
      // Debug events from Rust
      listenWithCleanup<{ taskId: string; message: string; error?: boolean }>(
        'cron:debug',
        (event) => { handleDebugEventRef.current?.(event.payload); },
        ac.signal,
      ),
      // New: Rust executed directly, notify frontend to update UI
      listenWithCleanup<{ taskId: string; success: boolean; executionCount: number }>(
        'cron:execution-complete',
        (event) => {
          if (handleExecutionCompleteRef.current) {
            handleExecutionCompleteRef.current(event.payload);
          } else if (isDebugMode()) {
            console.warn('[useCronTask] cron:execution-complete handler not ready');
          }
        },
        ac.signal,
      ),
      listenWithCleanup<{ taskId: string; error: string }>(
        'cron:execution-error',
        (event) => { handleExecutionErrorRef.current?.(event.payload); },
        ac.signal,
      ),
      listenWithCleanup<{ taskId: string; exitReason?: string | null }>(
        'cron:task-stopped',
        (event) => { void handleTaskStoppedRef.current?.(event.payload); },
        ac.signal,
      ),
    ]).then(() => {
      if (ac.signal.aborted) return;
      if (isDebugMode()) {
        console.log('[useCronTask] Tauri event listeners ready');
      }
    });

    return () => {
      ac.abort();
    };
  }, []);

  // Restore state from an existing cron task (for app restart recovery)
  const restoreFromTask = useCallback((task: CronTask) => {
    // Legacy Ralph Loop records are historical only. Goal state now lives in
    // SessionGoalStore and no Loop row may re-enter the Cron state machine.
    if (task.schedule?.kind === 'loop') return;
    // Issue #206 root-cause fix (companion to 224b0b7a which only patched
    // the overlay symptom in SimpleChatInput). `runMode === 'new_session'`
    // rotates a fresh sessionId per execution (see Rust
    // `cron_task.rs::rotate_new_session_id`), so any sid the user reaches
    // via 任务详情 →「关联会话」is already a DETACHED one-shot transcript
    // of a past run — the cron task is not "bound" to it in any live sense,
    // and the next execution will mint a yet-newer sid. Restoring the task
    // into `cronState` for such a session would (a) make every consumer of
    // `cronState.task` (overlay gate, session-switch guard at Chat:2791,
    // `useSessionSurfaces`, the save-vs-create branch at Chat:3752, the
    // sessionId-sync effect at Chat:1177) incorrectly treat this historical
    // chat as a live cron workbench, and (b) force every new consumer added
    // later to re-discover the same `runMode !== 'new_session'` guard.
    // Single source of truth: skip restore here. `single_session` mode
    // (continuous reuse of one sid as the cron's workbench) keeps the
    // original behavior — that's the only mode where the session IS the
    // cron's live context.
    if (task.runMode === 'new_session') {
      console.log(
        '[useCronTask] Skipping restore for new_session task — historical detached session:',
        task.id,
        'sid:', task.sessionId,
      );
      return;
    }
    console.log('[useCronTask] Restoring from task:', task.id, task.status);
    // Reverse-derive executionTarget from runMode. Rust's CronTask schema
    // doesn't store executionTarget (it's a UI-only distinction that the
    // modal collapses into runMode at confirm time), so on restore we
    // recompute it. Without this the editor would default to
    // 'current_session' regardless of the actual task — Bug 2A's second
    // half (the first half is fixed by threading executionTarget through
    // the launcher → autoSend handoff). The mapping mirrors the modal's
    // forward direction: `executionTarget==='current_session'` ↔
    // `runMode==='single_session'`; `'new_task'` ↔ `'new_session'`.
    // Note: after the `new_session` early-return above,
    // TS narrows `task.runMode` to `'single_session'`, so the inverse
    // collapses to the constant 'current_session' branch.
    const recoveredExecutionTarget: 'current_session' | 'new_task' = 'current_session';
    setState({
      isEnabled: true,
      config: {
        taskKind: 'cron',
        prompt: task.prompt,
        intervalMinutes: task.intervalMinutes,
        endConditions: task.endConditions,
        runMode: task.runMode,
        notifyEnabled: task.notifyEnabled,
        model: task.model,
        permissionMode: task.permissionMode,
        providerId: task.providerId,
        runtime: task.runtime,
        runtimeConfig: task.runtimeConfig,
        schedule: task.schedule,
        delivery: task.delivery,
        executionTarget: recoveredExecutionTarget,
        mcpEnabledServers: task.mcpEnabledServers,
      },
      task,
      isStarting: false,
      isExecuting: false,
      executionNumber: undefined,
      error: null,
    });
  }, [setState]);

  return {
    state,
    enableCronMode,
    disableCronMode,
    updateConfig,
    updateRunningConfig,
    setExecutionState,
    startTask,
    stop,
    refresh,
    restoreFromTask,
  };
}
