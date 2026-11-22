
import type { AgentInput, BackgroundTaskStats, SubagentToolCall, ToolUseSimple, TaskStats } from '@/types/chat';

import Markdown from '@/components/Markdown';
import { formatDuration, getToolBadgeConfig } from '@/components/tools/toolBadgeConfig';
import {
  getSubagentContainerDurationMs,
  getSubagentContainerLifecycleStatus,
  isBackgroundSubagentTool,
  isSubagentCallRunning,
  isSubagentContainerRunning,
} from '@/components/tools/subagentActivity';
import ToolAttachmentGallery from '@/components/tools/ToolAttachmentGallery';
import BashTool from '@/components/tools/BashTool';
import FilePatchTool from '@/components/tools/FilePatchTool';
import ReadTool from '@/components/tools/ReadTool';
import { ExpandableResult } from '@/components/tools/utils';
import { useTabApiOptional, useTabStateOptional } from '@/context/TabContext';
import { useBackgroundTaskPolling } from '@/hooks/useBackgroundTaskPolling';
import { getBackgroundTaskStatus, isTerminalStatus, BACKGROUND_TASK_STATUS_EVENT, type BackgroundTaskTerminalStatus } from '@/utils/backgroundTaskStatus';
import {
  SuccessIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  CoinsIcon,
  LoaderIcon,
  StopCircleIcon,
  WrenchIcon,
  XCircleIcon,
} from '@/components/icons';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso } from 'react-virtuoso';
import { dshToolDisplayName } from '../../../shared/toolDisplay/dshToolNames';

// Pattern 3 §3.2.3 — virtualize the expanded trace list when subagent calls are
// numerous. Below this threshold the simple flow layout wins (no overscan
// overhead, immediate fit-to-content height); above it Virtuoso pays for
// itself by mounting only the visible window.
const TRACE_VIRTUALIZE_THRESHOLD = 30;

// Constants
const DEFAULT_LINE_HEIGHT = 22;
const DEFAULT_MAX_LINES = 5;
const MAX_TASK_MODEL_PATH_ITEMS = 8;
const MAX_TASK_MODEL_ID_LENGTH = 128;
const MAX_TASK_MODEL_METADATA_ITEMS = 32;

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
  resolvedModel?: string;
  modelsUsed?: string[];
  output_file?: string;  // 后台任务输出文件路径
  outputFile?: string;   // SDK 0.3.220 async_launched output
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

function resolveTaskModels(result: TaskResult | null): string[] {
  if (!result) return [];
  const rawModels: unknown[] = Array.isArray(result.modelsUsed) ? result.modelsUsed : [];
  const normalizeModel = (model: unknown): string | null => {
    if (typeof model !== 'string') return null;
    const normalized = model.trim();
    return normalized.length > 0 && normalized.length <= MAX_TASK_MODEL_ID_LENGTH
      ? normalized
      : null;
  };
  const finalModel = normalizeModel(result.resolvedModel);
  if (rawModels.length > MAX_TASK_MODEL_METADATA_ITEMS) {
    return finalModel ? [finalModel] : [];
  }
  const models: string[] = [];
  const seen = new Set<string>();
  for (const rawModel of rawModels) {
    const model = normalizeModel(rawModel);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
    if (models.length > MAX_TASK_MODEL_PATH_ITEMS) {
      // An incomplete truncated path is misleading; retain only the SDK's
      // authoritative final model for malformed/unexpectedly large payloads.
      return finalModel ? [finalModel] : [];
    }
  }
  if (!finalModel) return models;
  if (!seen.has(finalModel) && models.length >= MAX_TASK_MODEL_PATH_ITEMS) {
    return [finalModel];
  }
  return [...models.filter(model => model !== finalModel), finalModel];
}

