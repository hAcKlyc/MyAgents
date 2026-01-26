
import type { AgentInput, SubagentToolCall, ToolUseSimple, TaskStats } from '@/types/chat';

import Markdown from '@/components/Markdown';
import { formatDuration } from '@/components/tools/toolBadgeConfig';
import { CheckCircle, ChevronDown, ChevronRight, Clock, Coins, Loader2, Terminal, Wrench, XCircle } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Constants
const DEFAULT_LINE_HEIGHT = 22;
const DEFAULT_MAX_LINES = 5;

interface TaskToolProps {
  tool: ToolUseSimple;
}

// Task 结果的类型定义
interface TaskResultContent {
  type: 'text' | string;
  text?: string;
}

interface TaskResult {
  status?: 'completed' | 'pending' | 'error' | string;
  prompt?: string;
  agentId?: string;
  content?: TaskResultContent[];
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

// 格式化 Token 数
function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1000000).toFixed(2)}M`;
}

// 可折叠内容组件 - 默认最多显示 5 行
function CollapsibleContent({ children, maxLines = DEFAULT_MAX_LINES }: { children: React.ReactNode; maxLines?: number }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [needsExpansion, setNeedsExpansion] = useState(false);
  const [computedMaxHeight, setComputedMaxHeight] = useState(maxLines * DEFAULT_LINE_HEIGHT);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contentRef.current) return;

    // Use ResizeObserver for accurate measurement after render
    const observer = new ResizeObserver(() => {
      if (contentRef.current) {
        const computedStyle = getComputedStyle(contentRef.current);
        const lineHeight = parseFloat(computedStyle.lineHeight) || DEFAULT_LINE_HEIGHT;
        const maxHeight = lineHeight * maxLines;
        setComputedMaxHeight(maxHeight);
        setNeedsExpansion(contentRef.current.scrollHeight > maxHeight + 10);
      }
    });

    observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [maxLines]);

  const handleToggle = useCallback(() => {
    setIsExpanded(prev => !prev);
  }, []);

  return (
    <div>
      <div
        ref={contentRef}
        className="overflow-hidden transition-all duration-200"
        style={{
          maxHeight: isExpanded ? 'none' : `${computedMaxHeight}px`,
        }}
      >
        {children}
      </div>
      {needsExpansion && (
        <button
          type="button"
          onClick={handleToggle}
          className="mt-2 flex items-center gap-1 text-xs text-[var(--ink-muted)] hover:text-[var(--ink)] transition-colors"
        >
          <ChevronDown className={`size-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
          <span>{isExpanded ? '收起' : '展开更多'}</span>
        </button>
      )}
    </div>
  );
}

