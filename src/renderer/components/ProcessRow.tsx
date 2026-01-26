
import { AlertCircle, Brain, ChevronDown, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import Markdown from '@/components/Markdown';
import {
    getToolBadgeConfig,
    getToolLabel
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
    const [isExpanded, setIsExpanded] = useState(false);
    const [userManuallyOpened, setUserManuallyOpened] = useState(false);
    const prevIsBlockActiveRef = useRef(false);

    const isThinking = block.type === 'thinking';
    const isTool = block.type === 'tool_use';
    const isLastBlock = index === totalBlocks - 1;

    // Issue 1: 改进 loading 判断逻辑
    // - Thinking: 没有 isComplete 就是 loading
    // - Tool: 有下一个 block 就结束了，或者有 result 就结束了
    const isThinkingActive = isThinking && block.isComplete !== true;

    // Tool loading 逻辑改进：
    // 1. 如果不是最后一个 block，说明后面有更多内容了，这个工具已完成
    // 2. 如果是最后一个 block 且正在 streaming，需要检查是否有 result
    // 3. 有 result 就完成了
    const isToolActive = isTool && isLastBlock && isStreaming && !block.tool?.result;

    const isBlockActive = isThinkingActive || isToolActive;

    // Issue 3: 自动展开/折叠逻辑
    useEffect(() => {
        const wasActive = prevIsBlockActiveRef.current;

        if (isBlockActive && !wasActive) {
            // Block just became active -> expand
            setIsExpanded(true);
        } else if (!isBlockActive && wasActive && !userManuallyOpened) {
            // Block just completed and user didn't manually open -> collapse
            setIsExpanded(false);
        }

        prevIsBlockActiveRef.current = isBlockActive;
    }, [isBlockActive, userManuallyOpened]);

    // If this becomes the latest active block, auto expand
    useEffect(() => {
        if (isLastBlock && isStreaming && isBlockActive) {
            setIsExpanded(true);
        }
    }, [isLastBlock, isStreaming, isBlockActive]);

    // Handle user click - track manual interaction
    const handleToggle = () => {
        if (!hasContent) return;
        const newState = !isExpanded;
        setIsExpanded(newState);
        if (newState) {
            setUserManuallyOpened(true);
        }
    };

    // Build display content
    let icon = null;
    let mainLabel = '';
    let subLabel = '';

    if (isThinking) {
        // Issue: 正确的思考标题 - "思考中…" vs "思考了 Xs"
        if (isThinkingActive) {
            mainLabel = '思考中…';
            icon = <Loader2 className="size-4 animate-spin" />;
        } else {
            const durationSec = block.thinkingDurationMs ? Math.round(block.thinkingDurationMs / 1000) : 0;
            mainLabel = durationSec > 0 ? `思考了 ${durationSec}s` : '思考完成';
            icon = <Brain className="size-4" />;
        }
    } else if (isTool && block.tool) {
        const config = getToolBadgeConfig(block.tool.name);
        const toolLabel = getToolLabel(block.tool);

        // 工具名在前（深色粗体），内容描述在后（浅色）
        mainLabel = block.tool.name;
        subLabel = toolLabel !== block.tool.name ? toolLabel : '';

        // Loading 判断：有后续 block 或有 result 就不 loading
        if (isToolActive) {
            icon = <Loader2 className="size-4 animate-spin" />;
        } else if (block.tool.isError) {
            icon = <AlertCircle className="size-4 text-[var(--error)]" />;
        } else {
            icon = config.icon;
        }
    }

    const hasContent =
        (isThinking && block.thinking && block.thinking.length > 0) ||
        (isTool && block.tool && (block.tool.inputJson || block.tool.result || block.tool.subagentCalls?.length));

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
                    {subLabel && subLabel !== mainLabel && (
                        <span className="text-xs text-[var(--ink-muted)] font-mono">
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
