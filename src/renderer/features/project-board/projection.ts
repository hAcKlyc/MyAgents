import type { GoalStatus } from '@/types/sessionGoal';
import type { SessionWorkProgress } from '@/../shared/sessionWorkProgress';
import type { SessionMetadata } from '@/api/sessionClient';
import type { Task } from '@/../shared/types/task';
import { workspacePathsEqual } from '@/../shared/workspacePath';
import { isManagedScheduledJob } from '@/../shared/managedScheduledJob';

export type BoardGroup = 'todo' | 'running' | 'needs' | 'done' | 'idle' | 'scheduled' | 'archived';
export type ConfirmationReason = 'waiting' | 'paused' | 'verification' | 'blocked' | 'stopped' | 'unknown' | 'stopFailed';
export type SessionActivity = 'idle' | 'running' | 'waiting_user_action';
export interface ActivitySnapshot {
  goal?: { checkedAt: number; value?: { status: GoalStatus; isExecuting: boolean } | null; error?: string };
  state?: SessionActivity;
  checkedAt: number;
  execution?: { startedAt: string; elapsedMs: number };
  progress?: SessionWorkProgress;
  error?: string;
  errorCode?: 'execution_failed';
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
  activitySessionId?: string;
  confirmationReason?: ConfirmationReason;
  archived: boolean;
}

export const ACTIVITY_FRESHNESS_MS = 60_000;

export function freshActivity(snapshot: ActivitySnapshot | undefined, now: number): SessionActivity | undefined {
  if (!snapshot || snapshot.error || now - snapshot.checkedAt > ACTIVITY_FRESHNESS_MS) return undefined;
  return snapshot.state;
}

/** Fresh observations extrapolate locally. Stale ones show only the observed
 * duration, not an assertion that a turn kept running after the last read. */
export function sessionExecutionTime(snapshot: ActivitySnapshot | undefined, now: number) {
  if (!snapshot || snapshot.state === 'idle' || !snapshot.state || !snapshot.execution) return undefined;
  const { elapsedMs, startedAt } = snapshot.execution;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || !Number.isFinite(Date.parse(startedAt))) return undefined;
  const stale = !freshActivity(snapshot, now);
  return { elapsedMs: elapsedMs + (stale ? 0 : Math.max(0, now - snapshot.checkedAt)), stale, startedAt };
}