// 实时统计显示组件（进行中状态）
function TaskRunningStats({
  startTime,
  stats,
  hasTrace,
  traceExpanded,
  onToggleTrace
}: {
  startTime: number;
  stats: TaskStats;
  hasTrace: boolean;
  traceExpanded: boolean;
  onToggleTrace: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    // Use requestAnimationFrame to set initial value asynchronously
    // This avoids "synchronous setState in effect" lint warning
    const rafId = requestAnimationFrame(() => {
      setElapsed(Date.now() - startTime);
    });

    intervalRef.current = setInterval(() => {
      setElapsed(Date.now() - startTime);
    }, 1000);

    return () => {
      cancelAnimationFrame(rafId);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [startTime]);

  const totalTokens = stats.inputTokens + stats.outputTokens;

  return (
    <button
      type="button"
      onClick={hasTrace ? onToggleTrace : undefined}
      disabled={!hasTrace}
      aria-expanded={hasTrace ? traceExpanded : undefined}
      aria-controls={hasTrace ? 'task-trace-content' : undefined}
      className={`flex w-full items-center justify-between text-xs rounded-lg bg-[var(--accent)]/5 px-3 py-2 ${
        hasTrace ? 'cursor-pointer hover:bg-[var(--accent)]/10' : 'cursor-default'
      } transition-colors`}
    >
      <div className="flex flex-wrap items-center gap-3 text-[var(--ink-muted)]">
        {/* 运行中状态 */}
        <div className="flex items-center gap-1.5 text-[var(--accent)]">
          <Loader2 className="size-3.5 animate-spin" />
          <span className="font-medium">运行中</span>
        </div>

        {/* 已运行时间 */}
        <div className="flex items-center gap-1">
          <Clock className="size-3.5" />
          <span>已运行 {formatDuration(elapsed)}</span>
        </div>

        {/* 工具调用次数 */}
        {stats.toolCount > 0 && (
          <div className="flex items-center gap-1">
            <Wrench className="size-3.5" />
            <span>调用工具 {stats.toolCount} 次</span>
          </div>
        )}

        {/* Token 消耗 */}
        {totalTokens > 0 && (
          <div className="flex items-center gap-1">
            <Coins className="size-3.5" />
            <span>消耗 {formatTokens(totalTokens)} token</span>
          </div>
        )}
      </div>

      {/* 展开/收起箭头 */}
      {hasTrace && (
        <ChevronRight
          className={`size-4 text-[var(--ink-muted)] transition-transform ${traceExpanded ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
      )}
    </button>
  );
}

// 完成状态统计栏
function TaskCompletedStats({
  result,
  stats,
  hasTrace,
  traceExpanded,
  onToggleTrace
}: {
  result: TaskResult;
  stats?: TaskStats;
  hasTrace: boolean;
  traceExpanded: boolean;
  onToggleTrace: () => void;
}) {
  const isSuccess = result.status === 'completed';
  const isError = result.status === 'error';

  const statusIcon = isSuccess ? (
    <CheckCircle className="size-3.5" />
  ) : isError ? (
    <XCircle className="size-3.5" />
  ) : (
    <Loader2 className="size-3.5 animate-spin" />
  );

  const statusLabel = isSuccess ? '完成' : isError ? '错误' : '进行中';

  const totalTokens = stats
    ? stats.inputTokens + stats.outputTokens
    : result.totalTokens || 0;
  const toolCount = stats?.toolCount || result.totalToolUseCount || 0;
  const duration = result.totalDurationMs;

  const bgColor = isSuccess
    ? 'bg-[var(--success)]/10 hover:bg-[var(--success)]/15'
    : isError
      ? 'bg-[var(--error)]/10 hover:bg-[var(--error)]/15'
      : 'bg-[var(--accent)]/5 hover:bg-[var(--accent)]/10';

  const textColor = isSuccess
    ? 'text-[var(--success)]'
    : isError
      ? 'text-[var(--error)]'
      : 'text-[var(--ink-muted)]';

  return (
    <button
      type="button"
      onClick={hasTrace ? onToggleTrace : undefined}
      disabled={!hasTrace}
      aria-expanded={hasTrace ? traceExpanded : undefined}
      aria-controls={hasTrace ? 'task-trace-content' : undefined}
      className={`flex w-full items-center justify-between text-xs rounded-lg px-3 py-2 ${bgColor} ${
        hasTrace ? 'cursor-pointer' : 'cursor-default'
      } transition-colors`}
    >
      <div className={`flex flex-wrap items-center gap-3 ${textColor}`}>
        {/* 状态 */}
        <div className="flex items-center gap-1.5 font-medium">
          {statusIcon}
          <span>{statusLabel}</span>
        </div>

        {/* 耗时 */}
        {duration != null && (
          <div className="flex items-center gap-1">
            <Clock className="size-3.5" />
            <span>{formatDuration(duration)}</span>
          </div>
        )}

        {/* 工具调用次数 */}
        {toolCount > 0 && (
          <div className="flex items-center gap-1">
            <Wrench className="size-3.5" />
            <span>{toolCount} 次工具调用</span>
          </div>
        )}

        {/* Token 消耗 */}
        {totalTokens > 0 && (
          <div className="flex items-center gap-1">
            <Coins className="size-3.5" />
            <span>消耗 {formatTokens(totalTokens)} token</span>
          </div>
        )}
      </div>

      {/* 展开/收起箭头 */}
      {hasTrace && (
        <ChevronRight
          className={`size-4 transition-transform ${traceExpanded ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
      )}
    </button>
  );
}

// 渲染单个子工具调用 - memo 化避免不必要的重渲染
const SubagentCallItem = memo(function SubagentCallItem({ call }: { call: SubagentToolCall }) {
  const description = useMemo(() => {
    if (call.parsedInput && typeof call.parsedInput === 'object' && 'description' in call.parsedInput) {
      return String(call.parsedInput.description ?? '');
    }
    if (typeof call.input === 'object' && call.input && 'description' in call.input) {
      return String(call.input.description ?? '');
    }
    return '';
  }, [call.parsedInput, call.input]);

  const inputText = useMemo(() => {
    return call.inputJson ?? (call.input ? JSON.stringify(call.input, null, 2) : undefined);
  }, [call.inputJson, call.input]);

  const isCallRunning = call.isLoading && !call.result;

  return (
    <div className="group flex flex-col gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex size-6 items-center justify-center rounded bg-[var(--accent-cool)]/10 text-[var(--accent-cool)]">
            <Terminal className="size-3.5" />
          </div>
          <span className="text-sm font-medium text-[var(--ink)]">{call.name}</span>
        </div>
        {isCallRunning && (
          <div className="flex items-center gap-1.5 rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--accent)]">
            <Loader2 className="size-3 animate-spin" />
            <span>执行中</span>
          </div>
        )}
      </div>

      {description && <div className="text-xs text-[var(--ink-muted)]">{description}</div>}

      {inputText && (
        <div className="relative overflow-hidden rounded-md bg-[var(--paper-contrast)] border border-[var(--line-subtle)]">
          <pre className="max-h-32 overflow-y-auto p-2 font-mono text-[10px] text-[var(--ink-secondary)] whitespace-pre-wrap break-words">
            {inputText}
          </pre>
        </div>
      )}

      {call.result && (
        <div className="mt-1">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]">结果</div>
          <pre className="max-h-48 overflow-y-auto rounded-md bg-[var(--paper-contrast)]/50 p-2 font-mono text-[10px] text-[var(--ink-secondary)] whitespace-pre-wrap">
            {call.result}
          </pre>
        </div>
      )}
    </div>
  );
});

// Trace 列表组件 - 显示所有子工具调用记录
const TaskTraceList = memo(function TaskTraceList({ calls }: { calls: SubagentToolCall[] }) {
  return (
    <div id="task-trace-content" className="pl-2 border-l-2 border-[var(--line)]">
      <div className="px-1 pb-2 text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
        调用记录 ({calls.length})
      </div>
      <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
        {calls.map(call => (
          <SubagentCallItem key={call.id} call={call} />
        ))}
      </div>
    </div>
  );
});

export default function TaskTool({ tool }: TaskToolProps) {
  const input = tool.parsedInput as AgentInput;
  const isRunning = tool.isLoading && !tool.result;
  const [traceExpanded, setTraceExpanded] = useState(false);
  const statsBarRef = useRef<HTMLDivElement>(null);

  // Stable callback for toggle - scroll stats bar into view when expanding
  const handleToggleTrace = useCallback(() => {
    setTraceExpanded(prev => {
      const willExpand = !prev;
      if (willExpand) {
        // Double requestAnimationFrame ensures DOM has fully updated before scrolling
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            statsBarRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
        });
      }
      return willExpand;
    });
  }, []);

  // Parse result for completed tasks
  const parsedResult = useMemo<TaskResult | null>(() => {
    if (!tool.result) return null;
    try {
      const parsed = JSON.parse(tool.result);
      if (parsed && (parsed.status || parsed.content)) {
        return parsed as TaskResult;
      }
      return null;
    } catch {
      return null;
    }
  }, [tool.result]);

  // Extract text content from result
  const textContent = useMemo(() => {
    if (!parsedResult?.content) return null;
    return parsedResult.content
      .filter((item) => item.type === 'text' && item.text)
      .map((item) => item.text)
      .join('\n\n');
  }, [parsedResult]);

  if (!input) {
    return <div className="text-sm text-[var(--ink-muted)]">Initializing task...</div>;
  }

  const hasTrace = (tool.subagentCalls?.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-3 text-sm">
      {/* 1. 统计栏 (第一行，可展开 Trace) */}
      <div ref={statsBarRef}>
        {isRunning && tool.taskStartTime && tool.taskStats ? (
          <TaskRunningStats
            startTime={tool.taskStartTime}
            stats={tool.taskStats}
            hasTrace={hasTrace}
            traceExpanded={traceExpanded}
            onToggleTrace={handleToggleTrace}
          />
        ) : parsedResult ? (
          <TaskCompletedStats
            result={parsedResult}
            stats={tool.taskStats}
            hasTrace={hasTrace}
            traceExpanded={traceExpanded}
            onToggleTrace={handleToggleTrace}
          />
        ) : null}
      </div>

      {/* Trace 内容 (展开时显示) */}
      {traceExpanded && hasTrace && (
        <TaskTraceList calls={tool.subagentCalls!} />
      )}

      {/* 2. 探索 Query / Prompt (第二块) */}
      {input.prompt && (
        <div className="rounded-lg bg-[var(--accent-cool)]/10 p-3">
          <CollapsibleContent maxLines={DEFAULT_MAX_LINES}>
            <div className="italic text-[var(--ink-secondary)]">
              &ldquo;{input.prompt}&rdquo;
            </div>
          </CollapsibleContent>
        </div>
      )}

      {/* 3. 生成的结果 (第三块) */}
      {textContent && (
        <div className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-contrast)]/50 p-3">
          <CollapsibleContent maxLines={DEFAULT_MAX_LINES}>
            <div className="text-sm text-[var(--ink)]">
              <Markdown>{textContent}</Markdown>
            </div>
          </CollapsibleContent>
        </div>
      )}

      {/* 非标准结果 (无法解析时显示原始内容) */}
      {tool.result && !parsedResult && (
        <div className="space-y-1.5">
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">输出</div>
          <div className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-contrast)] p-3">
            <CollapsibleContent maxLines={DEFAULT_MAX_LINES}>
              <pre className="font-mono text-sm text-[var(--ink)] whitespace-pre-wrap">
                {tool.result}
              </pre>
            </CollapsibleContent>
          </div>
        </div>
      )}
    </div>
  );
}
