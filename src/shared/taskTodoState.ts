// SDK 0.3.142 replaced the snapshot-based `TodoWrite` tool with incremental Task
// tools (`TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList`). Where `TodoWrite`
// carried the *entire* list on every call (render = latest snapshot), the Task
// tools mutate one task at a time:
//   - TaskCreate({subject, activeForm?})            → result { task: { id } }
//   - TaskUpdate({taskId, subject?, activeForm?, status?})  (status 'deleted' = remove)
//   - TaskList()                                    → result { tasks: [{id, subject, status}] }
//
// To derive "the current task list" for the status panel and the TaskList card we
// must **accumulate by task id** across the ordered tool calls — a pure reducer so
// it stays trivially testable (Functional Core / Imperative Shell). `TodoWrite`
// keeps its own path (`todoWriteState.ts`) for backward-compatible replay of old
// sessions; the two never need to merge.

interface TaskCreateInput { subject?: string; activeForm?: string }
interface TaskUpdateInput { taskId?: string; subject?: string; activeForm?: string; status?: string }
interface ToolUseSimple { name: string; parsedInput?: unknown; result?: string; isError?: boolean }

export type TaskTodoStatus = 'pending' | 'in_progress' | 'completed';

export interface DerivedTaskTodo {
  id: string;
  content: string;
  status: TaskTodoStatus;
  activeForm: string;
  owner?: string;
}

const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList']);

