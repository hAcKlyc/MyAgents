// PRD 0.2.17 — Agent Status Panel
//
// 派生 hook：从 messages + 后台任务状态模块（backgroundTaskStatus）+
// runtime-native plan snapshot 派生统一的 AgentStatusState。
//
// 后续接入外部 Runtime 时新增 mapper（如 mapCodexEvents → AgentStatusState），
// 消费侧组件不变（PRD §5.2）。

import { useEffect, useMemo, useState } from 'react';

import type { AgentInput, AgentStatusTodoSnapshot, Message, ToolUseSimple } from '@/types/chat';
import {
  isBackgroundSubagentTool,
  isSubagentContainerRunning,
  isSubagentContainerTool,
} from '@/components/tools/subagentActivity';
import { deriveSessionTodos } from '@/../shared/sessionWorkProgress';
import { isTaskTodoTool } from '@/utils/taskTodoState';
import {
  BACKGROUND_TASK_STATUS_EVENT,
  collectCompletedBackgroundToolIdsFromHistory,
  getActiveBackgroundTasks,
  getBackgroundTaskStatus,
  hydrateBackgroundTaskStatusesFromHistory,
  isBackgroundTaskRegistered,
  isTerminalStatus,
} from '@/utils/backgroundTaskStatus';

import type { AgentStatusState, SubagentStatus, TodoItem } from './types';

/**
 * 从 messages 派生当前面板状态。
 *
 * @param messages — 当前 Tab 的完整消息列表（historyMessages + streamingMessage 合并后）
 *
 * 派生规则：
 * - todos：反向扫描，取最近一个 TodoWrite 工具的 result.newTodos（优先）或
 *   parsedInput.todos（fallback），忽略仍在 streaming、parsedInput 尚未成形的 TodoWrite
 *   （这样新 TodoWrite 在 streaming 期间显示旧状态，stop 后切换为新状态）。
 * - subagents（sync）：所有 isLoading 且未拿到 result 的 Task tool_use 块。
 * - subagents（background）：所有 SDK 默认后台的 Task/Agent tool_use 块
 *   （run_in_background 省略或 true；显式 false 才同步），
 *   其 backgroundTaskStatus 状态未到 terminal 的视为仍在运行。
 */
