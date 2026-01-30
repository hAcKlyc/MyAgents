
import { AlertCircle, Brain, ChevronDown, Loader2, XCircle, StopCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import Markdown from '@/components/Markdown';
import {
    formatDuration,
    getToolBadgeConfig,
    getToolLabel,
    getToolMainLabel
} from '@/components/tools/toolBadgeConfig';
import ToolUse from '@/components/ToolUse';
import type { ContentBlock } from '@/types/chat';

interface ProcessRowProps {
    block: ContentBlock;
    index: number;
    totalBlocks: number;
    isStreaming?: boolean;
}

export default function ProcessRow({
    block,
    index,
    totalBlocks,
    isStreaming = false
}: ProcessRowProps) {
    // User manually toggled state (null = not toggled, true/false = user choice)
    const [userToggled, setUserToggled] = useState<boolean | null>(null);
    // Task tool elapsed time (for running tasks)
    const [taskElapsed, setTaskElapsed] = useState(0);
    const taskTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

    const isThinking = block.type === 'thinking';
    const isTool = block.type === 'tool_use' || block.type === 'server_tool_use';
    const isServerTool = block.type === 'server_tool_use';
    const isLastBlock = index === totalBlocks - 1;
    const isTaskTool = isTool && !isServerTool && block.tool?.name === 'Task';

    // Thinking: 没有 isComplete 就是 active
    const isThinkingActive = isThinking && block.isComplete !== true;

    // Tool: 是最后一个 block 且正在 streaming 且没有 result 就是 active
    const isToolActive = isTool && isLastBlock && isStreaming && !block.tool?.result;
    const isTaskRunning = isTaskTool && block.tool?.isLoading && !block.tool?.result;

    const isBlockActive = isThinkingActive || isToolActive;

    // Task tool timer - update elapsed time every second while running
    useEffect(() => {
        if (!isTaskRunning || !block.tool?.taskStartTime) {
            if (taskTimerRef.current) {
                clearInterval(taskTimerRef.current);
                taskTimerRef.current = undefined;
            }
            return;
        }

        const startTime = block.tool.taskStartTime;

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
    }, [isTaskRunning, block.tool?.taskStartTime]);

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

        return null;
    }, [isTaskTool, block.tool, isTaskRunning, taskElapsed, taskParsedResult]);

    // Check if block has expandable content
    const hasContent =
        (isThinking && block.thinking && block.thinking.length > 0) ||
        (isTool && block.tool && (block.tool.inputJson || block.tool.result || block.tool.subagentCalls?.length));

    // 派生展开状态（无 useEffect，避免无限循环）
    // 规则：
    // 1. 如果用户手动切换过，使用用户的选择
    // 2. 否则，thinking 块在 active 时自动展开
    // 3. tool 块默认不展开
    const isExpanded = userToggled !== null
        ? userToggled
        : (isThinking && isThinkingActive);

    // Handle user click
    const handleToggle = () => {
        if (!hasContent) return;
        setUserToggled(prev => prev === null ? true : !prev);
    };

    // Build display content
    let icon = null;
    let mainLabel = '';
    let subLabel = '';

    if (isThinking) {
        const durationSec = block.thinkingDurationMs ? Math.round(block.thinkingDurationMs / 1000) : 0;
        if (isThinkingActive) {
            mainLabel = '思考中…';
            icon = <Loader2 className="size-4 animate-spin" />;
        } else if (block.isFailed) {
            mainLabel = durationSec > 0 ? `思考失败 (${durationSec}s)` : '思考失败';
            icon = <XCircle className="size-4 text-[var(--error)]" />;
        } else if (block.isStopped) {
            mainLabel = durationSec > 0 ? `思考中断 (${durationSec}s)` : '思考中断';
            icon = <StopCircle className="size-4 text-[var(--warning)]" />;
        } else {
            mainLabel = durationSec > 0 ? `思考了 ${durationSec}s` : '思考完成';
            icon = <Brain className="size-4" />;
        }
    } else if (isTool && block.tool) {
        const config = getToolBadgeConfig(block.tool.name);
        const toolLabel = getToolLabel(block.tool);

        mainLabel = getToolMainLabel(block.tool);
        subLabel = toolLabel !== mainLabel ? toolLabel : '';

        if (isToolActive) {
            icon = <Loader2 className="size-4 animate-spin" />;
        } else if (block.tool.isFailed) {
            icon = <XCircle className="size-4 text-[var(--error)]" />;
        } else if (block.tool.isStopped) {
            icon = <StopCircle className="size-4 text-[var(--warning)]" />;
        } else if (block.tool.isError) {
            icon = <AlertCircle className="size-4 text-[var(--error)]" />;
        } else {
            icon = config.icon;
        }
    }

    return (
        <div className={`group ${index < totalBlocks - 1 ? 'border-b border-[var(--line-subtle)]' : ''}`}>
            <button
                type="button"
                onClick={handleToggle}
                disabled={!hasContent}
                className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${hasContent ? 'cursor-pointer hover:bg-[var(--paper-contrast)]' : 'cursor-default'
                    }`}
            >
                {/* Left indicator dot - smaller */}
                <div className={`flex size-1.5 shrink-0 rounded-full ${isBlockActive
                    ? 'bg-[var(--warning)] animate-pulse'
                    : block.isFailed || block.tool?.isFailed
                        ? 'bg-[var(--error)]'
                        : block.isStopped || block.tool?.isStopped
                            ? 'bg-[var(--warning)]'
                            : isThinking
                                ? 'bg-[var(--accent-cool)]'
                                : 'bg-[var(--ink-muted)]/40'
                    }`} />

                {/* Icon - fixed size container */}
                <div className={`flex size-4 shrink-0 items-center justify-center ${isThinking
                    ? 'text-[var(--accent-cool)]'
                    : 'text-[var(--ink-muted)]'
                    } [&>svg]:size-4`}>
                    {icon}
                </div>

                {/* Main Label */}
                <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className={`text-sm leading-snug ${isThinking
                        ? 'text-[var(--ink-secondary)]'
                        : 'text-[var(--ink)] font-medium'
                        }`}>
                        {mainLabel}
                    </span>
                    {/* Task duration - similar to thinking duration */}
                    {taskDuration && (
                        <span className="text-xs text-[var(--ink-muted)]">
                            {taskDuration}
                        </span>
                    )}
                    {subLabel && subLabel !== mainLabel && (
                        <span className="text-xs text-[var(--ink-muted)] font-mono truncate">
                            {subLabel}
                        </span>
                    )}
                </div>

                {/* Chevron */}
                {hasContent && (
                    <ChevronDown className={`size-4 text-[var(--ink-muted)] transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''
                        }`} />
                )}
            </button>

            {/* Expanded Body - CSS Grid animation for smooth height transition */}
            {hasContent && (
                <div
                    className="grid transition-[grid-template-rows] duration-200 ease-out"
                    style={{ gridTemplateRows: isExpanded ? '1fr' : '0fr' }}
                >
                    <div className="overflow-hidden">
                        <div className="border-t border-[var(--line)] bg-[var(--paper-elevated)]/50 px-4 pb-4 pt-3">
                            <div className="ml-7">
                                {isThinking && block.thinking && (
                                    <div className="text-[var(--ink-secondary)]">
                                        <Markdown compact>{block.thinking}</Markdown>
                                    </div>
                                )}
                                {isTool && block.tool && (
                                    <div className="w-full overflow-hidden">
                                        <ToolUse tool={block.tool} />
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