/** True for the incremental Task tools (NOT the sub-agent launcher `Task`/`Agent`). */
export function isTaskTodoTool(name: string | undefined): boolean {
  return !!name && TASK_TOOL_NAMES.has(name);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** Parse `TaskCreate` result `{ task: { id, subject } }`. */
export function parseTaskCreate(result: string | undefined): { id: string; subject?: string } | undefined {
  if (!result) return undefined;
  try {
    const parsed = asObject(JSON.parse(result));
    const task = asObject(parsed?.task);
    if (typeof task?.id !== 'string') return undefined;
    return { id: task.id, subject: typeof task.subject === 'string' ? task.subject : undefined };
  } catch {
    return undefined;
  }
}

/** Parse `TaskCreate` result → the created task id. */
export function parseTaskCreateId(result: string | undefined): string | undefined {
  return parseTaskCreate(result)?.id;
}

/**
 * Parse `TaskUpdate` result `{ success }`. Returns the success flag, or undefined
 * when the result hasn't arrived / can't be parsed (treated as "apply optimistically"
 * during streaming). A definitive `false` means the mutation was rejected by the
 * runtime (e.g. unknown taskId) and must NOT be applied to the derived list.
 */
export function parseTaskUpdateSuccess(result: string | undefined): boolean | undefined {
  if (!result) return undefined;
  try {
    const parsed = asObject(JSON.parse(result));
    return typeof parsed?.success === 'boolean' ? parsed.success : undefined;
  } catch {
    return undefined;
  }
}

interface TaskListResultTask {
  owner?: string;
  id: string;
  subject: string;
  status: TaskTodoStatus;
}

/** Parse `TaskList` result `{ tasks: [...] }` → the authoritative snapshot. */
export function parseTaskListResult(result: string | undefined): TaskListResultTask[] | null {
  if (!result) return null;
  try {
    const parsed = asObject(JSON.parse(result));
    const tasks = parsed?.tasks;
    if (!Array.isArray(tasks)) return null;
    const out: TaskListResultTask[] = [];
    for (const t of tasks) {
      const obj = asObject(t);
      if (!obj || typeof obj.id !== 'string') continue;
      out.push({
        id: obj.id,
        subject: typeof obj.subject === 'string' ? obj.subject : '',
        status: normalizeStatus(obj.status),
        ...(typeof obj.owner === 'string' && obj.owner ? { owner: obj.owner } : {}),
      });
    }
    return out;
  } catch {
    return null;
  }
}

function normalizeStatus(value: unknown): TaskTodoStatus {
  return value === 'in_progress' || value === 'completed' ? value : 'pending';
}

/** A Task tool call, narrowed to what the reducer needs. */
export type TaskToolCall = Pick<ToolUseSimple, 'name' | 'parsedInput' | 'result'>;

/**
 * Replay an ordered list of Task tool calls into the current task list.
 *
 * Insertion order = creation order (matches how `TodoWrite` rendered its list and
 * how `TaskList` returns tasks). A `TaskCreate` whose result hasn't arrived yet
 * (still streaming → no id to anchor on) is skipped, mirroring `TodoWrite`'s
 * streaming-period behaviour where a half-formed call shows the prior state.
 *
 * Correctness rules (derived from the SDK contract + verified against real
 * out-of-order / failure traces):
 *   - A `TaskUpdate` whose result reports `success: false` is a rejected mutation
 *     (e.g. unknown taskId) and is NOT applied — neither status changes nor delete.
 *   - A repeated/out-of-order `TaskCreate` for an already-known id only fills
 *     content, never resets an already-advanced status back to `pending`.
 *   - A metadata-only `TaskUpdate` (no subject, no status) for an unknown id does
 *     NOT spawn a blank placeholder row.
 *   - `TaskList` is the authoritative full set (its input takes no filter), so it
 *     reconciles AND prunes: ids known before the snapshot but absent from it were
 *     deleted and are dropped. Skipped entirely while its result is still streaming.
 */
export function accumulateTaskTodos(calls: TaskToolCall[]): DerivedTaskTodo[] {
  const order: string[] = [];
  const byId = new Map<string, DerivedTaskTodo>();

  const remove = (id: string): void => {
    if (byId.delete(id)) {
      const idx = order.indexOf(id);
      if (idx >= 0) order.splice(idx, 1);
    }
  };

  // Fill content/activeForm/status without ever downgrading an existing status.
  const upsert = (id: string, patch: Partial<DerivedTaskTodo>): void => {
    const existing = byId.get(id);
    if (existing) {
      if (patch.content !== undefined) existing.content = patch.content;
      if (patch.activeForm !== undefined) existing.activeForm = patch.activeForm;
      if (patch.status !== undefined) existing.status = patch.status;
      return;
    }
    order.push(id);
    byId.set(id, {
      id,
      content: patch.content ?? '',
      status: patch.status ?? 'pending',
      activeForm: patch.activeForm ?? patch.content ?? '',
    });
  };

  for (const call of calls) {
    if (call.name === 'TaskCreate') {
      const created = parseTaskCreate(call.result);
      if (!created) continue; // not yet resolved (streaming) — can't anchor without the id
      const input = call.parsedInput as TaskCreateInput | undefined;
      // Prefer the streamed input subject; recover from the result for loaded
      // history where parsedInput is absent.
      const content =
        typeof input?.subject === 'string' ? input.subject : (created.subject ?? '');
      const activeForm = typeof input?.activeForm === 'string' ? input.activeForm : content;
      if (byId.has(created.id)) {
        // Duplicate/replayed create — only refresh content, keep advanced status.
        upsert(created.id, { content, activeForm });
      } else {
        upsert(created.id, { content, activeForm, status: 'pending' });
      }
      continue;
    }

    if (call.name === 'TaskUpdate') {
      const input = call.parsedInput as TaskUpdateInput | undefined;
      const id = typeof input?.taskId === 'string' ? input.taskId : undefined;
      if (!id) continue;
      // A rejected update never touches the list.
      if (parseTaskUpdateSuccess(call.result) === false) continue;
      if (input?.status === 'deleted') {
        remove(id);
        continue;
      }
      const patch: Partial<DerivedTaskTodo> = {};
      if (typeof input?.subject === 'string') patch.content = input.subject;
      if (typeof input?.activeForm === 'string') patch.activeForm = input.activeForm;
      if (input?.status) patch.status = normalizeStatus(input.status);
      // Don't spawn a blank row from a metadata-only update for an unknown task.
      if (!byId.has(id) && patch.content === undefined && patch.status === undefined) continue;
      upsert(id, patch);
      continue;
    }

    if (call.name === 'TaskList') {
      const tasks = parseTaskListResult(call.result);
      if (!tasks) continue; // result still streaming — don't prune prematurely
      const present = new Set(tasks.map(t => t.id));
      // Prune tasks the authoritative snapshot dropped (deleted by another owner /
      // a lost 'deleted' update). Tasks created *after* this TaskList come later in
      // the call order and are re-added on their own.
      for (const id of [...order]) {
        if (!present.has(id)) remove(id);
      }
      for (const t of tasks) {
        upsert(t.id, { content: t.subject, status: t.status });
      }
      continue;
    }
    // TaskGet is a read — it never mutates the derived list.
  }

  return order.map(id => byId.get(id)!);
}

/**
 * For a single `TaskList` tool card: the snapshot it reported, as renderable todos.
 * Returns undefined while the result hasn't arrived (streaming) so the card can
 * show a loading state instead of an empty list.
 */
export function getTaskListSnapshot(
  tool: Pick<ToolUseSimple, 'result'>,
): DerivedTaskTodo[] | undefined {
  const tasks = parseTaskListResult(tool.result);
  if (!tasks) return undefined;
  return tasks.map(t => ({ id: t.id, content: t.subject, status: t.status, activeForm: t.subject, ...(t.owner ? { owner: t.owner } : {}) }));
}

/** Only a settled result identifies the owner; input alone is a requested transfer. */
export function getTaskResultOwner(tool: Pick<ToolUseSimple, 'result' | 'isError'>): string | undefined {
  if (tool.isError || !tool.result) return undefined;
  try {
    const task = asObject(asObject(JSON.parse(tool.result))?.task);
    return typeof task?.owner === 'string' && task.owner ? task.owner : undefined;
  } catch {
    return undefined;
  }
}
