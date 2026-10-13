import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: { defaultWorkspacePath: null as string | null, agents: [] },
  projects: [] as Array<Record<string, unknown>>,
  taskData: {
    sessions: [] as Array<Record<string, unknown>>,
    isSessionsLoading: false,
    error: null as string | null,
    sessionTagsMap: new Map(),
    workspaceSessionStates: new Map<string, { isLoading: boolean; error: string | null }>(),
    deleteProtectedSessionIds: new Set<string>(),
    refresh: vi.fn(),
    actions: {
      deleteSession: vi.fn(async () => ({ deleted: true as const })),
      setSessionFavorite: vi.fn(async () => true),
      beginSessionMetadataMutation: vi.fn(() => 1),
      applySessionMetadata: vi.fn(() => true),
      refreshSessions: vi.fn(),
    },
  },
  addProject: vi.fn(),
  removeProject: vi.fn(),
  patchProject: vi.fn(),
  touchProject: vi.fn(),
  refreshConfig: vi.fn(),
  configError: null as string | null,
  forcedRail: true,
  isTauri: false,
  openExternal: vi.fn(async () => undefined),
  openPathExternal: vi.fn(async () => undefined),
  deleteSession: vi.fn(),
  updateSession: vi.fn(),
  notificationSnapshot: {
    loadState: 'ready',
    authState: 'signed_out',
    items: [] as Array<Record<string, unknown>>,
    hasUnread: false,
    hasMore: false,
    isLoadingMore: false,
    feedCutoff: null,
    lastSyncedAt: null,
    errorCode: null,
  },
  notificationRefresh: vi.fn(),
  notificationLoadMore: vi.fn(async () => undefined),
  notificationMarkAllRead: vi.fn(async () => undefined),
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@/features/account/useMyAgentsAccount', () => ({
  useMyAgentsAccount: () => ({
    scope: 'production', enabled: false, generation: 0, loadState: 'ready',
    view: null, error: null,
    avatarPresets: { people: [], agents: [], lastFetchedAt: 0, isLoading: false, error: null },
  }),
}));

vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({
    config: mocks.config,
    projects: mocks.projects,
    isLoading: false,
    error: mocks.configError,
    addProject: mocks.addProject,
    removeProject: mocks.removeProject,
    patchProject: mocks.patchProject,
    touchProject: mocks.touchProject,
    refreshConfig: mocks.refreshConfig,
  }),
}));

vi.mock('@/hooks/useTaskCenterData', () => ({
  useGlobalSidebarTaskCenterData: () => mocks.taskData,
}));

vi.mock('@/hooks/taskCenterStore', () => ({ ensureWorkspaceSessions: vi.fn() }));

vi.mock('@/hooks/useWorkspaceFileService', () => ({
  useWorkspaceFileService: () => ({ openPathExternal: mocks.openPathExternal }),
}));

vi.mock('@/utils/browserMock', () => ({
  isBrowserDevMode: () => false,
  isTauriEnvironment: () => mocks.isTauri,
  pickFolderForDialog: vi.fn(),
}));

vi.mock('@/utils/openExternal', () => ({
  openExternal: mocks.openExternal,
}));

vi.mock('@/components/HistorySearchOverlayContent', () => ({
  default: ({
    onClose,
    onOpenSession,
    projects,
    taskCenterData,
  }: {
    onClose: () => void;
    onOpenSession: (session: Record<string, unknown>, project: Record<string, unknown>) => void;
    projects: Array<Record<string, unknown>>;
    taskCenterData: { sessions: Array<Record<string, unknown>> };
  }) => (
    <div data-testid="task-center-overlay">
      <button type="button" onClick={onClose}>Close search test overlay</button>
      {taskCenterData.sessions[0] && projects[0] && (
        <button
          type="button"
          onClick={() => onOpenSession(taskCenterData.sessions[0], projects[0])}
        >
          Open search session test
        </button>
      )}
    </div>
  ),
}));

vi.mock('@/components/FeedbackPopover', () => ({ default: () => null }));

vi.mock('@/notifications/useNotificationCenter', () => ({
  useNotificationCenter: () => ({
    snapshot: mocks.notificationSnapshot,
    refresh: mocks.notificationRefresh,
    loadMore: mocks.notificationLoadMore,
    markAllRead: mocks.notificationMarkAllRead,
  }),
}));

vi.mock('@/components/Toast', () => ({
  useToast: () => mocks.toast,
}));

vi.mock('@/context/SessionDeletionContext', () => ({
  useSessionDeletion: () => mocks.deleteSession,
}));

vi.mock('@/api/sessionClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sessionClient')>();
  return { ...actual, updateSession: mocks.updateSession };
});

vi.mock('@/components/launcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/launcher')>()),
  // The panel has its own suite; here only its contract with the sidebar matters.
  NewAgentPanel: ({ onCreated, onClose }: { onCreated: (project: { id: string; name: string; path: string }) => void; onClose: () => void }) => (
    <button
      type="button"
      data-testid="fake-new-agent-panel"
      onClick={() => {
        onCreated({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
        onClose();
      }}
    />
  ),
}));

import { i18n } from '@/i18n';
import type { Tab } from '@/types/tab';
import { GLOBAL_SIDEBAR_PREFERENCE_KEY } from '@/utils/globalSidebarPreference';
import GlobalSidebar, { isPointerWithinBounds, sortWorkspaceSessions } from './GlobalSidebar';

const launcherTab: Tab = {
  id: 'launcher-tab',
  view: 'launcher',
  title: 'Launcher',
};

type SidebarProps = ComponentProps<typeof GlobalSidebar>;

function sidebar(overrides: Partial<SidebarProps> = {}) {
  return (
    <GlobalSidebar
      tabs={[launcherTab]}
      activeTab={launcherTab}
      activeWorkspacePath={null}
      teamSpaceAvailable
      onNewTab={vi.fn()}
      onOpenTaskCenter={vi.fn()}
      onCreateTask={vi.fn()}
      onOpenSpace={vi.fn()}
      onOpenCapabilities={vi.fn()}
      onOpenSettings={vi.fn()}
      onOpenBugReport={vi.fn()}
      onOpenWorkspace={vi.fn(async () => true)}
      onOpenSession={vi.fn(async () => true)}
      onRenameSession={vi.fn(async () => null)}
      newAgentPanelOpen={false}
      onNewAgentPanelOpenChange={vi.fn()}
      {...overrides}
    />
  );
}

function renderSidebar(overrides: Partial<SidebarProps> = {}) {
  return render(sidebar(overrides));
}