/** Goal and Session report different lifecycles; an idle turn cannot settle a Goal. */
export function boardGoalState(snapshot: ActivitySnapshot | undefined, now: number): 'running' | 'paused' | 'blocked' | 'stopped' | 'complete' | 'unknown' | undefined {
  const goal = snapshot?.goal;
  if (!goal) return undefined;
  if (goal.error || now - goal.checkedAt > ACTIVITY_FRESHNESS_MS || goal.value === undefined) return 'unknown';
  if (!goal.value) return undefined;
  if (goal.value.isExecuting || goal.value.status === 'active') return 'running';
  return goal.value.status === 'canceled' ? 'stopped' : goal.value.status;
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
  const visibleSessions = sessions.filter(s => workspacePathsEqual(s.agentDir, workspace.path));
  const visibleTasks = tasks.filter(t => !t.deleted && t.status !== 'deleted'
    && !isManagedScheduledJob(t)
    && (t.workspacePath ? workspacePathsEqual(t.workspacePath, workspace.path) : t.workspaceId === workspace.id));
  const linked = new Set(visibleTasks.flatMap(t => t.sessionIds));
  const rows: BoardRow[] = visibleTasks.map(task => {
    const executionSessions = sessions.filter(s => task.sessionIds.includes(s.id));
    const goals = task.sessionIds.map(id => boardGoalState(activity.get(id), now));
    const goalReason = goals.includes('blocked') ? 'blocked' : goals.includes('paused') ? 'paused' : goals.includes('stopped') ? 'stopped' : goals.includes('unknown') ? 'unknown' : undefined;
    const goalRunning = goals.includes('running');
    const waitingSessionId = task.sessionIds.find(id => freshActivity(activity.get(id), now) === 'waiting_user_action');
    const runningSessionId = task.sessionIds.find(id => freshActivity(activity.get(id), now) === 'running');
    const snapshot = activity.get((waitingSessionId ?? runningSessionId) ?? task.sessionIds.find(id => boardGoalState(activity.get(id), now) === 'running') ?? '')
      ?? executionSessions.map(s => activity.get(s.id)).filter((a): a is ActivitySnapshot => !!a).find(a => a.error || !freshActivity(a, now))
      ?? [...executionSessions].sort((a,b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt)).map(s => activity.get(s.id)).find(a => !!a);
    const lastKnownActive = task.sessionIds.some(id => {
      const observation = activity.get(id);
      return observation && !freshActivity(observation, now)
        && (observation.state === 'running' || observation.state === 'waiting_user_action');
    });
    const confirmationReason: ConfirmationReason | undefined = task.executionState === 'stop_failed' ? 'stopFailed'
      : waitingSessionId ? 'waiting' : runningSessionId || goalRunning ? undefined
      : task.sessionIds.some(id => activity.get(id)?.errorCode === 'execution_failed') ? 'blocked'
      : task.executionState ? undefined
      : goalReason ? goalReason
      : lastKnownActive ? 'unknown' : task.status === 'verifying' ? 'verification' : task.status === 'blocked' ? 'blocked'
      : task.status === 'stopped' ? 'stopped'
      : task.executor === 'agent' && task.status === 'running' && task.executionMode === 'once' ? 'unknown' : undefined;
    const group: BoardGroup = confirmationReason ? 'needs'
      : runningSessionId || goalRunning || task.executionState || task.executor === 'user' && task.status === 'running' ? 'running'
      : task.status === 'archived' ? 'archived' : task.status === 'done' ? 'done'
      : task.status === 'todo' ? 'todo' : 'scheduled';
    return {
      id: `task:${task.id}`, title: task.name, group, task, sessions: executionSessions,
      summary: task.executionError || task.lastExecution?.error || task.description || '',
      updatedAt: task.updatedAt,
      activity: snapshot, activitySessionId: task.sessionIds.find(id => activity.get(id) === snapshot), confirmationReason, archived: task.status === 'archived',
    };
  });
  for (const session of visibleSessions) {
    if (linked.has(session.id)) continue;
    const snapshot = activity.get(session.id);
    const state = freshActivity(snapshot, now);
    const lastKnownActive = !state && (snapshot?.state === 'running' || snapshot?.state === 'waiting_user_action');
    const executionFailed = snapshot?.errorCode === 'execution_failed';
    const goal = boardGoalState(snapshot, now);
    const group = state === 'waiting_user_action' ? 'needs' : state === 'running' || goal === 'running' ? 'running'
      : goal && goal !== 'complete' || lastKnownActive || executionFailed ? 'needs'
      : session.archived ? 'archived' : !state ? 'needs' : goal === 'complete' ? 'done' : 'idle';
    rows.push({ id: `session:${session.id}`, title: session.title, sessions: [session], group,
      confirmationReason: group === 'needs' ? executionFailed || goal === 'blocked' ? 'blocked' : state === 'waiting_user_action' ? 'waiting' : goal === 'paused' ? 'paused' : goal === 'stopped' ? 'stopped' : 'unknown' : undefined,
      archived: Boolean(session.archived),
      summary: session.lastMessagePreview || '', updatedAt: Date.parse(session.lastActiveAt) || 0, activity: snapshot, activitySessionId: session.id });
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export function filterBoardRows(rows: readonly BoardRow[], filter: 'all' | 'needs' | 'todo', query: string): BoardRow[] {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter(row => (filter === 'all' || filter === 'needs' && row.group === 'needs'
    || filter === 'todo' && row.group === 'todo')
    && (!needle || `${row.title} ${row.summary} ${row.task?.tags.join(' ') ?? ''}`.toLocaleLowerCase().includes(needle)));
}

export function boardRowStateKey(row: BoardRow, now: number): string {
  if (row.confirmationReason) return `projectBoard.reasons.${row.confirmationReason}`;
  if (row.group === 'running') return 'projectBoard.running';
  if (row.group === 'done') return 'badges.status.done';
  if (row.group === 'idle') return 'projectBoard.idle';
  if (row.group === 'scheduled') return 'projectBoard.awaitingTrigger';
  if (row.group === 'archived') return 'projectBoard.groups.archived';
  if (row.task) return `badges.status.${row.task.status}`;
  return freshActivity(row.activity, now) ? 'projectBoard.idle' : 'projectBoard.unknown';
}
