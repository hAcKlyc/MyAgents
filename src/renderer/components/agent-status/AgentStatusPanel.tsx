// PRD 0.2.17 — Agent Status Panel
//
// Top-level 容器：组合 useAgentStatusState 派生 + 收起态长条 + 展开态 sections。
// 可见性由真实活动 / 当前 live turn 驱动；完成后只淡出一次。

import {
  SuccessIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  XCircleIcon,
  StopCircleIcon,
} from '@/components/icons';
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Message } from '@/types/chat';

import { useTabStateOptional } from '@/context/TabContext';

import { SubagentRunningIcon } from './icons';
import SubagentSection from './SubagentSection';
import TodoSection from './TodoSection';
import { useAgentStatusState } from './useAgentStatusState';

// 全部 completed 时先驻留 500ms 让用户看到「全完成」瞬间，再开始 fade。
// 总从「内容归零」到「DOM 卸载」≈ 500 (linger) + 200 (opacity transition) + 800 (extra delay before unmount)。
const FADE_LINGER_MS = 500;
const FADE_OUT_DELAY_MS = 1500;

interface AgentStatusPanelProps {
  /** Chat 内容区的 ref，限定 querySelector 作用域（防多 Tab 同 Session DOM 冲突） */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Chat 提供：ChatScrollController message jump + 二阶段 highlight。SubagentRow 透传调用。 */
  onJumpToTool: (toolId: string) => void;
}

/** Stable empty fallback if ever rendered outside a TabProvider (in practice
 *  only Chat mounts this, always inside one). */
const EMPTY_MESSAGES: Message[] = [];