describe('GlobalSidebar rail flyout', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.projects.length = 0;
    mocks.taskData.sessions.length = 0;
    mocks.taskData.sessionTagsMap.clear();
    mocks.taskData.workspaceSessionStates.clear();
    mocks.taskData.deleteProtectedSessionIds.clear();
    mocks.deleteSession.mockResolvedValue({ deleted: true });
    mocks.updateSession.mockReset();
    mocks.config.defaultWorkspacePath = null;
    mocks.configError = null;
    mocks.forcedRail = true;
    mocks.isTauri = false;
    mocks.notificationSnapshot.hasUnread = false;
    mocks.notificationSnapshot.items = [];
    mocks.touchProject.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        matches: mocks.forcedRail,
        media: '(max-width: 1080px)',
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    await i18n.changeLanguage('zh-CN');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps helper and settings above independent account and notification controls', () => {
    mocks.forcedRail = false;
    const onOpenSpace = vi.fn();
    renderSidebar({ onOpenSpace });
    const footer = document.querySelector('[data-global-sidebar-footer-actions]')!;
    const row = document.querySelector('[data-global-sidebar-account-row]')!;
    const account = screen.getByRole('button', { name: '登录 MyAgents' });
    const notification = screen.getByRole('button', { name: String(i18n.t('app:notificationCenter.bell')) });
    expect(footer.lastElementChild).toBe(row);
    expect(row.contains(account)).toBe(true);
    expect(row.contains(notification)).toBe(true);
    expect(row.contains(screen.getByRole('button', { name: '设置' }))).toBe(false);
    expect(row.contains(screen.getByRole('button', { name: '小助理' }))).toBe(false);
    fireEvent.click(account);
    expect(onOpenSpace).toHaveBeenCalledOnce();
    expect(mocks.notificationRefresh).not.toHaveBeenCalled();
    fireEvent.click(notification);
    expect(onOpenSpace).toHaveBeenCalledOnce();
    expect(mocks.notificationRefresh).toHaveBeenCalledOnce();
  });

  it('keeps only notification in the last rail row with no hidden account focus target', () => {
    renderSidebar();
    const row = document.querySelector('[data-global-sidebar-account-row]')!;
    expect(within(row as HTMLElement).getAllByRole('button')).toHaveLength(1);
    expect(within(row as HTMLElement).getByRole('button', { name: String(i18n.t('app:notificationCenter.bell')) })).toBeInTheDocument();
    expect(document.querySelector('[data-global-account-trigger]')).toBeNull();
  });

  it('renders healthy workspaces alongside invalid persisted Project rows without modifying them', () => {
    mocks.forcedRail = false;
    mocks.projects = [
      { id: 'bad-path', name: 'Bad path', path: null },
      { id: '', name: 'Missing identity', path: '/missing' },
      { id: 'duplicate', name: 'Duplicate one', path: '/one' },
      { id: 'duplicate', name: 'Duplicate two', path: '/two' },
      { id: 'healthy', name: 'Healthy workspace', path: '/healthy' },
    ];
    const source = JSON.stringify(mocks.projects);
    renderSidebar();
    expect(screen.getByText('Healthy workspace')).toBeInTheDocument();
    expect(screen.queryByText('Bad path')).not.toBeInTheDocument();
    expect(screen.queryByText('Duplicate one')).not.toBeInTheDocument();
    expect(JSON.stringify(mocks.projects)).toBe(source);
  });

  it('keeps the notification bell visible, distinguishes unread, and opens one fixed panel', () => {
    mocks.notificationSnapshot.hasUnread = true;
    renderSidebar();

    const bell = screen.getByRole('button', {
      name: String(i18n.t('app:notificationCenter.bellUnread')),
    });
    expect(bell.querySelector('.bg-\\[var\\(--accent-warm\\)\\]')).toBeInTheDocument();
    fireEvent.click(bell);

    expect(mocks.notificationRefresh).toHaveBeenCalledOnce();
    expect(screen.getByRole('dialog', {
      name: String(i18n.t('app:notificationCenter.title')),
    })).toBeInTheDocument();
    const shell = document.querySelector<HTMLElement>('[data-notification-center-shell]');
    expect(shell).not.toBeNull();
    expect(shell).toHaveClass(
      'bg-[var(--paper-elevated)]',
      'shadow-xl',
      'rounded-xl',
      'border-[var(--line)]',
    );
    expect(shell).not.toHaveClass('bg-[var(--global-sidebar-bg)]', 'shadow-md');
    expect(document.querySelectorAll('[data-notification-center-shell]')).toHaveLength(1);
  });

  it('extends the helper popover anchor to the sidebar edge', () => {
    renderSidebar();

    const anchor = document.querySelector('[data-feedback-popover-anchor]');
    expect(anchor).toHaveClass('-mr-3', 'pr-3');
  });

  it('keeps App Shell flyouts mutually exclusive in both directions', () => {
    renderSidebar();
    const bell = screen.getByRole('button', {
      name: String(i18n.t('app:notificationCenter.bell')),
    });
    fireEvent.click(bell);
    expect(screen.getByRole('dialog', {
      name: String(i18n.t('app:notificationCenter.title')),
    })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', {
      name: String(i18n.t('app:globalSidebar.helper')),
    }));
    expect(screen.queryByRole('dialog', {
      name: String(i18n.t('app:notificationCenter.title')),
    })).not.toBeInTheDocument();

    fireEvent.click(bell);
    const workspaceTrigger = screen.getByRole('button', { name: 'Agent 工作区' });
    fireEvent.pointerEnter(workspaceTrigger);
    act(() => vi.advanceTimersByTime(125));
    expect(screen.queryByRole('dialog', {
      name: String(i18n.t('app:notificationCenter.title')),
    })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();
  });

  it('opens idempotently on click even after the hover delay has elapsed', () => {
    renderSidebar();
    const trigger = screen.getByRole('button', { name: 'Agent 工作区' });

    fireEvent.pointerEnter(trigger);
    act(() => vi.advanceTimersByTime(125));
    const region = screen.getByRole('region', { name: 'Agent 工作区' });
    expect(region).toBeInTheDocument();
    const shell = region.closest('[data-global-sidebar-flyout]');
    expect(shell).toHaveClass(
      'bg-[var(--paper-elevated)]',
      'shadow-xl',
      'rounded-xl',
      'border-[var(--line)]',
    );
    expect(shell).not.toHaveClass('bg-[var(--global-sidebar-bg)]', 'shadow-md');

    fireEvent.click(trigger);
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();
  });

  it('opens the product website from the compact brand link without a row hover surface', async () => {
    mocks.forcedRail = false;
    renderSidebar();

    const brandLink = screen.getByRole('button', {
      name: String(i18n.t('app:globalSidebar.openWebsite')),
    });
    const brandRow = brandLink.closest('[data-global-sidebar-brand-row]');

    expect(brandLink).toHaveClass('cursor-pointer');
    expect(brandLink).not.toHaveClass('w-full', 'hover:bg-[var(--hover-bg)]', 'hover:bg-[var(--paper-inset)]');
    expect(brandRow).not.toHaveClass('cursor-pointer', 'hover:bg-[var(--hover-bg)]');

    fireEvent.click(brandLink);

    await vi.waitFor(() => {
      expect(mocks.openExternal).toHaveBeenCalledWith('https://myagents.io');
    });
  });

  it('opens immediately from keyboard focus', () => {
    renderSidebar();
    const trigger = screen.getByRole('button', { name: 'Agent 工作区' });

    fireEvent.focus(trigger);

    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();
  });

  it('hands Tab focus from the rail trigger into the viewport-owned flyout', () => {
    renderSidebar();
    const trigger = screen.getByRole('button', { name: 'Agent 工作区' });
    fireEvent.focus(trigger);
    const region = screen.getByRole('region', { name: 'Agent 工作区' });

    fireEvent.keyDown(trigger, { key: 'Tab' });

    expect(within(region).getByRole('button', {
      name: String(i18n.t('app:globalSidebar.workspaceViewOptions')),
    })).toHaveFocus();
    act(() => vi.advanceTimersByTime(220));
    expect(region).toBeInTheDocument();
  });

  it('hands Shift+Tab focus from the first flyout action back to its rail trigger', () => {
    renderSidebar();
    const trigger = screen.getByRole('button', { name: 'Agent 工作区' });
    fireEvent.focus(trigger);
    const region = screen.getByRole('region', { name: 'Agent 工作区' });
    fireEvent.keyDown(trigger, { key: 'Tab' });
    const firstAction = within(region).getByRole('button', {
      name: String(i18n.t('app:globalSidebar.workspaceViewOptions')),
    });

    fireEvent.keyDown(firstAction, { key: 'Tab', shiftKey: true });

    expect(trigger).toHaveFocus();
    act(() => vi.advanceTimersByTime(220));
    expect(region).toBeInTheDocument();
  });

  it('closes after a workspace navigation succeeds', async () => {
    const onOpenWorkspace = vi.fn(async () => true);
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    renderSidebar({ onOpenWorkspace });
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.newChatHere')) }));
    });

    await vi.waitFor(() => expect(onOpenWorkspace).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('region', { name: 'Agent 工作区' })).not.toBeInTheDocument();
  });

  it('closes on Escape from the rail trigger and restores trigger focus', () => {
    renderSidebar();
    const trigger = screen.getByRole('button', { name: 'Agent 工作区' });
    fireEvent.click(trigger);
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();

    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Escape' });

    expect(screen.queryByRole('region', { name: 'Agent 工作区' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes on Escape from inside the viewport-owned flyout and restores trigger focus', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    renderSidebar();
    const trigger = screen.getByRole('button', { name: 'Agent 工作区' });
    fireEvent.click(trigger);
    const workspaceToggle = screen.getByText('Project one')
      .closest('[data-global-sidebar-workspace-row]')!
      .querySelector('button')!;

    workspaceToggle.focus();
    fireEvent.keyDown(workspaceToggle, { key: 'Escape' });

    expect(screen.queryByRole('region', { name: 'Agent 工作区' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes after the pointer leaves an otherwise idle flyout', () => {
    renderSidebar();
    const trigger = screen.getByRole('button', { name: 'Agent 工作区' });
    fireEvent.click(trigger);
    const region = screen.getByRole('region', { name: 'Agent 工作区' });

    fireEvent.pointerLeave(region);
    act(() => vi.advanceTimersByTime(219));
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('region', { name: 'Agent 工作区' })).not.toBeInTheDocument();
  });

  it('keeps the flyout open when collapsing a workspace only changes layout beneath the pointer', () => {
    const bounds = { left: 72, right: 392, top: 48, bottom: 700 };

    expect(isPointerWithinBounds(bounds, 200, 160)).toBe(true);
    expect(isPointerWithinBounds(bounds, 420, 160)).toBe(false);
    expect(isPointerWithinBounds(bounds, bounds.right, 160)).toBe(false);
    expect(isPointerWithinBounds(bounds, 200, bounds.bottom)).toBe(false);
    expect(isPointerWithinBounds({ left: 0, right: 0, top: 0, bottom: 0 }, 0, 0)).toBe(false);

  });

  it('keeps the flyout open when collapsing a workspace removes the focused Session under a stationary pointer', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({
      id: 'session-1',
      agentDir: '/work/project-one',
      title: 'Focused session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    const region = screen.getByRole('region', { name: 'Agent 工作区' });
    const flyout = region.closest('[data-global-sidebar-flyout]')!;
    const session = screen.getByRole('button', { name: /Focused session/ });
    const workspaceToggle = screen.getByText('Project one').closest('[data-global-sidebar-workspace-row]')!
      .querySelector('button')!;
    const branch = screen.getByText('Focused session').closest('[data-global-sidebar-workspace-branch]')!;

    fireEvent.pointerEnter(flyout);
    session.focus();
    fireEvent.blur(session);
    fireEvent.click(workspaceToggle);

    expect(branch).toHaveAttribute('data-state', 'closed');
    expect(branch).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('button', { name: /Focused session/, hidden: true })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(199));
    expect(screen.getByRole('button', { name: /Focused session/, hidden: true })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));

    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Focused session/ })).not.toBeInTheDocument();
  });

  it('uses the shared App Shell surface and invisible fixed-height placeholders in the rail flyout', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.workspaceSessionStates.set('/work/project-one', { isLoading: true, error: null });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    const region = screen.getByRole('region', { name: 'Agent 工作区' });
    const flyout = region.closest('[data-global-sidebar-flyout]');
    expect(flyout).toHaveClass('bg-[var(--paper-elevated)]', 'shadow-xl');
    expect(flyout).toHaveClass('fixed', 'top-32', 'bottom-28');
    expect(flyout).not.toHaveClass('absolute', 'top-12', 'bottom-3');
    expect(flyout).not.toHaveClass('bg-[var(--global-sidebar-bg)]', 'shadow-md');
    const placeholder = region.querySelector('[data-global-sidebar-session-placeholder]')!;
    expect(placeholder.children).toHaveLength(3);
    for (const row of Array.from(placeholder.children)) {
      expect(row).toHaveClass('h-8');
      expect(row).not.toHaveClass('animate-pulse', 'bg-[var(--paper-inset)]/60');
      expect(row).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('opens the single New Agent panel from the + button and the empty state', () => {
    const onNewAgentPanelOpenChange = vi.fn();
    renderSidebar({ onNewAgentPanelOpenChange });
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('launcher:newAgentPanel.title')) }));
    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('launcher:rightRail.addFolder')) }));

    expect(onNewAgentPanelOpenChange.mock.calls).toEqual([[true], [true]]);
  });

  it('returns focus to the + entry after the panel it opened closes', () => {
    const onNewAgentPanelOpenChange = vi.fn();
    const view = renderSidebar({ onNewAgentPanelOpenChange });
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    const addButton = screen.getByRole('button', { name: String(i18n.t('launcher:newAgentPanel.title')) });

    fireEvent.click(addButton);
    view.rerender(sidebar({ onNewAgentPanelOpenChange, newAgentPanelOpen: true }));
    (document.activeElement as HTMLElement | null)?.blur();
    // The fake panel closes through its onClose prop, like every real close path.
    fireEvent.click(screen.getByTestId('fake-new-agent-panel'));

    expect(onNewAgentPanelOpenChange).toHaveBeenLastCalledWith(false);
    expect(addButton).toHaveFocus();
  });

  it('flashes the workspace created from the New Agent panel', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    const onNewAgentPanelOpenChange = vi.fn();
    renderSidebar({ newAgentPanelOpen: true, onNewAgentPanelOpenChange });
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    fireEvent.click(screen.getByTestId('fake-new-agent-panel'));

    const row = screen.getByText('Project one').closest<HTMLElement>('[data-global-sidebar-workspace-row]')!;
    expect(row).toHaveAttribute('data-recently-created');
    expect(onNewAgentPanelOpenChange).toHaveBeenCalledWith(false);
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(row).not.toHaveAttribute('data-recently-created');
  });

  it('uses instant portaled tooltips for workspace header and row actions', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    const addButton = screen.getByRole('button', { name: String(i18n.t('launcher:newAgentPanel.title')) });
    const viewOptionsButton = screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.workspaceViewOptions')) });
    const workspaceRow = screen.getByText('Project one').closest<HTMLElement>('[data-global-sidebar-workspace-row]')!;
    const newChatButton = within(workspaceRow).getByRole('button', { name: String(i18n.t('app:globalSidebar.newChatHere')) });
    const moreButton = within(workspaceRow).getByRole('button', { name: String(i18n.t('launcher:workspaceCard.more')) });

    expect(Boolean(viewOptionsButton.compareDocumentPosition(addButton) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(moreButton.compareDocumentPosition(newChatButton) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

    for (const [button, label] of [
      [addButton, String(i18n.t('launcher:newAgentPanel.title'))],
      [viewOptionsButton, '更多'],
      [newChatButton, '新对话'],
      [moreButton, '更多'],
    ] as const) {
      expect(button).not.toHaveAttribute('title');
      fireEvent.mouseEnter(button.parentElement!);
      const tip = screen.getByRole('tooltip', { name: label });
      expect(tip).toHaveClass('bg-[var(--button-dark-bg)]/90');
      expect(tip).not.toHaveClass('delay-500', 'transition-opacity');
      expect(button.parentElement).not.toContainElement(tip);
      fireEvent.mouseLeave(button.parentElement!);
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    }
  });

  it('opens a workspace context menu without allowing right-click text selection', () => {
    const workspacePath = 'D:\\work\\project-one';
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: workspacePath });
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    const workspaceRow = screen.getByText('Project one').closest<HTMLElement>('[data-global-sidebar-workspace-row]')!;
    expect(workspaceRow).toHaveClass('select-none');

    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 });
    fireEvent(workspaceRow, mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);

    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    fireEvent(workspaceRow, contextMenu);
    expect(contextMenu.defaultPrevented).toBe(true);
    const pinItem = screen.getByRole('button', { name: String(i18n.t('launcher:workspaceCard.pin')) });
    const menu = pinItem.closest<HTMLElement>('.global-sidebar-nested-layer')!;
    expect(within(menu).getAllByRole('button').map((item) => item.textContent)).toEqual([
      String(i18n.t('launcher:workspaceCard.agentSettings')),
      String(i18n.t('launcher:workspaceCard.openFolder')),
      String(i18n.t('launcher:workspaceCard.pin')),
      String(i18n.t('launcher:workspaceCard.archive')),
      String(i18n.t('launcher:workspaceCard.remove')),
    ]);

    fireEvent.click(within(menu).getByRole('button', {
      name: String(i18n.t('launcher:workspaceCard.openFolder')),
    }));
    expect(mocks.openPathExternal).toHaveBeenCalledWith({
      fullPath: workspacePath,
      workspace: workspacePath,
    });
  });

  it('opens a Session context menu without allowing right-click text selection', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({
      id: 'session-1',
      agentDir: '/work/project-one',
      title: 'Selectable session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    const sessionRow = screen.getByText('Selectable session').closest<HTMLElement>('[data-global-sidebar-session-row]')!;
    expect(sessionRow).toHaveClass('select-none');

    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 });
    fireEvent(sessionRow, mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);

    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    fireEvent(sessionRow, contextMenu);
    expect(contextMenu.defaultPrevented).toBe(true);
    expect(screen.getByRole('button', { name: String(i18n.t('launcher:rightRail.rename')) })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: String(i18n.t('launcher:rightRail.pin')) })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: String(i18n.t('launcher:rightRail.copySessionId')) })).toBeInTheDocument();
  });

  it('renames a sidebar Session through the shared dialog with the current title prefilled', async () => {
    const current = {
      id: 'session-rename',
      agentDir: '/work/project-one',
      title: 'Before rename',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    };
    const onRenameSession = vi.fn(async (_sessionId: string, title: string) => ({ ...current, title }));
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push(current);
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    renderSidebar({ onRenameSession });
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    const row = screen.getByText('Before rename').closest<HTMLElement>('[data-global-sidebar-session-row]')!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('launcher:rightRail.rename')) }));
    const input = screen.getByLabelText(String(i18n.t('launcher:rightRail.renameDialogLabel')));
    expect(input).toHaveValue('Before rename');
    fireEvent.change(input, { target: { value: 'After rename' } });
    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('common:actions.save')) }));

    await vi.waitFor(() => expect(onRenameSession).toHaveBeenCalledWith('session-rename', 'After rename'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps pinned Sessions ahead of recency and orders later pins first', () => {
    const ordered = sortWorkspaceSessions([
      { id: 'recent', agentDir: '/work', title: 'Recent', createdAt: '', lastActiveAt: '2026-09-02T12:00:00.000Z' },
      { id: 'pin-old', agentDir: '/work', title: 'Old pin', createdAt: '', lastActiveAt: '2026-01-01T00:00:00.000Z', pinnedAt: '2026-09-02T08:00:00.000Z' },
      { id: 'pin-new', agentDir: '/work', title: 'New pin', createdAt: '', lastActiveAt: '2025-01-01T00:00:00.000Z', pinnedAt: '2026-09-02T09:00:00.000Z' },
      { id: 'older', agentDir: '/work', title: 'Older', createdAt: '', lastActiveAt: '2026-09-01T12:00:00.000Z' },
    ]);

    expect(ordered.map((session) => session.id)).toEqual(['pin-new', 'pin-old', 'recent', 'older']);
  });

  it('keeps pinned favorites first without leaking non-favorites into the favorites view', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push(
      { id: 'favorite-recent', agentDir: '/work/project-one', title: 'Favorite recent', createdAt: '', lastActiveAt: '2026-09-02T12:00:00.000Z', favorite: true },
      { id: 'favorite-pin-old', agentDir: '/work/project-one', title: 'Favorite pin old', createdAt: '', lastActiveAt: '2026-01-01T00:00:00.000Z', favorite: true, pinnedAt: '2026-09-02T08:00:00.000Z' },
      { id: 'favorite-pin-new', agentDir: '/work/project-one', title: 'Favorite pin new', createdAt: '', lastActiveAt: '2025-01-01T00:00:00.000Z', favorite: true, pinnedAt: '2026-09-02T09:00:00.000Z' },
      { id: 'non-favorite-pin', agentDir: '/work/project-one', title: 'Non favorite pin', createdAt: '', lastActiveAt: '2026-09-02T13:00:00.000Z', pinnedAt: '2026-09-02T10:00:00.000Z' },
    );
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'favorites',
    }));
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    const titles = Array.from(document.querySelectorAll('[data-global-sidebar-session-title]'))
      .map((element) => element.textContent);
    expect(titles).toEqual(['Favorite pin new', 'Favorite pin old', 'Favorite recent']);
    expect(screen.queryByText('Non favorite pin')).not.toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: String(i18n.t('launcher:rightRail.pinned')) })).toHaveLength(2);
  });

  it('persists a sidebar pin intent and publishes the canonical Session response', async () => {
    const current = {
      id: 'session-pin',
      agentDir: '/work/project-one',
      title: 'Pin me',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    };
    const updated = { ...current, pinnedAt: '2026-09-02T08:00:00.000Z' };
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push(current);
    mocks.updateSession.mockResolvedValue(updated);
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    const row = screen.getByText('Pin me').closest<HTMLElement>('[data-global-sidebar-session-row]')!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('launcher:rightRail.pin')) }));

    await vi.waitFor(() => expect(mocks.updateSession).toHaveBeenCalledWith('session-pin', { pinned: true }));
    expect(mocks.taskData.actions.beginSessionMetadataMutation).toHaveBeenCalledWith('session-pin');
    expect(mocks.taskData.actions.applySessionMetadata).toHaveBeenCalledWith(updated, 1);
  });

  it('hides archived chats from all and favorites, and exposes them in the archived view', () => {
    mocks.forcedRail = false;
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push(
      { id: 'active', agentDir: '/work/project-one', title: 'Active chat', lastActiveAt: '2026-07-20T00:00:00Z', favorite: true },
      { id: 'archived', agentDir: '/work/project-one', title: 'Archived chat', lastActiveAt: '2026-07-20T00:00:00Z', favorite: true, archived: true },
      { id: 'archived-auto', agentDir: '/work/project-one', title: 'Archived automation', lastActiveAt: '2026-07-20T00:00:00Z', archived: true, cronTaskId: 'cron-1' },
    );
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1, preferredMode: 'expanded', expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true, showAutomationSessions: false, sessionView: 'all',
    }));
    renderSidebar();
    expect(screen.getByText('Active chat')).toBeInTheDocument();
    expect(screen.queryByText('Archived chat')).not.toBeInTheDocument();
    const chooseView = (key: string) => {
      fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.workspaceViewOptions')) }));
      fireEvent.click(screen.getByRole('button', { name: String(i18n.t(`app:globalSidebar.${key}`)) }));
    };
    chooseView('favoriteSessions');
    expect(screen.getByText('Active chat')).toBeInTheDocument();
    expect(screen.queryByText('Archived chat')).not.toBeInTheDocument();
    chooseView('archivedSessions');
    expect(screen.queryByText('Active chat')).not.toBeInTheDocument();
    expect(screen.getByText('Archived chat')).toBeInTheDocument();
    expect(screen.getByText('Archived automation')).toBeInTheDocument();
    fireEvent.contextMenu(screen.getByText('Archived chat').closest<HTMLElement>('[data-global-sidebar-session-row]')!);
    expect(screen.getByRole('button', { name: String(i18n.t('launcher:rightRail.restore')) })).toBeInTheDocument();
  });

  it.each([false, true])('persists sidebar archive changes using the metadata authority (archived=%s)', async (archived) => {
    const current = {
      id: 'archive-write', agentDir: '/work/project-one', title: 'Archive target',
      createdAt: '2026-07-20T00:00:00Z', lastActiveAt: '2026-07-20T00:00:00Z',
      favorite: true, pinnedAt: '2026-07-20T00:00:00Z', archived,
    };
    const updated = { ...current, archived: !archived };
    mocks.updateSession.mockResolvedValueOnce(updated);
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push(current);
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1, preferredMode: 'rail', expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true, showAutomationSessions: true, sessionView: archived ? 'archived' : 'all',
    }));
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    fireEvent.contextMenu(screen.getByText('Archive target').closest<HTMLElement>('[data-global-sidebar-session-row]')!);
    fireEvent.click(screen.getByRole('button', { name: String(i18n.t(`launcher:rightRail.${archived ? 'restore' : 'archive'}`)) }));
    await vi.waitFor(() => expect(mocks.updateSession).toHaveBeenCalledWith('archive-write', { archived: !archived }));
    expect(mocks.taskData.actions.applySessionMetadata).toHaveBeenCalledWith(updated, 1);
    expect(mocks.deleteSession).not.toHaveBeenCalled();
  });

  it('keeps a failed archive visible with a retryable menu and no optimistic metadata write', async () => {
    mocks.updateSession.mockRejectedValueOnce(new Error('disk failure'));
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({ id: 'failed', agentDir: '/work/project-one', title: 'Keep on failure', lastActiveAt: '2026-07-20T00:00:00Z' });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1, preferredMode: 'rail', expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true, showAutomationSessions: true, sessionView: 'all',
    }));
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    fireEvent.contextMenu(screen.getByText('Keep on failure').closest<HTMLElement>('[data-global-sidebar-session-row]')!);
    const action = screen.getByRole('button', { name: String(i18n.t('launcher:rightRail.archive')) });
    fireEvent.click(action);
    await vi.waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith(String(i18n.t('launcher:rightRail.archiveFailedRetry'))));
    expect(mocks.taskData.actions.applySessionMetadata).not.toHaveBeenCalled();
    expect(screen.getByText('Keep on failure')).toBeInTheDocument();
    expect(action).toBeEnabled();
  });

  it('loads and restores archived chats in an archived workspace without restoring that workspace', async () => {
    mocks.forcedRail = false;
    mocks.projects.push({ id: 'archived-project', name: 'Archived workspace', path: '/work/archived', archivedAt: '2026-07-20T00:00:00Z' });
    const current = { id: 'archived-both', agentDir: '/work/archived', title: 'Archived in archived workspace', archived: true, lastActiveAt: '2026-07-20T00:00:00Z' };
    mocks.taskData.sessions.push(current);
    mocks.updateSession.mockResolvedValueOnce({ ...current, archived: undefined });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1, preferredMode: 'expanded', expandedWorkspaceKeys: ['/work/archived'],
      hasSeededDefaultExpansion: true, showAutomationSessions: false, sessionView: 'archived',
    }));
    renderSidebar();
    expect(screen.getByText(current.title)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: String(i18n.t('app:globalSidebar.newChatHere')) })).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByText(current.title).closest<HTMLElement>('[data-global-sidebar-session-row]')!);
    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('launcher:rightRail.restore')) }));
    await vi.waitFor(() => expect(mocks.updateSession).toHaveBeenCalledWith(current.id, { archived: false }));
    expect(mocks.patchProject).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.workspaceViewOptions')) })).toHaveFocus();
  });

  it('refreshes canonical metadata when a concurrent mutation rejects an archive response', async () => {
    mocks.taskData.actions.applySessionMetadata.mockReturnValueOnce(false);
    mocks.updateSession.mockResolvedValueOnce({ id: 'stale-archive', agentDir: '/work/project-one', title: 'Concurrent archive', archived: true });
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({ id: 'stale-archive', agentDir: '/work/project-one', title: 'Concurrent archive', lastActiveAt: '2026-07-20T00:00:00Z' });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1, preferredMode: 'rail', expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true, showAutomationSessions: true, sessionView: 'all',
    }));
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    fireEvent.contextMenu(screen.getByText('Concurrent archive').closest<HTMLElement>('[data-global-sidebar-session-row]')!);
    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('launcher:rightRail.archive')) }));
    await vi.waitFor(() => expect(mocks.taskData.actions.refreshSessions).toHaveBeenCalled());
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.info).toHaveBeenCalledWith(String(i18n.t('launcher:rightRail.archiveStateRefreshing')));
  });

  it('shows a truncated Session title only after a one-second hover', () => {
    const title = 'A very long historical conversation title that cannot fit in the sidebar';
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({
      id: 'session-1',
      agentDir: '/work/project-one',
      title,
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    const trigger = document.querySelector<HTMLElement>('[data-global-sidebar-session-title]')!;
    expect(trigger).not.toHaveTextContent(title);
    expect(trigger.textContent).toMatch(/\.\.\.$/);
    Object.defineProperty(trigger, 'clientWidth', { configurable: true, value: 360 });
    Object.defineProperty(trigger, 'scrollWidth', { configurable: true, value: 200 });
    fireEvent.pointerEnter(trigger);
    act(() => vi.advanceTimersByTime(999));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('tooltip')).toHaveTextContent(title);
  });

  it('routes sidebar Session deletion through the App-owned lifecycle capability', async () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({
      id: 'deletable-session',
      agentDir: '/work/project-one',
      title: 'Deletable session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    const row = screen.getByText('Deletable session').closest<HTMLElement>('[data-global-sidebar-session-row]')!;
    fireEvent.click(within(row).getByRole('button', { name: String(i18n.t('launcher:rightRail.more')) }));
    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('launcher:rightRail.delete')) }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '删除' }));
      await Promise.resolve();
    });

    expect(mocks.deleteSession).toHaveBeenCalledWith('deletable-session');
    expect(mocks.toast.success).toHaveBeenCalledWith(String(i18n.t('launcher:rightRail.deleted')));
  });

  it('lets the Rust authority decide protected sidebar deletion and explains its refusal', async () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({
      id: 'protected-session',
      agentDir: '/work/project-one',
      title: 'Protected session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    mocks.taskData.deleteProtectedSessionIds.add('protected-session');
    mocks.deleteSession.mockResolvedValue({ deleted: false, reason: 'in-use' });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    const row = screen.getByText('Protected session').closest<HTMLElement>('[data-global-sidebar-session-row]')!;
    fireEvent.click(within(row).getByRole('button', { name: String(i18n.t('launcher:rightRail.more')) }));
    const deleteButton = screen.getByRole('button', { name: String(i18n.t('launcher:rightRail.delete')) });
    expect(deleteButton).not.toBeDisabled();
    fireEvent.click(deleteButton);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '删除' }));
      await Promise.resolve();
    });

    expect(mocks.deleteSession).toHaveBeenCalledWith('protected-session');
    expect(mocks.toast.warning).toHaveBeenCalledWith(String(i18n.t('launcher:rightRail.deleteBlockedByOwner')));
  });

  it('copies the Session ID from the Session resource menu', async () => {
    const sessionId = '642ea003-5219-4af7-a812-a9812d6e79de';
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({
      id: sessionId,
      agentDir: '/work/project-one',
      title: 'Copyable session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    const sessionRow = screen.getByText('Copyable session').closest<HTMLElement>('[data-global-sidebar-session-row]')!;
    fireEvent.click(within(sessionRow).getByRole('button', { name: String(i18n.t('launcher:rightRail.more')) }));
    const copyButton = screen.getByRole('button', { name: String(i18n.t('launcher:rightRail.copySessionId')) });
    const menu = copyButton.closest<HTMLElement>('.global-sidebar-nested-layer')!;
    const menuButtons = within(menu).getAllByRole('button');
    expect(menuButtons[0]).toBe(copyButton);
    expect(menuButtons[1]).toHaveAccessibleName(String(i18n.t('launcher:rightRail.rename')));

    await act(async () => {
      fireEvent.click(copyButton);
      await Promise.resolve();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`SessionID: ${sessionId}`);
    expect(mocks.toast.success).toHaveBeenCalledWith(String(i18n.t('launcher:rightRail.copySessionIdSuccess')));
  });

  it('reserves tooltips for non-workspace rail actions', () => {
    renderSidebar();

    expect(screen.queryByRole('tooltip', { name: 'Agent 工作区' })).not.toBeInTheDocument();
    const taskButton = screen.getByRole('button', { name: '自动化任务' });
    fireEvent.mouseEnter(taskButton.parentElement!);
    const taskTip = screen.getByRole('tooltip', { name: '自动化任务' });
    expect(taskTip).toHaveClass('bg-[var(--button-dark-bg)]/90');
    expect(taskTip).not.toHaveClass('delay-500', 'transition-opacity');

    fireEvent.mouseLeave(taskButton.parentElement!);
    fireEvent.click(screen.getByRole('button', { name: '小助理' }));
    expect(screen.queryByRole('tooltip', { name: '小助理' })).not.toBeInTheDocument();
  });

  it('keeps the hover Task-create tooltip trigger inside an absolute row overlay', () => {
    mocks.forcedRail = false;
    window.localStorage.setItem(
      GLOBAL_SIDEBAR_PREFERENCE_KEY,
      JSON.stringify({
        version: 1,
        preferredMode: 'expanded',
        expandedWorkspaceKeys: [],
        hasSeededDefaultExpansion: true,
        showAutomationSessions: true,
        sessionView: 'all',
      }),
    );
    renderSidebar();

    const createButton = screen.getByRole('button', { name: '创建任务' });
    const tooltipAnchor = createButton.parentElement;
    const rowOverlay = tooltipAnchor?.parentElement;
    expect(tooltipAnchor).toHaveClass('relative', 'inline-flex');
    expect(tooltipAnchor).not.toHaveClass('absolute');
    expect(rowOverlay).toHaveClass('absolute', 'right-1', 'top-1');
    expect(rowOverlay?.parentElement).toHaveClass('group/task-create', 'relative');
  });

  it('keeps the workspace surface open when Session navigation is rejected', async () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({
      id: 'rejected-session',
      agentDir: '/work/project-one',
      title: 'Rejected session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    const onOpenSession = vi.fn(async () => false);
    renderSidebar({ onOpenSession });
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Rejected session/ }));
    });

    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();
  });

  it('keeps the workspace surface open when Session navigation throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({
      id: 'failed-session',
      agentDir: '/work/project-one',
      title: 'Failed session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    const onOpenSession = vi.fn(async () => {
      throw new Error('navigation failed');
    });
    renderSidebar({ onOpenSession });
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Failed session/ }));
    });

    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalledWith(
      '[GlobalSidebar] Failed to open Session:',
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it('closes the workspace surface when the authoritative active Tab changes', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    const view = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();

    const activeSessionTab: Tab = {
      id: 'active-session-tab',
      agentDir: '/work/project-one',
      sessionId: 'active-session',
      view: 'chat',
      title: 'Active Session',
      sidecarConfigDisposition: 'adopt',
    };
    view.rerender(sidebar({
      tabs: [launcherTab, activeSessionTab],
      activeTab: activeSessionTab,
      activeWorkspacePath: '/work/project-one',
    }));

    expect(screen.queryByRole('region', { name: 'Agent 工作区' })).not.toBeInTheDocument();
  });

  it('does not let an old Session completion close a newly reopened flyout', async () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({
      id: 'slow-session',
      agentDir: '/work/project-one',
      title: 'Slow session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    let resolveOpen!: (opened: boolean) => void;
    const onOpenSession = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveOpen = resolve;
    }));
    const view = renderSidebar({ onOpenSession });
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    fireEvent.click(screen.getByRole('button', { name: /Slow session/ }));

    const activeSessionTab: Tab = {
      id: 'slow-session-tab',
      agentDir: '/work/project-one',
      sessionId: 'slow-session',
      view: 'chat',
      title: 'Slow session',
      sidecarConfigDisposition: 'pending',
    };
    view.rerender(sidebar({
      tabs: [launcherTab, activeSessionTab],
      activeTab: activeSessionTab,
      activeWorkspacePath: '/work/project-one',
      onOpenSession,
    }));
    expect(screen.queryByRole('region', { name: 'Agent 工作区' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();

    await act(async () => {
      resolveOpen(true);
      await Promise.resolve();
    });

    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();
  });

  it('does not let an old workspace completion close a newly reopened flyout', async () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    let resolveOpen!: (opened: boolean) => void;
    const onOpenWorkspace = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveOpen = resolve;
    }));
    const view = renderSidebar({ onOpenWorkspace });
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.newChatHere')) }));

    const pendingWorkspaceTab: Tab = {
      id: 'pending-workspace-tab',
      agentDir: '/work/project-one',
      sessionId: null,
      view: 'chat',
      title: 'Project one',
      sidecarConfigDisposition: 'pending',
    };
    view.rerender(sidebar({
      tabs: [launcherTab, pendingWorkspaceTab],
      activeTab: pendingWorkspaceTab,
      activeWorkspacePath: '/work/project-one',
      onOpenWorkspace,
    }));
    expect(screen.queryByRole('region', { name: 'Agent 工作区' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();

    await act(async () => {
      resolveOpen(true);
      await Promise.resolve();
    });

    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();
  });

  it('keeps toggle, search and notification mounted across manual modes and replaces the rail website entry', () => {
    mocks.forcedRail = false;
    mocks.isTauri = true;
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: [],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    const first = renderSidebar();
    const navigation = screen.getByRole('complementary', { name: String(i18n.t('app:globalSidebar.navigation')) });
    expect(navigation).toHaveAttribute('data-global-sidebar-mode', 'rail');
    expect(navigation).not.toHaveAttribute('data-global-sidebar-motion');
    expect(navigation).toHaveAttribute('data-global-sidebar-tabbar-toggle', 'true');
    expect(navigation).toHaveClass('[--global-sidebar-surface:var(--global-sidebar-bg)]');
    expect(navigation).not.toHaveClass('bg-[var(--global-sidebar-bg)]');
    expect(navigation).not.toHaveClass('bg-[var(--paper)]', 'bg-[var(--paper-elevated)]', 'border-r');
    expect(navigation).not.toHaveClass('border-[var(--line)]');
    const brandIcon = navigation.querySelector('[data-global-sidebar-brand-icon]');
    const brandLink = navigation.querySelector('[data-global-sidebar-brand-link]');
    const brandName = navigation.querySelector('[data-global-sidebar-brand-name]');
    const brandRow = navigation.querySelector('[data-global-sidebar-brand-row]');
    const search = screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.search')) });
    const notification = screen.getByRole('button', { name: String(i18n.t('app:notificationCenter.bell')) });
    const primaryNav = navigation.querySelector('[data-global-sidebar-primary-nav]');
    const workspaceRail = navigation.querySelector('[data-global-sidebar-workspace-rail]');
    const footerActions = navigation.querySelector('[data-global-sidebar-footer-actions]');
    expect(brandIcon).not.toBeNull();
    expect(brandLink).toHaveClass('w-10', 'overflow-hidden');
    expect(brandLink).toHaveAttribute('inert');
    expect(brandLink).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('button', { name: String(i18n.t('app:globalSidebar.openWebsite')) })).not.toBeInTheDocument();
    expect(brandRow).toContainElement(search);
    expect(primaryNav).not.toContainElement(search);
    expect(brandName).toHaveAttribute('aria-hidden', 'true');
    expect(brandRow).toHaveClass('global-sidebar-brand-row');
    expect(primaryNav).toHaveClass('global-sidebar-rail-stack');
    expect(primaryNav).not.toHaveClass('items-center', 'px-2', 'border-t', 'space-y-1');
    expect(workspaceRail).toHaveClass('global-sidebar-rail-stack');
    expect(workspaceRail).not.toHaveClass('items-center', 'px-2', 'border-t', 'border-[var(--line-subtle)]');
    expect(footerActions).toHaveClass('global-sidebar-rail-stack');
    expect(footerActions).not.toHaveClass('items-center', 'px-2', 'space-y-1', 'border-t', 'border-[var(--line-subtle)]');
    const expand = screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.expand')) });
    expect(expand).toHaveAttribute('data-global-sidebar-toggle');
    expect(expand).not.toHaveAttribute('title');
    const toggleSlot = expand.closest('.absolute');
    expect(toggleSlot).toHaveClass('left-[var(--global-sidebar-toggle-left)]');
    expect(expand.querySelector('[data-global-sidebar-toggle-icon]')).toHaveClass('app-icon-sidebar');
    fireEvent.mouseEnter(expand.parentElement!);
    expect(screen.getByRole('tooltip', { name: String(i18n.t('app:globalSidebar.expand')) }))
      .toHaveClass('bg-[var(--button-dark-bg)]/90');
    fireEvent.click(expand);
    const collapse = screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.collapse')) });
    expect(collapse).toBe(expand);
    expect(collapse.closest('.absolute')).toBe(toggleSlot);
    expect(collapse.querySelector('[data-global-sidebar-toggle-icon]')).toHaveClass('app-icon-sidebar');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.mouseLeave(collapse.parentElement!);
    fireEvent.mouseEnter(collapse.parentElement!);
    expect(screen.getByRole('tooltip', { name: String(i18n.t('app:globalSidebar.collapse')) }))
      .not.toHaveClass('delay-500', 'transition-opacity');
    expect(navigation).toHaveAttribute('data-global-sidebar-mode', 'expanded');
    expect(navigation).toHaveAttribute('data-global-sidebar-motion', 'expand');
    expect(navigation).toHaveAttribute('data-global-sidebar-tabbar-toggle', 'false');
    expect(navigation.querySelector('[data-global-sidebar-brand-icon]')).toBe(brandIcon);
    expect(navigation.querySelector('[data-global-sidebar-brand-link]')).toBe(brandLink);
    expect(brandLink).not.toHaveClass('w-10', 'overflow-hidden');
    expect(brandLink).not.toHaveAttribute('inert');
    expect(brandLink).toHaveAttribute('aria-hidden', 'false');
    expect(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.search')) })).toBe(search);
    expect(screen.getByRole('button', { name: String(i18n.t('app:notificationCenter.bell')) })).toBe(notification);
    expect(navigation.querySelector('[data-global-sidebar-brand-row]')).toBe(brandRow);
    expect(navigation.querySelector('[data-global-sidebar-primary-nav]')).not.toHaveClass('global-sidebar-rail-stack');
    expect(navigation.querySelector('[data-global-sidebar-workspace-rail]')).not.toBeInTheDocument();
    expect(navigation.querySelector('[data-global-sidebar-workspace-region]')).not.toHaveClass('border-t', 'border-[var(--line-subtle)]');
    expect(navigation.querySelector('[data-global-sidebar-footer-actions]')).not.toHaveClass('global-sidebar-rail-stack');
    expect(brandName?.querySelector('[data-myagents-logotype]')).toHaveAccessibleName('MyAgents');
    expect(brandName).toHaveClass('theme-product-wordmark', 'text-sm', 'font-medium');
    expect(brandName).not.toHaveClass('font-semibold', 'tracking-wide', 'theme-launcher-hero-title');
    expect(brandName).toHaveAttribute('aria-hidden', 'false');

    fireEvent.click(collapse);
    expect(navigation).toHaveAttribute('data-global-sidebar-mode', 'rail');
    expect(navigation).toHaveAttribute('data-global-sidebar-motion', 'collapse');
    expect(brandLink).toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.search')) })).toBe(search);
    expect(screen.getByRole('button', { name: String(i18n.t('app:notificationCenter.bell')) })).toBe(notification);
    expect(navigation.querySelector('[data-global-sidebar-workspace-region]'))
      .toHaveAttribute('aria-hidden', 'true');
    expect(navigation.querySelector('[data-global-sidebar-workspace-rail]')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.expand')) }));
    expect(navigation).toHaveAttribute('data-global-sidebar-mode', 'expanded');
    expect(navigation).toHaveAttribute('data-global-sidebar-motion', 'expand');
    act(() => { vi.advanceTimersByTime(200); });
    expect(navigation.querySelector('[data-global-sidebar-workspace-region]')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.collapse')) }));
    act(() => { vi.advanceTimersByTime(200); });
    expect(navigation.querySelector('[data-global-sidebar-workspace-region]')).not.toBeInTheDocument();
    first.unmount();

    mocks.forcedRail = true;
    renderSidebar();
    expect(screen.queryByRole('button', { name: String(i18n.t('app:globalSidebar.expand')) })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: String(i18n.t('app:globalSidebar.openWebsite')) })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.search')) })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: String(i18n.t('app:globalSidebar.navigation')) }))
      .toHaveAttribute('data-global-sidebar-toggle-visible', 'false');
  });

  it('keeps compact geometry and stable workspace weight across selection and menus', () => {
    mocks.forcedRail = false;
    mocks.projects.push(
      { id: 'project-1', name: 'Project one', path: '/work/project-one' },
      { id: 'project-2', name: 'Project two', path: '/work/project-two' },
    );
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'expanded',
      expandedWorkspaceKeys: [],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    renderSidebar({ activeWorkspacePath: '/work/project-one' });

    for (const label of [
      i18n.t('app:globalSidebar.newChat'),
      i18n.t('app:globalSidebar.tasks'),
      i18n.t('app:globalSidebar.more'),
      i18n.t('app:globalSidebar.capabilities'),
      i18n.t('app:globalSidebar.helper'),
      i18n.t('app:globalSidebar.settings'),
    ]) {
      const action = screen.getAllByRole('button', { name: String(label) }).find(button => button.hasAttribute('data-global-sidebar-nav-button'))!;
      expect(action).toHaveClass('h-8');
      expect(action).not.toHaveClass('h-9', 'h-10');
    }

    const activeRow = screen.getByText('Project one').closest<HTMLElement>('[data-global-sidebar-workspace-row]')!;
    const inactiveRow = screen.getByText('Project two').closest<HTMLElement>('[data-global-sidebar-workspace-row]')!;
    const activeTitle = activeRow.querySelector('[data-global-sidebar-workspace-title]');
    const inactiveTitle = inactiveRow.querySelector('[data-global-sidebar-workspace-title]');
    // Navigation, workspace and session rows share one 32px rhythm.
    expect(activeRow).toHaveClass('h-8');
    expect(inactiveRow).toHaveClass('h-8');
    expect(activeTitle).toHaveClass('font-medium');
    expect(inactiveTitle).toHaveClass('font-medium');
    expect(inactiveTitle?.className).not.toContain('group-hover/workspace:font-medium');
    expect(inactiveTitle?.className).not.toContain('group-focus-within/workspace:font-medium');
    const notificationButton = screen.getByRole('button', {
      name: String(i18n.t('app:notificationCenter.bell')),
    });
    const helperButton = screen.getByRole('button', {
      name: String(i18n.t('app:globalSidebar.helper')),
    });
    expect(notificationButton.querySelector('.global-sidebar-nav-label')).not.toBeInTheDocument();
    expect(helperButton.querySelector('.global-sidebar-nav-label')).toBeInTheDocument();
    const workspaceFade = document.querySelector<HTMLElement>('[data-global-sidebar-workspace-fade]');
    expect(workspaceFade).toHaveClass('pointer-events-none', 'absolute', 'inset-x-0', 'bottom-0', 'h-6');
    expect(workspaceFade?.style.background).toContain('linear-gradient(to bottom');
    expect(workspaceFade?.style.background).toContain('var(--global-sidebar-bg-a0)');
    expect(workspaceFade?.style.background).toContain('var(--global-sidebar-bg)');
    expect(document.querySelector('[role="tree"]')).toHaveClass('pt-2', 'pb-6');
    const workspaceFadeTop = document.querySelector<HTMLElement>('[data-global-sidebar-workspace-fade-top]');
    expect(workspaceFadeTop).toHaveClass('pointer-events-none', 'absolute', 'inset-x-0', 'top-8', 'h-2');
    expect(workspaceFadeTop?.style.background).toContain('linear-gradient(to bottom');
    expect(workspaceFadeTop?.style.background).toContain('var(--global-sidebar-bg)');
    expect(workspaceFadeTop?.style.background).toContain('var(--global-sidebar-bg-a0)');
    // The top fade must consume the header row's former bottom slack: the
    // header shrinks from h-12 to h-8 so the scroller edge (and the fade)
    // occupy the exact pixels that used to be solid spacing below the
    // section title, instead of stacking a fade below an unchanged gap.
    const workspaceSectionHeader = screen.getByText(String(i18n.t('app:globalSidebar.workspaceSection'))).closest('div');
    expect(workspaceSectionHeader).toHaveClass('h-8', 'pl-6', 'pr-[var(--global-sidebar-action-inset)]');
    // The fade must consume the spacing directly above the notification entry:
    // the expanded footer drops its top padding so the scroller edge (and the
    // fade) reach the notification button, instead of stacking an extra
    // gradient band on top of an unchanged gap.
    const footerActions = document.querySelector<HTMLElement>('[data-global-sidebar-footer-actions]');
    expect(footerActions).toHaveClass('pt-0', 'pb-2');
    const workspaceToggle = within(inactiveRow).getAllByRole('button')[0];
    const workspaceActions = inactiveRow.querySelector<HTMLElement>('[data-global-sidebar-workspace-actions]');
    expect(inactiveRow).toHaveClass('relative');
    expect(workspaceToggle).toHaveClass('flex-1');
    expect(workspaceActions).toHaveClass('pointer-events-none', 'absolute', 'inset-y-0', 'right-0', 'gap-1', 'pl-6');
    expect(workspaceActions).not.toHaveClass('shrink-0');
    expect(workspaceActions).toHaveClass('global-sidebar-workspace-actions');

    fireEvent.click(within(inactiveRow).getByRole('button', { name: String(i18n.t('launcher:workspaceCard.more')) }));
    expect(inactiveTitle).toHaveClass('font-medium');
    expect(inactiveTitle).not.toHaveClass('font-normal');
    expect(inactiveRow).toHaveAttribute('data-menu-open', 'true');
    expect(inactiveRow).not.toHaveAttribute('aria-current');
    expect(activeRow).toHaveAttribute('aria-current', 'page');
  });

  it('animates workspace branches in the expanded sidebar and cancels a pending collapse when reopened', () => {
    mocks.forcedRail = false;
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({
      id: 'session-1',
      agentDir: '/work/project-one',
      title: 'Animated session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'expanded',
      expandedWorkspaceKeys: [],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    renderSidebar();

    const workspaceRow = screen.getByText('Project one').closest<HTMLElement>('[data-global-sidebar-workspace-row]')!;
    const workspaceToggle = within(workspaceRow).getAllByRole('button')[0];
    const branch = workspaceRow.nextElementSibling as HTMLElement;
    const disclosureSlot = workspaceToggle.querySelector('[data-global-sidebar-disclosure-slot]');
    const workspaceChevron = workspaceToggle.querySelector('[data-global-sidebar-disclosure-chevron]');
    expect(branch).toHaveAttribute('data-global-sidebar-workspace-branch');
    expect(branch).toHaveAttribute('data-state', 'closed');
    // Avatar and chevron share one 16px slot on the sidebar icon axis; the
    // chevron only appears on row hover or keyboard focus.
    expect(workspaceToggle).toHaveClass('gap-3', 'pl-4', 'pr-2', 'text-sm');
    expect(disclosureSlot).toHaveClass('h-4', 'w-4');
    expect(workspaceChevron).toHaveClass('absolute', 'opacity-0', 'group-hover/workspace:opacity-100');
    expect(workspaceChevron).not.toHaveClass('rotate-90');
    expect(screen.queryByText('Animated session')).not.toBeInTheDocument();

    fireEvent.click(workspaceToggle);
    act(() => vi.advanceTimersByTime(16));
    expect(branch).toHaveAttribute('data-state', 'open');
    expect(branch).toHaveClass('grid-rows-[1fr]', 'duration-200', 'motion-reduce:transition-none');
    expect(workspaceChevron).toHaveClass('rotate-90');
    expect(branch.querySelector('.ml-6')).toHaveClass('border-l', 'pl-1.5');
    expect(screen.getByText('Animated session')).toHaveClass('text-sm');

    fireEvent.click(workspaceToggle);
    expect(branch).toHaveAttribute('data-state', 'closed');
    expect(screen.getByText('Animated session')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(100));
    fireEvent.click(workspaceToggle);
    act(() => vi.advanceTimersByTime(200));

    expect(branch).toHaveAttribute('data-state', 'open');
    expect(screen.getByText('Animated session')).toBeInTheDocument();
  });

  it('opens the global search overlay with one stable lazy-loaded shell', async () => {
    mocks.isTauri = true;
    const { container } = renderSidebar();

    const search = screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.search')) });
    expect(container.querySelector('[data-global-sidebar-brand-row]')).toContainElement(search);
    expect(container.querySelector('[data-global-sidebar-primary-nav]')).not.toContainElement(search);
    fireEvent.click(search);
    expect(search).toHaveAttribute('aria-expanded', 'true');
    const coldPanel = document.querySelector('[data-history-search-overlay-panel]');
    expect(coldPanel).toBeInTheDocument();
    const coldFilters = document.querySelector('[data-history-search-fallback-filters]');
    expect(coldFilters).toHaveTextContent(String(i18n.t('app:historyOverlay.filters.all')));
    expect(coldFilters).toHaveTextContent(String(i18n.t('app:historyOverlay.filters.favorite')));
    expect(document.querySelector('[data-history-search-fallback-compact]')).toBeInTheDocument();

    const backdrop = coldPanel?.parentElement ?? null;
    expect(container).not.toContainElement(backdrop);
    expect(backdrop?.parentElement).toBe(document.body);

    await act(async () => {
      await vi.dynamicImportSettled();
    });

    expect(screen.getByTestId('task-center-overlay')).toBeInTheDocument();
    expect(document.querySelector('[data-history-search-overlay-panel]')).toBe(coldPanel);
  });

  it('consumes a Tag navigation intent when the search surface closes before content handles it', async () => {
    mocks.isTauri = true;
    const onHistoryTagIntentConsumed = vi.fn();
    renderSidebar({
      historyTagIntent: { id: 41, tag: 'Alpha' },
      onHistoryTagIntentConsumed,
    });

    await act(async () => {
      await vi.dynamicImportSettled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close search test overlay' }));
    expect(onHistoryTagIntentConsumed).toHaveBeenCalledWith(41);
  });

  it('hides the Team Space navigation entry when the feature is unavailable', () => {
    const onOpenSpace = vi.fn();
    renderSidebar({ teamSpaceAvailable: false, onOpenSpace });

    expect(screen.queryByRole('button', { name: String(i18n.t('app:globalSidebar.team')) }))
      .not.toBeInTheDocument();
    expect(onOpenSpace).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: String(i18n.t('app:globalSidebar.more')) })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.agentNetwork')) })).toBeInTheDocument();
  });

  it('does not let an old Session completion close a newly reopened search overlay', async () => {
    mocks.isTauri = true;
    mocks.forcedRail = false;
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    mocks.taskData.sessions.push({
      id: 'slow-search-session',
      agentDir: '/work/project-one',
      title: 'Slow search session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    let resolveOpen!: (opened: boolean) => void;
    const onOpenSession = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveOpen = resolve;
    }));
    renderSidebar({ onOpenSession });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.search')) }));
      await vi.dynamicImportSettled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open search session test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close search test overlay' }));
    expect(screen.queryByTestId('task-center-overlay')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.search')) }));
      await vi.dynamicImportSettled();
    });
    expect(screen.getByTestId('task-center-overlay')).toBeInTheDocument();

    await act(async () => {
      resolveOpen(true);
      await Promise.resolve();
    });

    expect(screen.getByTestId('task-center-overlay')).toBeInTheDocument();
  });

  it('keeps archived workspaces reachable when there are no active workspaces', () => {
    const workspacePath = 'E:\\work\\archived';
    mocks.projects.push({
      id: 'archived-1',
      name: 'Archived project',
      path: workspacePath,
      archivedAt: '2026-07-20T00:00:00.000Z',
    });
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    const archived = screen.getByRole('button', { name: /已归档/ });
    expect(archived).toBeInTheDocument();
    fireEvent.click(archived);
    const archivedRow = screen.getByText('Archived project').parentElement!;
    fireEvent.click(within(archivedRow).getByRole('button', {
      name: String(i18n.t('launcher:workspaceCard.more')),
    }));
    fireEvent.click(screen.getByRole('button', {
      name: String(i18n.t('launcher:workspaceCard.openFolder')),
    }));
    expect(mocks.openPathExternal).toHaveBeenCalledWith({
      fullPath: workspacePath,
      workspace: workspacePath,
    });
  });

  it('keeps the flyout alive while a menu-launched confirmation owns focus', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    const region = screen.getByRole('region', { name: 'Agent 工作区' });
    const workspaceRow = screen.getByText('Project one').closest<HTMLElement>('[data-global-sidebar-workspace-row]')!;
    const moreButton = within(workspaceRow).getByRole('button', { name: String(i18n.t('launcher:workspaceCard.more')) });
    fireEvent.click(moreButton);
    fireEvent.click(screen.getByText(String(i18n.t('launcher:workspaceCard.remove'))));

    fireEvent.pointerLeave(region);
    act(() => vi.advanceTimersByTime(220));
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /取消/ }));
    expect(moreButton).toHaveFocus();
  });

  it('returns focus to a nested menu anchor when Escape dismisses the portal', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));
    const region = screen.getByRole('region', { name: 'Agent 工作区' });
    const workspaceRow = screen.getByText('Project one').closest<HTMLElement>('[data-global-sidebar-workspace-row]')!;
    const moreButton = within(workspaceRow).getByRole('button', { name: String(i18n.t('launcher:workspaceCard.more')) });
    fireEvent.click(moreButton);
    const pinItem = screen.getByText(String(i18n.t('launcher:workspaceCard.pin')));
    pinItem.focus();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(moreButton).toHaveFocus();
    fireEvent.pointerLeave(region);
    act(() => vi.advanceTimersByTime(220));
    expect(screen.getByRole('region', { name: 'Agent 工作区' })).toBeInTheDocument();
  });

  it('pages 11 sessions as 5 → 10 → 11, exposes every tag, and leaves no icon spacer for a closed session', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    for (let index = 1; index <= 11; index += 1) {
      mocks.taskData.sessions.push({
        id: `session-${index}`,
        agentDir: '/work/project-one',
        title: `Session ${index}`,
        createdAt: `2026-07-${String(index).padStart(2, '0')}T00:00:00.000Z`,
        lastActiveAt: `2026-07-${String(12 - index).padStart(2, '0')}T00:00:00.000Z`,
      });
    }
    mocks.taskData.workspaceSessionStates.set('/work/project-one', { isLoading: false, error: null });
    mocks.taskData.sessionTagsMap.set('session-1', [
      { type: 'im', platform: 'Telegram' },
      { type: 'cron' },
    ]);

    renderSidebar({ activeWorkspacePath: '/work/project-one' });
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    expect(document.querySelector('[data-global-sidebar-workspace-list]')).not.toHaveClass('space-y-1');
    const workspaceRow = screen.getByText('Project one').closest('[data-global-sidebar-workspace-row]');
    expect(workspaceRow).toHaveAttribute('aria-current', 'page');
    expect(workspaceRow).not.toHaveClass('bg-[var(--paper-elevated)]', 'shadow-sm');
    expect(workspaceRow?.querySelector('[data-global-sidebar-workspace-actions]')).toHaveClass('global-sidebar-workspace-actions');
    const firstSession = screen.getByRole('button', { name: /Session 1/ });
    expect(firstSession.className).toContain('focus-visible:ring-2');
    expect(firstSession.firstElementChild?.textContent).toBe('Session 1');
    expect(firstSession).toHaveTextContent('Telegram');
    expect(firstSession).toHaveTextContent(String(i18n.t('app:sessionTags.cron')));
    const firstSessionRow = firstSession.closest('[data-global-sidebar-session-row]');
    expect(firstSessionRow).toHaveClass('h-8');
    expect(firstSessionRow?.querySelector('[data-global-sidebar-session-title]')).toHaveClass('text-sm');
    expect(firstSessionRow?.querySelector('[data-global-sidebar-session-title]')).not.toHaveClass('text-xs');
    expect(screen.getByText('Telegram')).toHaveClass('text-xs', 'font-medium');
    expect(firstSession).toHaveClass('w-full');
    expect(firstSessionRow?.querySelector('[data-global-sidebar-session-date]')).toHaveClass('ml-auto');
    expect(firstSessionRow?.querySelector('[data-global-sidebar-session-action-overlay]')).toHaveClass('absolute', 'justify-end');
    expect(firstSessionRow?.querySelector('[data-global-sidebar-session-action-overlay]')).toHaveClass('pointer-events-none');
    const sessionDate = firstSessionRow?.querySelector('[data-global-sidebar-session-date]');
    expect(sessionDate).toHaveClass('text-xs');
    const sessionMore = firstSessionRow?.querySelector('[data-global-sidebar-session-action-overlay] button');
    expect(sessionDate).not.toHaveClass('opacity-0');
    fireEvent.click(sessionMore!);
    expect(sessionDate).toHaveClass('opacity-0');
    fireEvent.click(sessionMore!);
    expect(screen.queryByText('Session 6')).not.toBeInTheDocument();
    expect(screen.queryByText('Session 11')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.loadMore')) }));
    expect(screen.getByText('Session 10')).toBeInTheDocument();
    expect(screen.queryByText('Session 11')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.loadMore')) }));
    expect(screen.getByText('Session 11')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: String(i18n.t('app:globalSidebar.loadMore')) })).not.toBeInTheDocument();
  });

  it('projects only the shared generating and unread Tab signals into Session rows', () => {
    mocks.projects.push({ id: 'project-1', name: 'Project one', path: '/work/project-one' });
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/project-one'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    const sessionSpecs = [
      { id: 'active-session', title: 'Active session' },
      { id: 'open-session', title: 'Open session' },
      { id: 'unread-session', title: 'Unread session' },
      { id: 'generating-session', title: 'Generating session' },
    ];
    sessionSpecs.forEach((session, index) => {
      mocks.taskData.sessions.push({
        ...session,
        agentDir: '/work/project-one',
        createdAt: `2026-07-2${index}T00:00:00.000Z`,
        lastActiveAt: `2026-07-2${index}T00:00:00.000Z`,
      });
    });
    mocks.taskData.workspaceSessionStates.set('/work/project-one', { isLoading: false, error: null });

    const activeSessionTab: Tab = {
      id: 'active-tab',
      agentDir: '/work/project-one',
      sessionId: 'active-session',
      view: 'chat',
      title: 'Active session',
      sidecarConfigDisposition: 'adopt',
    };
    const openSessionTab: Tab = {
      ...activeSessionTab,
      id: 'open-tab',
      sessionId: 'open-session',
      title: 'Open session',
    };
    const unreadSessionTab: Tab = {
      ...activeSessionTab,
      id: 'unread-tab',
      sessionId: 'unread-session',
      title: 'Unread session',
      hasUnread: true,
    };
    const generatingSessionTab: Tab = {
      ...activeSessionTab,
      id: 'generating-tab',
      sessionId: 'generating-session',
      title: 'Generating session',
      isGenerating: true,
      hasUnread: true,
    };

    renderSidebar({
      tabs: [launcherTab, activeSessionTab, openSessionTab, unreadSessionTab, generatingSessionTab],
      activeTab: activeSessionTab,
      activeWorkspacePath: '/work/project-one',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    const rowFor = (title: string) => screen.getByText(title).closest<HTMLElement>('[data-global-sidebar-session-row]')!;
    const activeRow = rowFor('Active session');
    const workspaceRow = screen.getByText('Project one').closest<HTMLElement>('[data-global-sidebar-workspace-row]')!;
    expect(workspaceRow).not.toHaveAttribute('aria-current');
    expect(workspaceRow).not.toHaveClass('bg-[var(--hover-bg)]');
    expect(workspaceRow.querySelector('[data-global-sidebar-workspace-title]')).toHaveClass('font-medium');
    expect(activeRow).toHaveClass('global-sidebar-resource-row');
    expect(activeRow).toHaveAttribute('aria-current', 'page');
    expect(activeRow.querySelector('[data-tab-activity-indicator]')).toBeNull();
    expect(rowFor('Open session').querySelector('[data-tab-activity-indicator]')).toBeNull();

    const unreadIndicator = rowFor('Unread session').querySelector('[data-tab-activity-indicator]');
    expect(unreadIndicator).toHaveAttribute('data-tab-activity-indicator', 'unread');
    expect(unreadIndicator).toHaveClass('bg-[var(--accent-warm)]');

    const generatingIndicator = rowFor('Generating session').querySelector('[data-tab-activity-indicator]');
    expect(generatingIndicator).toHaveAttribute('data-tab-activity-indicator', 'generating');
    expect(generatingIndicator?.children).toHaveLength(2);
    Array.from(generatingIndicator?.children ?? []).forEach((dot) => {
      expect(dot).toHaveClass('bg-[var(--success)]');
    });
  });

  it('keeps one workspace failure local while another workspace remains usable', () => {
    mocks.projects.push(
      { id: 'project-a', name: 'Project A', path: '/work/a' },
      { id: 'project-b', name: 'Project B', path: '/work/b' },
    );
    window.localStorage.setItem(GLOBAL_SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      preferredMode: 'rail',
      expandedWorkspaceKeys: ['/work/a', '/work/b'],
      hasSeededDefaultExpansion: true,
      showAutomationSessions: true,
      sessionView: 'all',
    }));
    mocks.taskData.sessions.push({
      id: 'session-b',
      agentDir: '/work/b',
      title: 'Healthy session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    });
    mocks.taskData.workspaceSessionStates.set('/work/a', { isLoading: false, error: 'A failed' });
    mocks.taskData.workspaceSessionStates.set('/work/b', { isLoading: false, error: null });

    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    expect(screen.getByText('A failed')).toBeInTheDocument();
    expect(screen.getByText('Healthy session')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: String(i18n.t('launcher:rightRail.retry')) })).toHaveLength(1);
  });

  it('shows config loading failures with an explicit retry action', () => {
    mocks.configError = 'config unavailable';
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 工作区' }));

    expect(screen.getByText('config unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('launcher:rightRail.retry')) }));
    expect(mocks.refreshConfig).toHaveBeenCalled();
  });
});

