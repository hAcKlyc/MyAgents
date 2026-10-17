import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    searchSessions: vi.fn(),
    searchSessionPage: vi.fn(),
    closeSessionSearch: vi.fn(),
    deleteSession: vi.fn(),
    getSessionUserTags: vi.fn(),
    mutateSessionUserTagAssignment: vi.fn(),
    deletedIds: new Set<string>(),
    toast: {
        success: vi.fn(),
        error: vi.fn(),
        warning: vi.fn(),
    },
}));

vi.mock('@/api/sessionClient', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/api/sessionClient')>(),
    getSessionUserTags: mocks.getSessionUserTags,
    mutateSessionUserTagAssignment: mocks.mutateSessionUserTagAssignment,
}));

vi.mock('@/api/searchClient', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/api/searchClient')>();
    return { ...actual, searchSessions: mocks.searchSessions, searchSessionPage: mocks.searchSessionPage, closeSessionSearch: mocks.closeSessionSearch };
});

vi.mock('@/hooks/useTaskCenterData', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/hooks/useTaskCenterData')>(),
    isSessionDeleted: (id: string) => mocks.deletedIds.has(id),
}));

vi.mock('@/components/Toast', () => ({
    useToast: () => mocks.toast,
}));

vi.mock('@/context/SessionDeletionContext', () => ({
    useSessionDeletion: () => mocks.deleteSession,
}));

vi.mock('react-virtuoso', () => ({
    Virtuoso: ({
        data,
        itemContent,
    }: {
        data: unknown[];
        itemContent: (index: number, item: unknown) => React.ReactNode;
    }) => <>{data.map((item, index) => <div key={index}>{itemContent(index, item)}</div>)}</>,
}));

import type { SessionMetadata } from '@/api/sessionClient';
import type { Project } from '@/config/types';
import type { TaskCenterData } from '@/hooks/useTaskCenterData';
import { i18n } from '@/i18n';

import HistorySearchOverlayContent from './HistorySearchOverlayContent';

const session: SessionMetadata = {
    id: '642ea003-5219-4af7-a812-a9812d6e79de',
    agentDir: '/workspace',
    title: 'Shared menu session',
    createdAt: '2026-07-20T00:00:00.000Z',
    lastActiveAt: '2026-07-20T00:00:00.000Z',
};

const project: Project = {
    id: 'project-1',
    name: 'Workspace',
    path: '/workspace',
    providerId: null,
    permissionMode: null,
};

function taskCenterData(overrides: Partial<TaskCenterData> = {}): TaskCenterData {
    return {
        sessions: [session],
        deleteProtectedSessionIds: new Set(),
        sessionTagsMap: new Map(),
        isSessionsLoading: false,
        actions: {
            deleteSession: vi.fn(async () => ({ deleted: true as const })),
            setSessionFavorite: vi.fn(async () => true),
            beginSessionMetadataMutation: vi.fn(() => 1),
            applySessionMetadata: vi.fn(() => true),
            refreshSessions: vi.fn(),
        },
        ...overrides,
    } as TaskCenterData;
}

function renderOverlay() {
    return render(
        <HistorySearchOverlayContent
            projects={[project]}
            taskCenterData={taskCenterData()}
            onClose={vi.fn()}
            onOpenSession={vi.fn()}
            onRenameSession={vi.fn(async () => null)}
        />,
    );
}

function enterSearchMode() {
    const trigger = screen.getByRole('button', {
        name: i18n.t('app:historyOverlay.searchPlaceholder'),
    });
    fireEvent.click(trigger);
    return screen.getByPlaceholderText(i18n.t('app:historyOverlay.searchPlaceholder'));
}

function expectSharedSessionMenu() {
    const menu = document.querySelector<HTMLElement>('.session-context-menu');
    expect(menu).not.toBeNull();
    expect(within(menu!).getAllByRole('button').map(button => button.textContent)).toEqual([
        i18n.t('launcher:rightRail.copySessionId'),
        i18n.t('launcher:rightRail.rename'),
        i18n.t('launcher:rightRail.favorite'),
        i18n.t('common:sessionTags.addTag'),
        i18n.t('launcher:rightRail.viewStats'),
        i18n.t('launcher:rightRail.archive'),
        i18n.t('launcher:rightRail.delete'),
    ]);
}

