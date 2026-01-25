/**
 * UnifiedLogsPanel - Fullscreen modal displaying aggregated logs from all sources
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { LogEntry, LogLevel, LogSource } from '@/types/log';

interface UnifiedLogsPanelProps {
    /** Logs received from SSE via TabProvider */
    sseLogs: LogEntry[];
    /** Whether to show the panel */
    isVisible: boolean;
    /** Callback to close the panel */
    onClose: () => void;
    /** Callback to clear all logs */
    onClearAll?: () => void;
}

const LOG_LEVEL_COLORS: Record<LogLevel, string> = {
    info: 'text-[var(--ink)]',
    warn: 'text-[var(--warning)]',
    error: 'text-[var(--error)]',
    debug: 'text-[var(--ink-muted)]',
};

const SOURCE_COLORS: Record<LogSource, string> = {
    bun: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    rust: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
    react: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
};

const SOURCE_LABELS: Record<LogSource, string> = {
    bun: 'BUN',
    rust: 'RUST',
    react: 'REACT',
};

// Log limit for display
const MAX_DISPLAY_LOGS = 3000;

// Source filter options with labels
const SOURCE_FILTERS: { value: LogSource | 'all'; label: string }[] = [
    { value: 'all', label: 'ALL' },
    { value: 'react', label: 'REACT' },
    { value: 'bun', label: 'BUN' },
    { value: 'rust', label: 'RUST' },
];

// Level filter options
const LEVEL_FILTERS: { value: LogLevel | 'all'; label: string }[] = [
    { value: 'all', label: 'ALL' },
    { value: 'info', label: 'INFO' },
    { value: 'warn', label: 'WARN' },
    { value: 'error', label: 'ERROR' },
    { value: 'debug', label: 'DEBUG' },
];

