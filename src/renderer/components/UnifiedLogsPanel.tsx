/**
 * UnifiedLogsPanel - Fullscreen modal displaying aggregated logs from all sources
 */

import { isImeComposingEvent } from '@/utils/imeKeyboard';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { useCloseLayer } from '@/hooks/useCloseLayer';
import { useFrontendLogs } from '@/hooks/useFrontendLogs';
import type { LogLevel, LogSource } from '@/types/log';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  DownloadIcon,
  SearchIcon,
  TrashIcon,
} from '@/components/icons';

interface UnifiedLogsPanelProps {
    tabId?: string;
    sessionId?: string | null;
    /** Whether to show the panel */
    isVisible: boolean;
    /** Callback to close the panel */
    onClose: () => void;
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

// v0.2.0+: Sidecar runs on Node.js; the LogSource discriminant key `'bun'`
// is kept for historical log-file compatibility (pre-0.2.0 unified logs on
// disk use this key), but the UI label is "NODE".
const SOURCE_LABELS: Record<LogSource, string> = {
    bun: 'NODE',
    rust: 'RUST',
    react: 'REACT',
};

// Log limit for display
const MAX_DISPLAY_LOGS = 3000;

// Source filter options with labels
const SOURCE_FILTERS: { value: LogSource | 'all'; label: string }[] = [
    { value: 'all', label: 'ALL' },
    { value: 'react', label: 'REACT' },
    { value: 'bun', label: 'NODE' },
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

// Hide filter options (multi-select)
type HideFilter = 'stream_event' | 'analytics';
const HIDE_FILTERS: { value: HideFilter; labelKey?: string; label?: string }[] = [
    { value: 'stream_event', label: 'Stream Event' },
    { value: 'analytics', labelKey: 'logsPanel.hideAnalytics' },
];
const DEFAULT_HIDE_FILTERS = new Set<HideFilter>(['stream_event', 'analytics']);

/** Highlight all occurrences of `query` in `text` (case-insensitive) */
function highlightText(text: string, query: string): React.ReactNode {
    if (!query) return text;
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let pos = lowerText.indexOf(lowerQuery);
    while (pos !== -1) {
        if (pos > lastIndex) parts.push(text.slice(lastIndex, pos));
        parts.push(
            <mark key={pos} className="rounded-sm bg-[var(--warning-bg)] px-0.5 text-inherit">
                {text.slice(pos, pos + query.length)}
            </mark>
        );
        lastIndex = pos + query.length;
        pos = lowerText.indexOf(lowerQuery, lastIndex);
    }
    if (lastIndex < text.length) parts.push(text.slice(lastIndex));
    return parts.length > 0 ? parts : text;
}

export function UnifiedLogsPanel({ tabId, sessionId, isVisible, onClose }: UnifiedLogsPanelProps) {
    const { t } = useTranslation('app');
    const { logs: sseLogs, clear: handleClearAll } = useFrontendLogs(isVisible, { tabId, sessionId });
    useCloseLayer(() => { if (!isVisible) return false; onClose(); return true; }, 100);
    // Only the visible panel subscribes to the window's diagnostic buffer.
    const [filter, setFilter] = useState<LogSource | 'all'>('all');
    const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');
    const [hideFilters, setHideFilters] = useState<Set<HideFilter>>(new Set(DEFAULT_HIDE_FILTERS));
    const scrollRef = useRef<HTMLDivElement>(null);
    const autoScrollRef = useRef(true);

    // ── Search state ──
    const [searchQuery, setSearchQuery] = useState('');
    const [activeMatchIndex, setActiveMatchIndex] = useState(0);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const matchRowRefs = useRef<Map<number, HTMLDivElement>>(new Map());

    const toggleHideFilter = useCallback((f: HideFilter) => {
        setHideFilters(prev => {
            const next = new Set(prev);
            if (next.has(f)) next.delete(f);
            else next.add(f);
            return next;
        });
    }, []);

    // Limit logs for display and sort newest first
    // PERF: Skip expensive sort when panel is hidden — recomputes once on open
    const allLogs = useMemo(() => {
        if (!isVisible) return [];
        const limited = sseLogs.length > MAX_DISPLAY_LOGS
            ? sseLogs.slice(-MAX_DISPLAY_LOGS)
            : sseLogs;
        return [...limited].sort(
            (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
    }, [sseLogs, isVisible]);

    // Filter logs by source, level, and hide filters
    const filteredLogs = useMemo(() => {
        let logs = allLogs;
        if (filter !== 'all') {
            logs = logs.filter(log => log.source === filter);
        }
        if (levelFilter !== 'all') {
            logs = logs.filter(log => log.level === levelFilter);
        }
        if (hideFilters.has('stream_event')) {
            logs = logs.filter(log =>
                !log.message.includes('type=stream_event') &&
                !log.message.includes('"type":"stream_event"')
            );
        }
        if (hideFilters.has('analytics')) {
            logs = logs.filter(log =>
                !log.message.includes('analytics.myagents.io') &&
                !log.message.includes('/api/unified-log')
            );
        }
        return logs;
    }, [allLogs, filter, levelFilter, hideFilters]);

    // Search: indices of matching rows in filteredLogs
    const matchIndices = useMemo(() => {
        if (!searchQuery.trim()) return [];
        const q = searchQuery.toLowerCase();
        const indices: number[] = [];
        for (let i = 0; i < filteredLogs.length; i++) {
            if (filteredLogs[i].message.toLowerCase().includes(q)) {
                indices.push(i);
            }
        }
        return indices;
    }, [filteredLogs, searchQuery]);

    // Clamp activeMatchIndex when matches change
    /* eslint-disable react-hooks/set-state-in-effect */
    useEffect(() => {
        if (matchIndices.length === 0) {
            setActiveMatchIndex(0);
        } else if (activeMatchIndex >= matchIndices.length) {
            setActiveMatchIndex(matchIndices.length - 1);
        }
    }, [matchIndices.length, activeMatchIndex]);
    /* eslint-enable react-hooks/set-state-in-effect */

    // Scroll to active match
    useEffect(() => {
        if (matchIndices.length === 0) return;
        const rowIdx = matchIndices[activeMatchIndex];
        const el = matchRowRefs.current.get(rowIdx);
        if (el) {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            autoScrollRef.current = false;
        }
    }, [activeMatchIndex, matchIndices]);

    const navigateMatch = useCallback((direction: 'next' | 'prev') => {
        if (matchIndices.length === 0) return;
        setActiveMatchIndex(prev => {
            if (direction === 'next') return (prev + 1) % matchIndices.length;
            return (prev - 1 + matchIndices.length) % matchIndices.length;
        });
    }, [matchIndices.length]);

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

    // Keyboard shortcuts: Cmd+F to focus search, ESC to clear search or close
    useEffect(() => {
        if (!isVisible) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (isImeComposingEvent(e)) return;
            if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
                e.preventDefault();
                searchInputRef.current?.focus();
                searchInputRef.current?.select();
            } else if (e.key === 'Escape') {
                if (searchQuery) {
                    setSearchQuery('');
                    searchInputRef.current?.blur();
                } else {
                    onClose();
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isVisible, onClose, searchQuery]);

    // Download filtered logs as .txt
    const handleDownload = useCallback(() => {
        const lines = filteredLogs.map(log => {
            const time = new Date(log.timestamp).toLocaleTimeString('en-US', {
                hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
            });
            const level = log.level !== 'info' ? ` [${log.level.toUpperCase()}]` : '';
            return `${SOURCE_LABELS[log.source]} ${time}${level} ${log.message}`;
        });
        const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `myagents-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    }, [filteredLogs]);

    // Only close on genuine clicks (mousedown + mouseup both on backdrop).
    // Prevents closing when user drags a text selection out of the modal.
    if (!isVisible) return null;

    // Use portal to render at document root for true fullscreen overlay
    return (
        <OverlayBackdrop portal onClose={onClose} className="z-[100]">
            <div
                className="flex h-[90vh] w-[95vw] max-w-6xl flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-2xl"
            >
                {/* Header */}
                <div className="flex items-center justify-between border-b border-[var(--line)] px-6 py-3">
                    <div className="flex items-center gap-4">
                        <h2 className="text-lg font-semibold text-[var(--ink)]">Logs</h2>
                        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
                            {filteredLogs.length} / {allLogs.length}
                        </span>
                    </div>

                    <div className="flex items-center gap-2">
                        {/* Search bar */}
                        <div className="flex items-center gap-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1">
                            <SearchIcon className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                            <input
                                ref={searchInputRef}
                                type="text"
                                value={searchQuery}
                                onChange={e => { setSearchQuery(e.target.value); setActiveMatchIndex(0); }}
                                onKeyDown={e => {
                                    if (isImeComposingEvent(e)) return;
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        navigateMatch(e.shiftKey ? 'prev' : 'next');
                                    }
                                }}
                                placeholder={t('logsPanel.searchPlaceholder')}
                                className="w-40 bg-transparent text-xs text-[var(--ink)] placeholder:text-[var(--ink-subtle)] focus:outline-none"
                            />
                            {searchQuery && (
                                <>
                                    <span className="text-xs text-[var(--ink-muted)] tabular-nums">
                                        {matchIndices.length > 0 ? `${activeMatchIndex + 1}/${matchIndices.length}` : '0/0'}
                                    </span>
                                    <button onClick={() => navigateMatch('prev')} className="rounded p-0.5 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]" title={t('logsPanel.previous')}>
                                        <ChevronUpIcon className="h-3 w-3" />
                                    </button>
                                    <button onClick={() => navigateMatch('next')} className="rounded p-0.5 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]" title={t('logsPanel.next')}>
                                        <ChevronDownIcon className="h-3 w-3" />
                                    </button>
                                    <button onClick={() => { setSearchQuery(''); searchInputRef.current?.focus(); }} className="rounded p-0.5 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]" title={t('logsPanel.clearSearch')}>
                                        <CloseIcon className="h-3 w-3" />
                                    </button>
                                </>
                            )}
                        </div>

                        <div className="h-4 w-px bg-[var(--line)]" />

                        {/* Download button */}
                        <button
                            onClick={handleDownload}
                            className="rounded p-1.5 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                            title={t('logsPanel.export')}
                        >
                            <DownloadIcon className="h-4 w-4" />
                        </button>
                        {/* Clear button */}
                        <button
                            onClick={handleClearAll}
                            className="rounded p-1.5 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                            title={t('logsPanel.clear')}
                        >
                            <TrashIcon className="h-4 w-4" />
                        </button>
                        {/* Close button */}
                        <button
                            onClick={onClose}
                            className="rounded-lg p-1.5 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                            aria-label={t('logsPanel.close')}
                        >
                            <CloseIcon className="h-5 w-5" />
                        </button>
                    </div>
                </div>

                {/* Filter bar — 三组筛选 */}
                <div className="flex flex-wrap items-center gap-4 border-b border-[var(--line)] px-6 py-2">
                    {/* 范围 (单选) */}
                    <div className="flex items-center gap-1.5">
                        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60">{t('logsPanel.scope')}</span>
                        <div className="flex gap-0.5">
                            {SOURCE_FILTERS.map(({ value, label }) => (
                                <button
                                    key={value}
                                    onClick={() => setFilter(value)}
                                    className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${filter === value
                                        ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                                        : 'bg-[var(--paper-inset)] text-[var(--ink-muted)] hover:bg-[var(--line)]'
                                        }`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="h-4 w-px bg-[var(--line)]" />

                    {/* 类型 (单选) */}
                    <div className="flex items-center gap-1.5">
                        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60">{t('logsPanel.type')}</span>
                        <div className="flex gap-0.5">
                            {LEVEL_FILTERS.map(({ value, label }) => (
                                <button
                                    key={value}
                                    onClick={() => setLevelFilter(value)}
                                    className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${levelFilter === value
                                        ? 'bg-[var(--button-dark-bg)] text-[var(--button-dark-text)]'
                                        : 'bg-[var(--paper-inset)] text-[var(--ink-muted)] hover:bg-[var(--line)]'
                                        }`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="h-4 w-px bg-[var(--line)]" />

                    {/* 隐藏 (多选) */}
                    <div className="flex items-center gap-1.5">
                        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60">{t('logsPanel.hide')}</span>
                        <div className="flex gap-1">
                            {HIDE_FILTERS.map(({ value, label, labelKey }) => (
                                <button
                                    key={value}
                                    onClick={() => toggleHideFilter(value)}
                                    className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${hideFilters.has(value)
                                        ? 'bg-[var(--warning)]/15 text-[var(--warning)]'
                                        : 'bg-[var(--paper-inset)] text-[var(--ink-muted)] hover:bg-[var(--line)]'
                                        }`}
                                >
                                    {labelKey ? t(labelKey) : label}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Logs container */}
                <div
                    ref={scrollRef}
                    onScroll={handleScroll}
                    className="flex-1 overflow-y-auto bg-[var(--paper-elevated)] p-4 font-mono text-xs leading-relaxed"
                >
                    {filteredLogs.length === 0 ? (
                        <div className="flex h-full items-center justify-center text-[var(--ink-muted)]">
                            {t('logsPanel.empty')}
                        </div>
                    ) : (
                        <div className="space-y-0.5">
                            {filteredLogs.map((log, index) => {
                                const isMatch = searchQuery && matchIndices.includes(index);
                                const isActive = isMatch && matchIndices[activeMatchIndex] === index;
                                return (
                                    <div
                                        key={`${log.timestamp}-${index}`}
                                        ref={el => { if (el && isMatch) matchRowRefs.current.set(index, el); }}
                                        className={`flex gap-3 rounded px-2 py-1 hover:bg-[var(--paper-inset)] ${LOG_LEVEL_COLORS[log.level]} ${isActive ? 'ring-2 ring-[var(--accent)] bg-[var(--accent-warm-subtle)]' : isMatch ? 'bg-[var(--accent-warm-subtle)]/50' : ''}`}
                                    >
                                        {/* Source badge */}
                                        <span
                                            className={`flex-shrink-0 rounded px-1.5 py-0.5 text-xs font-bold ${SOURCE_COLORS[log.source]}`}
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
                                        {/* Message — highlight search matches */}
                                        <span className="flex-1 break-all">
                                            {searchQuery ? highlightText(log.message, searchQuery) : log.message}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between border-t border-[var(--line)] bg-[var(--paper-inset)] px-6 py-2 text-xs text-[var(--ink-muted)]">
                    <div className="flex gap-3">
                        <span className="text-blue-600 dark:text-blue-400">REACT: {logCounts.react}</span>
                        <span className="text-green-600 dark:text-green-400">NODE: {logCounts.bun}</span>
                        <span className="text-orange-600 dark:text-orange-400">RUST: {logCounts.rust}</span>
                        <span className="text-[var(--ink-muted)]">{t('logsPanel.total', { count: allLogs.length })}</span>
                    </div>
                    <div>
                        <Trans
                            i18nKey="logsPanel.escToClose"
                            ns="app"
                            components={{ key: <kbd className="rounded bg-[var(--paper-elevated)] px-1.5 py-0.5 font-mono text-xs" /> }}
                        />
                    </div>
                </div>
            </div>
        </OverlayBackdrop>
    );
}
