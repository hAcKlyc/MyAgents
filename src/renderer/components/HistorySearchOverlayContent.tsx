/**
 * HistorySearchOverlayContent — history/search content inside the App Shell overlay.
 *
 * v0.1.69 rework: was a two-column view (sessions + cron tasks). The right
 * column has been removed because the Launcher's 「我的任务」 tab now routes
 * "全部 → / 搜索" to the Task Center singleton tab instead of this overlay,
 * making the cron column redundant here. The overlay now serves a single
 * purpose — browse/filter/search historical Chat sessions — and is renamed
 * accordingly ("历史会话").
 *
 * The App Shell owns the stable backdrop/panel and its entrance animation.
 * This lazy component renders only the interior so Suspense resolution cannot
 * replace the visible shell and replay an opacity-from-zero animation.
 *
 * The legacy `onOpenCronDetail` prop is dropped; downstream callers have
 * been updated in the same commit.
 */

import { isImeComposingEvent } from '@/utils/imeKeyboard';
import { memo, useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  SearchIcon,
  LoaderIcon,
  ChartIcon,
  ClockIcon,
  StarIcon,
  TrashIcon,
  CloseIcon,
} from '@/components/icons';
import { Virtuoso } from 'react-virtuoso';

import type { SessionSearchHit } from '@/api/searchClient';
import { useHistorySearch } from '@/hooks/useHistorySearch';
import { isSessionDeleted } from '@/hooks/useTaskCenterData';

import type { SessionTag, TaskCenterData } from '@/hooks/useTaskCenterData';
import WorkspaceIcon from '@/components/launcher/WorkspaceIcon';
import SessionTagBadge from '@/components/SessionTagBadge';
import Tip from '@/components/Tip';
import SessionStatsModal from '@/components/SessionStatsModal';
import SessionContextMenu from '@/components/SessionContextMenu';
import ConfirmDialog from '@/components/ConfirmDialog';
import CustomSelect from '@/components/CustomSelect';
import { useToast } from '@/components/Toast';
import { useSessionDeletion } from '@/context/SessionDeletionContext';
import { getFolderName, formatTime, getSessionDisplayText, formatTurnCount } from '@/utils/taskCenterUtils';
import type { SessionMetadata } from '@/api/sessionClient';
import { normalizeWorkspacePathIdentity } from '@/../shared/workspacePath';
import type { Project } from '@/config/types';
import SessionSearchItem from '@/components/search/SessionSearchItem';
import { parseSessionIdQuery } from '@/utils/parseSessionIdQuery';
import { copyPlainText } from '@/utils/clipboard';
import UserTagPills from '@/components/session-tags/UserTagPills';
import UserTagFilter from '@/components/session-tags/UserTagFilter';
import type { GlobalUserTagChange } from '@/components/session-tags/SessionTagMenuItem';
import {
    deriveSessionUserTagSummaries,
    sessionHasUserTag,
} from '../../shared/session-user-tags';

interface HistorySearchOverlayContentProps {
    projects: Project[];
    onOpenSession: (session: SessionMetadata, project: Project) => void;
    onRenameSession: (sessionId: string, title: string) => Promise<SessionMetadata | null>;
    onClose: () => void;
    taskCenterData: TaskCenterData;
    tagIntent?: { id: number; tag: string } | null;
    onTagIntentConsumed?: (id: number) => void;
}

type BrowseFilter = 'all' | 'favorite';

const BROWSE_FILTER_OPTIONS: { key: BrowseFilter; labelKey: string }[] = [
    { key: 'all', labelKey: 'historyOverlay.filters.all' },
    { key: 'favorite', labelKey: 'historyOverlay.filters.favorite' },
];

interface HistorySessionRowProps {
    session: SessionMetadata;
    project: Project;
    tags: SessionTag[];
    deleteProtected: boolean;
    onOpen: () => void;
    onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
    onToggleFavorite: (event: React.MouseEvent) => void;
    onShowStats: (event: React.MouseEvent) => void;
    onDelete: (event: React.MouseEvent) => void;
    onTagClick: (name: string) => void;
}

