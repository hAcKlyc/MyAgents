
import {
  BrainIcon,
  ChevronDownIcon,
  ImageIcon,
  XCircleIcon,
  StopCircleIcon,
  CopyIcon,
  CheckIcon,
  DownloadIcon,
} from '@/components/icons';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { track } from '@/analytics';
import Markdown from '@/components/Markdown';
import Tip from '@/components/Tip';
import { useToastOptional } from '@/components/Toast';
import { useNotifyRowLayoutChanged } from '@/context/ChatRowLayoutContext';
import { buildThinkingMarkdown, downloadMarkdown, localDateStr } from '@/utils/markdownExport';
import { copyPlainText } from '@/utils/clipboard';
import {
    formatDuration,
    getToolBadgeConfig,
    getToolMainLabel,
    getToolActionLabel,
    getToolSummaryNode,
    isSubagentContainerTool
} from '@/components/tools/toolBadgeConfig';
import {
    getSubagentContainerDurationMs,
    getSubagentContainerLifecycleStatus,
    isBackgroundSubagentTool,
} from '@/components/tools/subagentActivity';
import ToolUse, { hasToolResultContent } from '@/components/ToolUse';
import ProcessStatus from './ProcessStatus';
import { getProcessOutcome } from '@/utils/processPresentation';
import { processResultLabel } from '@/utils/processResults';
import ProcessTiming from './ProcessTiming';
import ToolAttachmentGallery from '@/components/tools/ToolAttachmentGallery';
import type { ContentBlock } from '@/types/chat';

interface ProcessRowProps {
    block: ContentBlock;
    index: number;
    totalBlocks: number;
    isStreaming?: boolean;
    resultFirst?: boolean;
    resultLabel?: string;
    expandedOverride?: boolean;
    onExpansionChange?: (expanded: boolean) => void;
    // Called when the user EXPANDS this row. The parent BlockGroup uses it to
    // suppress its auto-fold for the turn — otherwise folding would unmount a
    // row the user deliberately opened and silently lose its expanded state.
    onUserExpand?: () => void;
}

