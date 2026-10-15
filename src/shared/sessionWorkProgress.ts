import { z } from 'zod';
import { accumulateTaskTodos, isTaskTodoTool, parseTaskListResult, type TaskToolCall } from './taskTodoState';
import { getEffectiveTodoWriteTodos } from './todoWriteState';

export const progressTodoSchema = z.object({ key: z.string(), content: z.string(), activeForm: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) });
export type ProgressTodo = z.infer<typeof progressTodoSchema>;
export const workProgressSchema = z.object({
  source: z.enum(['live', 'history']),
  todoSource: z.enum(['tools', 'runtime', 'none']),
  todos: z.array(progressTodoSchema).max(100),
  todoTotal: z.number().int().nonnegative(), todoCompleted: z.number().int().nonnegative(),
  agents: z.array(z.object({ id: z.string(), agentType: z.string(), description: z.string(),
    status: z.enum(['running', 'completed', 'failed', 'interrupted', 'unknown']), background: z.boolean(),
    startedAt: z.number().finite().nonnegative().optional(), finishedAt: z.number().finite().nonnegative().optional(),
  })).max(20),
  agentTotal: z.number().int().nonnegative(), agentRunning: z.number().int().nonnegative(),
});
export type SessionWorkProgress = z.infer<typeof workProgressSchema>;
export type ProgressMessage = { id: string; role?: string; content: unknown };
const object = (v: unknown): Record<string, unknown> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const string = (v: unknown, fallback = '') => typeof v === 'string' ? v : fallback;
function blocks(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content !== 'string' || !content.startsWith('[')) return [];
  try { const value: unknown = JSON.parse(content); return Array.isArray(value) ? value : []; } catch { return []; }
}
function tools(messages: readonly ProgressMessage[]) {
  return messages.flatMap(message => blocks(message.content).flatMap(block => {
    const b = object(block), tool = object(b?.tool);
    return message.role !== 'user' && b?.type === 'tool_use' && tool && typeof tool.name === 'string' ? [{ messageId: message.id, tool }] : [];
  }));
}

/** Same ordered projection for Chat and board. A null native plan means no
 * native snapshot; an empty native list explicitly clears prior tool todos. */
export function deriveSessionTodos(messages: readonly ProgressMessage[], runtimePlan: readonly ProgressTodo[] | null = null) {
  let todos: ProgressTodo[] = [], source: SessionWorkProgress['todoSource'] = 'none';
  const taskCalls: TaskToolCall[] = [];
  for (const { tool } of tools(messages)) {
    if (tool.name === 'TodoWrite') {
      const value = getEffectiveTodoWriteTodos(tool);
      if (value) {
        todos = value.flatMap((item, index) => {
          const parsed = progressTodoSchema.safeParse({ ...object(item), key: `${string(tool.id)}-${index}`, activeForm: string(item?.activeForm, item?.content) });
          return parsed.success ? [parsed.data] : [];
        });
        source = 'tools';
      }
    } else if (isTaskTodoTool(string(tool.name))) {
      taskCalls.push({ name: string(tool.name), parsedInput: tool.parsedInput, result: typeof tool.result === 'string' ? tool.result : undefined });
    }
  }
  const accumulated = accumulateTaskTodos(taskCalls);
  if (accumulated.length || taskCalls.some(call => call.name === 'TaskList' && parseTaskListResult(call.result) !== null)) {
    todos = accumulated.map(item => ({ key: item.id, content: item.content, activeForm: item.activeForm, status: item.status }));
    source = 'tools';
  }
  if (runtimePlan !== null) { todos = runtimePlan.map(item => ({ ...item })); source = 'runtime'; }
  return { todos, source };
}

export type ActiveProgressAgent = { id: string; toolUseId?: string; description?: string; agentType?: string; startedAt?: number };
/** This is a read-only presentation. It never decides root or Task completion.
 * Historical loading flags are unknown, and SDK background work must still be
 * owned by the exact live Query; result-less historical cards cannot revive it. */
export function deriveSessionWorkProgress(messages: readonly ProgressMessage[], options: {
  live: boolean; runtimePlan?: readonly ProgressTodo[] | null; activeBackground?: readonly ActiveProgressAgent[];
}): SessionWorkProgress {
  const { todos, source } = deriveSessionTodos(messages, options.runtimePlan);
  const active = options.live ? options.activeBackground ?? [] : [];
  const agents = new Map<string, SessionWorkProgress['agents'][number]>();
  const candidates = tools(messages).filter(({ tool }) => ['Agent', 'Task', 'CollabAgent'].includes(string(tool.name)));
  const latestLifecycleMessage = candidates.findLast(({tool}) => !!object(tool.subagentLifecycle))?.messageId;
  for (const { messageId, tool } of candidates) {
    const input = object(tool.parsedInput), lifecycle = object(tool.subagentLifecycle);
    const id = string(tool.id);
    if (!id) continue;
    const background = tool.name !== 'CollabAgent' && input?.run_in_background !== false;
    const owned = active.find(item => item.toolUseId === id);
    if (lifecycle && messageId !== latestLifecycleMessage && !owned) continue;
    if (!lifecycle && background && !owned) continue;
    if (!lifecycle && tool.name === 'CollabAgent') continue;
    const terminal = lifecycle && ['completed', 'failed', 'interrupted'].includes(string(lifecycle.status)) ? lifecycle.status as 'completed' | 'failed' | 'interrupted' : undefined;
    const running = options.live && (owned || lifecycle?.status === 'running' || !background && tool.isLoading === true && !tool.result);
    if (!terminal && !running && !lifecycle) continue;
    const startedAt = lifecycle?.timingVerified === false ? undefined : lifecycle?.startedAt ?? tool.taskStartTime ?? owned?.startedAt;
    const finishedAt = lifecycle?.timingVerified === false ? undefined : lifecycle?.finishedAt;
    agents.set(id, { id, agentType: string(lifecycle?.agentType, string(input?.subagent_type, 'general-purpose')),
      description: string(lifecycle?.description, string(input?.description)), background: lifecycle?.mode === 'continuable' || background,
      status: terminal ?? (running ? 'running' : 'unknown'),
      ...(typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt >= 0 ? { startedAt } : {}),
      ...(typeof finishedAt === 'number' && Number.isFinite(finishedAt) && finishedAt >= 0 ? { finishedAt } : {}),
    });
  }
  for (const item of active) {
    const id = item.toolUseId ?? item.id;
    if (agents.has(id)) continue;
    agents.set(id, { id, agentType: item.agentType ?? 'general-purpose', description: item.description ?? '', status: 'running', background: true,
      ...(item.startedAt === undefined ? {} : { startedAt: item.startedAt }) });
  }
  const allAgents = [...agents.values()].sort((a,b) => Number(b.status === 'running') - Number(a.status === 'running'));
  // Display caps apply after exact totals. A large plan remains visibly partial.
  return { source: options.live ? 'live' : 'history', todoSource: source,
    todos: todos.slice(0,100).map(todo => ({ ...todo, content: todo.content.slice(0,2000), activeForm: todo.activeForm.slice(0,2000) })), todoTotal: todos.length, todoCompleted: todos.filter(item => item.status === 'completed').length,
    agents: allAgents.slice(0,20), agentTotal: allAgents.length, agentRunning: allAgents.filter(item => item.status === 'running').length };
}