export function useAgentStatusState(
  messages: Message[],
  runtimePlanTodos: readonly AgentStatusTodoSnapshot[] | null = null,
  sessionId: string | null = null,
  lifecycleMessageId: string | null | undefined = undefined,
): AgentStatusState {
  // 订阅后台任务状态变化，触发 useMemo 重算。
  const [bgEpoch, setBgEpoch] = useState(0);
  useEffect(() => {
    const handler = (event: Event) => {
      const eventSessionId = (event as CustomEvent<{ sessionId?: string | null }>).detail?.sessionId ?? null;
      if ((eventSessionId ?? null) !== (sessionId ?? null)) return;
      setBgEpoch(v => v + 1);
    };
    window.addEventListener(BACKGROUND_TASK_STATUS_EVENT, handler);
    return () => window.removeEventListener(BACKGROUND_TASK_STATUS_EVENT, handler);
  }, [sessionId]);

  useEffect(() => {
    hydrateBackgroundTaskStatusesFromHistory(messages, sessionId);
  }, [messages, sessionId]);

  return useMemo<AgentStatusState>(() => {
    void bgEpoch;
    const todos: TodoItem[] = deriveSessionTodos(messages, runtimePlanTodos).todos;
    const subagents: SubagentStatus[] = [];
    let latestLifecycleMessageIndex = -1;
    let latestLifecycleSubagents: SubagentStatus[] = [];
    const seenSubagentToolIds = new Set<string>();
    // SDK 0.3.142+ Task tools (TaskCreate/Update/Get/List), collected in order for
    // the task-id accumulator. Used in preference to the legacy TodoWrite snapshot
    // when present (a session uses one or the other, never both).


    // B1 兜底：历史里所有 task-notification 消息里的 toolUseId 都视为已完成。
    const completedBgFromHistory = collectCompletedBackgroundToolIdsFromHistory(messages, sessionId);

    // 单次正序遍历：collect 所有候选 + 同步活跃 subagents + 后台 subagent 候选。
    // todos 取最后一个有效 TodoWrite。
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (typeof msg.content === 'string') continue;

      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (block.type !== 'tool_use' || !block.tool) continue;
        const tool = block.tool;

        if (tool.name === 'TodoWrite' || isTaskTodoTool(tool.name)) continue;

        if (isSubagentContainerTool(tool.name)) {
          seenSubagentToolIds.add(tool.id);
          const input = tool.parsedInput as AgentInput | undefined;
          const isBackground = isBackgroundSubagentTool(tool);

          if (tool.subagentLifecycle) {
            if (lifecycleMessageId !== undefined) {
              if (lifecycleMessageId === msg.id) {
                latestLifecycleSubagents.push(buildSubagentStatus(tool, input, 'sync', sessionId));
              }
              continue;
            }
            if (i > latestLifecycleMessageIndex) {
              latestLifecycleMessageIndex = i;
              latestLifecycleSubagents = [];
            }
            if (i === latestLifecycleMessageIndex) {
              latestLifecycleSubagents.push(buildSubagentStatus(tool, input, 'sync', sessionId));
            }
            continue;
          }

          // Old persisted CollabAgent cards do not carry execution authority.
          // Never revive them from stale nested isLoading flags on cold history.
          if (tool.name === 'CollabAgent') continue;

          if (isBackground) {
            // 后台任务过滤条件，三道防线（任一命中 → 视为已完成 → 跳过）：
            //   1. 历史里有对应 task-notification 消息（最可靠，扛 Cmd+R / LRU 驱逐）
            //   2. backgroundTaskStatus 模块里 status 是 terminal（运行期间正常完成路径）
            //   3. 模块里根本没注册过（要么没启动要么已被 LRU 驱逐 → 不应复活僵尸）
            if (completedBgFromHistory.has(tool.id)) continue;
            if (!isBackgroundTaskRegistered(tool.id, sessionId)) continue;
            const status = getBackgroundTaskStatus(tool.id, sessionId);
            if (isTerminalStatus(status)) continue;
            subagents.push(buildSubagentStatus(tool, input, 'background', sessionId));
          } else {
            // 同步任务：父工具还在跑，或 Codex spawn 已完成但 nested trace 仍在跑。
            const isActive = isSubagentContainerRunning(tool);
            if (!isActive) continue;
            subagents.push(buildSubagentStatus(tool, input, 'sync', sessionId));
          }
        }
      }
    }

    for (const task of getActiveBackgroundTasks(sessionId)) {
      if (seenSubagentToolIds.has(task.toolUseId)) continue;
      if (completedBgFromHistory.has(task.toolUseId)) continue;
      if (isTerminalStatus(task.status)) continue;
      subagents.push({
        id: task.toolUseId,
        agentType: task.taskType ?? 'general-purpose',
        description: task.description ?? '',
        mode: 'background',
        startedAt: task.startedAt,
        inputTokens: 0,
        outputTokens: 0,
        toolCount: 0,
        status: 'running',
      });
    }

    subagents.push(...latestLifecycleSubagents);

    // 排序：同步在前（按 startedAt 升序），后台在后（按 startedAt 升序）。
    subagents.sort((a, b) => {
      if (a.mode !== b.mode) return a.mode === 'sync' ? -1 : 1;
      return a.startedAt - b.startedAt;
    });

    let completed = 0;
    let inProgress = 0;
    for (const t of todos) {
      if (t.status === 'completed') completed++;
      else if (t.status === 'in_progress') inProgress++;
    }
    // 取「最早开始」（startedAt 最小）= 跑得最久的那一个的 startedAt。
    // 注意不要在派生值里调 Date.now()——见 types.ts AgentStatusSummary 注释。
    const runningSubagents = subagents.filter(subagent => subagent.status === 'running');
    const longestStartedAt = runningSubagents.length === 0
      ? null
      : runningSubagents.reduce(
        (earliest, s) => (s.startedAt < earliest ? s.startedAt : earliest),
        runningSubagents[0].startedAt,
      );
    const subagentTerminalStatus = subagents.some(subagent => subagent.status === 'failed')
      ? 'failed'
      : subagents.some(subagent => subagent.status === 'interrupted')
        ? 'interrupted'
        : subagents.length > 0 && runningSubagents.length === 0
          ? 'completed'
          : null;

    return {
      todos,
      subagents,
      summary: {
        todoCompleted: completed,
        todoInProgress: inProgress,
        todoTotal: todos.length,
        subagentRunning: runningSubagents.length,
        subagentTotal: subagents.length,
        subagentTerminalStatus,
        longestSubagentStartedAt: longestStartedAt,
      },
    };
    // bgEpoch 在 deps 里仅为触发重算；其引用本身在闭包外不使用。
  }, [messages, runtimePlanTodos, bgEpoch, sessionId, lifecycleMessageId]);
}