const AgentStatusPanel = memo(function AgentStatusPanel({ containerRef, onJumpToTool }: AgentStatusPanelProps) {
  // P3: self-subscribe to messages instead of receiving them as a prop. This
  // removes the [messages] dependency from Chat's `agentStatusSlot` useMemo, so
  // the slot element identity stays STABLE during streaming → SimpleChatInput's
  // React.memo holds and the input no longer re-renders on every streamed token.
  // This panel still re-renders per commit via the context subscription; its
  // derived DOM only changes when todos/subagents do (cost absorbed by React).
  const tab = useTabStateOptional();
  const messages = tab?.messages ?? EMPTY_MESSAGES;
  const turnIsLive = tab?.sessionState === 'starting'
    || tab?.sessionState === 'running'
    || tab?.sessionState === 'stopping';
  const [armedSessionId, setArmedSessionId] = useState<string | null>(null);
  useEffect(() => {
    if (!turnIsLive && !tab?.isSessionLoading) return;
    const raf = requestAnimationFrame(() => {
      setArmedSessionId(tab?.isSessionLoading ? null : tab?.sessionId ?? null);
    });
    return () => cancelAnimationFrame(raf);
  }, [tab?.isSessionLoading, tab?.sessionId, turnIsLive]);
  const tail = messages.at(-1);
  const lifecycleMessageId = tab?.streamingMessage?.id
    ?? (!turnIsLive
      && !tab?.isSessionLoading
      && armedSessionId === (tab?.sessionId ?? null)
      && tail?.role === 'assistant'
      ? tail.id
      : null);
  const state = useAgentStatusState(
    messages,
    tab?.agentPlanTodos ?? null,
    tab?.sessionId ?? null,
    lifecycleMessageId,
  );
  // hasContent：todos 全部 completed 时视为「已结束」→ 进入 fade-out
  // （对齐 PRD §8.1 #6 验收：「5/5 ☑ 后 1.5s 整段淡出」）
  const todosActive = state.todos.length > 0 && state.todos.some(t => t.status !== 'completed');
  const hasActiveContent = todosActive || state.summary.subagentRunning > 0;
  const hasDisplayContent = state.todos.length > 0 || state.subagents.length > 0;

  // Completed transcript data is not a new presentation event. Only activity
  // or the existing live-turn arm may show the panel; fading consumes that arm.
  // Otherwise completed todos survive unmount and restart this cycle every 2s,
  // changing the input overlay and chat footer height even in an idle session.
  const terminalPresentationArmed = armedSessionId !== null
    && armedSessionId === (tab?.sessionId ?? null);
  const [mounted, setMounted] = useState(false);
  const [opaque, setOpaque] = useState(false);

  useEffect(() => {
    if (!hasActiveContent && !(hasDisplayContent && terminalPresentationArmed)) return;
    let raf2: number | undefined;
    const raf1 = requestAnimationFrame(() => {
      setMounted(true);
      raf2 = requestAnimationFrame(() => setOpaque(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2 !== undefined) cancelAnimationFrame(raf2);
    };
    // Mount is an output, not a reason to replay the entrance or cancel its
    // second frame. Completion timing is owned by the effect below.
  }, [hasActiveContent, hasDisplayContent, terminalPresentationArmed]);

  useEffect(() => {
    if (hasActiveContent || !mounted) return;
    let fadeTimer: ReturnType<typeof setTimeout> | undefined;
    const lingerTimer = setTimeout(() => {
      setOpaque(false);
      fadeTimer = setTimeout(() => {
        setArmedSessionId(null);
        setMounted(false);
      }, FADE_OUT_DELAY_MS);
    }, FADE_LINGER_MS);
    return () => {
      clearTimeout(lingerTimer);
      if (fadeTimer !== undefined) clearTimeout(fadeTimer);
    };
  }, [hasActiveContent, mounted]);

  // 展开/收起状态（Tab 生命周期内保持；不持久化）
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded(v => !v), []);

  if (!mounted) return null;

  return (
    // 卡片级 DOM——定位/居中/右边界对齐由父级 SimpleChatInput 内的「panel 行」
    // 负责。和 QueuedMessagesPanel 同居一个 `flex items-end justify-end gap-2`
    // 行：当 queue 同时存在时 `[&:not(:only-child)]:mr-auto` 把 Todo 推到左侧，
    // queue 自然落到右侧；只剩 Todo 时 `:only-child` 触发，无 mr-auto，
    // justify-end 把它保持在右边。这样原来 `bottom-[8rem]` 的硬编码偏移和与
    // queue 的 z-20 撞车都被布局消化了，输入框高度变化（图片附件、textarea
    // 长大、cron status bar）也不再让 Todo 偏离 queue。
    <div
      aria-hidden={!opaque}
      inert={!opaque}
      className={`flex w-[min(380px,100%)] min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/95 shadow-lg backdrop-blur-md transition-opacity duration-200 [&:not(:only-child)]:mr-auto ${
        opaque ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
      }`}
    >
      {/* 展开态：上面 sections，下面 bar；收起态：仅 bar */}
      {expanded && (
        <div className="flex flex-col">
          <TodoSection todos={state.todos} />
          <SubagentSection subagents={state.subagents} containerRef={containerRef} onJumpToTool={onJumpToTool} />
        </div>
      )}
      <AgentStatusBar
        summary={state.summary}
        currentTodo={state.todos.find(todo => todo.status === 'in_progress')?.activeForm || state.todos.find(todo => todo.status === 'in_progress')?.content}
        expanded={expanded}
        onToggle={toggle}
      />
    </div>
  );
});

export default AgentStatusPanel;

interface AgentStatusBarProps {
  summary: import('./types').AgentStatusSummary;
  currentTodo?: string;
  expanded: boolean;
  onToggle: () => void;
}

// V3 收起态文案（用户拍板）：「Todo 0/4   Agents 3 ·」，· 是脉冲绿点。
// 不显示 icon prefix、不显示 elapsed 时间数字、不区分 sync/bg 计数——
// 信息密度刚好够「瞥一眼知有几件事」，详情留给展开态。
const AgentStatusBar = memo(function AgentStatusBar({ summary, currentTodo, expanded, onToggle }: AgentStatusBarProps) {
  const { t } = useTranslation('app');
  const hasTodos = summary.todoTotal > 0;
  const hasSubagents = summary.subagentTotal > 0;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={expanded ? t('agentStatus.collapse') : t('agentStatus.expand')}
      className={`flex min-w-0 items-center gap-2 px-3 py-2 text-xs text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]/40 ${
        expanded ? 'border-t border-[var(--line-subtle)]' : ''
      }`}
    >
      {hasTodos && (
        <span className="shrink-0 tabular-nums">
          Todo {summary.todoCompleted}/{summary.todoTotal}
        </span>
      )}

      {currentTodo && <span data-current-todo className="min-w-0 flex-1 truncate text-left text-[var(--ink-secondary)]" title={currentTodo}>{currentTodo}</span>}

      {hasSubagents && (
        <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
          Agents {summary.subagentTotal}
          {summary.subagentRunning > 0 ? (
            <SubagentRunningIcon />
          ) : summary.subagentTerminalStatus === 'failed' ? (
            <XCircleIcon className="size-3.5 text-[var(--error)]" />
          ) : summary.subagentTerminalStatus === 'interrupted' ? (
            <StopCircleIcon className="size-3.5 text-[var(--warning)]" />
          ) : (
            <SuccessIcon className="size-3.5 text-[var(--success)]" />
          )}
        </span>
      )}

      <span className="ml-auto text-[var(--ink-muted)]">
        {expanded ? <ChevronDownIcon className="size-4" /> : <ChevronUpIcon className="size-4" />}
      </span>
    </button>
  );
});