// 可折叠内容组件 - 默认最多显示 5 行
function CollapsibleContent({ children, maxLines = DEFAULT_MAX_LINES }: { children: React.ReactNode; maxLines?: number }) {
  const { t } = useTranslation('chat');
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
          <ChevronDownIcon className={`size-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
          <span>{isExpanded ? t('shell.toolChrome.task.collapse') : t('shell.toolChrome.task.expandMore')}</span>
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
  const { t } = useTranslation('chat');
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
          <LoaderIcon className="size-3.5 animate-spin" />
          <span className="font-medium">{t('shell.toolChrome.task.statusRunning')}</span>
        </div>

        {/* 已运行时间 */}
        <div className="flex items-center gap-1">
          <ClockIcon className="size-3.5" />
          <span>{t('shell.toolChrome.task.ranFor', { duration: formatDuration(elapsed) })}</span>
        </div>

        {/* 工具调用次数 */}
        {stats.toolCount > 0 && (
          <div className="flex items-center gap-1">
            <WrenchIcon className="size-3.5" />
            <span>{t('shell.toolChrome.task.toolCalls', { count: stats.toolCount })}</span>
          </div>
        )}

        {/* Token 消耗 */}
        {totalTokens > 0 && (
          <div className="flex items-center gap-1">
            <CoinsIcon className="size-3.5" />
            <span>{t('shell.toolChrome.task.tokenUsage', { tokens: formatTokens(totalTokens) })}</span>
          </div>
        )}
      </div>

      {/* 展开/收起箭头 */}
      {hasTrace && (
        <ChevronRightIcon
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
  const { t } = useTranslation('chat');
  const isSuccess = result.status === 'completed';
  const isError = result.status === 'error';
  const isStopped = result.status === 'stopped';

  const statusIcon = isSuccess ? (
    <SuccessIcon className="size-3.5" />
  ) : isError ? (
    <XCircleIcon className="size-3.5" />
  ) : isStopped ? (
    <StopCircleIcon className="size-3.5" />
  ) : (
    <LoaderIcon className="size-3.5 animate-spin" />
  );

  const statusLabel =
    isSuccess ? t('shell.toolChrome.task.statusCompleted')
    : isError ? t('shell.toolChrome.task.statusError')
    : isStopped ? t('shell.toolChrome.task.statusStopped')
    : t('shell.toolChrome.task.statusRunning');

  const totalTokens = stats
    ? stats.inputTokens + stats.outputTokens
    : result.totalTokens || 0;
  const toolCount = stats?.toolCount || result.totalToolUseCount || 0;
  const duration = result.totalDurationMs;
  const models = resolveTaskModels(result);

  const bgColor = isSuccess
    ? 'bg-[var(--success)]/10 hover:bg-[var(--success)]/15'
    : isError
      ? 'bg-[var(--error)]/10 hover:bg-[var(--error)]/15'
      : isStopped
        ? 'bg-[var(--warning)]/10 hover:bg-[var(--warning)]/15'
      : 'bg-[var(--accent)]/5 hover:bg-[var(--accent)]/10';

  const textColor = isSuccess
    ? 'text-[var(--success)]'
    : isError
      ? 'text-[var(--error)]'
      : isStopped
        ? 'text-[var(--warning)]'
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
            <ClockIcon className="size-3.5" />
            <span>{formatDuration(duration)}</span>
          </div>
        )}

        {/* 工具调用次数 */}
        {toolCount > 0 && (
          <div className="flex items-center gap-1">
            <WrenchIcon className="size-3.5" />
            <span>{t('shell.toolChrome.task.toolCallsShort', { count: toolCount })}</span>
          </div>
        )}

        {/* Token 消耗 */}
        {totalTokens > 0 && (
          <div className="flex items-center gap-1">
            <CoinsIcon className="size-3.5" />
            <span>{t('shell.toolChrome.task.tokenUsage', { tokens: formatTokens(totalTokens) })}</span>
          </div>
        )}

        {models.length > 0 && (
          <div data-task-models="true" className="min-w-0 truncate font-mono">
            {models.length > 1
              ? t('shell.toolChrome.task.modelsUsed', { models: models.join(' → ') })
              : t('shell.toolChrome.task.resolvedModel', { model: models[0] })}
          </div>
        )}
      </div>

      {/* 展开/收起箭头 */}
      {hasTrace && (
        <ChevronRightIcon
          className={`size-4 transition-transform ${traceExpanded ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
      )}
    </button>
  );
}

