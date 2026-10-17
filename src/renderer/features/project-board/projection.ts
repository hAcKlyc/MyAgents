import type { SessionMetadata } from '@/api/sessionClient';
import type { Task } from '@/../shared/types/task';
import { workspacePathsEqual } from '@/../shared/workspacePath';
import { isManagedScheduledJob } from '@/../shared/managedScheduledJob';

export type BoardGroup = 'running' | 'needs' | 'verifying' | 'done' | 'todo' | 'other';
export type SessionActivity = 'idle' | 'running' | 'waiting_user_action';
export interface ActivitySnapshot {
  state?: SessionActivity;
  checkedAt: number;
  execution?: { startedAt: string; elapsedMs: number };
  error?: string;
}
export interface BoardRow {
  id: string;
  title: string;
  group: BoardGroup;
  task?: Task;
  sessions: SessionMetadata[];
  summary: string;
  updatedAt: number;
  activity?: ActivitySnapshot;
}

export const ACTIVITY_FRESHNESS_MS = 60_000;

export function freshActivity(snapshot: ActivitySnapshot | undefined, now: number): SessionActivity | undefined {
  if (!snapshot || snapshot.error || now - snapshot.checkedAt > ACTIVITY_FRESHNESS_MS) return undefined;
  return snapshot.state;
}

/** Fresh observations extrapolate locally. Stale ones show only the observed
 * duration, not an assertion that a turn kept running after the last read. */
export function sessionExecutionTime(snapshot: ActivitySnapshot | undefined, now: number) {
  if (!snapshot || snapshot.error || snapshot.state === 'idle' || !snapshot.state || !snapshot.execution) return undefined;
  const { elapsedMs, startedAt } = snapshot.execution;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || !Number.isFinite(Date.parse(startedAt))) return undefined;
  const stale = !freshActivity(snapshot, now);
  return { elapsedMs: elapsedMs + (stale ? 0 : Math.max(0, now - snapshot.checkedAt)), stale, startedAt };
}

/** Task identity wins over a Session decoration; a shared execution Session
 * may appear under several real Tasks but never also becomes a standalone row. */
export function projectBoardRows(
  workspace: { id?: string; path: string },
  tasks: readonly Task[],
  sessions: readonly SessionMetadata[],
  activity: ReadonlyMap<string, ActivitySnapshot>,
  now: number,
): BoardRow[] {
  const visibleSessions = sessions.filter(s => !s.archived && workspacePathsEqual(s.agentDir, workspace.path));
  const visibleTasks = tasks.filter(t => !t.deleted && t.status !== 'deleted' && t.status !== 'archived'
    && !isManagedScheduledJob(t)
    && (t.workspacePath ? workspacePathsEqual(t.workspacePath, workspace.path) : t.workspaceId === workspace.id));
  const linked = new Set(visibleTasks.flatMap(t => t.sessionIds));
  const rows: BoardRow[] = visibleTasks.map(task => {
    const executionSessions = sessions.filter(s => task.sessionIds.includes(s.id));
    const waitingSession = executionSessions.find(s => freshActivity(activity.get(s.id), now) === 'waiting_user_action');
    const group: BoardGroup = task.executionState === 'stop_failed' || waitingSession
      || task.status === 'blocked' || task.status === 'stopped' ? 'needs'
      : task.status === 'verifying' ? 'verifying' : task.status === 'done' ? 'done'
      : task.status === 'todo' ? 'todo' : task.executionMode !== 'once' && !task.executionState ? 'other' : 'running';
    return {
      id: `task:${task.id}`, title: task.name, group, task, sessions: executionSessions,
      summary: task.executionError || task.lastExecution?.error || task.description || '',
      updatedAt: task.updatedAt,
      activity: waitingSession ? activity.get(waitingSession.id) : executionSessions.map(s => activity.get(s.id)).find(a => a?.error),
    };
  });
  for (const session of visibleSessions) {
    if (linked.has(session.id)) continue;
    const snapshot = activity.get(session.id);
    const state = freshActivity(snapshot, now);
    rows.push({ id: `session:${session.id}`, title: session.title, sessions: [session],
      group: state === 'running' ? 'running' : state === 'waiting_user_action' ? 'needs' : 'other',
      summary: session.lastMessagePreview || '', updatedAt: Date.parse(session.lastActiveAt) || 0, activity: snapshot });
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export function filterBoardRows(rows: readonly BoardRow[], filter: 'all' | 'needs' | 'todo', query: string): BoardRow[] {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter(row => (filter === 'all' || filter === 'needs' && ['needs', 'verifying'].includes(row.group)
    || filter === 'todo' && row.group === 'todo')
    && (!needle || `${row.title} ${row.summary} ${row.task?.tags.join(' ') ?? ''}`.toLocaleLowerCase().includes(needle)));
}
