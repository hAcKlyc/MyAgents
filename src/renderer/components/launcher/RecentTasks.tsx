/**
 * RecentTasks - Displays the 3 most recent sessions globally
 * Shows session title + workspace folder icon + workspace name
 *
 * Includes retry mechanism for cases where Global Sidecar startup
 * is delayed (e.g., macOS permission dialogs)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Clock, FolderOpen, MessageSquare, RefreshCw } from 'lucide-react';

import { getSessions, type SessionMetadata } from '@/api/sessionClient';
import type { Project } from '@/config/types';

interface RecentTasksProps {
    projects: Project[];
    onOpenTask: (session: SessionMetadata, project: Project) => void;
}

// Constants for retry behavior
const MAX_AUTO_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// Section header component (defined outside to avoid recreation on each render)
function SectionHeader() {
    return (
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]/60">
            最近任务
        </h3>
    );
}

export default function RecentTasks({ projects, onOpenTask }: RecentTasksProps) {
    const [recentSessions, setRecentSessions] = useState<SessionMetadata[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [retryCount, setRetryCount] = useState(0);
    const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    const fetchSessions = useCallback(async (currentRetryCount = 0) => {
        if (currentRetryCount === 0) {
            setIsLoading(true);
        }
        setError(null);

        try {
            const sessions = await getSessions();
            // Sort by lastActiveAt descending and take top 3
            const sorted = sessions
                .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
                .slice(0, 3);
            setRecentSessions(sorted);
            setRetryCount(0); // Reset retry count on success
        } catch (err) {
            console.error('[RecentTasks] Failed to load sessions:', err);

            // Auto-retry if under max retries
            if (currentRetryCount < MAX_AUTO_RETRIES) {
                const nextRetry = currentRetryCount + 1;
                console.log(`[RecentTasks] Auto-retry ${nextRetry}/${MAX_AUTO_RETRIES} in ${RETRY_DELAY_MS}ms`);
                setRetryCount(nextRetry);
                retryTimeoutRef.current = setTimeout(() => {
                    void fetchSessions(nextRetry);
                }, RETRY_DELAY_MS);
            } else {
                setError('加载失败，请稍后重试');
            }
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void fetchSessions(0);

        return () => {
            if (retryTimeoutRef.current) {
                clearTimeout(retryTimeoutRef.current);
            }
        };
    }, [fetchSessions]);

    const handleManualRetry = useCallback(() => {
        setRetryCount(0);
        void fetchSessions(0);
    }, [fetchSessions]);

    const getProjectForSession = (session: SessionMetadata): Project | undefined => {
        return projects.find((p) => p.path === session.agentDir);
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

    if (isLoading) {
        return (
            <div className="mb-8">
                <SectionHeader />
                <div className="py-4 text-[13px] text-[var(--ink-muted)]/70">加载中...</div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="mb-8">
                <SectionHeader />
                <div className="rounded-xl border border-dashed border-[var(--line)] px-4 py-5 text-center">
                    <AlertCircle className="mx-auto mb-2 h-4 w-4 text-amber-500/70" />
                    <p className="mb-2 text-[13px] text-[var(--ink-muted)]">{error}</p>
                    <button
                        onClick={handleManualRetry}
                        className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                    >
                        <RefreshCw className="h-3.5 w-3.5" />
                        重试
                    </button>
                </div>
            </div>
        );
    }

    if (recentSessions.length === 0) {
        return (
            <div className="mb-8">
                <SectionHeader />
                <div className="rounded-xl border border-dashed border-[var(--line)] px-4 py-5 text-center">
                    <MessageSquare className="mx-auto mb-2 h-4 w-4 text-[var(--ink-muted)]/50" />
                    <p className="text-[13px] text-[var(--ink-muted)]/70">暂无最近任务</p>
                </div>
            </div>
        );
    }

    return (
        <div className="mb-8">
            <SectionHeader />
            <div className="space-y-1">
                {recentSessions.map((session) => {
                    const project = getProjectForSession(session);
                    if (!project) return null;

                    return (
                        <button
                            key={session.id}
                            onClick={() => onOpenTask(session, project)}
                            className="group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-all hover:bg-[var(--paper-inset)]"
                        >
                            {/* Time - fixed width to prevent layout shift */}
                            <div className="flex w-14 shrink-0 items-center gap-1 text-[11px] text-[var(--ink-muted)]/50">
                                <Clock className="h-2.5 w-2.5" />
                                <span>{formatTime(session.lastActiveAt)}</span>
                            </div>

                            {/* Session title */}
                            <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ink-secondary)] transition-colors group-hover:text-[var(--ink)]">
                                {session.title}
                            </span>

                            {/* Workspace info */}
                            <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--ink-muted)]/45">
                                <FolderOpen className="h-3 w-3" />
                                <span className="max-w-[80px] truncate">{project.name}</span>
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