// 稳定 fallback startedAt：tool.taskStartTime 缺失时，记录首次见到此 toolId 的时间。
// 之前直接用 `?? Date.now()` 每次 useMemo 重算都会刷新成"现在"，elapsed 始终 0（Codex W4）。
const firstSeenAtByToolId = new Map<string, number>();

function buildSubagentStatus(
  tool: Pick<ToolUseSimple, 'id' | 'name' | 'parsedInput' | 'taskStartTime' | 'taskStats' | 'subagentCalls' | 'subagentLifecycle'>,
  input: AgentInput | undefined,
  mode: 'sync' | 'background',
  sessionId: string | null,
): SubagentStatus {
  let startedAt = tool.subagentLifecycle?.startedAt ?? tool.taskStartTime;
  if (startedAt === undefined) {
    const cacheKey = `${sessionId ?? '__default__'}\u0000${tool.id}`;
    const cached = firstSeenAtByToolId.get(cacheKey);
    if (cached !== undefined) {
      startedAt = cached;
    } else {
      startedAt = Date.now();
      firstSeenAtByToolId.set(cacheKey, startedAt);
    }
  }
  const fallback = buildSubagentStatusFallback(tool);
  const lifecycle = tool.subagentLifecycle;
  return {
    id: tool.id,
    agentType: lifecycle?.agentType ?? input?.subagent_type ?? fallback.agentType,
    description: lifecycle?.description ?? input?.description ?? fallback.description,
    mode: lifecycle?.mode === 'continuable' ? 'background' : mode,
    startedAt,
    finishedAt: tool.subagentLifecycle?.finishedAt,
    status: tool.subagentLifecycle?.status ?? 'running',
    inputTokens: lifecycle?.usage?.inputTokens ?? tool.taskStats?.inputTokens ?? 0,
    outputTokens: lifecycle?.usage?.outputTokens ?? tool.taskStats?.outputTokens ?? 0,
    toolCount: tool.taskStats?.toolCount ?? tool.subagentCalls?.length ?? 0,
  };
}

function getStringProp(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function buildSubagentStatusFallback(
  tool: Pick<ToolUseSimple, 'name' | 'parsedInput'>,
): { agentType: string; description: string } {
  if (tool.name !== 'CollabAgent') {
    return { agentType: 'general-purpose', description: '' };
  }
  const action = getStringProp(tool.parsedInput, 'tool');
  const model = getStringProp(tool.parsedInput, 'model');
  const prompt = getStringProp(tool.parsedInput, 'prompt') ?? getStringProp(tool.parsedInput, 'description') ?? '';
  return {
    agentType: model ? `Codex · ${model}` : 'Codex',
    description: action === 'spawnAgent' ? prompt : action ?? '',
  };
}