describe('Agent network and Space navigation', () => {
  beforeEach(() => { vi.useRealTimers(); vi.clearAllMocks(); mocks.projects = []; window.localStorage.clear(); });
  it('opens the right menu by keyboard and restores focus on Escape', async () => {
    const onOpenSpace = vi.fn();
    renderSidebar({ onOpenSpace });
    const more = screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.more')) });
    more.focus(); fireEvent.keyDown(more, { key: 'ArrowRight' });
    const space = await screen.findByRole('menuitem', { name: String(i18n.t('app:globalSidebar.team')) });
    expect(more).toHaveAttribute('aria-expanded', 'true');
    await vi.waitFor(() => expect(space).toHaveFocus());
    fireEvent.keyDown(space, { key: 'ArrowDown' });
    expect(space).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(more).toHaveFocus();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(more); fireEvent.click(await screen.findByRole('menuitem', { name: String(i18n.t('app:globalSidebar.team')) }));
    expect(onOpenSpace).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
  it('exposes AgentNet in primary navigation and keeps only Space in the hover menu', async () => {
    const onOpenAgentNetwork = vi.fn();
    const networkTab: Tab = { id: 'network-tab', view: 'agentnetwork', title: 'AgentNet' };
    const view = renderSidebar({ onOpenAgentNetwork, activeTab: networkTab });
    const buttons = screen.getAllByRole('button').filter(button => button.hasAttribute('data-global-sidebar-nav-button'));
    const labels = buttons.map(button => button.getAttribute('aria-label'));
    expect(labels).toEqual(['新对话', '自动化任务', '技能与工具', 'AgentNet 局域网络', '更多', '小助理', '设置']);
    const network = screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.agentNetwork')) });
    const more = screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.more')) });
    expect(network).toHaveAttribute('aria-current', 'page');
    expect(more).not.toHaveAttribute('aria-current');
    fireEvent.click(network);
    expect(onOpenAgentNetwork).toHaveBeenCalledOnce();
    fireEvent.pointerEnter(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.more')) }));
    expect(await screen.findByRole('menuitem', { name: String(i18n.t('app:globalSidebar.team')) })).toBeVisible();
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
    expect(screen.queryByRole('menuitem', { name: String(i18n.t('app:globalSidebar.agentNetwork')) })).not.toBeInTheDocument();
    fireEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menuitem', { name: String(i18n.t('app:globalSidebar.team')) })).toBeVisible();
    fireEvent.click(more);
    expect(screen.getByRole('menu')).toBeVisible();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    const spaceTab: Tab = { id: 'space-tab', view: 'space', title: 'Space' };
    view.rerender(sidebar({ onOpenAgentNetwork, activeTab: spaceTab }));
    expect(screen.getByRole('button', { name: String(i18n.t('app:globalSidebar.more')) })).toHaveAttribute('aria-current', 'page');
    expect(network).not.toHaveAttribute('aria-current');
  });
});
