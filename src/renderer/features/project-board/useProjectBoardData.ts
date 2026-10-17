import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { taskList } from '@/api/taskCenter';
import { getSnapshot, subscribePassive, registerPassiveWorkspaceSessionDemand, ensureWorkspaceSessions } from '@/hooks/taskCenterStore';
import { normalizeWorkspacePathIdentity, workspacePathsEqual } from '@/../shared/workspacePath';
import type { GoalChangedPayload } from '@/types/sessionGoal';
import type { Task } from '@/../shared/types/task';
import { listenWithCleanup } from '@/utils/tauriListen';
import { readBoardSessionActivity } from './activity';
import type { ActivitySnapshot } from './projection';

const SESSION_SNAPSHOT_LIMIT = 50;
const SNAPSHOT_CONCURRENCY = 4;
export const BOARD_REFRESH_MS = 30_000;

export function useProjectBoardData(workspacePath: string, isActive: boolean) {
  const store = useSyncExternalStore(subscribePassive, getSnapshot);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ReadonlyMap<string, ActivitySnapshot>>(() => new Map());
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== 'hidden');
  const taskRequest = useRef(0);
  const observationRun = useRef<Promise<void> | null>(null);

  useEffect(() => registerPassiveWorkspaceSessionDemand(workspacePath), [workspacePath]);
  const sessions = useMemo(() => store.sessions.filter(s => workspacePathsEqual(s.agentDir, workspacePath)), [store.sessions, workspacePath]);
  const observedSessions = [...sessions].sort((a, b) => Number(Boolean(a.archived)) - Number(Boolean(b.archived))).slice(0, SESSION_SNAPSHOT_LIMIT);
  const linkedIds = (tasks ?? []).filter(t => !t.deleted && (t.workspacePath ? workspacePathsEqual(t.workspacePath, workspacePath) : false)).flatMap(t => t.sessionIds);
  const candidateIds = [...new Set([...linkedIds, ...observedSessions.map(s => s.id)])];
  const sessionKey = candidateIds.slice(0, SESSION_SNAPSHOT_LIMIT).join('\n');
  const sessionRevision = observedSessions.map(s => `${s.id}:${s.lastActiveAt}:${Boolean(s.archived)}`).join('\n');
  const sessionState = store.workspaceSessionStates.get(normalizeWorkspacePathIdentity(workspacePath));

  useEffect(() => {
    const visibilityChanged = () => setDocumentVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => document.removeEventListener('visibilitychange', visibilityChanged);
  }, []);

  useEffect(() => {
    if (!isActive || !documentVisible) return;
    const timer = window.setInterval(() => {
      // A slow bounded sweep must finish, rather than be invalidated by its
      // own refresh clock. Explicit refreshes still replace publication.
      if (!observationRun.current) setRefreshNonce(n => n + 1);
    }, BOARD_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [isActive, documentVisible]);

  const reloadTasks = useCallback(async () => {
    const request = ++taskRequest.current;
    try {
      const next = await taskList();
      if (request !== taskRequest.current) return;
      setTasks(next);
      setTaskError(null);
    } catch (error) {
      if (request === taskRequest.current) setTaskError(String(error));
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;
    void reloadTasks();
    const controller = new AbortController();
    for (const event of ['task:status-changed', 'cron:execution-state-changed', 'task:session-rebound']) {
      void listenWithCleanup(event, () => { void reloadTasks(); }, controller.signal);
    }
    return () => { controller.abort(); taskRequest.current += 1; };
  }, [isActive, reloadTasks]);

  useEffect(() => {
    if (!isActive || !documentVisible) return;
    const controller = new AbortController();
    void listenWithCleanup<GoalChangedPayload>('goal:changed', event => {
      if (workspacePathsEqual(event.payload.workspacePath, workspacePath)) setRefreshNonce(n => n + 1);
    }, controller.signal);
    return () => controller.abort();
  }, [isActive, documentVisible, workspacePath]);

  useEffect(() => {
    if (!isActive || !documentVisible || !sessionKey) { setChecking(false); return; }
    let cancelled = false;
    const ids = sessionKey.split('\n');
    let cursor = 0;
    // Bounded, visible-workspace reads through the existing passive resolver.
    // Never creates/ensures a Session or probes processes; hidden tabs stop.
    setChecking(true);
    const previousRun = observationRun.current;
    const run = (async () => {
      // Cancelled generations drain their in-flight reads before the next
      // generation starts; the four-reader limit applies across refreshes.
      if (previousRun) await previousRun;
      if (cancelled) return;
      const results = new Map<string, ActivitySnapshot>();
      await Promise.all(Array.from({ length: Math.min(SNAPSHOT_CONCURRENCY, ids.length) }, async () => {
        while (!cancelled && cursor < ids.length) {
          const id = ids[cursor++];
          try { results.set(id, await readBoardSessionActivity(id, workspacePath)); }
          catch (error) { results.set(id, { checkedAt: Date.now(), error: String(error),
            ...(error instanceof Error && 'code' in error && error.code === 'SESSION_EXECUTION_FAILED'
              ? { errorCode: 'execution_failed' as const } : {}),
          }); }
        }
      }));
      if (cancelled) return;
      setActivity(previous => new Map([...results].map(([id, result]) => [id,
        result.error && previous.has(id) ? { ...previous.get(id)!, error: result.error, errorCode: result.errorCode, ...(result.goal ? { goal: result.goal } : {}) } : result,
      ])));
      setCheckedAt(Date.now());
      setNow(Date.now());
      setChecking(false);
    })();
    observationRun.current = run;
    const release = () => { if (observationRun.current === run) observationRun.current = null; };
    void run.then(release, release);
    return () => { cancelled = true; };
  }, [isActive, documentVisible, sessionKey, sessionRevision, refreshNonce, workspacePath]);

  useEffect(() => {
    if (!isActive || !documentVisible) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isActive, documentVisible]);

  const refresh = useCallback(() => {
    void reloadTasks();
    void ensureWorkspaceSessions([workspacePath], true);
    setRefreshNonce(n => n + 1);
  }, [reloadTasks, workspacePath]);

  return { tasks: tasks ?? [], tasksLoading: tasks === null && !taskError, taskError,
    sessions, sessionsLoading: sessionState?.isLoading ?? store.isSessionsLoading,
    sessionError: sessionState?.error ?? store.sessionsError, activity, checking: Boolean(sessionKey) && checking, checkedAt, now, refresh,
    unobservedCount: Math.max(0, Math.max(sessions.length, candidateIds.length) - SESSION_SNAPSHOT_LIMIT) };
}
