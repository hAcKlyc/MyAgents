import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { taskList } from '@/api/taskCenter';
import { getSnapshot, subscribePassive, registerPassiveWorkspaceSessionDemand, ensureWorkspaceSessions } from '@/hooks/taskCenterStore';
import { normalizeWorkspacePathIdentity, workspacePathsEqual } from '@/../shared/workspacePath';
import type { Task } from '@/../shared/types/task';
import { listenWithCleanup } from '@/utils/tauriListen';
import { readBoardSessionActivity } from './activity';
import type { ActivitySnapshot } from './projection';

const SESSION_SNAPSHOT_LIMIT = 50;
const SNAPSHOT_CONCURRENCY = 4;

export function useProjectBoardData(workspacePath: string, isActive: boolean) {
  const store = useSyncExternalStore(subscribePassive, getSnapshot);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ReadonlyMap<string, ActivitySnapshot>>(() => new Map());
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const taskRequest = useRef(0);

  useEffect(() => registerPassiveWorkspaceSessionDemand(workspacePath), [workspacePath]);
  const sessions = useMemo(() => store.sessions.filter(s => workspacePathsEqual(s.agentDir, workspacePath)), [store.sessions, workspacePath]);
  const sessionKey = sessions.filter(s => !s.archived).slice(0, SESSION_SNAPSHOT_LIMIT).map(s => s.id).join('\n');
  const sessionState = store.workspaceSessionStates.get(normalizeWorkspacePathIdentity(workspacePath));

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
    if (!isActive || !sessionKey) return;
    let cancelled = false;
    const ids = sessionKey.split('\n');
    let cursor = 0;
    // One bounded workspace snapshot at entry/explicit refresh. No process
    // probes or periodic per-Sidecar network polling and no Session creation.
    void (async () => {
      setChecking(true);
      const results = new Map<string, ActivitySnapshot>();
      await Promise.all(Array.from({ length: Math.min(SNAPSHOT_CONCURRENCY, ids.length) }, async () => {
        while (!cancelled && cursor < ids.length) {
          const id = ids[cursor++];
          try { results.set(id, await readBoardSessionActivity(id)); }
          catch (error) { results.set(id, { checkedAt: Date.now(), error: String(error) }); }
        }
      }));
      if (cancelled) return;
      setActivity(results);
      setCheckedAt(Date.now());
      setNow(Date.now());
      setChecking(false);
    })();
    return () => { cancelled = true; };
  }, [isActive, sessionKey, refreshNonce]);

  useEffect(() => {
    if (!isActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [isActive]);

  const refresh = useCallback(() => {
    void reloadTasks();
    void ensureWorkspaceSessions([workspacePath], true);
    setRefreshNonce(n => n + 1);
  }, [reloadTasks, workspacePath]);

  return { tasks: tasks ?? [], tasksLoading: tasks === null && !taskError, taskError,
    sessions, sessionsLoading: sessionState?.isLoading ?? store.isSessionsLoading,
    sessionError: sessionState?.error ?? store.sessionsError, activity, checking: Boolean(sessionKey) && checking, checkedAt, now, refresh,
    unobservedCount: Math.max(0, sessions.filter(s => !s.archived).length - SESSION_SNAPSHOT_LIMIT) };
}
