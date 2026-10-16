import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  createSessionGoal,
  getSessionGoal,
  markSessionGoalTerminal,
  pauseSessionGoal,
  resumeSessionGoal,
} from '@/api/sessionGoalClient';
import type {
  GoalChangedPayload,
  SessionGoal,
  SessionGoalDraftConfig,
} from '@/types/sessionGoal';
import { isTauriEnvironment } from '@/utils/browserMock';
import {
  isTerminalGoalFromListenerGap,
  projectGoalExecutionState,
  shouldAcceptGoalState,
} from '@/utils/goalStateReconciliation';
import { createSyncStateRef } from '@/utils/syncStateRef';
import { listenWithCleanup } from '@/utils/tauriListen';
import { workspacePathsEqual } from '@/../shared/workspacePath';
import { coerceRuntimeBirthPermissionMode } from '@/../shared/runtimeBirthFields';

export interface SessionGoalState {
  goal: SessionGoal | null;
  isStarting: boolean;
  isExecuting: boolean;
  executionNumber?: number;
  error: string | null;
}

export interface SessionGoalStopResult {
  goal: SessionGoal;
  prompt: string | null;
}

export interface SessionGoalOwner {
  sessionId: string;
  workspacePath: string;
}

interface UseSessionGoalOptions {
  workspacePath: string;
  sessionId: string;
  materializeOwner?: () => Promise<SessionGoalOwner>;
}

interface PendingGoalStart {
  canceled: boolean;
  phase: 'materializing' | 'creating';
  initialOwner: SessionGoalOwner;
  owner?: SessionGoalOwner;
}

const initialState: SessionGoalState = {
  goal: null,
  isStarting: false,
  isExecuting: false,
  executionNumber: undefined,
  error: null,
};

function isTerminalGoal(goal: SessionGoal | null | undefined): boolean {
  return goal?.status === 'complete'
    || goal?.status === 'blocked'
    || goal?.status === 'canceled';
}

function isSameGoalOwner(
  previous: { sessionId: string; workspacePath: string },
  next: { sessionId: string; workspacePath: string },
): boolean {
  if (!workspacePathsEqual(previous.workspacePath, next.workspacePath)) return false;
  return previous.sessionId === next.sessionId;
}

