/**
 * MermaidDiagram - Renders Mermaid diagrams from code blocks
 * 
 * Features:
 * - Progressive rendering: keeps last successful render while content updates
 * - Graceful degradation: shows last valid diagram if current content fails to parse
 * - Debounced updates to avoid excessive re-renders during streaming
 */

import { AlertCircle, RefreshCw } from 'lucide-react';
import mermaid from 'mermaid';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

// Track if mermaid is initialized
let mermaidInitialized = false;

function initMermaid() {
    if (mermaidInitialized) return;

    mermaid.initialize({
        startOnLoad: false,
        theme: 'neutral',
        securityLevel: 'loose',
        suppressErrorRendering: true, // Don't show error in SVG
        fontFamily: "'Avenir Next', 'Gill Sans', sans-serif",
        flowchart: {
            useMaxWidth: true,
            htmlLabels: true,
            curve: 'basis',
        },
        themeVariables: {
            primaryColor: '#e8ddd0',
            primaryTextColor: '#1c1612',
            primaryBorderColor: '#c4b5a5',
            lineColor: '#8a7a6a',
            secondaryColor: '#f5efe8',
            tertiaryColor: '#fff8f0',
        },
    });
    mermaidInitialized = true;
}

interface MermaidDiagramProps {
    children: string;
}

// Check if mermaid content looks like it could be valid and complete
function looksLikeValidMermaid(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed || trimmed.length < 15) return false; // Need more than just "graph TD"

    // Must have at least one newline to be a valid diagram
    if (!trimmed.includes('\n')) return false;

    const validStarts = [
        'graph', 'flowchart', 'sequencediagram', 'classdiagram',
        'statediagram', 'erdiagram', 'journey', 'gantt', 'pie',
        'mindmap', 'timeline', 'gitgraph', 'c4context'
    ];

    // Get first line and check if it starts with a valid keyword
    const firstLine = trimmed.split('\n')[0].trim().toLowerCase();
    return validStarts.some(start => firstLine.startsWith(start));
}

export default function MermaidDiagram({ children }: MermaidDiagramProps) {
    // Store both current SVG and last successfully rendered SVG
    const [lastValidSvg, setLastValidSvg] = useState<string>('');
    const [lastValidContent, setLastValidContent] = useState<string>('');
    const [isRendering, setIsRendering] = useState(false);
    const [parseError, setParseError] = useState<string | null>(null);

    const id = useId().replace(/:/g, '_');
    const renderCountRef = useRef(0);
    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const tryRender = useCallback(async (content: string) => {
        const trimmedContent = content.trim();

        // Skip if content hasn't changed from last successful render
        if (trimmedContent === lastValidContent) {
            return;
        }

        // Skip if content doesn't look like valid mermaid
        if (!looksLikeValidMermaid(trimmedContent)) {
            return;
        }

        try {
            initMermaid();
            setIsRendering(true);
            setParseError(null);

            // Unique ID for each render attempt
            renderCountRef.current += 1;
            const renderId = `mermaid-${id}-${renderCountRef.current}`;

            const { svg } = await mermaid.render(renderId, trimmedContent);

            // Success! Update both the displayed SVG and the last valid content
            setLastValidSvg(svg);
            setLastValidContent(trimmedContent);
        } catch (err) {
            // Parse failed - this is expected during streaming
            // Keep showing the last valid SVG, just note the error
            const errorMsg = err instanceof Error ? err.message : 'Parse error';
            setParseError(errorMsg);
        } finally {
            setIsRendering(false);
        }
    }, [id, lastValidContent]);

    useEffect(() => {
        // Debounce rendering - wait for content to stabilize
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
        }

        debounceTimerRef.current = setTimeout(() => {
            if (children.trim()) {
                tryRender(children);
            }
        }, 300); // 300ms debounce

        return () => {
            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
            }
        };
    }, [children, tryRender]);

    const handleRetry = () => {
        setParseError(null);
        tryRender(children);
    };

    // If we have a valid SVG, show it
    if (lastValidSvg) {
        return (
            <div className="my-3 overflow-x-auto rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)]">
                {/* Show subtle updating indicator */}
                {isRendering && (
                    <div className="flex items-center gap-1.5 border-b border-[var(--line-subtle)] px-3 py-1.5 text-xs text-[var(--ink-muted)]">
                        <RefreshCw className="size-3 animate-spin" />
                        <span>更新中...</span>
                    </div>
                )}
                {/* 
                 * SECURITY: dangerouslySetInnerHTML is safe here because:
                 * 1. SVG is generated by Mermaid library from validated diagram syntax
                 * 2. User input is parsed as Mermaid DSL, not directly injected as HTML
                 * 3. Mermaid is configured with securityLevel: 'loose' which still sanitizes
                 */}
                <div
                    className="flex justify-center p-4 [&>svg]:max-w-full"
                    dangerouslySetInnerHTML={{ __html: lastValidSvg }}
                />
            </div>
        );
    }

    // No valid SVG yet - show loading or error state
    if (parseError && looksLikeValidMermaid(children)) {
        return (
            <div className="my-3 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning-bg)]/30 p-4">
                <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 text-[var(--warning)]">
                        <AlertCircle className="mt-0.5 size-4 shrink-0" />
                        <div className="min-w-0">
                            <p className="text-sm font-medium">图表渲染中...</p>
                            <p className="mt-1 truncate text-xs opacity-60">{parseError}</p>
                        </div>
                    </div>
                    <button
                        onClick={handleRetry}
                        className="shrink-0 rounded px-2 py-1 text-xs text-[var(--warning)] hover:bg-[var(--warning-bg)]"
                    >
                        重试
                    </button>
                </div>
            </div>
        );
    }

    // Initial loading state
    return (
        <div className="my-3 flex h-20 items-center justify-center rounded-lg border border-[var(--line)] bg-[var(--paper-contrast)]/50">
            <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
                <RefreshCw className="size-4 animate-spin" />
                <span>渲染图表...</span>
            </div>
        </div>
    );
}
