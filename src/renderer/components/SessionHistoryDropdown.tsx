import { useEffect, useRef, useState } from 'react';
import { Clock, MessageSquare, Trash2 } from 'lucide-react';

import { deleteSession, getSessions, type SessionMetadata } from '@/api/sessionClient';

interface SessionHistoryDropdownProps {
    agentDir: string;
    currentSessionId: string | null;
    onSelectSession: (sessionId: string) => void;
    isOpen: boolean;
    onClose: () => void;
}

export default function SessionHistoryDropdown({
    agentDir,
    currentSessionId,
    onSelectSession,
    isOpen,
    onClose,
}: SessionHistoryDropdownProps) {
    const [sessions, setSessions] = useState<SessionMetadata[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Load sessions when opened
    useEffect(() => {
        if (!isOpen || !agentDir) return;

        setIsLoading(true);
        getSessions(agentDir)
            .then(setSessions)
            .finally(() => setIsLoading(false));
    }, [isOpen, agentDir]);

    // Close on outside click
    useEffect(() => {
        if (!isOpen) return;

        const handleClickOutside = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                onClose();
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen, onClose]);

    const handleDelete = async (e: React.MouseEvent, sessionId: string) => {
        e.stopPropagation();
        if (!confirm('确定要删除这条对话记录吗？')) return;

        const success = await deleteSession(sessionId);
        if (success) {
            setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        }
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

    return (
        <div
            ref={dropdownRef}
            className="absolute right-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper)] shadow-lg"
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
                        return (
                            <div
                                key={session.id}
                                className={`group flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors ${isCurrent
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
                                <MessageSquare className="h-4 w-4 flex-shrink-0 text-[var(--ink-muted)]" />
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <span className={`truncate text-sm ${isCurrent ? 'font-medium text-[var(--accent)]' : 'text-[var(--ink)]'}`}>
                                            {session.title}
                                        </span>
                                        {isCurrent && (
                                            <span className="rounded bg-[var(--accent)]/20 px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
                                                当前
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-1 text-xs text-[var(--ink-muted)]">
                                        <Clock className="h-3 w-3" />
                                        <span>{formatTime(session.lastActiveAt)}</span>
                                    </div>
                                </div>
                                {!isCurrent && (
                                    <button
                                        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--error-bg)] group-hover:opacity-100"
                                        onClick={(e) => handleDelete(e, session.id)}
                                        title="删除"
                                    >
                                        <Trash2 className="h-3.5 w-3.5 text-[var(--error)]" />
                                    </button>
                                )}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}