export function useSessionGoal(options: UseSessionGoalOptions) {
  const { workspacePath, sessionId } = options;
  const [state, setStateRaw] = useState<SessionGoalState>(initialState);
  const stateRef = useRef(createSyncStateRef(state, setStateRaw)).current;
  const setState = stateRef.set;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const mountedRef = useRef(true);
  const dismissedIdsRef = useRef<Set<string>>(new Set());
  const pendingStartRef = useRef<PendingGoalStart | null>(null);
  const listenerStartedAtRef = useRef(Date.now());
  const listenersReadyAtRef = useRef<number | null>(null);
  const [listenersReady, setListenersReady] = useState(false);
  const hydrationActivation = useMemo(() => ({ sessionId, workspacePath }), [sessionId, workspacePath]);
  const currentHydration = useRef(hydrationActivation);
  useLayoutEffect(() => {
    currentHydration.current = hydrationActivation;
  }, [hydrationActivation]);
  const [hydratedOwner, setHydratedOwner] = useState<typeof hydrationActivation | null>(null);
  const ownerIdentityRef = useRef({ sessionId, workspacePath });

  const acceptSnapshot = useCallback((goal: SessionGoal, patch: Partial<SessionGoalState> = {}) => {
    setState(prev => {
      if (!shouldAcceptGoalState(goal, prev.goal)) return prev;
      return { ...prev, ...projectGoalExecutionState(goal), ...patch, goal };
    });
  }, [setState]);

  const stillProjectsGoal = useCallback((requested: SessionGoal, returned: SessionGoal): boolean => {
    if (!mountedRef.current || returned.id !== requested.id) return false;
    const currentOwner = optionsRef.current;
    const projected = stateRef.current.goal;
    return projected?.id === requested.id
      && isSameGoalOwner(requested, currentOwner)
      && isSameGoalOwner(returned, currentOwner);
  }, [stateRef]);

  const cancelPendingStart = useCallback(() => {
    if (pendingStartRef.current) pendingStartRef.current.canceled = true;
    setState(prev => prev.isStarting ? { ...prev, isStarting: false } : prev);
  }, [setState]);

  const start = useCallback(async (
    config: SessionGoalDraftConfig,
    promptOverride?: string,
  ): Promise<SessionGoal | null> => {
    if (stateRef.current.isStarting) {
      throw new Error('[useSessionGoal] Goal start is already in flight');
    }
    const objective = (promptOverride ?? config.prompt).trim();
    if (!objective) throw new Error('[useSessionGoal] Goal objective is required');

    const initialOwner = { sessionId, workspacePath };
    const pendingStart: PendingGoalStart = {
      canceled: false,
      phase: 'materializing',
      initialOwner,
    };
    pendingStartRef.current = pendingStart;
    setState(prev => ({ ...prev, isStarting: true, error: null }));
    let createdGoalId: string | null = null;
    try {
      const startOwner = optionsRef.current.materializeOwner
        ? await optionsRef.current.materializeOwner()
        : initialOwner;
      if (pendingStart.canceled || pendingStartRef.current !== pendingStart) return null;
      pendingStart.phase = 'creating';
      pendingStart.owner = startOwner;
      const currentOwner = optionsRef.current;
      const currentMatchesStart = isSameGoalOwner(startOwner, currentOwner);
      const currentStillAwaitingAdoption = initialOwner.sessionId.startsWith('pending-')
        && isSameGoalOwner(initialOwner, currentOwner);
      if (!currentMatchesStart && !currentStillAwaitingAdoption) {
        pendingStartRef.current = null;
        setState(initialState);
        return null;
      }
      const goal = await createSessionGoal({
        workspacePath: startOwner.workspacePath,
        sessionId: startOwner.sessionId,
        objective,
        endConditions: config.endConditions,
        notifyEnabled: config.notifyEnabled,
        permissionMode: coerceRuntimeBirthPermissionMode(
          config.permissionMode,
          config.runtime ?? 'builtin',
        ),
      });
      createdGoalId = goal.id;

      if (pendingStart.canceled) {
        dismissedIdsRef.current.add(goal.id);
        await markSessionGoalTerminal(goal.id, 'canceled', 'Canceled before Goal Mode started');
        return null;
      }
      const currentOwnerAfterCreate = optionsRef.current;
      if (!mountedRef.current
        || pendingStartRef.current !== pendingStart
        || (!isSameGoalOwner(startOwner, currentOwnerAfterCreate)
          && !(initialOwner.sessionId.startsWith('pending-')
            && isSameGoalOwner(initialOwner, currentOwnerAfterCreate)))) {
        // The durable Goal belongs to the captured Session and remains paused
        // awaiting its first user turn. Do not let the caller send that turn
        // through whichever Session the Tab adopted while create was pending.
        return null;
      }
      acceptSnapshot(goal, { isStarting: false });
      return goal;
    } catch (error) {
      if (pendingStart.canceled && !createdGoalId) return null;
      if (mountedRef.current && pendingStartRef.current === pendingStart) {
        setState(prev => ({
          ...prev,
          isStarting: false,
          error: error instanceof Error ? error.message : 'Failed to start Goal',
        }));
      }
      throw error;
    } finally {
      if (pendingStartRef.current === pendingStart) pendingStartRef.current = null;
    }
  }, [acceptSnapshot, sessionId, setState, stateRef, workspacePath]);

  const pause = useCallback(async (): Promise<SessionGoal | null> => {
    const current = stateRef.current.goal;
    if (!current || isTerminalGoal(current)) return null;
    try {
      const goal = await pauseSessionGoal(current.id);
      if (stillProjectsGoal(current, goal)) acceptSnapshot(goal);
      return goal;
    } catch (error) {
      console.error('[useSessionGoal] Failed to pause Goal:', error);
      return null;
    }
  }, [acceptSnapshot, stateRef, stillProjectsGoal]);

  const resume = useCallback(async (): Promise<SessionGoal | null> => {
    const current = stateRef.current.goal;
    if (!current || current.status !== 'paused') return null;
    try {
      const goal = await resumeSessionGoal(current.id);
      if (stillProjectsGoal(current, goal)) acceptSnapshot(goal);
      return goal;
    } catch (error) {
      console.error('[useSessionGoal] Failed to resume Goal:', error);
      return null;
    }
  }, [acceptSnapshot, stateRef, stillProjectsGoal]);

  const cancel = useCallback(async (reason = 'Canceled by user'): Promise<SessionGoalStopResult | null> => {
    const current = stateRef.current.goal;
    if (!current) return null;
    try {
      const goal = await markSessionGoalTerminal(current.id, 'canceled', reason);
      if (goal.status === 'canceled') {
        if (goal.id === current.id) dismissedIdsRef.current.add(goal.id);
        if (stillProjectsGoal(current, goal)) setState(initialState);
      } else if (stillProjectsGoal(current, goal)) {
        acceptSnapshot(goal);
      }
      return { goal, prompt: current.objective || null };
    } catch (error) {
      console.error('[useSessionGoal] Failed to cancel Goal:', error);
      return null;
    }
  }, [acceptSnapshot, setState, stateRef, stillProjectsGoal]);

  const dismiss = useCallback(() => {
    const current = stateRef.current.goal;
    if (current && isTerminalGoal(current)) dismissedIdsRef.current.add(current.id);
    setState(initialState);
  }, [setState, stateRef]);

  const handleGoalChangedRef = useRef<(payload: GoalChangedPayload) => void>(() => {});

  handleGoalChangedRef.current = (payload) => {
    const currentOptions = optionsRef.current;
    if (payload.sessionId !== currentOptions.sessionId) return;
    if (!workspacePathsEqual(payload.workspacePath, currentOptions.workspacePath)) return;
    if (isTerminalGoal(payload.goal) && dismissedIdsRef.current.has(payload.goal.id)) return;
    acceptSnapshot(payload.goal);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingStartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    const ac = new AbortController();
    listenWithCleanup<GoalChangedPayload>(
      'goal:changed',
      event => handleGoalChangedRef.current(event.payload),
      ac.signal,
    ).then(() => {
      if (ac.signal.aborted) return;
      listenersReadyAtRef.current = Date.now();
      setListenersReady(true);
    });
    return () => {
      ac.abort();
    };
  }, []);

  useEffect(() => {
    const previous = ownerIdentityRef.current;
    const next = { sessionId, workspacePath };
    ownerIdentityRef.current = next;
    const pendingStart = pendingStartRef.current;
    if (pendingStart) {
      const workspaceChanged = !workspacePathsEqual(
        pendingStart.initialOwner.workspacePath,
        next.workspacePath,
      );
      const expectedCreatingOwner = pendingStart.owner;
      const expectedSession = pendingStart.phase === 'materializing'
        || next.sessionId === pendingStart.initialOwner.sessionId
        || (expectedCreatingOwner && next.sessionId === expectedCreatingOwner.sessionId);
      if (workspaceChanged || !expectedSession) {
        pendingStartRef.current = null;
        setState(initialState);
      }
      return;
    }
    const projected = stateRef.current.goal;
    if (projected
      && projected.sessionId === next.sessionId
      && workspacePathsEqual(projected.workspacePath, next.workspacePath)) return;
    if (isSameGoalOwner(previous, next)) return;
    // Detach the new surface from an old in-flight request without canceling
    // the old session's Goal. Only cancelPendingStart marks a request canceled.
    pendingStartRef.current = null;
    setState(initialState);
  }, [sessionId, setState, stateRef, workspacePath]);

  useEffect(() => {
    if (!isTauriEnvironment() || !listenersReady) return;
    if (!sessionId || sessionId.startsWith('pending-')) return;

    let cancelled = false;
    void getSessionGoal(sessionId, workspacePath, true).then(goal => {
      if (cancelled || !mountedRef.current || currentHydration.current !== hydrationActivation) return;
      setHydratedOwner(hydrationActivation);
      if (!goal) return;
      if (isTerminalGoal(goal) && dismissedIdsRef.current.has(goal.id)) return;
      const current = stateRef.current.goal;
      if (isTerminalGoal(goal) && !current && !isTerminalGoalFromListenerGap(
        goal,
        listenerStartedAtRef.current,
        listenersReadyAtRef.current,
      )) return;
      if (!shouldAcceptGoalState(goal, current)) return;
      acceptSnapshot(goal);
    }).catch(error => {
      if (!cancelled) console.warn('[useSessionGoal] Failed to hydrate Goal state:', error);
    });
    return () => { cancelled = true; };
  }, [acceptSnapshot, hydrationActivation, listenersReady, sessionId, setState, stateRef, workspacePath]);

  return {
    state,
    restorationReady: !isTauriEnvironment() || hydratedOwner === hydrationActivation,
    start,
    pause,
    resume,
    cancel,
    dismiss,
    cancelPendingStart,
  };
}