const ProcessRow = memo(function ProcessRow({
    block,
    index,
    totalBlocks,
    isStreaming = false,
    resultFirst = false,
    resultLabel,
    expandedOverride,
    onExpansionChange,
    onUserExpand
}: ProcessRowProps) {
    // User manually toggled state (null = not toggled, true/false = user choice)
    const [userToggled, setUserToggled] = useState<boolean | null>(null);
    // Thinking elapsed time (real-time timer while thinking is active)
    const [thinkingElapsed, setThinkingElapsed] = useState(0);
    const thinkingTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
    // Task tool elapsed time (for running tasks)
    const [taskElapsed, setTaskElapsed] = useState(0);
    const taskTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
    // Thinking-block copy feedback (icon swap, auto-resets after 1.5s)
    const [thinkingCopied, setThinkingCopied] = useState(false);
    const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const exportingRef = useRef(false);
    const toast = useToastOptional();
    const { t } = useTranslation('chat');
    const notifyRowLayoutChanged = useNotifyRowLayoutChanged();

    useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);

    const isThinking = block.type === 'thinking';
    const isTool = block.type === 'tool_use' || block.type === 'server_tool_use';
    const isServerTool = block.type === 'server_tool_use';
    const outcome = getProcessOutcome(block, isStreaming);
    const providerOutcome = isServerTool ? outcome : undefined;
    const isTaskTool = isTool && !isServerTool && !!block.tool?.name && isSubagentContainerTool(block.tool.name);
    const isFilePatchTool = isTool
        && !isServerTool
        && (block.tool?.name === 'Edit' || block.tool?.name === 'Write'
            || block.tool?.name === 'edit' || block.tool?.name === 'write');

    // Thinking: 没有 isComplete 且正在 streaming 才是 active（避免历史消息计时器永跑）
    const isThinkingActive = isThinking && outcome === 'running';

    // Parallel tools use their own outcome; child lifecycle can outlive the parent turn.
    const isTaskRunning = isTaskTool && outcome === 'running';
    const subagentLifecycleStatus = isTaskTool
        ? getSubagentContainerLifecycleStatus(block.tool)
        : null;
    const isToolActive = isTool && outcome === 'running';

    const wasToolActiveRef = useRef(false);

    useLayoutEffect(() => {
        const isAnyToolActive = isTool && (isToolActive || isTaskRunning);
        if (wasToolActiveRef.current && !isAnyToolActive) {
            notifyRowLayoutChanged('tool-complete');
        }
        wasToolActiveRef.current = isAnyToolActive;
    }, [isTool, isToolActive, isTaskRunning, notifyRowLayoutChanged]);

    // Thinking timer - update elapsed time every second while thinking is active
    useEffect(() => {
        if (!isThinkingActive || !block.thinkingStartedAt) {
            if (thinkingTimerRef.current) {
                clearInterval(thinkingTimerRef.current);
                thinkingTimerRef.current = undefined;
            }
            // Use rAF to avoid synchronous setState in effect body (react-hooks/set-state-in-effect)
            const resetId = requestAnimationFrame(() => setThinkingElapsed(0));
            return () => cancelAnimationFrame(resetId);
        }

        const startTime = block.thinkingStartedAt;
        const rafId = requestAnimationFrame(() => {
            setThinkingElapsed(Date.now() - startTime);
        });

        thinkingTimerRef.current = setInterval(() => {
            setThinkingElapsed(Date.now() - startTime);
        }, 1000);

        return () => {
            cancelAnimationFrame(rafId);
            if (thinkingTimerRef.current) {
                clearInterval(thinkingTimerRef.current);
                thinkingTimerRef.current = undefined;
            }
        };
    }, [isThinkingActive, block.thinkingStartedAt]);

    // Task tool timer - update elapsed time every second while running
    useEffect(() => {
        const startTime = block.tool?.subagentLifecycle?.startedAt ?? block.tool?.taskStartTime;
        if (!isTaskRunning || !startTime) {
            if (taskTimerRef.current) {
                clearInterval(taskTimerRef.current);
                taskTimerRef.current = undefined;
            }
            return;
        }

        // Use requestAnimationFrame to set initial value asynchronously (avoids lint warning)
        const rafId = requestAnimationFrame(() => {
            setTaskElapsed(Date.now() - startTime);
        });

        // Update every second
        taskTimerRef.current = setInterval(() => {
            setTaskElapsed(Date.now() - startTime);
        }, 1000);

        return () => {
            cancelAnimationFrame(rafId);
            if (taskTimerRef.current) {
                clearInterval(taskTimerRef.current);
                taskTimerRef.current = undefined;
            }
        };
    }, [isTaskRunning, block.tool?.subagentLifecycle?.startedAt, block.tool?.taskStartTime]);

    // Parse Task result once (memoized to avoid repeated JSON parsing)
    const taskParsedResult = useMemo(() => {
        if (!isTaskTool || !block.tool?.result) return null;
        try {
            return JSON.parse(block.tool.result) as { totalDurationMs?: number };
        } catch {
            return null;
        }
    }, [isTaskTool, block.tool?.result]);

    // Get Task duration (running: from state, completed: from result)
    const taskDuration = useMemo(() => {
        if (!isTaskTool || !block.tool) return null;

        if (isTaskRunning && taskElapsed > 0) {
            return formatDuration(taskElapsed);
        }

        if (taskParsedResult?.totalDurationMs) {
            return formatDuration(taskParsedResult.totalDurationMs);
        }

        const lifecycleDuration = getSubagentContainerDurationMs(block.tool);
        if (lifecycleDuration !== null) return formatDuration(lifecycleDuration);

        return null;
    }, [isTaskTool, block.tool, isTaskRunning, taskElapsed, taskParsedResult]);

    // Check if block has expandable content
    // #293 — PROCESS media (Playwright / computer-use screenshots) renders
    // INSIDE this folded row, not in the conversation flow (Message.tsx hoists
    // only artifact attachments). Memoized: attachments identity changes only
    // when the tool state object is replaced by an SSE update.
    const processAttachments = useMemo(
        () => (isTool ? (block.tool?.attachments ?? []).filter((a) => a.presentation === 'process') : []),
        [isTool, block.tool?.attachments],
    );

    // In result-first mode, input JSON alone does not make a useful result
    // body. Keep input-driven patch/plan/child renderers reachable, but avoid
    // chevrons that only open an empty/awaiting generic result.
    const inputDrivenResult = isTaskTool || isFilePatchTool || (isTool && block.tool
        && ['MultiEdit', 'NotebookEdit', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'].includes(block.tool.name));
    const hasContent = Boolean(
        (isThinking && block.thinking?.trim()) ||
        (isTool && block.tool && (
            (resultFirst ? inputDrivenResult && block.tool.inputJson : block.tool.inputJson || block.tool.isLoading)
            || (resultFirst ? hasToolResultContent(block.tool) : block.tool.result?.trim())
            || block.tool.subagentCalls?.length || processAttachments.length > 0
        )));

    // 派生展开状态（无 useEffect，避免无限循环）
    // thinking 与 tool 块都默认折叠，只由用户手动点击展开。
    // thinking 块刻意不再随 streaming 自动展开、完成后自动收起——那个"展开→收起"
    // 会在流式时让页面上下跳动，体验差。折叠态仍通过 "思考中… (Xs)" 标签 + active
    // 指示实时反馈思考进行中（见 isThinkingActive / mainLabel），不影响可感知性。
    const isExpanded = expandedOverride ?? userToggled ?? false;

    // Handle user click
    const handleToggle = () => {
        if (!hasContent) return;
        const willExpand = !isExpanded;
        notifyRowLayoutChanged(willExpand ? 'process-row-expand' : 'process-row-collapse');
        setUserToggled(willExpand);
        onExpansionChange?.(willExpand);
        // Signal the parent group on EXPAND so it can pin its layout (stop the
        // auto-fold that would unmount this row and drop the just-opened state).
        if (willExpand) onUserExpand?.();
    };

    const handleCopyThinking = () => {
        if (!block.thinking) return;
        void copyPlainText(block.thinking).then(() => {
            track('thinking_copy', {});
            setThinkingCopied(true);
            if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
            copyTimerRef.current = setTimeout(() => setThinkingCopied(false), 1500);
        }).catch(error => {
            console.warn('[ProcessRow] Failed to copy thinking:', error);
            toast?.error(t('workspaceFiles.common.copyFailed'));
        });
    };

    const handleExportThinking = async () => {
        // In-flight guard: a rapid double-click would otherwise fire two
        // downloads + two toasts for the same file.
        if (!block.thinking || exportingRef.current) return;
        exportingRef.current = true;
        try {
            track('thinking_export', {});
            const fileName = `${localDateStr()}_${t('shell.toolChrome.thinking.exportFilename')}.md`;
            toast?.success(await downloadMarkdown(fileName, buildThinkingMarkdown(block.thinking)));
        } finally {
            exportingRef.current = false;
        }
    };

    // Build display content
    let icon = null;
    let mainLabel = '';
    let subLabel = '';
    // Summary node — small surfaced result detail next to subLabel (Edit +N -M, Grep N matches…).
    // Plain ReactNode (each tool picks its own color). Computed inline: ProcessRow is
    // already wrapped in React.memo so we only render when `block` changes, and the
    // React Compiler handles further optimization. Manual useMemo with granular deps
    // would defeat compiler auto-memoization.
    const summaryNode = !resultFirst && isTool && block.tool && outcome === 'succeeded' ? getToolSummaryNode(block.tool, t) : null;

    if (isThinking) {
        const durationSec = block.thinkingDurationMs ? Math.floor(block.thinkingDurationMs / 1000) : 0;
        if (isThinkingActive) {
            const elapsedSec = thinkingElapsed > 0 ? Math.floor(thinkingElapsed / 1000) : 0;
            mainLabel = elapsedSec > 0 ?
                t('shell.toolChrome.thinking.activeWithSeconds', { seconds: elapsedSec })
                : t('shell.toolChrome.thinking.active');
            icon = <BrainIcon className="size-4" />;
        } else if (block.isFailed) {
            mainLabel = durationSec > 0 ?
                t('shell.toolChrome.thinking.failedWithSeconds', { seconds: durationSec })
                : t('shell.toolChrome.thinking.failed');
            icon = <XCircleIcon className="size-4 text-[var(--error)]" />;
        } else if (block.isStopped) {
            mainLabel = durationSec > 0 ?
                t('shell.toolChrome.thinking.stoppedWithSeconds', { seconds: durationSec })
                : t('shell.toolChrome.thinking.stopped');
            icon = <StopCircleIcon className="size-4 text-[var(--warning)]" />;
        } else if (outcome === 'unknown') {
            mainLabel = t('process.thinkingRecord');
            icon = <BrainIcon className="size-4" />;
        } else {
            mainLabel = t('shell.toolChrome.thinking.completedWithSeconds', { seconds: Math.max(durationSec, 1) });
            icon = <BrainIcon className="size-4" />;
        }
    } else if (isTool && block.tool) {
        const config = getToolBadgeConfig(block.tool.name);
        mainLabel = getToolActionLabel(block.tool, t);
        subLabel = getToolMainLabel(block.tool, t);

        // Tool identity and execution state have separate visual roles.
        icon = config.icon;
    }

    if (resultFirst) {
        mainLabel = resultLabel ?? processResultLabel({ block, index, outcome }, t);
        subLabel = '';
    }

    // PRD 0.2.17 Agent Status Panel：当本 row 是 Task/Agent 工具时挂 data-tool-id 锚点。
    // 必须放在最外层（不是 TaskTool 内部），这样折叠态/展开态都保留锚点；点击 panel 行
    // 跳转能 scrollIntoView 到这里。
    const toolAnchorId = isTaskTool ? block.tool?.id : undefined;
    return (
        <div
            className={`group select-none ${index < totalBlocks - 1 ? 'border-b border-[var(--line-subtle)]' : ''}`}
            data-tool-id={toolAnchorId}
            data-process-row={outcome}
        >
            <button
                type="button"
                onClick={handleToggle}
                disabled={!hasContent}
                aria-expanded={hasContent ? isExpanded : undefined}
                className={`flex w-full items-center gap-3 ${resultFirst ? `px-3 ${isThinking ? 'py-1.5' : 'py-2'}` : 'px-4 py-2.5'} text-left transition-colors ${hasContent ? 'cursor-pointer hover:bg-[var(--hover-bg)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]' : 'cursor-default'
                    }`}
            >
                {/* Icon - fixed size container */}
                {!resultFirst && <div className={`flex size-4 shrink-0 items-center justify-center text-[var(--ink-muted)] [&>svg]:size-4`}>
                    {icon}
                </div>}

                {/* Main Label */}
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={`min-w-0 break-words text-sm leading-snug ${isThinking
                        ? 'text-[var(--ink-secondary)]'
                        : 'text-[var(--ink)] font-medium'
                        }`}>
                        {mainLabel}
                    </span>
                    {/* Background task badge */}
                    {isServerTool && (
                        <span
                            data-provider-owned="true"
                            data-provider-outcome={providerOutcome}
                            className="rounded-full bg-[var(--accent)]/10 px-1.5 py-0.5 text-xs font-medium text-[var(--accent)]"
                        >
                            {t('shell.toolChrome.common.providerOwned')} · {t(`shell.toolChrome.common.providerOutcome.${providerOutcome ?? 'unknown'}`)}
                        </span>
                    )}
                    {isTaskTool && isBackgroundSubagentTool(block.tool) && (
                        <span className="rounded-full bg-[var(--accent)]/10 px-1.5 py-0.5 text-xs font-medium text-[var(--accent)]">
                            {t('shell.toolChrome.common.background')}
                        </span>
                    )}
                    {/* Task duration - similar to thinking duration */}
                    {isTaskTool && subagentLifecycleStatus === 'completed' && block.tool?.subagentLifecycle?.handleState === 'open' && (
                        <span className="text-xs text-[var(--success)]" data-subagent-continuable="true">
                            {t('shell.toolChrome.common.completedContinuable')}
                        </span>
                    )}
                    {taskDuration && !resultFirst && (
                        <span className="text-xs text-[var(--ink-muted)]">
                            {taskDuration}
                        </span>
                    )}
                    {subLabel && subLabel !== mainLabel && (
                        <span className="text-xs text-[var(--ink-secondary)]">
                            {subLabel}
                        </span>
                    )}
                    {/* #293 — process-media badge: screenshots live inside this fold;
                        the badge is the collapsed-state affordance that they exist. */}
                    {processAttachments.length > 0 && (
                        <span className="flex shrink-0 items-center gap-0.5 text-xs text-[var(--ink-muted)]">
                            <ImageIcon className="size-3" />
                            {processAttachments.length > 1 ? `×${processAttachments.length}` : ''}
                        </span>
                    )}
                    {summaryNode && <span className="shrink-0 text-xs leading-none">{summaryNode}</span>}
                    {resultFirst && <span className="w-full"><ProcessTiming blocks={[block]} running={outcome === 'running'} /></span>}
                </div>

                <ProcessStatus outcome={outcome} compact={resultFirst && outcome === 'succeeded'} />

                {/* Chevron */}
                {hasContent && (
                    <ChevronDownIcon className={`size-4 text-[var(--ink-muted)] transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''
                        }`} />
                )}
            </button>

            {/* Expanded Body — Pattern 3 §3.2.3 (Collapse = unmount).
                Previously the body was always mounted under `gridTemplateRows: 0fr`
                — a 100-tool tab would mount 100 ToolUse / Markdown subtrees and
                pay re-render cost on every streaming delta even though they
                are visually collapsed. Now we only mount the body when the
                row is actually expanded; the cheap header (chevron / label)
                stays so the affordance is preserved. The CSS-grid animation
                still plays for the duration the body is mounted, giving the
                same expand/collapse easing on toggles. */}
            {hasContent && isExpanded && (
                <div className="grid grid-rows-[1fr] transition-[grid-template-rows] duration-200 ease-out">
                    <div className="overflow-hidden">
                        <div className="border-t border-[var(--line)] bg-[var(--paper-elevated)]/50 px-4 pb-4 pt-3">
                            <div
                                data-process-body-layout={isFilePatchTool || resultFirst ? 'full' : 'indented'}
                                className={isFilePatchTool || resultFirst ? '' : 'ml-7'}
                            >
                                {isThinking && block.thinking && (
                                    <div className="group/think text-[var(--ink-secondary)] select-text">
                                        <Markdown compact>{block.thinking}</Markdown>
                                        {!isThinkingActive && (
                                            <div className="-ml-2 mt-2 flex select-none items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/think:opacity-100 focus-within:opacity-100">
                                                <Tip label={thinkingCopied ? t('shell.toolChrome.common.copied') : t('shell.toolChrome.common.copy')}>
                                                    <button type="button"
                                                        aria-label={t('shell.toolChrome.thinking.copyAria')}
                                                        onClick={handleCopyThinking}
                                                        className="compact-action text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
                                                        {thinkingCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
                                                    </button>
                                                </Tip>
                                                <Tip label={t('shell.toolChrome.common.exportMarkdown')}>
                                                    <button type="button"
                                                        aria-label={t('shell.toolChrome.thinking.exportAria')}
                                                        onClick={handleExportThinking}
                                                        className="compact-action text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
                                                        <DownloadIcon className="size-3.5" />
                                                    </button>
                                                </Tip>
                                            </div>
                                        )}
                                    </div>
                                )}
                                {isTool && block.tool && (
                                    <div className="w-full overflow-hidden select-text">
                                        <ToolUse tool={block.tool} resultOnly={resultFirst} />
                                        {/* #293 — process media (screenshots) renders here inside the
                                            fold, the inverse of the PRD 0.2.30 artifact hoist: these
                                            are the AI's working captures, not deliverables, so they
                                            must NOT occupy the conversation flow. */}
                                        {processAttachments.length > 0 && (
                                            <div className="mt-3">
                                                <ToolAttachmentGallery attachments={processAttachments} />
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
});

export default ProcessRow;