// 后台任务统计组件
function TaskBackgroundStats({
  stats,
  terminalStatus,
  startTime,
  result,
}: {
  stats: BackgroundTaskStats | null;
  terminalStatus: BackgroundTaskTerminalStatus | null;
  startTime: number;
  result: TaskResult | null;
}) {
  const { t } = useTranslation('chat');
  const [frontendElapsed, setFrontendElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const isDone = terminalStatus !== null;
  const isSuccess = terminalStatus === 'completed';

  useEffect(() => {
    if (isDone) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }

    const rafId = requestAnimationFrame(() => {
      setFrontendElapsed(Date.now() - startTime);
    });

    intervalRef.current = setInterval(() => {
      setFrontendElapsed(Date.now() - startTime);
    }, 1000);

    return () => {
      cancelAnimationFrame(rafId);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [startTime, isDone]);

  // Use backend elapsed if available and larger, otherwise frontend timer
  const elapsed = stats?.elapsed && stats.elapsed > frontendElapsed ? stats.elapsed : frontendElapsed;
  const models = resolveTaskModels(result);

  return (
    <div className="flex w-full items-center justify-between text-xs rounded-lg bg-[var(--accent)]/5 px-3 py-2 cursor-default transition-colors">
      <div className="flex flex-wrap items-center gap-3 text-[var(--ink-muted)]">
        {/* "后台" 标签 */}
        <span className="rounded-full bg-[var(--ink-muted)]/10 px-1.5 py-0.5 text-xs font-medium">
          {t('shell.toolChrome.common.background')}
        </span>

        {/* 状态 */}
        {isDone ? (
          isSuccess ? (
            <div className="flex items-center gap-1.5 text-[var(--success)]">
              <SuccessIcon className="size-3.5" />
              <span className="font-medium">{t('shell.toolChrome.task.backgroundCompleted')}</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-[var(--error)]">
              <XCircleIcon className="size-3.5" />
              <span className="font-medium">{t('shell.toolChrome.task.backgroundFailed')}</span>
            </div>
          )
        ) : (
          <div className="flex items-center gap-1.5 text-[var(--accent)]">
            <LoaderIcon className="size-3.5 animate-spin" />
            <span className="font-medium">{t('shell.toolChrome.task.backgroundRunning')}</span>
          </div>
        )}

        {/* 已运行时间 */}
        {elapsed > 0 && (
          <div className="flex items-center gap-1">
            <ClockIcon className="size-3.5" />
            <span>{formatDuration(elapsed)}</span>
          </div>
        )}

        {/* 工具调用次数 */}
        {stats && stats.toolCount > 0 && (
          <div className="flex items-center gap-1">
            <WrenchIcon className="size-3.5" />
            <span>{t('shell.toolChrome.task.toolCalls', { count: stats.toolCount })}</span>
          </div>
        )}

        {models.length > 0 && (
          <div data-task-models="true" className="min-w-0 truncate font-mono">
            {models.length > 1
              ? t('shell.toolChrome.task.modelsUsed', { models: models.join(' → ') })
              : t('shell.toolChrome.task.resolvedModel', { model: models[0] })}
          </div>
        )}
      </div>
    </div>
  );
}

// 渲染单个子工具调用 - memo 化避免不必要的重渲染
const SubagentCallItem = memo(function SubagentCallItem({ call }: { call: SubagentToolCall }) {
  const { t } = useTranslation('chat');
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

  const isCallRunning = isSubagentCallRunning(call);
  const name = dshToolDisplayName(call.name);
  const isFilePatchCall = name === 'Edit' || name === 'Write' || name === 'MultiEdit';
  const tool: ToolUseSimple = {
    ...call,
    streamIndex: 0,
    parsedInput: call.parsedInput ?? (call.input as ToolUseSimple['parsedInput']),
  };
  const specializedBody = isFilePatchCall ? <FilePatchTool tool={tool} />
    : name === 'Read' ? <ReadTool tool={tool} />
    : ['Bash', 'PowerShell', 'bash', 'pwsh'].includes(name) ? <BashTool tool={tool} /> : null;
  const isPending = call.resultMeta?.status === 'pending';

  return (
    <div className="group flex flex-col gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-6 shrink-0 items-center justify-center rounded bg-[var(--accent-cool)]/10 text-[var(--accent-cool)]">
            {getToolBadgeConfig(call.name).icon}
          </div>
          <span className="min-w-0 truncate text-sm font-medium text-[var(--ink)]">{call.name}</span>
        </div>
        {isCallRunning && (
          <div className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-xs font-medium text-[var(--accent)]">
            {isPending ? <ClockIcon className="size-3" /> : <LoaderIcon className="size-3 animate-spin motion-reduce:animate-none" />}
            <span>{t(isPending ? 'shell.toolChrome.bash.status.pending' : 'shell.toolChrome.common.executing')}</span>
          </div>
        )}
      </div>

      {description && <div className="text-xs text-[var(--ink-muted)]">{description}</div>}

      {specializedBody ?? (inputText && (
        <div className="relative overflow-hidden rounded-md bg-[var(--paper-inset)] border border-[var(--line-subtle)]">
          <pre className="max-h-32 overflow-y-auto p-2 font-mono text-xs text-[var(--ink-secondary)] whitespace-pre-wrap break-words">
            {inputText}
          </pre>
        </div>
      ))}

      {call.result && !specializedBody && (
        <div className="mt-1">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">{t('shell.toolChrome.common.result')}</div>
          <ExpandableResult
            content={call.result}
            className="rounded-md bg-[var(--paper-inset)]/50 p-2 text-xs text-[var(--ink-secondary)]"
          />
        </div>
      )}

      {/* Rich-media produced by the nested sub-agent tool (Codex child
          image_generation etc.) — same uniform gallery as top-level tools. */}
      {call.attachments && call.attachments.length > 0 && (
        <ToolAttachmentGallery attachments={call.attachments} />
      )}
    </div>
  );
});

// Trace 列表组件 - 显示所有子工具调用记录
//
// Pattern 3 §3.2.3 — for short traces (<30 calls) we keep the original
// flow layout (cheap, fits naturally to content). For long traces we
// virtualise via react-virtuoso so a Task with 500 subagent calls only
// mounts the rows currently in view (~10) instead of all 500 at once.
const TaskTraceList = memo(function TaskTraceList({ calls }: { calls: SubagentToolCall[] }) {
  const { t } = useTranslation('chat');
  const itemContent = useCallback((index: number) => {
    const call = calls[index];
    return <SubagentCallItem key={call.id} call={call} />;
  }, [calls]);

  return (
    <div id="task-trace-content" className="pl-2 border-l-2 border-[var(--line)]">
      <div className="px-1 pb-2 text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
        {t('shell.toolChrome.task.traceTitle', { count: calls.length })}
      </div>
      {calls.length < TRACE_VIRTUALIZE_THRESHOLD ? (
        <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
          {calls.map(call => (
            <SubagentCallItem key={call.id} call={call} />
          ))}
        </div>
      ) : (
        <Virtuoso
          totalCount={calls.length}
          itemContent={itemContent}
          style={{ height: '24rem' }}
          className="pr-1"
          increaseViewportBy={200}
        />
      )}
    </div>
  );
});

export default function TaskTool({ tool }: TaskToolProps) {
  const { t } = useTranslation('chat');
  const input = tool.parsedInput as AgentInput;
  const isRunning = isSubagentContainerRunning(tool);
  const lifecycleStatus = getSubagentContainerLifecycleStatus(tool);
  const lifecycleDuration = getSubagentContainerDurationMs(tool);
  const effectiveStartTime = tool.subagentLifecycle?.startedAt ?? tool.taskStartTime;
  const [traceExpanded, setTraceExpanded] = useState(false);
  const statsBarRef = useRef<HTMLDivElement>(null);

  // SDK Task/Agent defaults to background; only explicit run_in_background=false
  // means a foreground synchronous sub-agent.
  const isBackgroundTask = isBackgroundSubagentTool(tool);
  // Stable fallback start time for background tasks (lazy initializer avoids Date.now() on re-render)
  const [bgFallbackStartTime] = useState(() => Date.now());

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
      if (parsed && (parsed.status || parsed.content || parsed.output_file)) {
        return parsed as TaskResult;
      }
      return null;
    } catch {
      return null;
    }
  }, [tool.result]);

  // Background task status matching: use tool.id (= toolUseId) as the lookup key.
  // chat:task-started registers the toolUseId↔taskId mapping in backgroundTaskStatus.ts;
  // chat:task-notification later fires with taskId, which the module bridges back to
  // toolUseId via that mapping. This replaces the old regex-from-text approach which
  // was brittle (SDK text format changes) and fundamentally broken (agentId ≠ taskId).
  const bgToolUseId = isBackgroundTask ? tool.id : null;
  const tabState = useTabStateOptional();
  const backgroundTaskSessionId = tabState?.sessionId ?? null;

  // Terminal status: solely from SDK's task_notification (persisted in module-level Map).
  // Map survives timing races — if notification arrived before mount, we read it on mount.
  const [bgTerminalStatus, setBgTerminalStatus] = useState<BackgroundTaskTerminalStatus | null>(null);
  useEffect(() => {
    if (!isBackgroundTask || !bgToolUseId) return;
    const existing = getBackgroundTaskStatus(bgToolUseId, backgroundTaskSessionId);
    const rafId = requestAnimationFrame(() => setBgTerminalStatus(isTerminalStatus(existing) ? existing : null));
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if ((detail.sessionId ?? null) !== backgroundTaskSessionId) return;
      // Match strictly by toolUseId — the mapping module and server both
      // resolve taskId→toolUseId, so detail.toolUseId is always populated
      // when the mapping was registered at task-started time.
      if (detail.toolUseId === bgToolUseId) {
        cancelAnimationFrame(rafId);
        setBgTerminalStatus(isTerminalStatus(detail.status) ? detail.status : null);
      }
    };
    window.addEventListener(BACKGROUND_TASK_STATUS_EVENT, handler);
    return () => { cancelAnimationFrame(rafId); window.removeEventListener(BACKGROUND_TASK_STATUS_EVENT, handler); };
  }, [isBackgroundTask, bgToolUseId, backgroundTaskSessionId]);

  const bgComplete = bgTerminalStatus !== null;

  // Live stats polling (for tool count display during execution, NOT for completion)
  const outputFileCandidate = parsedResult?.outputFile ?? parsedResult?.output_file;
  const outputFile = isBackgroundTask && typeof outputFileCandidate === 'string'
    ? outputFileCandidate
    : null;
  const tabApi = useTabApiOptional();
  const noopApiPost = useCallback(async <T,>(_path: string, _body?: unknown): Promise<T> => { throw new Error('no apiPost'); }, []);
  const { stats: bgStats } = useBackgroundTaskPolling({
    outputFile,
    isActive: !tool.subagentLifecycle && isBackgroundTask && !!outputFile && !isRunning && !bgComplete,
    apiPost: tabApi?.apiPost ?? noopApiPost
  });

  // Show background stats when task is background, not running in foreground,
  // and main Agent hasn't provided a final status yet.
  // Keep showing even when bgComplete=true so TaskBackgroundStats renders "后台完成/失败".
  // Only dismiss when parsedResult gets a real completion/error status (e.g. from Phase 4 SSE).
  const showBackgroundStats = !tool.subagentLifecycle && isBackgroundTask && !isRunning
    && parsedResult?.status !== 'completed' && parsedResult?.status !== 'error';

  // Extract text content from result
  const textContent = useMemo(() => {
    if (tool.subagentLifecycle?.result !== undefined) return tool.subagentLifecycle.result;
    if (!parsedResult?.content) return null;
    return parsedResult.content
      .filter((item) => item.type === 'text' && item.text)
      .map((item) => item.text)
      .join('\n\n');
  }, [parsedResult, tool.subagentLifecycle?.result]);

  if (!input) {
    return <div className="text-sm text-[var(--ink-muted)]">{t('shell.toolChrome.task.initializing')}</div>;
  }

  const hasTrace = (tool.subagentCalls?.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-3 text-sm select-none">
      {tool.subagentLifecycle?.status === 'completed' && tool.subagentLifecycle.handleState === 'open' && (
        <span className="text-xs text-[var(--success)]">{t('shell.toolChrome.common.completedContinuable')}</span>
      )}
      {/* 1. 统计栏 (第一行，可展开 Trace) */}
      <div ref={statsBarRef}>
        {isRunning && effectiveStartTime ? (
          <TaskRunningStats
            startTime={effectiveStartTime}
            stats={tool.taskStats ?? { toolCount: tool.subagentCalls?.length ?? 0, inputTokens: 0, outputTokens: 0 }}
            hasTrace={hasTrace}
            traceExpanded={traceExpanded}
            onToggleTrace={handleToggleTrace}
          />
        ) : showBackgroundStats ? (
          <TaskBackgroundStats
            stats={bgStats}
            terminalStatus={bgTerminalStatus}
            startTime={tool.taskStartTime || bgFallbackStartTime}
            result={parsedResult}
          />
        ) : parsedResult ? (
          <TaskCompletedStats
            result={parsedResult}
            stats={tool.taskStats}
            hasTrace={hasTrace}
            traceExpanded={traceExpanded}
            onToggleTrace={handleToggleTrace}
          />
        ) : lifecycleStatus && lifecycleStatus !== 'running' ? (
          <TaskCompletedStats
            result={{
              status: lifecycleStatus === 'completed'
                ? 'completed'
                : lifecycleStatus === 'interrupted' ? 'stopped' : 'error',
              totalDurationMs: lifecycleDuration ?? undefined,
            }}
            stats={tool.taskStats ?? { toolCount: tool.subagentCalls?.length ?? 0, inputTokens: 0, outputTokens: 0 }}
            hasTrace={hasTrace}
            traceExpanded={traceExpanded}
            onToggleTrace={handleToggleTrace}
          />
        ) : hasTrace ? (
          // PRD 0.2.27 — Codex collab cards have a nested trace but no JSON result
          // and may lack taskStartTime. Without this branch the trace toggle would
          // be unreachable. Synthesize a status-aware stats row so the toggle shows;
          // toolCount falls back to subagentCalls length on history replay (no taskStats).
          <TaskCompletedStats
            result={{ status: isRunning ? 'pending' : (tool.isError ? 'error' : 'completed') }}
            stats={tool.taskStats ?? { toolCount: tool.subagentCalls?.length ?? 0, inputTokens: 0, outputTokens: 0 }}
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
            <div className="italic text-[var(--ink-secondary)] select-text">
              &ldquo;{input.prompt}&rdquo;
            </div>
          </CollapsibleContent>
        </div>
      )}

      {/* 3. 生成的结果 (第三块) */}
      {textContent && (
        <div className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-inset)]/50 p-3">
          <CollapsibleContent maxLines={DEFAULT_MAX_LINES}>
            <div className="text-sm text-[var(--ink)] select-text">
              <Markdown>{textContent}</Markdown>
            </div>
          </CollapsibleContent>
        </div>
      )}

      {/* 非标准结果 (无法解析时显示原始内容) */}
      {tool.result && !parsedResult && (
        <div className="space-y-1.5">
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">{t('shell.toolChrome.task.output')}</div>
          <div className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-inset)] p-3">
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