describe('HistorySearchOverlayContent', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.deletedIds.clear();
        mocks.getSessionUserTags.mockResolvedValue([{ name: 'Alpha', count: 1 }]);
        mocks.closeSessionSearch.mockResolvedValue(undefined);
        mocks.searchSessions.mockResolvedValue({ queryId: 'query', nextCursor: null, removedSessionIds: [], hits: [], totalCount: 0, queryTimeMs: 1 });
        await i18n.changeLanguage('zh-CN');
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: vi.fn().mockResolvedValue(undefined) },
        });
    });

    it('renders a complete search page before the global metadata projection has loaded', async () => {
        const hit = { session, sessionId: session.id, title: session.title, agentDir: session.agentDir,
            score: 1, matchType: 'title', snippet: null, snippetHighlights: [], titleHighlights: [],
            matchedRole: null, lastActiveAt: session.lastActiveAt, source: 'desktop', turnCount: 1 };
        mocks.searchSessions.mockResolvedValue({ queryId: 'cold', nextCursor: null, removedSessionIds: [],
            hits: [hit], totalCount: 1, queryTimeMs: 1 });
        const onOpenSession = vi.fn();
        render(<HistorySearchOverlayContent projects={[project]}
            taskCenterData={taskCenterData({ sessions: [], isSessionsLoading: true })}
            onClose={vi.fn()} onOpenSession={onOpenSession} onRenameSession={vi.fn()} />);
        fireEvent.change(enterSearchMode(), { target: { value: 'Shared' } });
        fireEvent.click(await screen.findByText(session.title!));
        expect(onOpenSession).toHaveBeenCalledWith(session, project);
    });

    it('does not resurrect a deleted final-page result when the store prunes its tombstone', async () => {
        const hit = { session, sessionId: session.id, title: session.title, agentDir: session.agentDir,
            score: 1, matchType: 'title', snippet: null, snippetHighlights: [], titleHighlights: [],
            matchedRole: null, lastActiveAt: session.lastActiveAt, source: 'desktop', turnCount: 1 };
        mocks.searchSessions.mockResolvedValue({ queryId: 'final', nextCursor: null, removedSessionIds: [],
            hits: [hit], totalCount: 1, queryTimeMs: 1 });
        const view = (sessions: SessionMetadata[]) => <HistorySearchOverlayContent projects={[project]}
            taskCenterData={taskCenterData({ sessions })} onClose={vi.fn()}
            onOpenSession={vi.fn()} onRenameSession={vi.fn()} />;
        const { rerender } = render(view([session]));
        fireEvent.change(enterSearchMode(), { target: { value: 'Shared' } });
        expect(await screen.findByText(session.title!)).toBeInTheDocument();
        mocks.deletedIds.add(session.id);
        rerender(view([]));
        await waitFor(() => expect(screen.queryByText(session.title!)).not.toBeInTheDocument());
        mocks.deletedIds.clear();
        rerender(view([]));
        expect(screen.queryByText(session.title!)).not.toBeInTheDocument();
        expect(mocks.searchSessions).toHaveBeenCalledOnce();
    });

    it('opens with a compact right-side search field and expands it on activation', async () => {
        renderOverlay();

        const searchBar = document.querySelector<HTMLElement>('[data-history-search-bar]')!;
        const browseControls = document.querySelector<HTMLElement>('[data-history-browse-controls]')!;
        const expandingSurface = document.querySelector<HTMLElement>('[data-history-search-expanding-surface]')!;
        const trigger = screen.getByRole('button', {
            name: i18n.t('app:historyOverlay.searchPlaceholder'),
        });
        const input = screen.getByPlaceholderText(i18n.t('app:historyOverlay.searchPlaceholder'));

        expect(searchBar).toHaveAttribute('data-state', 'compact');
        expect(trigger).toHaveClass('w-[30%]', 'opacity-100');
        expect(trigger).toHaveFocus();
        expect(input).toBeDisabled();
        expect(browseControls).not.toHaveAttribute('inert');

        fireEvent.click(trigger);

        expect(searchBar).toHaveAttribute('data-state', 'expanded');
        expect(expandingSurface).toHaveClass('scale-x-100', 'opacity-100');
        expect(browseControls).toHaveAttribute('inert');
        expect(input).not.toBeDisabled();
        expect(screen.getByRole('textbox', {
            name: i18n.t('app:historyOverlay.searchPlaceholder'),
        })).toBe(input);
        await waitFor(() => expect(input).toHaveFocus());
    });

    it('collapses search, clears the query, and restores focus to the compact field', async () => {
        renderOverlay();
        const input = enterSearchMode();
        fireEvent.change(input, { target: { value: 'Shared menu' } });

        fireEvent.click(screen.getByRole('button', { name: i18n.t('app:historyOverlay.exitSearch') }));

        const trigger = screen.getByRole('button', {
            name: i18n.t('app:historyOverlay.searchPlaceholder'),
        });
        expect(input).toHaveValue('');
        expect(input).toBeDisabled();
        await waitFor(() => expect(trigger).toHaveFocus());
    });

    it('uses Escape to return from expanded search to browse mode', async () => {
        renderOverlay();
        const input = enterSearchMode();

        fireEvent.keyDown(input, { key: 'Escape' });

        expect(document.querySelector('[data-history-search-bar]')).toHaveAttribute('data-state', 'compact');
        await waitFor(() => expect(screen.getByRole('button', {
            name: i18n.t('app:historyOverlay.searchPlaceholder'),
        })).toHaveFocus());
    });

    it('keeps only all and favorites in the non-search browse filters', () => {
        renderOverlay();

        const browseFilters = document.querySelector<HTMLElement>('[data-history-browse-filters]')!;
        expect(within(browseFilters).getByRole('button', { name: '全部' })).toBeInTheDocument();
        const favoritesFilter = within(browseFilters).getByRole('button', { name: '收藏' });
        for (const removedFilter of ['活跃中', '桌面', '聊天机器人']) {
            expect(within(browseFilters).queryByRole('button', { name: removedFilter })).not.toBeInTheDocument();
        }

        fireEvent.click(favoritesFilter);
        expect(screen.queryByText(session.title)).not.toBeInTheDocument();
    });

    it('uses the shared sidebar menu and suppresses text selection in the browse list', async () => {
        renderOverlay();

        const row = screen.getByText(session.title).closest<HTMLElement>('[data-history-session-row]')!;
        expect(row).toHaveClass('select-none');

        const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 });
        fireEvent(row, mouseDown);
        expect(mouseDown.defaultPrevented).toBe(true);

        const contextMenu = new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            button: 2,
            clientX: 120,
            clientY: 90,
        });
        fireEvent(row, contextMenu);
        expect(contextMenu.defaultPrevented).toBe(true);
        expectSharedSessionMenu();

        fireEvent.click(screen.getByRole('button', { name: i18n.t('launcher:rightRail.copySessionId') }));
        await waitFor(() => {
            expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`SessionID: ${session.id}`);
            expect(mocks.toast.success).toHaveBeenCalledWith(i18n.t('launcher:rightRail.copySessionIdSuccess'));
        });
    });

    it('uses the newly right-clicked session when switching an open Tag picker', async () => {
        const secondSession = { ...session, id: 'session-b', title: 'Second session' };
        mocks.mutateSessionUserTagAssignment.mockResolvedValue({
            action: 'updated', affectedSessionCount: 1, tags: [{ name: 'Alpha', count: 2 }],
            session: { ...session, userTags: ['Alpha'] },
        });
        render(<HistorySearchOverlayContent projects={[project]}
            taskCenterData={taskCenterData({ sessions: [session, secondSession] })}
            onClose={vi.fn()} onOpenSession={vi.fn()} onRenameSession={vi.fn(async () => null)} />);
        fireEvent.contextMenu(screen.getByText(session.title).closest('[data-history-session-row]')!);
        fireEvent.click(screen.getByRole('button', { name: i18n.t('common:sessionTags.addTag') }));
        fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Alpha/ }));
        await waitFor(() => expect(screen.getByRole('menuitemcheckbox', { name: /Alpha/ })).toHaveAttribute('aria-checked', 'true'));

        fireEvent.contextMenu(screen.getByText(secondSession.title).closest('[data-history-session-row]')!);
        if (!screen.queryByRole('menuitemcheckbox', { name: /Alpha/ })) {
            fireEvent.click(screen.getByRole('button', { name: i18n.t('common:sessionTags.addTag') }));
        }
        const tag = await screen.findByRole('menuitemcheckbox', { name: /Alpha/ });
        expect(tag).toHaveAttribute('aria-checked', 'false');
        fireEvent.click(tag);
        await waitFor(() => expect(mocks.mutateSessionUserTagAssignment).toHaveBeenLastCalledWith(
            secondSession.id, { kind: 'add', name: 'Alpha' },
        ));
    });

    it('keeps an open history menu synchronized with the live Session collection', async () => {
        mocks.getSessionUserTags.mockResolvedValue([{ name: 'Alpha', count: 1 }, { name: 'Beta', count: 1 }]);
        const view = (current: SessionMetadata) => <HistorySearchOverlayContent projects={[project]}
            taskCenterData={taskCenterData({ sessions: [current] })} onClose={vi.fn()}
            onOpenSession={vi.fn()} onRenameSession={vi.fn()} />;
        const { rerender } = render(view({ ...session, userTags: ['Alpha'] }));
        fireEvent.contextMenu(screen.getByText(session.title).closest('[data-history-session-row]')!);
        fireEvent.click(screen.getByRole('button', { name: i18n.t('common:sessionTags.addTag') }));
        expect(await screen.findByRole('menuitemcheckbox', { name: /Alpha/ })).toHaveAttribute('aria-checked', 'true');
        rerender(view({ ...session, userTags: ['Beta'] }));
        expect(screen.getByRole('menuitemcheckbox', { name: /Alpha/ })).toHaveAttribute('aria-checked', 'false');
        expect(screen.getByRole('menuitemcheckbox', { name: /Beta/ })).toHaveAttribute('aria-checked', 'true');
    });

    it('uses the current search-hit metadata for a full-text result menu', async () => {
        mocks.getSessionUserTags.mockResolvedValue([{ name: 'Alpha', count: 1 }, { name: 'Beta', count: 1 }]);
        const hitSession = { ...session, userTags: ['Beta'] };
        const hit = { session: hitSession, sessionId: session.id, title: session.title, agentDir: session.agentDir,
            score: 1, matchType: 'title', snippet: null, snippetHighlights: [], titleHighlights: [],
            matchedRole: null, lastActiveAt: session.lastActiveAt, source: 'desktop', turnCount: 1 };
        mocks.searchSessions.mockResolvedValue({ queryId: 'tags-search', nextCursor: null, removedSessionIds: [], hits: [hit], totalCount: 1, queryTimeMs: 1 });
        render(<HistorySearchOverlayContent projects={[project]}
            taskCenterData={taskCenterData({ sessions: [{ ...session, userTags: ['Alpha'] }] })}
            onClose={vi.fn()} onOpenSession={vi.fn()} onRenameSession={vi.fn()} />);
        fireEvent.change(enterSearchMode(), { target: { value: 'Shared' } });
        const title = await screen.findByText(session.title);
        fireEvent.contextMenu(title.closest('[data-history-search-session-row]')!);
        fireEvent.click(screen.getByRole('button', { name: i18n.t('common:sessionTags.addTag') }));
        expect(await screen.findByRole('menuitemcheckbox', { name: /Beta/ })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByRole('menuitemcheckbox', { name: /Alpha/ })).toHaveAttribute('aria-checked', 'false');
    });

    it('routes browse deletion through the App owner and explains a live owner refusal', async () => {
        mocks.deleteSession.mockResolvedValue({ deleted: false, reason: 'in-use' });
        renderOverlay();

        const row = screen.getByText(session.title).closest<HTMLElement>('[data-history-session-row]')!;
        fireEvent.contextMenu(row, { clientX: 120, clientY: 90 });
        const menu = document.querySelector<HTMLElement>('.session-context-menu')!;
        fireEvent.click(within(menu).getByRole('button', { name: i18n.t('launcher:rightRail.delete') }));
        const confirm = screen.getByText(i18n.t('app:historyOverlay.deleteTitle'))
            .closest<HTMLElement>('.glass-panel')!;
        fireEvent.click(within(confirm).getByRole('button', { name: i18n.t('app:historyOverlay.delete') }));

        await waitFor(() => {
            expect(mocks.deleteSession).toHaveBeenCalledWith(session.id);
            expect(mocks.toast.warning).toHaveBeenCalledWith(
                i18n.t('launcher:rightRail.deleteBlockedByOwner'),
            );
        });
    });

    it('routes a direct Session ID deletion through the App owner', async () => {
        mocks.deleteSession.mockResolvedValue({ deleted: true });
        renderOverlay();
        fireEvent.change(enterSearchMode(), {
            target: { value: `SessionID: ${session.id}` },
        });

        const row = screen.getByText(session.title).closest<HTMLElement>('[data-history-direct-session-row]')!;
        fireEvent.contextMenu(row, { clientX: 160, clientY: 110 });

        expectSharedSessionMenu();
        const menu = document.querySelector<HTMLElement>('.session-context-menu')!;
        fireEvent.click(within(menu).getByRole('button', { name: i18n.t('launcher:rightRail.delete') }));
        const confirm = screen.getByText(i18n.t('app:historyOverlay.deleteTitle'))
            .closest<HTMLElement>('.glass-panel')!;
        fireEvent.click(within(confirm).getByRole('button', { name: i18n.t('app:historyOverlay.delete') }));

        await waitFor(() => {
            expect(mocks.deleteSession).toHaveBeenCalledWith(session.id);
            expect(mocks.toast.success).toHaveBeenCalledWith(
                i18n.t('app:historyOverlay.deleted'),
            );
        });
    });

    it('opens the same menu for a full-text search result', async () => {
        mocks.searchSessions.mockResolvedValue({
            queryId: 'query', nextCursor: null, removedSessionIds: [], totalCount: 1, queryTimeMs: 1,
            hits: [{
                session,
                sessionId: session.id,
                title: session.title,
                agentDir: session.agentDir,
                score: 1,
                matchType: 'title',
                snippet: null,
                snippetHighlights: [],
                titleHighlights: [],
                matchedRole: null,
                lastActiveAt: session.lastActiveAt,
                source: 'desktop',
                turnCount: 1,
            }],
        });
        renderOverlay();
        fireEvent.change(enterSearchMode(), {
            target: { value: 'Shared menu' },
        });

        const title = await screen.findByText(session.title);
        const row = title.closest<HTMLElement>('[data-history-search-session-row]')!;
        fireEvent.contextMenu(row, { clientX: 180, clientY: 130 });

        expectSharedSessionMenu();
    });

    it('uses a single Tag filter for both browse metadata and pre-limit full-text search', async () => {
        const taggedSession = { ...session, id: 'session-alpha', userTags: ['Alpha'] };
        const otherSession = { ...session, id: 'session-beta', title: 'Other session', userTags: ['Beta'] };
        mocks.searchSessions.mockResolvedValue({ queryId: 'query', nextCursor: null, removedSessionIds: [], hits: [], totalCount: 0, queryTimeMs: 1 });
        render(
            <HistorySearchOverlayContent
                projects={[project]}
                taskCenterData={taskCenterData({ sessions: [taggedSession, otherSession] })}
                onClose={vi.fn()}
                onOpenSession={vi.fn()}
                onRenameSession={vi.fn(async () => null)}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: i18n.t('common:sessionTags.allTags') }));
        fireEvent.click(screen.getByRole('option', { name: /Alpha/ }));
        expect(document.querySelectorAll('[data-history-session-row]')).toHaveLength(1);
        expect(screen.getByText(taggedSession.title)).toBeInTheDocument();
        expect(screen.queryByText(otherSession.title)).not.toBeInTheDocument();

        fireEvent.change(enterSearchMode(), { target: { value: 'needle' } });
        await waitFor(() => expect(mocks.searchSessions).toHaveBeenCalledWith(expect.objectContaining({ query: 'needle', tag: 'Alpha', workspaces: ['/workspace'] })));

        fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
        fireEvent.click(screen.getByRole('option', { name: i18n.t('common:sessionTags.allTags') }));
        expect(screen.getByPlaceholderText(i18n.t('app:historyOverlay.searchPlaceholder'))).toHaveValue('needle');
        await waitFor(() => expect(mocks.searchSessions).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'needle', tag: null, workspaces: ['/workspace'] })));
    });

    it('applies a clicked Tag intent as a clean aggregation and acknowledges it once', () => {
        const onConsumed = vi.fn();
        render(
            <HistorySearchOverlayContent
                projects={[project]}
                taskCenterData={taskCenterData({ sessions: [{ ...session, userTags: ['Alpha'] }] })}
                onClose={vi.fn()}
                onOpenSession={vi.fn()}
                onRenameSession={vi.fn(async () => null)}
                tagIntent={{ id: 7, tag: 'Alpha' }}
                onTagIntentConsumed={onConsumed}
            />,
        );

        expect(document.querySelector('button[aria-haspopup="listbox"]')).toHaveTextContent('Alpha');
        expect(onConsumed).toHaveBeenCalledOnce();
        expect(onConsumed).toHaveBeenCalledWith(7);
    });

    it('keeps stale history rows visible and offers retry when metadata refresh fails', () => {
        const refreshSessions = vi.fn();
        render(
            <HistorySearchOverlayContent
                projects={[project]}
                taskCenterData={taskCenterData({
                    sessionsError: 'failed',
                    actions: {
                        ...taskCenterData().actions,
                        refreshSessions,
                    } as TaskCenterData['actions'],
                })}
                onClose={vi.fn()}
                onOpenSession={vi.fn()}
                onRenameSession={vi.fn(async () => null)}
            />,
        );

        expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('app:historyOverlay.metadataFailed'));
        expect(screen.getByText(session.title)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: i18n.t('app:historyOverlay.retry') }));
        expect(refreshSessions).toHaveBeenCalledOnce();
    });
});
