import { useEffect, useRef, useState } from 'react';
import { BarChart2, Clock, Trash2 } from 'lucide-react';

import { deleteSession, getSessions, type SessionMetadata } from '@/api/sessionClient';
import { formatTokens } from '@/utils/formatTokens';

import SessionStatsModal from './SessionStatsModal';

interface SessionHistoryDropdownProps {
    agentDir: string;
    currentSessionId: string | null;
    onSelectSession: (sessionId: string) => void;
    isOpen: boolean;
    onClose: () => void;
}

// Track fetch state: null = not fetched, empty array = fetched but empty
type FetchState = SessionMetadata[] | null;

export default function SessionHistoryDropdown({
    agentDir,
    currentSessionId,
    onSelectSession,
    isOpen,
    onClose,
}: SessionHistoryDropdownProps) {
    const [sessions, setSessions] = useState<FetchState>(null);
    const [statsSession, setStatsSession] = useState<{ id: string; title: string } | null>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const onCloseRef = useRef(onClose);

    // Keep onClose ref updated via effect
    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    // Load sessions when opened
    useEffect(() => {
        if (!isOpen || !agentDir) return;

        let cancelled = false;

        (async () => {
            const data = await getSessions(agentDir);
            if (!cancelled) {
                setSessions(data);
            }
        })();

        return () => {
            cancelled = true;
            // Reset state when closing or agentDir changes
            setSessions(null);
            setStatsSession(null);
        };
    }, [isOpen, agentDir]);

    // Close on outside click (using stable ref to avoid re-attaching listener)
    useEffect(() => {
        if (!isOpen) return;

        const handleClickOutside = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                onCloseRef.current();
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen]);

    const handleDelete = async (e: React.MouseEvent, sessionId: string) => {
        e.stopPropagation();
        if (!confirm('确定要删除这条对话记录吗？')) return;

        const success = await deleteSession(sessionId);
        if (success) {
            setSessions((prev) => prev?.filter((s) => s.id !== sessionId) ?? null);
        }
    };

    const handleShowStats = (e: React.MouseEvent, session: SessionMetadata) => {
        e.stopPropagation();
        setStatsSession({ id: session.id, title: session.title });
    };

    const formatTime = (isoString: string) => {
        const date = new Date(isoString);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) {
            return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        } else if (diffDays === 1) {
            return '昨天';
        } else if (diffDays < 7) {
            return `${diffDays}天前`;
        } else {
            return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
        }
    };

    if (!isOpen) return null;

    // Derive loading state: open but sessions not yet fetched
    const isLoading = sessions === null;

    return (
        <>
            <div
                ref={dropdownRef}
                className="absolute right-0 top-full z-50 mt-1 w-96 overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper)] shadow-lg"
            >
                {/* Header */}
                <div className="border-b border-[var(--line)] px-4 py-2">
                    <h3 className="text-sm font-semibold text-[var(--ink)]">历史记录</h3>
                </div>

                {/* Session list */}
                <div className="max-h-80 overflow-y-auto">
                    {isLoading ? (
                        <div className="px-4 py-8 text-center text-sm text-[var(--ink-muted)]">
                            加载中...
                        </div>
                    ) : sessions.length === 0 ? (
                        <div className="px-4 py-8 text-center text-sm text-[var(--ink-muted)]">
                            暂无历史记录
                        </div>
                    ) : (
                        sessions.map((session) => {
                            const isCurrent = session.id === currentSessionId;
                            const stats = session.stats;
                            const hasStats = stats && (stats.messageCount > 0 || stats.totalInputTokens > 0);
                            const totalTokens = (stats?.totalInputTokens ?? 0) + (stats?.totalOutputTokens ?? 0);

                            return (
                                <div
                                    key={session.id}
                                    className={`group flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors ${isCurrent
                                        ? 'bg-[var(--accent)]/10'
                                        : 'hover:bg-[var(--paper-contrast)]'
                                        }`}
                                    onClick={() => {
                                        if (!isCurrent) {
                                            onSelectSession(session.id);
                                            onClose();
                                        }
                                    }}
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            {isCurrent && (
                                                <span className="flex-shrink-0 rounded bg-[var(--accent)]/20 px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                                                    当前
                                                </span>
                                            )}
                                            <span className={`truncate text-sm ${isCurrent ? 'font-medium text-[var(--accent)]' : 'text-[var(--ink)]'}`}>
                                                {session.title}
                                            </span>
                                        </div>
                                        <div className="mt-1 flex items-center gap-2 text-xs text-[var(--ink-muted)]">
                                            <span className="flex items-center gap-1">
                                                <Clock className="h-3 w-3" />
                                                {formatTime(session.lastActiveAt)}
                                            </span>
                                            {hasStats && (
                                                <>
                                                    <span>·</span>
                                                    <span>{stats.messageCount} 条消息</span>
                                                    <span>·</span>
                                                    <span>{formatTokens(totalTokens)} tokens</span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex flex-shrink-0 items-center gap-1">
                                        <button
                                            className="flex h-6 w-6 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--paper-contrast)] group-hover:opacity-100"
                                            onClick={(e) => handleShowStats(e, session)}
                                            title="查看统计"
                                        >
                                            <BarChart2 className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                                        </button>
                                        {!isCurrent && (
                                            <button
                                                className="flex h-6 w-6 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--error-bg)] group-hover:opacity-100"
                                                onClick={(e) => handleDelete(e, session.id)}
                                                title="删除"
                                            >
                                                <Trash2 className="h-3.5 w-3.5 text-[var(--error)]" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>

            {/* Stats Modal */}
            {statsSession && (
                <SessionStatsModal
                    sessionId={statsSession.id}
                    sessionTitle={statsSession.title}
                    onClose={() => setStatsSession(null)}
                />
            )}
        </>
    );
}