const HistorySessionRow = memo(function HistorySessionRow({
    session,
    project,
    tags,
    deleteProtected,
    onOpen,
    onContextMenu,
    onToggleFavorite,
    onShowStats,
    onDelete,
    onTagClick,
}: HistorySessionRowProps) {
    const { t } = useTranslation('app');
    const displayText = getSessionDisplayText(session);
    const turnCount = formatTurnCount(session);

    return (
        <div className="pb-0.5">
            <div
                role="button"
                onClick={onOpen}
                onMouseDown={(event) => {
                    if (event.button === 2) event.preventDefault();
                }}
                onContextMenu={onContextMenu}
                className="group relative flex w-full cursor-pointer select-none items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--hover-bg)]"
                data-history-session-row
            >
                <div className="flex w-16 shrink-0 items-center gap-1 text-xs text-[var(--ink-muted)]/50">
                    <ClockIcon className="h-2.5 w-2.5" />
                    <span>{formatTime(session.lastActiveAt)}</span>
                </div>
                {tags.map((tag, index) => (
                    <SessionTagBadge key={`${tag.type}-${index}`} tag={tag} />
                ))}
                <UserTagPills tags={session.userTags} onTagClick={onTagClick} />
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--ink-secondary)] transition-colors group-hover:text-[var(--ink)]">
                    {displayText}
                    {turnCount && (
                        <span className="ml-1.5 text-xs text-[var(--ink-muted)]/40">
                            {turnCount}
                        </span>
                    )}
                </span>
                <div className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--ink-muted)]/45">
                    <WorkspaceIcon icon={project.icon} size={14} />
                    <span className="max-w-[80px] truncate">
                        {getFolderName(project.path)}
                    </span>
                </div>

                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                    <div className="h-full w-10 bg-gradient-to-r from-[var(--paper-inset-a0)] to-[var(--paper-inset)]" />
                    <div className="flex h-full items-center gap-1 bg-[var(--paper-inset)] pr-3">
                        <Tip label={session.favorite ? t('historyOverlay.unfavorite') : t('historyOverlay.favorite')} position="bottom">
                            <button
                                onClick={onToggleFavorite}
                                aria-label={session.favorite ? t('historyOverlay.unfavorite') : t('historyOverlay.favorite')}
                                className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper)] ${
                                    session.favorite
                                        ? 'text-[var(--accent)]'
                                        : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                                }`}
                            >
                                <StarIcon className="h-3.5 w-3.5" fill={session.favorite ? 'currentColor' : 'none'} />
                            </button>
                        </Tip>
                        <Tip label={t('historyOverlay.viewStats')} position="bottom">
                            <button
                                onClick={onShowStats}
                                aria-label={t('historyOverlay.viewStats')}
                                className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
                            >
                                <ChartIcon className="h-3.5 w-3.5" />
                            </button>
                        </Tip>
                        <Tip
                            label={deleteProtected ? t('historyOverlay.deleteBlocked') : t('historyOverlay.delete')}
                            position="bottom"
                        >
                            <button
                                onClick={onDelete}
                                aria-label={deleteProtected ? t('historyOverlay.deleteBlockedAria') : t('historyOverlay.delete')}
                                className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                            >
                                <TrashIcon className="h-3.5 w-3.5" />
                            </button>
                        </Tip>
                    </div>
                </div>
            </div>
        </div>
    );
});

const HistorySearchResultRow = memo(function HistorySearchResultRow({
    hit, session, project, deleteProtected, onOpen, onContextMenu, onShowStats, onDelete, onTagClick,
}: {
    hit: SessionSearchHit;
    session: SessionMetadata;
    project: Project;
    deleteProtected: boolean;
    onOpen: (session: SessionMetadata, project: Project) => void;
    onContextMenu: (event: React.MouseEvent<HTMLDivElement>, session: SessionMetadata) => void;
    onShowStats: (event: React.MouseEvent, session: SessionMetadata) => void;
    onDelete: (event: React.MouseEvent, session: SessionMetadata) => void;
    onTagClick: (name: string) => void;
}) {
    const open = useCallback(() => onOpen(session, project), [onOpen, session, project]);
    const contextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => onContextMenu(event, session), [onContextMenu, session]);
    const stats = useCallback((event: React.MouseEvent) => onShowStats(event, session), [onShowStats, session]);
    const remove = useCallback((event: React.MouseEvent) => onDelete(event, session), [onDelete, session]);
    return <SessionSearchItem hit={hit} session={session} project={project} deleteProtected={deleteProtected}
        onClick={open} onContextMenu={contextMenu} onShowStats={stats} onDelete={remove} onTagClick={onTagClick} />;
});

export default memo(function HistorySearchOverlayContent({
    projects,
    onOpenSession,
    onRenameSession,
    onClose,
    taskCenterData,
    tagIntent,
    onTagIntentConsumed,
}: HistorySearchOverlayContentProps) {
    const { t } = useTranslation('app');
    const { t: tLauncher } = useTranslation('launcher');
    const {
        sessions,
        deleteProtectedSessionIds,
        sessionTagsMap,
        isSessionsLoading,
        sessionsError,
        actions,
    } = taskCenterData;
    const deleteSession = useSessionDeletion();
    const toast = useToast();

    // Search state
    const [isSearchMode, setIsSearchMode] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [composing, setComposing] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const compactSearchRef = useRef<HTMLButtonElement>(null);

    const [browseFilter, setBrowseFilter] = useState<BrowseFilter>('all');
    const [workspaceFilter, setWorkspaceFilter] = useState<string>('all');
    const [selectedUserTag, setSelectedUserTag] = useState<string | null>(() => tagIntent?.tag ?? null);
    const searchWorkspaces = useMemo(() => projects.map(project => project.path), [projects]);
    const search = useHistorySearch({ query: searchQuery, tag: selectedUserTag,
        workspaces: searchWorkspaces, composing,
        enabled: isSearchMode && !parseSessionIdQuery(searchQuery),
    });
    const searchResults = search.hits;
    const searchError = search.status === 'error';
    const isSearching = search.status === 'searching' || search.status === 'indexing';
    const [pendingDeleteSession, setPendingDeleteSession] = useState<{ id: string; title: string } | null>(null);
    const [statsSession, setStatsSession] = useState<{ id: string; title: string } | null>(null);
    const [contextMenu, setContextMenu] = useState<{ sessionId: string; source: 'history' | 'search'; x: number; y: number } | null>(null);
    const contextMenuAnchorRef = useRef<HTMLSpanElement>(null);
    const [appliedTagIntent, setAppliedTagIntent] = useState(tagIntent?.id ?? null);
    const acknowledgedTagIntent = useRef<number | null>(null);

    // A new App navigation intent resets this component's local view before
    // its children/effects commit. An effect reset would briefly start the old
    // query and then schedule another render and cancellation.
    if (tagIntent && tagIntent.id !== appliedTagIntent) {
        setAppliedTagIntent(tagIntent.id);
        setIsSearchMode(false);
        setSearchQuery('');
        setBrowseFilter('all');
        setWorkspaceFilter('all');
        setSelectedUserTag(tagIntent.tag);
    }
    useEffect(() => {
        if (tagIntent && acknowledgedTagIntent.current !== tagIntent.id) {
            acknowledgedTagIntent.current = tagIntent.id;
            onTagIntentConsumed?.(tagIntent.id);
        }
    }, [onTagIntentConsumed, tagIntent]);

    // Keep keyboard focus inside the overlay and on the same search affordance
    // as it morphs between compact and expanded states.
    useEffect(() => {
        if (isSearchMode) {
            searchInputRef.current?.focus();
        } else {
            compactSearchRef.current?.focus();
        }
    }, [isSearchMode]);

    const enterSearchMode = useCallback(() => {
        setIsSearchMode(true);
    }, []);

    const exitSearchMode = useCallback(() => {
        setIsSearchMode(false);
        setSearchQuery('');
    }, []);

    const projectsByWorkspace = useMemo(() => {
        const byWorkspace = new Map<string, Project>();
        for (const project of projects) {
            byWorkspace.set(normalizeWorkspacePathIdentity(project.path), project);
        }
        return byWorkspace;
    }, [projects]);

    const getProjectForSession = useCallback(
        (session: SessionMetadata): Project | undefined =>
            projectsByWorkspace.get(normalizeWorkspacePathIdentity(session.agentDir)),
        [projectsByWorkspace],
    );

    const userTagSummaries = useMemo(
        () => deriveSessionUserTagSummaries(sessions.filter((session) => !!getProjectForSession(session))),
        [getProjectForSession, sessions],
    );
    if (selectedUserTag && !isSessionsLoading
        && !userTagSummaries.some(tag => tag.name.toLowerCase() === selectedUserTag.toLowerCase())) {
        setSelectedUserTag(null);
    }

    const openTagAggregation = useCallback((name: string) => {
        setIsSearchMode(false);
        setSearchQuery('');
        setBrowseFilter('all');
        setWorkspaceFilter('all');
        setSelectedUserTag(name);
    }, []);

    const handleTagFilterChange = useCallback((name: string | null) => {
        setSelectedUserTag(name);
    }, []);

    const handleGlobalTagChange = useCallback((change: GlobalUserTagChange) => {
        setSelectedUserTag((current) => {
            if (!current || current.toLowerCase() !== change.name.toLowerCase()) return current;
            return change.kind === 'rename' ? (change.newName ?? null) : null;
        });
        actions.refreshSessions();
    }, [actions]);

    // Unique workspace entries for dropdown (name + icon)
    const workspaceOptions = useMemo(() => {
        const seen = new Map<string, string | undefined>(); // name → icon
        for (const s of sessions) {
            const proj = getProjectForSession(s);
            if (proj) {
                const name = getFolderName(proj.path);
                if (!seen.has(name)) seen.set(name, proj.icon);
            }
        }
        return Array.from(seen.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, icon]) => ({ name, icon }));
    }, [sessions, getProjectForSession]);

    // Memoize CustomSelect options to avoid re-creating JSX icons each render
    const workspaceSelectOptions = useMemo(() => [
        { value: 'all', label: t('historyOverlay.allWorkspaces') },
        ...workspaceOptions.map(({ name, icon }) => ({
            value: name,
            label: name,
            icon: <WorkspaceIcon icon={icon} size={14} />,
        })),
    ], [workspaceOptions, t]);

    // Filter sessions
    const filteredSessions = useMemo(() => {
        return sessions.filter(session => {
            if (browseFilter === 'favorite' && !session.favorite) return false;
            if (selectedUserTag && !sessionHasUserTag(session.userTags, selectedUserTag)) return false;

            // Workspace filter
            if (workspaceFilter !== 'all') {
                const proj = getProjectForSession(session);
                if (!proj || getFolderName(proj.path) !== workspaceFilter) return false;
            }

            return true;
        });
    }, [sessions, browseFilter, selectedUserTag, workspaceFilter, getProjectForSession]);

    const browseRows = useMemo(() => filteredSessions.flatMap((session) => {
        const project = getProjectForSession(session);
        return project ? [{ session, project }] : [];
    }), [filteredSessions, getProjectForSession]);

    // Paste-to-jump (Issue #260): if the query is a pasted session id (bare or
    // the `SessionID: <uuid>` copy-button format), resolve it directly against
    // the already-loaded sessions instead of running full-text search.
    //   - { kind: 'found' }    → render one clickable result, Enter opens it
    //   - { kind: 'notFound' } → the id is well-formed but no loaded session matches
    //   - null                 → not a session id, fall through to normal search
    const directSessionMatch = useMemo(() => {
        const sessionId = parseSessionIdQuery(searchQuery);
        if (!sessionId) return null;
        const session = sessions.find(s => (
            s.id.toLowerCase() === sessionId
            && (!selectedUserTag || sessionHasUserTag(s.userTags, selectedUserTag))
        ));
        const project = session ? getProjectForSession(session) : undefined;
        if (session && project) return { kind: 'found' as const, session, project };
        return { kind: 'notFound' as const };
    }, [searchQuery, selectedUserTag, sessions, getProjectForSession]);

    // Open the direct-match session (used by Enter in the search box).
    const openDirectMatch = useCallback(() => {
        if (directSessionMatch?.kind === 'found') {
            onOpenSession(directSessionMatch.session, directSessionMatch.project);
        }
    }, [directSessionMatch, onOpenSession]);

    const removeSearchSessions = search.removeSessions;
    useEffect(() => {
        // Store tombstones are pruned after a durable metadata refresh. Keep
        // observed removals in this query so that pruning cannot resurrect rows.
        removeSearchSessions(searchResults.filter(hit => isSessionDeleted(hit.sessionId)).map(hit => hit.sessionId));
    }, [sessions, searchResults, removeSearchSessions]);

    const searchRows = searchResults.flatMap(hit => {
        if (isSessionDeleted(hit.sessionId)) return [];
        const session = hit.session;
        const project = getProjectForSession(session);
        if (!project || (selectedUserTag && !sessionHasUserTag(session.userTags, selectedUserTag))) return [];
        return [{ hit, session, project }];
    });

    const protectedSessionIds = deleteProtectedSessionIds;

    const requestDelete = useCallback((session: SessionMetadata) => {
        setPendingDeleteSession({ id: session.id, title: getSessionDisplayText(session) });
    }, []);

    const handleDeleteClick = useCallback((e: React.MouseEvent, session: SessionMetadata) => {
        e.stopPropagation();
        requestDelete(session);
    }, [requestDelete]);

    const handleConfirmDelete = useCallback(async () => {
        if (!pendingDeleteSession) return;
        const { id } = pendingDeleteSession;
        setPendingDeleteSession(null);
        try {
            const result = await deleteSession(id);
            if (result.deleted) {
                removeSearchSessions([id]);
                toast.success(t('historyOverlay.deleted'));
            } else if (result.reason === 'in-use') {
                toast.warning(tLauncher('rightRail.deleteBlockedByOwner'));
            } else if (result.reason === 'transition-in-progress') {
                toast.warning(tLauncher('rightRail.deleteTransitionInProgress'));
            } else if (result.reason === 'activity-unavailable') {
                toast.warning(tLauncher('rightRail.deleteActivityUnavailable'));
            } else {
                toast.error(t('historyOverlay.deleteFailedRetry'));
            }
        } catch (err) {
            console.error('[HistorySearchOverlayContent] Delete session failed:', err);
            toast.error(t('historyOverlay.deleteFailed'));
        }
    }, [deleteSession, pendingDeleteSession, removeSearchSessions, t, tLauncher, toast]);

    const showStats = useCallback((session: SessionMetadata) => {
        setStatsSession({ id: session.id, title: getSessionDisplayText(session) });
    }, []);

    const handleShowStats = useCallback((e: React.MouseEvent, session: SessionMetadata) => {
        e.stopPropagation();
        showStats(session);
    }, [showStats]);

    const updateSearchSession = search.updateSession;
    const toggleFavorite = useCallback(async (session: SessionMetadata) => {
        try {
            const success = await actions.setSessionFavorite(session.id, !session.favorite);
            if (!success) toast.error(t('historyOverlay.favoriteFailed'));
            else updateSearchSession({ ...session, favorite: !session.favorite });
        } catch (err) {
            console.error('[HistorySearchOverlayContent] Toggle favorite failed:', err);
            toast.error(t('historyOverlay.favoriteFailed'));
        }
    }, [actions, t, toast, updateSearchSession]);

    const handleToggleFavorite = useCallback((e: React.MouseEvent, session: SessionMetadata) => {
        e.stopPropagation();
        void toggleFavorite(session);
    }, [toggleFavorite]);

    const handleCopySessionId = useCallback(async (session: SessionMetadata) => {
        try {
            await copyPlainText(`SessionID: ${session.id}`);
            toast.success(tLauncher('rightRail.copySessionIdSuccess'));
        } catch (error) {
            console.error('[HistorySearchOverlayContent] Copy session id failed:', error);
            toast.error(tLauncher('rightRail.copyFailed'));
        }
    }, [tLauncher, toast]);

    const openContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>, session: SessionMetadata, source: 'history' | 'search' = 'history') => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({ sessionId: session.id, source, x: event.clientX, y: event.clientY });
    }, []);
    const openSearchContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>, session: SessionMetadata) => {
        openContextMenu(event, session, 'search');
    }, [openContextMenu]);
    // Menu position/target is local interaction state; Session metadata belongs
    // to the same live collection as the row the user clicked.
    const menuSession = contextMenu?.source === 'search'
        ? searchResults.find(hit => hit.sessionId === contextMenu.sessionId)?.session
        : sessions.find(candidate => candidate.id === contextMenu?.sessionId);

    return (
        <>
                {/* Header — v0.1.69 renamed from "任务中心" to "历史对话" to
                    match the new domain of this overlay (Chat sessions only;
                    Tasks live in the Task Center singleton tab). */}
                <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-[var(--ink)]">{t('historyOverlay.title')}</h2>
                    <button
                        onClick={onClose}
                        aria-label={t('common.close')}
                        className="rounded-md p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                    >
                        <CloseIcon className="h-4 w-4" />
                    </button>
                </div>

                {/* Body — single column now that the cron-tasks right pane
                    has been removed. Kept inside the flex wrapper so a future
                    sibling (e.g. per-workspace stats) slides in without
                    further restructuring. */}
                <div className="flex min-h-0 flex-1">
                    <div className="flex min-w-0 flex-1 flex-col">
                        {/* Browse controls stay visible until the compact search field is
                            activated. The animated surface uses transform/opacity only,
                            while the toolbar keeps a fixed height above the long list. */}
                        <div className="relative mb-3 flex h-8 items-center gap-2">
                            <div
                                className={`flex h-full shrink-0 items-center gap-2 transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none ${
                                    isSearchMode
                                        ? 'pointer-events-none absolute -translate-x-2 opacity-0'
                                        : 'translate-x-0 opacity-100'
                                }`}
                                data-history-browse-controls
                                aria-hidden={isSearchMode}
                                inert={isSearchMode}
                            >
                                <div className="flex gap-1" data-history-browse-filters>
                                    {BROWSE_FILTER_OPTIONS.map(opt => (
                                        <button
                                            key={opt.key}
                                            onClick={() => setBrowseFilter(opt.key)}
                                            className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                                                browseFilter === opt.key
                                                    ? 'bg-[var(--button-primary-bg)] text-[var(--button-primary-text)]'
                                                    : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]'
                                            }`}
                                        >
                                            {t(opt.labelKey)}
                                        </button>
                                    ))}
                                </div>

                                {workspaceOptions.length > 1 && (
                                    <CustomSelect
                                        value={workspaceFilter}
                                        options={workspaceSelectOptions}
                                        onChange={setWorkspaceFilter}
                                        compact
                                        className="w-[140px]"
                                    />
                                )}
                            </div>
                            <UserTagFilter
                                tags={userTagSummaries}
                                value={selectedUserTag}
                                onChange={handleTagFilterChange}
                            />
                            <div
                                className="relative h-8 min-w-0 flex-1"
                                data-history-search-bar
                                data-state={isSearchMode ? 'expanded' : 'compact'}
                            >
                            <button
                                ref={compactSearchRef}
                                type="button"
                                onClick={enterSearchMode}
                                aria-label={t('historyOverlay.searchPlaceholder')}
                                aria-hidden={isSearchMode}
                                tabIndex={isSearchMode ? -1 : 0}
                                className={`absolute inset-y-0 right-0 flex w-[30%] min-w-72 items-center justify-between gap-3 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 text-xs text-[var(--ink-muted)] transition-[opacity,transform] duration-150 ease-out hover:border-[var(--line-strong)] hover:bg-[var(--paper-inset)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/20 motion-reduce:transition-none ${
                                    isSearchMode
                                        ? 'pointer-events-none translate-x-2 opacity-0'
                                        : 'pointer-events-auto translate-x-0 opacity-100'
                                }`}
                                data-history-search-compact-trigger
                            >
                                <span className="truncate text-[var(--ink-muted)]/60">
                                    {t('historyOverlay.searchPlaceholder')}
                                </span>
                                <SearchIcon className="h-3.5 w-3.5 shrink-0" />
                            </button>

                            <div
                                aria-hidden="true"
                                className={`pointer-events-none absolute inset-0 origin-right rounded-md border bg-[var(--paper-elevated)] transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${
                                    isSearchMode
                                        ? 'scale-x-100 border-[var(--accent)] opacity-100'
                                        : 'scale-x-[0.3] border-[var(--line)] opacity-0'
                                }`}
                                data-history-search-expanding-surface
                            />

                            <div
                                className={`absolute inset-0 transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none ${
                                    isSearchMode
                                        ? 'pointer-events-auto translate-x-0 opacity-100 delay-75 motion-reduce:delay-0'
                                        : 'pointer-events-none translate-x-2 opacity-0'
                                }`}
                                aria-hidden={!isSearchMode}
                                data-history-search-expanded-content
                            >
                                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-2.5 text-[var(--ink-muted)]/50">
                                    <SearchIcon className="h-3.5 w-3.5" />
                                </div>
                                <input
                                    ref={searchInputRef}
                                    type="text"
                                    value={searchQuery}
                                    disabled={!isSearchMode}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    onCompositionStart={() => setComposing(true)}
                                    onCompositionEnd={(e) => { setComposing(false); setSearchQuery(e.currentTarget.value); }}
                                    aria-label={t('historyOverlay.searchPlaceholder')}
                                    placeholder={t('historyOverlay.searchPlaceholder')}
                                    className="h-full w-full bg-transparent py-1 pl-8 pr-10 text-sm text-[var(--ink)] outline-none placeholder:text-xs placeholder:text-[var(--ink-muted)]/60 disabled:cursor-default"
                                    onKeyDown={(e) => {
                                        if (isImeComposingEvent(e) || composing) return;
                                        if (e.key === 'Escape') {
                                            e.preventDefault();
                                            exitSearchMode();
                                        } else if (e.key === 'Enter' && directSessionMatch?.kind === 'found') {
                                            // Paste-to-jump: Enter opens the matched session (#260).
                                            e.preventDefault();
                                            openDirectMatch();
                                        } else if (e.key === 'Enter') {
                                            e.preventDefault();
                                            search.refresh();
                                        }
                                    }}
                                />
                                <div className="absolute inset-y-0 right-0 flex items-center gap-1 pr-2">
                                    {isSearching && (
                                        <LoaderIcon className="h-3.5 w-3.5 animate-spin text-[var(--ink-muted)]/50" />
                                    )}
                                    <button
                                        type="button"
                                        onClick={exitSearchMode}
                                        aria-label={t('historyOverlay.exitSearch')}
                                        tabIndex={isSearchMode ? 0 : -1}
                                        className="flex items-center rounded-sm text-[var(--ink-muted)]/50 transition-colors hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/20"
                                    >
                                        <CloseIcon className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            </div>
                        </div>
                        </div>

                        {sessionsError && (
                            <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-md border border-[var(--error)]/20 bg-[var(--error-bg)] px-3 py-2 text-xs text-[var(--error)]">
                                <span>{t('historyOverlay.metadataFailed')}</span>
                                <button
                                    type="button"
                                    onClick={actions.refreshSessions}
                                    className="shrink-0 rounded px-2 py-1 font-medium hover:bg-[var(--paper-elevated)]"
                                >
                                    {t('historyOverlay.retry')}
                                </button>
                            </div>
                        )}

                        {/* Session list — empty-query history is virtualized so opening
                            the overlay never mounts the entire archive in one commit. */}
                        {isSearchMode && directSessionMatch ? (
                            <div className="flex-1 overflow-y-auto overscroll-contain" style={{ scrollbarGutter: 'stable' }}>
                                {directSessionMatch.kind === 'found' ? (
                                    <div className="space-y-2">
                                        <div className="px-1 text-xs text-[var(--ink-muted)]/60">
                                            {t('historyOverlay.directMatch')}
                                        </div>
                                        <div
                                            role="button"
                                            onClick={openDirectMatch}
                                            onMouseDown={(event) => {
                                                if (event.button === 2) event.preventDefault();
                                            }}
                                            onContextMenu={(event) => openContextMenu(event, directSessionMatch.session)}
                                            className="group flex w-full cursor-pointer select-none items-center gap-2.5 rounded-lg border border-[var(--accent)]/30 px-3 py-2.5 text-left transition-colors hover:bg-[var(--hover-bg)]"
                                            data-history-direct-session-row
                                        >
                                            <div className="flex w-16 shrink-0 items-center gap-1 text-xs text-[var(--ink-muted)]/50">
                                                <ClockIcon className="h-2.5 w-2.5" />
                                                <span>{formatTime(directSessionMatch.session.lastActiveAt)}</span>
                                            </div>
                                            <UserTagPills tags={directSessionMatch.session.userTags} onTagClick={openTagAggregation} />
                                            <span className="min-w-0 flex-1 truncate text-sm text-[var(--ink-secondary)] transition-colors group-hover:text-[var(--ink)]">
                                                {getSessionDisplayText(directSessionMatch.session)}
                                            </span>
                                            <div className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--ink-muted)]/45">
                                                <WorkspaceIcon icon={directSessionMatch.project.icon} size={14} />
                                                <span className="max-w-[80px] truncate">
                                                    {getFolderName(directSessionMatch.project.path)}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="py-8 text-center text-sm text-[var(--ink-muted)]/60">
                                        {t('historyOverlay.sessionNotFound')}
                                    </div>
                                )}
                            </div>
                        ) : isSearchMode && searchQuery.trim() !== '' ? (
                            <div className="flex min-h-0 flex-1 flex-col" aria-busy={isSearching}>
                                <div className="mb-2 flex items-center justify-between px-1 text-xs text-[var(--ink-muted)]/70">
                                    <span>{t('historyOverlay.recentActivityOrder')}</span>
                                    <span role="status">{isSearching
                                        ? t(search.status === 'indexing' ? 'historyOverlay.preparingIndex' : 'historyOverlay.searching')
                                        : search.status === 'ready' ? t('historyOverlay.resultsLoaded', { loaded: searchRows.length, total: search.total }) : ''}</span>
                                </div>
                                {searchError && !isSearching ? (
                                    <div role="alert" className="py-8 text-center text-sm text-[var(--error)]">
                                        {t('historyOverlay.searchFailed')}
                                        <button type="button" onClick={search.refresh} className="ml-2 underline">{t('historyOverlay.retry')}</button>
                                    </div>
                                ) : searchRows.length === 0 && !isSearching ? (
                                    <div className="py-8 text-center text-sm text-[var(--ink-muted)]/60">
                                        {t('historyOverlay.noResults')}
                                    </div>
                                ) : (
                                    <Virtuoso
                                        key={search.queryId}
                                        data={searchRows}
                                        computeItemKey={(_index, row) => row.hit.sessionId}
                                        defaultItemHeight={64}
                                        increaseViewportBy={200}
                                        className="min-h-0 flex-1 overscroll-contain"
                                        style={{ scrollbarGutter: 'stable' }}
                                        rangeChanged={({ endIndex }) => {
                                            if (!isSearching && !search.pageError && search.hasMore && endIndex >= searchRows.length - 8) void search.loadMore();
                                        }}
                                        endReached={() => {
                                            if (!isSearching && !search.pageError && search.hasMore) void search.loadMore();
                                        }}
                                        itemContent={(_index, row) => (
                                            <HistorySearchResultRow
                                                hit={row.hit} session={row.session} project={row.project}
                                                deleteProtected={protectedSessionIds.has(row.session.id)}
                                                onOpen={onOpenSession} onContextMenu={openSearchContextMenu}
                                                onShowStats={handleShowStats} onDelete={handleDeleteClick}
                                                onTagClick={openTagAggregation}
                                            />
                                        )}
                                    />
                                )}
                                {search.loadingMore && <div role="status" className="flex justify-center py-2"><LoaderIcon className="h-4 w-4 animate-spin text-[var(--ink-muted)]" aria-label={t('historyOverlay.loadingMore')} /></div>}
                                {search.pageError && <div role="alert" className="py-2 text-center text-xs text-[var(--error)]">
                                    {t(search.pageError === 'expired' ? 'historyOverlay.searchExpired' : 'historyOverlay.pageFailed')}
                                    <button type="button" className="ml-2 underline" onClick={search.pageError === 'expired' ? search.refresh : () => { void search.loadMore(); }}>{t('historyOverlay.retry')}</button>
                                </div>}
                            </div>
                        ) : isSessionsLoading && browseRows.length === 0 ? (
                            <div className="flex flex-1 items-center justify-center" aria-busy="true">
                                <LoaderIcon className="h-4 w-4 animate-spin text-[var(--ink-muted)]/50" />
                            </div>
                        ) : browseRows.length === 0 ? (
                            <div className="flex-1 py-8 text-center text-sm text-[var(--ink-muted)]/60">
                                {t('historyOverlay.empty')}
                            </div>
                        ) : (
                            <Virtuoso
                                data={browseRows}
                                computeItemKey={(_index, row) => row.session.id}
                                defaultItemHeight={38}
                                increaseViewportBy={240}
                                className="flex-1 overscroll-contain"
                                style={{ scrollbarGutter: 'stable' }}
                                itemContent={(_index, row) => (
                                    <HistorySessionRow
                                        session={row.session}
                                        project={row.project}
                                        tags={sessionTagsMap.get(row.session.id) ?? []}
                                        deleteProtected={protectedSessionIds.has(row.session.id)}
                                        onOpen={() => onOpenSession(row.session, row.project)}
                                        onContextMenu={(event) => openContextMenu(event, row.session)}
                                        onToggleFavorite={(event) => handleToggleFavorite(event, row.session)}
                                        onShowStats={(event) => handleShowStats(event, row.session)}
                                        onDelete={(event) => handleDeleteClick(event, row.session)}
                                        onTagClick={openTagAggregation}
                                    />
                                )}
                            />
                        )}
                    </div>
                </div>

            {createPortal(
                <span
                    ref={contextMenuAnchorRef}
                    aria-hidden="true"
                    className="pointer-events-none fixed h-px w-px"
                    style={{ left: contextMenu?.x ?? 0, top: contextMenu?.y ?? 0 }}
                />,
                document.body,
            )}
            {contextMenu && menuSession && !isSessionDeleted(menuSession.id) && (
                <SessionContextMenu
                    open
                    onClose={() => setContextMenu(null)}
                    anchorRef={contextMenuAnchorRef}
                    placement="bottom-start"
                    session={menuSession}
                    deleteProtected={protectedSessionIds.has(menuSession.id)}
                    onCopySessionId={() => handleCopySessionId(menuSession)}
                    onToggleFavorite={() => toggleFavorite(menuSession)}
                    onRenameSession={async (id, title) => {
                        const updated = await onRenameSession(id, title);
                        if (updated) search.updateSession(updated);
                        return updated;
                    }}
                    onShowStats={() => showStats(menuSession)}
                    onDelete={() => requestDelete(menuSession)}
                    onSessionMutationStart={actions.beginSessionMetadataMutation}
                    onSessionUpdated={(updated, sequence) => {
                        const applied = actions.applySessionMetadata(updated, sequence);
                        if (applied) search.updateSession(updated);
                        return applied;
                    }}
                    onRefreshSessions={() => { actions.refreshSessions(); search.refresh(); }}
                    onGlobalTagChange={handleGlobalTagChange}
                />
            )}

            {pendingDeleteSession && (
                <ConfirmDialog
                    title={t('historyOverlay.deleteTitle')}
                    message={t('historyOverlay.deleteMessage', { title: pendingDeleteSession.title })}
                    confirmText={t('historyOverlay.delete')}
                    confirmVariant="danger"
                    onConfirm={handleConfirmDelete}
                    onCancel={() => setPendingDeleteSession(null)}
                />
            )}
            {statsSession && (
                <SessionStatsModal
                    sessionId={statsSession.id}
                    sessionTitle={statsSession.title}
                    onClose={() => setStatsSession(null)}
                />
            )}
        </>
    );
});