export function UnifiedLogsPanel({ sseLogs, isVisible, onClose, onClearAll }: UnifiedLogsPanelProps) {
    // All logs (React + Bun + Rust) now come from sseLogs prop via TabProvider
    const [filter, setFilter] = useState<LogSource | 'all'>('all');
    const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');
    const [hideStreamEvents, setHideStreamEvents] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const autoScrollRef = useRef(true);

    // Limit logs for display and sort newest first
    const allLogs = useMemo(() => {
        const limited = sseLogs.length > MAX_DISPLAY_LOGS
            ? sseLogs.slice(-MAX_DISPLAY_LOGS)
            : sseLogs;
        return [...limited].sort(
            (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
    }, [sseLogs]);

    // Filter logs by source, level, and stream events
    const filteredLogs = useMemo(() => {
        let logs = allLogs;
        if (filter !== 'all') {
            logs = logs.filter(log => log.source === filter);
        }
        if (levelFilter !== 'all') {
            logs = logs.filter(log => log.level === levelFilter);
        }
        // Hide stream_event logs if toggle is on
        if (hideStreamEvents) {
            logs = logs.filter(log =>
                !log.message.includes('type=stream_event') &&
                !log.message.includes('"type":"stream_event"')
            );
        }
        return logs;
    }, [allLogs, filter, levelFilter, hideStreamEvents]);

    // Count logs by source
    const logCounts = useMemo(() => {
        const counts = { react: 0, bun: 0, rust: 0 };
        for (const log of allLogs) {
            if (log.source in counts) {
                counts[log.source as keyof typeof counts]++;
            }
        }
        return counts;
    }, [allLogs]);

    // Auto-scroll to top for newest first
    useEffect(() => {
        if (autoScrollRef.current && scrollRef.current) {
            scrollRef.current.scrollTop = 0;
        }
    }, [filteredLogs.length]);

    // Handle scroll to detect if user scrolled down
    const handleScroll = useCallback(() => {
        if (!scrollRef.current) return;
        const { scrollTop } = scrollRef.current;
        autoScrollRef.current = scrollTop < 50; // At top
    }, []);

    // ESC key to close
    useEffect(() => {
        if (!isVisible) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isVisible, onClose]);

    // Clear all logs (now all logs are managed by TabProvider)
    const handleClearAll = useCallback(() => {
        onClearAll?.();
    }, [onClearAll]);

    if (!isVisible) return null;

    // Use portal to render at document root for true fullscreen overlay
    return createPortal(
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
            onClick={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div
                className="flex h-[90vh] w-[95vw] max-w-6xl flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper)] shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between border-b border-[var(--line)] px-6 py-4">
                    <div className="flex items-center gap-4">
                        <h2 className="text-lg font-semibold text-[var(--ink)]">
                            统一日志 Unified Logs
                        </h2>
                        <span className="rounded-full bg-[var(--paper-contrast)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
                            {filteredLogs.length} / {allLogs.length} 条
                        </span>
                    </div>

                    <div className="flex items-center gap-4">
                        {/* Source filter */}
                        <div className="flex gap-1">
                            {SOURCE_FILTERS.map(({ value, label }) => (
                                <button
                                    key={value}
                                    onClick={() => setFilter(value)}
                                    className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${filter === value
                                        ? 'bg-[var(--accent)] text-white'
                                        : 'bg-[var(--paper-contrast)] text-[var(--ink-muted)] hover:bg-[var(--line)]'
                                        }`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>

                        {/* Level filter */}
                        <div className="flex gap-1">
                            {LEVEL_FILTERS.map(({ value, label }) => (
                                <button
                                    key={value}
                                    onClick={() => setLevelFilter(value)}
                                    className={`rounded px-2 py-1 text-xs font-medium transition-colors ${levelFilter === value
                                        ? 'bg-[var(--ink)] text-[var(--paper)]'
                                        : 'bg-[var(--paper-strong)] text-[var(--ink-muted)] hover:bg-[var(--line)]'
                                        }`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>

                        {/* Hide stream events toggle */}
                        <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-[var(--paper-contrast)]">
                            <input
                                type="checkbox"
                                checked={hideStreamEvents}
                                onChange={(e) => setHideStreamEvents(e.target.checked)}
                                className="size-3.5 rounded border-[var(--line)] accent-[var(--accent)]"
                            />
                            <span className="text-[var(--ink-muted)] select-none">隐藏 stream_event</span>
                        </label>

                        {/* Clear button */}
                        <button
                            onClick={handleClearAll}
                            className="rounded px-3 py-1 text-xs font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)]"
                        >
                            清空
                        </button>

                        {/* Close button */}
                        <button
                            onClick={onClose}
                            className="rounded-lg p-2 text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                            aria-label="Close"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                            </svg>
                        </button>
                    </div>
                </div>

                {/* Logs container */}
                <div
                    ref={scrollRef}
                    onScroll={handleScroll}
                    className="flex-1 overflow-y-auto bg-[var(--paper-strong)] p-4 font-mono text-xs leading-relaxed"
                >
                    {filteredLogs.length === 0 ? (
                        <div className="flex h-full items-center justify-center text-[var(--ink-muted)]">
                            No logs yet.
                        </div>
                    ) : (
                        <div className="space-y-0.5">
                            {filteredLogs.map((log, index) => (
                                <div
                                    key={`${log.timestamp}-${index}`}
                                    className={`flex gap-3 rounded px-2 py-1 hover:bg-[var(--paper-contrast)] ${LOG_LEVEL_COLORS[log.level]}`}
                                >
                                    {/* Source badge */}
                                    <span
                                        className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${SOURCE_COLORS[log.source]}`}
                                    >
                                        {SOURCE_LABELS[log.source]}
                                    </span>
                                    {/* Timestamp */}
                                    <span className="flex-shrink-0 text-[var(--ink-muted)]">
                                        {new Date(log.timestamp).toLocaleTimeString('en-US', {
                                            hour12: false,
                                            hour: '2-digit',
                                            minute: '2-digit',
                                            second: '2-digit',
                                            fractionalSecondDigits: 3,
                                        })}
                                    </span>
                                    {/* Level indicator */}
                                    {log.level !== 'info' && (
                                        <span className={`flex-shrink-0 font-bold uppercase ${LOG_LEVEL_COLORS[log.level]}`}>
                                            [{log.level}]
                                        </span>
                                    )}
                                    {/* Message */}
                                    <span className="flex-1 break-all">{log.message}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between border-t border-[var(--line)] bg-[var(--paper-contrast)] px-6 py-2 text-xs text-[var(--ink-muted)]">
                    <div className="flex gap-3">
                        <span className="text-blue-600 dark:text-blue-400">REACT: {logCounts.react}</span>
                        <span className="text-green-600 dark:text-green-400">BUN: {logCounts.bun}</span>
                        <span className="text-orange-600 dark:text-orange-400">RUST: {logCounts.rust}</span>
                        <span className="text-[var(--ink-muted)]">Total: {allLogs.length}</span>
                    </div>
                    <div>
                        Press <kbd className="rounded bg-[var(--paper-strong)] px-1.5 py-0.5 font-mono text-[10px]">ESC</kbd> to close
                    </div>
                </div>
            </div>
        </div>,
        document.body
    );
}
