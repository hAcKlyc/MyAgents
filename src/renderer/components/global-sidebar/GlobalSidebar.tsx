import { selectUsableAgentWorkspaceRecords } from '../../../shared/agentWorkspaceIdentity';
import { isImeComposingEvent } from '@/utils/imeKeyboard';
import {
  AlertIcon,
  RadioIcon,
  CheckIcon,
  ChevronDownIcon,
  EyeIcon,
  EyeOffIcon,
  FolderOpenIcon,
  GridIcon,
  LoaderIcon,
  PinIcon,
  PinOffIcon,
  RefreshIcon,
  UndoIcon,
  SlidersIcon,
  StarIcon,
  TrashIcon,
  CloseIcon,
} from '@/components/icons';
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { track } from '@/analytics';
import { APP_ICON_SRC } from '@/components/brand/appBrand';
import { updateSession, type SessionMetadata } from '@/api/sessionClient';
import { MyAgentsLogotype } from '@/components/brand/MyAgentsLogotype';
import { APP_DISPLAY_NAME, APP_WEBSITE_URL } from '../../../shared/appProfile';
import ConfirmDialog from '@/components/ConfirmDialog';
import FeedbackPopover from '@/components/FeedbackPopover';
import AccountEntry from '@/features/account/AccountEntry';
import { APP_SHELL_POPOVER_CHROME } from '@/components/global-sidebar/appShellPopoverChrome';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import SessionStatsModal from '@/components/SessionStatsModal';
import SessionContextMenu from '@/components/SessionContextMenu';
import SessionTagBadge from '@/components/SessionTagBadge';
import TabActivityIndicator from '@/components/TabActivityIndicator';
import Tip from '@/components/Tip';
import {
  ArchiveIcon,
  BellIcon,
  CapabilitiesIcon,
  ChevronRightIcon,
  ComposeIcon,
  HelperIcon,
  MoreIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SidebarIcon,
  TasksIcon,
  TeamIcon,
  FolderIcon,
} from '@/components/icons';
import UnreadNotificationIndicator from '@/components/UnreadNotificationIndicator';
import { useToast } from '@/components/Toast';
import { NewAgentPanel } from '@/components/launcher';
import WorkspaceIcon from '@/components/launcher/WorkspaceIcon';
import { sortLauncherProjects } from '@/components/launcher/workspaceSort';
import { MenuItem } from '@/components/ui/MenuItem';
import { Popover } from '@/components/ui/Popover';
import {
  isProjectActiveForUser,
  isProjectArchived,
  isProjectVisibleToUser,
  isSystemPresetProject,
  type Project,
} from '@/config/types';
import {
  getAgentById,
  setAgentEnabledForLifecycle,
  stopAgentChannelsForLifecycle,
} from '@/config/services/agentConfigService';
import {
  archiveProject,
  unarchiveProject,
} from '@/config/services/projectService';
import { useConfig } from '@/hooks/useConfig';
import { useSessionDeletion } from '@/context/SessionDeletionContext';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { useGlobalSidebarTaskCenterData, type SessionTag, type TaskCenterData } from '@/hooks/useTaskCenterData';
import { ensureWorkspaceSessions } from '@/hooks/taskCenterStore';
import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import type { Tab, InitialMessage } from '@/types/tab';
import { isSupportedLocale } from '../../../shared/i18n';
import { isAutomationHistoryOrigin } from '../../../shared/session-origin';
import { normalizeWorkspacePathIdentity, workspacePathsEqual } from '../../../shared/workspacePath';
import {
  DEFAULT_GLOBAL_SIDEBAR_PREFERENCE,
  loadGlobalSidebarPreference,
  pruneRemovedWorkspaceKeys,
  resolveGlobalSidebarMode,
  saveGlobalSidebarPreference,
  seedDefaultWorkspaceExpansion,
  type GlobalSidebarPreferenceV1,
} from '@/utils/globalSidebarPreference';
import { isTauriEnvironment } from '@/utils/browserMock';
import { formatTime, getSessionDisplayText } from '@/utils/taskCenterUtils';
import { getFullSessionDisplayText } from '@/utils/sessionDisplay';
import { copyPlainText } from '@/utils/clipboard';
import { openExternal } from '@/utils/openExternal';
import { OverflowNameTooltip } from '@/components/workspace-tree/OverflowNameTooltip';
import NotificationCenterFlyout from '@/notifications/NotificationCenterFlyout';
import { useNotificationCenter } from '@/notifications/useNotificationCenter';
import type { AppRoute } from '../../../shared/appRoute';

const loadHistorySearchOverlayContent = () => import('@/components/HistorySearchOverlayContent');
const HistorySearchOverlayContent = lazy(loadHistorySearchOverlayContent);
const WorkspaceConfigPanel = lazy(() => import('@/components/WorkspaceConfigPanel'));

const SESSION_PAGE_SIZE = 5;
const AUTO_RAIL_QUERY = '(max-width: 1080px)';
const EMPTY_TAGS: SessionTag[] = [];
const SIDEBAR_TRANSITION_MS = 200;
const WORKSPACE_BRANCH_TRANSITION_MS = 200;
const FLYOUT_FOCUS_ENTRY_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function isPointerWithinBounds(
  bounds: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
  clientX: number,
  clientY: number,
): boolean {
  return bounds.right > bounds.left
    && bounds.bottom > bounds.top
    && clientX >= bounds.left
    && clientX < bounds.right
    && clientY >= bounds.top
    && clientY < bounds.bottom;
}

function sessionTime(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Sidebar-only order: pins first, then each partition's own canonical time. */
export function sortWorkspaceSessions(sessions: readonly SessionMetadata[]): SessionMetadata[] {
  return [...sessions].sort((a, b) => {
    const aPinned = Boolean(a.pinnedAt);
    const bPinned = Boolean(b.pinnedAt);
    if (aPinned !== bPinned) return bPinned ? 1 : -1;
    const primary = aPinned
      ? sessionTime(b.pinnedAt) - sessionTime(a.pinnedAt)
      : sessionTime(b.lastActiveAt) - sessionTime(a.lastActiveAt);
    if (primary !== 0) return primary;
    return a.id.localeCompare(b.id);
  });
}

export type CapabilitySection = 'skills' | 'plugins' | 'mcp';

interface GlobalSidebarProps {
  tabs: readonly Tab[];
  activeTab: Tab | undefined;
  activeWorkspacePath: string | null;
  sessionNotificationBadgeCounts?: ReadonlyMap<string, number>;
  teamSpaceAvailable: boolean;
  onNewTab: () => void;
  onOpenTaskCenter: () => void;
  onCreateTask: () => void;
  onOpenSpace: () => void;
  onOpenAgentNetwork?: () => void;
  onOpenAppRoute?: (route: AppRoute) => Promise<boolean> | boolean;
  onOpenCapabilities: (section?: CapabilitySection) => void;
  onOpenSettings: () => void;
  onOpenBugReport: () => void;
  onOpenWorkspace: (
    project: Project,
    initialMessage?: InitialMessage,
    entryIntent?: 'open_workspace' | 'workspace_init',
  ) => Promise<boolean>;
  onOpenSession: (session: SessionMetadata, project: Project) => Promise<boolean>;
  onRenameSession: (sessionId: string, title: string) => Promise<SessionMetadata | null>;
  historyTagIntent?: { id: number; tag: string } | null;
  onHistoryTagIntentConsumed?: (id: number) => void;
  /** The single New Agent panel is owned here but opened from App-level entry
   *  points too (launcher workspace selector), so its open state is lifted. */
  newAgentPanelOpen: boolean;
  onNewAgentPanelOpenChange: (open: boolean) => void;
}

function useForcedRail(): boolean {
  const [forced, setForced] = useState(() => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(AUTO_RAIL_QUERY).matches
  ));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(AUTO_RAIL_QUERY);
    const onChange = (event: MediaQueryListEvent) => setForced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return forced;
}

function useNestedInteractionCleanup(onOpenChange: (open: boolean) => void): void {
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);
  useEffect(() => () => onOpenChangeRef.current(false), []);
}

interface SidebarNavButtonProps {
  icon: ReactNode;
  label: string;
  expanded: boolean;
  active?: boolean;
  disabled?: boolean;
  tooltipDisabled?: boolean;
  hasPopup?: 'menu';
  ariaExpanded?: boolean;
  onClick: () => void;
}

/**
 * One 16px slot on the sidebar icon axis. At rest it shows the row's identity
 * (workspace avatar / group icon); on hover or keyboard focus the disclosure
 * chevron takes its place, so expandable rows do not spend a second leading
 * column on an arrow that only matters while pointing at the row.
 */
function SidebarDisclosureSlot({
  expanded,
  group,
  children,
}: {
  expanded: boolean;
  group: 'workspace' | 'archived';
  children: ReactNode;
}) {
  // Row hover reveals for the whole workspace row (including its actions);
  // keyboard focus reveals only via focus-visible on the toggle itself, so a
  // mouse click does not leave the avatar replaced by a chevron.
  const reveal = group === 'workspace'
    ? 'group-hover/workspace:opacity-100 group-focus-visible/disclosure:opacity-100'
    : 'group-hover/disclosure:opacity-100 group-focus-visible/disclosure:opacity-100';
  const conceal = group === 'workspace'
    ? 'group-hover/workspace:opacity-0 group-focus-visible/disclosure:opacity-0'
    : 'group-hover/disclosure:opacity-0 group-focus-visible/disclosure:opacity-0';
  return (
    <span className="relative flex h-4 w-4 shrink-0 items-center justify-center" data-global-sidebar-disclosure-slot>
      <span className={`flex items-center justify-center transition-opacity duration-150 motion-reduce:transition-none ${conceal}`}>
        {children}
      </span>
      <ChevronRightIcon
        className={`absolute inset-0 h-4 w-4 text-[var(--ink-muted)] opacity-0 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${reveal} ${expanded ? 'rotate-90' : ''}`}
        data-global-sidebar-disclosure-chevron
      />
    </span>
  );
}

function SidebarNavButton({
  icon,
  label,
  expanded,
  active,
  disabled,
  tooltipDisabled,
  hasPopup,
  ariaExpanded,
  onClick,
}: SidebarNavButtonProps) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-haspopup={hasPopup}
      aria-expanded={ariaExpanded}
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      className={`global-sidebar-row relative flex h-8 items-center text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
        expanded ? 'w-full' : 'w-10'
      } ${
        active
          ? 'bg-[var(--paper-inset)] text-[var(--ink)]'
          : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
      } ${disabled ? 'cursor-not-allowed opacity-45' : ''}`}
      data-global-sidebar-nav-button
    >
      <span className="absolute left-3 flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="global-sidebar-copy global-sidebar-nav-label global-sidebar-label min-w-0 truncate text-left" aria-hidden={!expanded}>
        {label}
      </span>
    </button>
  );
  return (
    <Tip
      label={label}
      position="right"
      disabled={expanded || tooltipDisabled}
      className={`global-sidebar-nav-tip ${expanded ? 'w-full' : 'w-10'}`}
    >
      {button}
    </Tip>
  );
}

function SidebarMore({ expanded, activeView, onTeam }: {
  expanded: boolean; activeView: string | undefined; onTeam: () => void;
}) {
  const { t } = useTranslation('app');
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null), menu = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboard = useRef(false);
  const cancel = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const show = () => { cancel(); setOpen(true); };
  const hide = () => { cancel(); timer.current = setTimeout(() => setOpen(false), 150); };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const setMenuRef = useCallback((node: HTMLDivElement | null) => {
    menu.current = node;
    if (node && keyboard.current) { node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); keyboard.current = false; }
  }, []);
  const enter = () => {
    keyboard.current = true; show();
    if (menu.current) { menu.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); keyboard.current = false; }
  };
  const close = () => { cancel(); setOpen(false); };
  return <div ref={anchor} className="relative" onPointerEnter={show} onPointerLeave={hide}
    onKeyDown={event => { if (event.key === 'ArrowRight') { event.preventDefault(); enter(); } }}>
    <SidebarNavButton expanded={expanded} active={activeView === 'space'}
      icon={<MoreIcon className="h-4 w-4" />} label={t('globalSidebar.more')} tooltipDisabled={open} hasPopup="menu" ariaExpanded={open}
      onClick={enter} />
    <Popover open={open} onClose={close} anchorRef={anchor} placement="right-start" className="min-w-40 p-1">
      <div ref={setMenuRef} role="menu" aria-label={t('globalSidebar.more')} onPointerEnter={cancel} onPointerLeave={hide}
        onKeyDown={event => {
          if (isImeComposingEvent(event)) return;
          const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
          }
          if (event.key === 'ArrowLeft' || event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation(); close(); anchor.current?.querySelector<HTMLButtonElement>('button')?.focus();
          }
        }}>
        <button type="button" role="menuitem" onClick={() => { close(); onTeam(); }}
          className="flex h-9 w-full items-center gap-2 rounded-md px-3 text-sm text-[var(--ink)] hover:bg-[var(--hover-bg)] focus:bg-[var(--hover-bg)]">
          <TeamIcon className="h-4 w-4 text-[var(--ink-muted)]" /><span className="global-sidebar-label">{t('globalSidebar.team')}</span>
        </button>
      </div>
    </Popover>
  </div>;
}

/**
 * Own one visual shell from the opening click through lazy-content readiness.
 * Suspense only swaps the interior, so the cold path cannot replay the
 * backdrop and panel entrance animations when the search content resolves.
 */
function HistorySearchOverlayFrame({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  useCloseLayer(() => {
    onClose();
    return true;
  }, 40);

  // This App-wide overlay is declared by GlobalSidebar, which precedes the
  // active Tab workspace in DOM order. WKWebView paints macOS overflow
  // scrollbars in a separate composited layer, so keeping the backdrop in that
  // earlier subtree lets a later Tab scrollbar overpaint it despite z-index.
  // Portalling the stable shell to body makes it a root-level, later paint
  // surface while preserving the same Suspense and close-layer lifetimes.
  return createPortal(
    <OverlayBackdrop
      onClose={onClose}
      className="z-40"
      style={{ animation: 'overlayFadeIn 140ms ease-out' }}
    >
      <div
        data-history-search-overlay-panel
        className="glass-panel flex h-[85vh] w-full max-w-5xl flex-col"
        style={{ padding: '2vh 2vw', animation: 'overlayPanelIn 160ms ease-out' }}
      >
        {children}
      </div>
    </OverlayBackdrop>,
    document.body,
  );
}

function HistorySearchOverlayFallback({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('app');

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-[var(--ink)]">{t('historyOverlay.title')}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('historyOverlay.exitSearch')}
          className="rounded-md p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>
      <div className="flex h-8 items-center justify-between gap-4">
        <div
          aria-hidden="true"
          className="flex items-center gap-1"
          data-history-search-fallback-filters
        >
          <span className="rounded-full bg-[var(--button-primary-bg)] px-2.5 py-1 text-xs font-medium text-[var(--button-primary-text)]">
            {t('historyOverlay.filters.all')}
          </span>
          <span className="rounded-full px-2.5 py-1 text-xs font-medium text-[var(--ink-muted)]">
            {t('historyOverlay.filters.favorite')}
          </span>
        </div>
        <div
          className="flex h-full w-[30%] min-w-72 shrink-0 items-center justify-between gap-3 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 text-[var(--ink-muted)]/50"
          data-history-search-fallback-compact
        >
          <span className="truncate text-sm">{t('historyOverlay.searchPlaceholder')}</span>
          <SearchIcon className="h-3.5 w-3.5 shrink-0" />
        </div>
      </div>
      <div aria-busy="true" className="flex min-h-0 flex-1 items-center justify-center">
        <LoaderIcon className="h-4 w-4 animate-spin text-[var(--ink-muted)]/50" />
      </div>
    </>
  );
}

export default memo(function GlobalSidebar({
  tabs,
  activeTab,
  activeWorkspacePath,
  sessionNotificationBadgeCounts,
  teamSpaceAvailable,
  onNewTab,
  onOpenTaskCenter,
  onCreateTask,
  onOpenSpace,
  onOpenAgentNetwork,
  onOpenAppRoute,
  onOpenCapabilities,
  onOpenSettings,
  onOpenBugReport,
  onOpenWorkspace,
  onOpenSession,
  onRenameSession,
  historyTagIntent,
  onHistoryTagIntentConsumed,
  newAgentPanelOpen,
  onNewAgentPanelOpenChange,
}: GlobalSidebarProps) {
  const { t } = useTranslation('app');
  const { t: tLauncher } = useTranslation('launcher');
  const toast = useToast();
  const deleteSession = useSessionDeletion();
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);
  const {
    config,
    projects,
    isLoading: projectsLoading,
    error: projectsError,
    removeProject,
    patchProject,
    touchProject,
    refreshConfig,
  } = useConfig();
  const { openPathExternal } = useWorkspaceFileService(null);
  const forceRail = useForcedRail();
  const [preference, setPreference] = useState<GlobalSidebarPreferenceV1>(() => {
    if (typeof window === 'undefined') return DEFAULT_GLOBAL_SIDEBAR_PREFERENCE;
    return loadGlobalSidebarPreference(window.localStorage);
  });
  const [sessionLimits, setSessionLimits] = useState<Record<string, number>>({});
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const notificationCenter = useNotificationCenter();
  const refreshNotificationCenter = notificationCenter.refresh;
  const previousActiveTabIdRef = useRef(activeTab?.id ?? null);
  const activeTabIdRef = useRef(activeTab?.id ?? null);
  activeTabIdRef.current = activeTab?.id ?? null;
  const resourceSurfaceInteractionGenerationRef = useRef(0);
  const openNestedLayerKeysRef = useRef(new Set<string>());
  const flyoutTriggerRef = useRef<HTMLButtonElement | null>(null);
  const flyoutRef = useRef<HTMLDivElement | null>(null);
  const flyoutPointerInsideRef = useRef(false);
  const flyoutTriggerPointerInsideRef = useRef(false);
  const childLayerReturnFocusRef = useRef<HTMLElement | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const feedbackTriggerRef = useRef<HTMLDivElement | null>(null);
  const notificationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const notificationPanelRef = useRef<HTMLDivElement | null>(null);

  const [recentlyCreatedWorkspaceKey, setRecentlyCreatedWorkspaceKey] = useState<string | null>(null);
  const [projectToRemove, setProjectToRemove] = useState<Project | null>(null);
  const [agentWorkspacePath, setAgentWorkspacePath] = useState<string | null>(null);
  const [pendingDeleteSession, setPendingDeleteSession] = useState<SessionMetadata | null>(null);
  const [statsSession, setStatsSession] = useState<SessionMetadata | null>(null);
  const pinInFlightRef = useRef(new Set<string>());
  const archiveInFlightRef = useRef(new Set<string>());
  const childLayerOpen = newAgentPanelOpen
    || projectToRemove !== null
    || agentWorkspacePath !== null
    || pendingDeleteSession !== null
    || statsSession !== null;
  const childLayerOpenRef = useRef(childLayerOpen);
  childLayerOpenRef.current = childLayerOpen;
  const previousChildLayerOpenRef = useRef(childLayerOpen);

  const updatePreference = useCallback((update: (current: GlobalSidebarPreferenceV1) => GlobalSidebarPreferenceV1) => {
    setPreference((current) => {
      const next = update(current);
      if (next === current) return current;
      if (typeof window !== 'undefined') saveGlobalSidebarPreference(window.localStorage, next);
      return next;
    });
  }, []);

  const sortedProjects = useMemo(
    () => sortLauncherProjects(selectUsableAgentWorkspaceRecords(projects, []).projects.filter(isProjectVisibleToUser)),
    [projects],
  );
  const activeProjects = useMemo(
    () => sortedProjects.filter(isProjectActiveForUser),
    [sortedProjects],
  );
  const archivedProjects = useMemo(
    () => sortedProjects
      .filter(isProjectArchived)
      .sort((a, b) => (Date.parse(b.archivedAt ?? '') || 0) - (Date.parse(a.archivedAt ?? '') || 0)),
    [sortedProjects],
  );
  const expandedWorkspacePaths = useMemo(() => {
    const expandedKeys = new Set(preference.expandedWorkspaceKeys);
    return activeProjects
      .filter((project) => expandedKeys.has(normalizeWorkspacePathIdentity(project.path)))
      .map((project) => project.path);
  }, [activeProjects, preference.expandedWorkspaceKeys]);
  const taskCenterData = useGlobalSidebarTaskCenterData(expandedWorkspacePaths, searchOpen);

  useEffect(() => {
    if (projectsLoading) return;
    updatePreference((current) => {
      const seeded = seedDefaultWorkspaceExpansion(
        current,
        config.defaultWorkspacePath,
        activeProjects.map((project) => project.path),
      );
      return pruneRemovedWorkspaceKeys(seeded, activeProjects.map((project) => project.path));
    });
  }, [activeProjects, config.defaultWorkspacePath, projectsLoading, updatePreference]);

  const effectiveMode = resolveGlobalSidebarMode(preference.preferredMode, forceRail);
  const expanded = effectiveMode === 'expanded';
  const [sidebarMotion, setSidebarMotion] = useState<'expand' | 'collapse' | null>(null);
  const [expandedWorkspaceMounted, setExpandedWorkspaceMounted] = useState(expanded);

  useEffect(() => {
    if (expanded) {
      setExpandedWorkspaceMounted(true);
      return;
    }
    if (openNestedLayerKeysRef.current.size > 0 || childLayerOpenRef.current) {
      setExpandedWorkspaceMounted(false);
      return;
    }
    const timeout = window.setTimeout(() => {
      setExpandedWorkspaceMounted(false);
    }, SIDEBAR_TRANSITION_MS);
    return () => window.clearTimeout(timeout);
  }, [expanded]);

  const clearFlyoutTimers = useCallback(() => {
    if (openTimerRef.current) clearTimeout(openTimerRef.current);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    openTimerRef.current = null;
    closeTimerRef.current = null;
  }, []);

  useEffect(() => clearFlyoutTimers, [clearFlyoutTimers]);

  const openFlyoutNow = useCallback(() => {
    clearFlyoutTimers();
    setNotificationOpen(false);
    setShowFeedback(false);
    setSearchOpen(false);
    resourceSurfaceInteractionGenerationRef.current += 1;
    setFlyoutOpen(true);
  }, [clearFlyoutTimers]);

  const scheduleFlyoutOpen = useCallback(() => {
    if (expanded || flyoutOpen) return;
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    openTimerRef.current = setTimeout(() => {
      setNotificationOpen(false);
      setShowFeedback(false);
      setSearchOpen(false);
      resourceSurfaceInteractionGenerationRef.current += 1;
      setFlyoutOpen(true);
    }, 125);
  }, [expanded, flyoutOpen]);

  const scheduleFlyoutClose = useCallback(() => {
    if (expanded) return;
    if (openTimerRef.current) clearTimeout(openTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      if (openNestedLayerKeysRef.current.size > 0 || childLayerOpenRef.current) return;
      const flyout = flyoutRef.current;
      if (!flyout || typeof document === 'undefined') return;
      if (flyoutPointerInsideRef.current || flyoutTriggerPointerInsideRef.current) return;
      const active = document.activeElement;
      if (active && (flyout.contains(active) || flyoutTriggerRef.current?.contains(active))) return;
      setFlyoutOpen(false);
    }, 220);
  }, [expanded]);

  const handleFlyoutPointerLeave = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = flyoutRef.current?.getBoundingClientRect();
    if (bounds && isPointerWithinBounds(bounds, event.clientX, event.clientY)) {
      flyoutPointerInsideRef.current = true;
      clearFlyoutTimers();
      return;
    }
    flyoutPointerInsideRef.current = false;
    scheduleFlyoutClose();
  }, [clearFlyoutTimers, scheduleFlyoutClose]);

  const handleFlyoutPointerEnter = useCallback(() => {
    flyoutPointerInsideRef.current = true;
    clearFlyoutTimers();
  }, [clearFlyoutTimers]);

  const handleFlyoutTriggerPointerEnter = useCallback(() => {
    flyoutTriggerPointerInsideRef.current = true;
    scheduleFlyoutOpen();
  }, [scheduleFlyoutOpen]);

  const handleFlyoutTriggerPointerLeave = useCallback(() => {
    flyoutTriggerPointerInsideRef.current = false;
    scheduleFlyoutClose();
  }, [scheduleFlyoutClose]);

  const handleFlyoutTriggerFocus = useCallback((event: ReactFocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget && flyoutRef.current?.contains(event.relatedTarget as Node)) {
      clearFlyoutTimers();
      return;
    }
    openFlyoutNow();
  }, [clearFlyoutTimers, openFlyoutNow]);

  const handleNestedInteractionChange = useCallback((key: string, open: boolean) => {
    if (open) openNestedLayerKeysRef.current.add(key);
    else openNestedLayerKeysRef.current.delete(key);
    if (!open) scheduleFlyoutClose();
  }, [scheduleFlyoutClose]);

  useEffect(() => {
    const wasOpen = previousChildLayerOpenRef.current;
    previousChildLayerOpenRef.current = childLayerOpen;
    if (childLayerOpen && closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    } else if (wasOpen && !childLayerOpen) {
      scheduleFlyoutClose();
    }
  }, [childLayerOpen, scheduleFlyoutClose]);

  const closeFlyout = useCallback((restoreFocus = false) => {
    clearFlyoutTimers();
    openNestedLayerKeysRef.current.clear();
    flyoutPointerInsideRef.current = false;
    flyoutTriggerPointerInsideRef.current = false;
    resourceSurfaceInteractionGenerationRef.current += 1;
    setFlyoutOpen(false);
    if (restoreFocus) flyoutTriggerRef.current?.focus();
  }, [clearFlyoutTimers]);

  const closeNotificationCenter = useCallback((restoreFocus = false) => {
    setNotificationOpen(false);
    if (restoreFocus) notificationTriggerRef.current?.focus();
  }, []);

  const toggleNotificationCenter = useCallback(() => {
    closeFlyout();
    setShowFeedback(false);
    setSearchOpen(false);
    setNotificationOpen((open) => {
      const next = !open;
      if (next) refreshNotificationCenter();
      return next;
    });
  }, [closeFlyout, refreshNotificationCenter]);

  const toggleFeedback = useCallback(() => {
    closeFlyout();
    closeNotificationCenter();
    setSearchOpen(false);
    setShowFeedback((value) => !value);
  }, [closeFlyout, closeNotificationCenter]);

  useEffect(() => {
    const activeTabId = activeTab?.id ?? null;
    const activeTabChanged = previousActiveTabIdRef.current !== activeTabId;
    previousActiveTabIdRef.current = activeTabId;
    if (!activeTabChanged) return;
    setSearchOpen(false);
    closeFlyout();
    closeNotificationCenter();
  }, [activeTab?.id, closeFlyout, closeNotificationCenter]);

  useCloseLayer(() => {
    if (!flyoutOpen) return false;
    closeFlyout(true);
    return true;
  }, flyoutOpen ? 240 : -1);

  useCloseLayer(() => {
    if (!notificationOpen) return false;
    closeNotificationCenter(true);
    return true;
  }, notificationOpen ? 245 : -1);

  useEffect(() => {
    if (!notificationOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (notificationPanelRef.current?.contains(target)) return;
      if (notificationTriggerRef.current?.contains(target)) return;
      closeNotificationCenter();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isImeComposingEvent(event)) return;
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeNotificationCenter(true);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [closeNotificationCenter, notificationOpen]);

  useEffect(() => {
    if (expanded && flyoutOpen) closeFlyout();
  }, [closeFlyout, expanded, flyoutOpen]);

  const handleToggleMode = useCallback(() => {
    if (forceRail) return;
    setSidebarMotion(expanded ? 'collapse' : 'expand');
    updatePreference((current) => ({
      ...current,
      preferredMode: current.preferredMode === 'expanded' ? 'rail' : 'expanded',
    }));
  }, [expanded, forceRail, updatePreference]);

  const handleToggleWorkspace = useCallback((project: Project) => {
    const key = normalizeWorkspacePathIdentity(project.path);
    updatePreference((current) => {
      const keys = new Set(current.expandedWorkspaceKeys);
      if (keys.has(key)) keys.delete(key);
      else keys.add(key);
      return { ...current, expandedWorkspaceKeys: [...keys], hasSeededDefaultExpansion: true };
    });
  }, [updatePreference]);

  const rememberChildLayerOrigin = useCallback((origin?: HTMLElement | null) => {
    childLayerReturnFocusRef.current = origin ?? flyoutTriggerRef.current;
  }, []);

  const restoreChildLayerFocus = useCallback(() => {
    const target = childLayerReturnFocusRef.current;
    childLayerReturnFocusRef.current = null;
    if (target?.isConnected) target.focus();
    else flyoutTriggerRef.current?.focus();
  }, []);

  const handleLoadMore = useCallback((project: Project, total: number) => {
    const key = normalizeWorkspacePathIdentity(project.path);
    setSessionLimits((current) => ({
      ...current,
      [key]: Math.min((current[key] ?? SESSION_PAGE_SIZE) + SESSION_PAGE_SIZE, total),
    }));
  }, []);

  const handleOpenNewAgentPanel = useCallback((origin?: HTMLElement | null) => {
    // Same child-layer contract as the other sidebar dialogs: return focus to
    // the entry inside the flyout so it stays open and the new row is visible.
    rememberChildLayerOrigin(origin);
    onNewAgentPanelOpenChange(true);
  }, [onNewAgentPanelOpenChange, rememberChildLayerOrigin]);

  const handleNewAgentCreated = useCallback((project: Project) => {
    setRecentlyCreatedWorkspaceKey(normalizeWorkspacePathIdentity(project.path));
  }, []);

  // The created-row flash is a one-shot cue; clear it after the CSS animation.
  useEffect(() => {
    if (!recentlyCreatedWorkspaceKey) return;
    const timer = setTimeout(() => setRecentlyCreatedWorkspaceKey(null), 1600);
    return () => clearTimeout(timer);
  }, [recentlyCreatedWorkspaceKey]);

  const handleOpenTaskCenter = useCallback(() => {
    track('task_center_open', {});
    onOpenTaskCenter();
  }, [onOpenTaskCenter]);

  const handleTogglePin = useCallback(async (project: Project) => {
    if (isProjectArchived(project) || pinInFlightRef.current.has(project.id)) return;
    pinInFlightRef.current.add(project.id);
    try {
      const latest = projects.find((candidate) => candidate.id === project.id) ?? project;
      await patchProject(project.id, { pinnedAt: latest.pinnedAt ? undefined : new Date().toISOString() });
    } catch (error) {
      console.error('[GlobalSidebar] Failed to toggle workspace pin:', error);
      toastRef.current.warning(tLauncher('toasts.pinFailed'));
    } finally {
      pinInFlightRef.current.delete(project.id);
    }
  }, [patchProject, projects, tLauncher]);

  const handleArchive = useCallback(async (project: Project) => {
    if (archiveInFlightRef.current.has(project.id)) return;
    archiveInFlightRef.current.add(project.id);
    try {
      const latest = projects.find((candidate) => candidate.id === project.id) ?? project;
      const agent = latest.agentId ? getAgentById(config, latest.agentId) : undefined;
      const wasEnabled = agent?.enabled === true;
      const archived = await archiveProject(latest.id, { agentEnabledBeforeArchive: wasEnabled });
      if (!archived) throw new Error(`Project ${latest.id} not found`);
      if (agent && wasEnabled) await setAgentEnabledForLifecycle(agent.id, false);
      if (agent) await stopAgentChannelsForLifecycle(agent);
      await refreshConfig();
      toastRef.current.success(tLauncher('toasts.workspaceArchived'));
    } catch (error) {
      console.error('[GlobalSidebar] Failed to archive workspace:', error);
      toastRef.current.warning(tLauncher('toasts.archiveFailed'));
    } finally {
      archiveInFlightRef.current.delete(project.id);
    }
  }, [config, projects, refreshConfig, tLauncher]);

  const handleUnarchive = useCallback(async (project: Project) => {
    if (archiveInFlightRef.current.has(project.id)) return;
    archiveInFlightRef.current.add(project.id);
    try {
      const latest = projects.find((candidate) => candidate.id === project.id) ?? project;
      const shouldRestoreAgent = latest.archivedAgentEnabledBeforeArchive === true;
      const restored = await unarchiveProject(latest.id);
      if (!restored) throw new Error(`Project ${latest.id} not found`);
      if (shouldRestoreAgent && latest.agentId) {
        try {
          await setAgentEnabledForLifecycle(latest.agentId, true);
        } catch (error) {
          await archiveProject(latest.id, {
            archivedAtIso: latest.archivedAt,
            agentEnabledBeforeArchive: true,
          });
          throw error;
        }
      }
      await refreshConfig();
      toastRef.current.success(tLauncher('toasts.workspaceUnarchived'));
    } catch (error) {
      console.error('[GlobalSidebar] Failed to unarchive workspace:', error);
      toastRef.current.warning(tLauncher('toasts.unarchiveFailed'));
    } finally {
      archiveInFlightRef.current.delete(project.id);
    }
  }, [projects, refreshConfig, tLauncher]);

  const handleOpenFolder = useCallback(async (project: Project) => {
    try {
      await openPathExternal({ fullPath: project.path, workspace: project.path });
    } catch (error) {
      console.error('[GlobalSidebar] Failed to open workspace folder:', error);
      toastRef.current.error(tLauncher('toasts.openFolderFailed'));
    }
  }, [openPathExternal, tLauncher]);

  const handleConfirmRemoveProject = useCallback(async () => {
    if (!projectToRemove) return;
    await removeProject(projectToRemove.id);
    setProjectToRemove(null);
    restoreChildLayerFocus();
  }, [projectToRemove, removeProject, restoreChildLayerFocus]);

  const handleOpenWorkspace = useCallback(async (
    project: Project,
    initialMessage?: InitialMessage,
    entryIntent: 'open_workspace' | 'workspace_init' = 'open_workspace',
  ) => {
    const sourceActiveTabId = activeTabIdRef.current;
    const interactionGeneration = resourceSurfaceInteractionGenerationRef.current;
    const opened = await onOpenWorkspace(project, initialMessage, entryIntent);
    if (opened) {
      void touchProject(project.id).catch(() => {});
      if (
        activeTabIdRef.current === sourceActiveTabId
        && resourceSurfaceInteractionGenerationRef.current === interactionGeneration
      ) {
        closeFlyout();
      }
    }
  }, [closeFlyout, onOpenWorkspace, touchProject]);

  const handleOpenSession = useCallback(async (session: SessionMetadata, project: Project) => {
    const sourceActiveTabId = activeTabIdRef.current;
    const interactionGeneration = resourceSurfaceInteractionGenerationRef.current;
    try {
      const opened = await onOpenSession(session, project);
      if (!opened) return;
      // A newly activated target already closes through the active-Tab
      // projection above. This success fallback covers same-Tab navigation,
      // where the authoritative active identity does not change. Correlate it
      // to the original interaction generation so an old ensure completion
      // cannot dismiss a flyout the user has since reopened.
      if (
        activeTabIdRef.current === sourceActiveTabId
        && resourceSurfaceInteractionGenerationRef.current === interactionGeneration
      ) {
        setSearchOpen(false);
        closeFlyout();
      }
      void touchProject(project.id).catch(() => {});
    } catch (error) {
      // Navigation rejection keeps the resource surface available for retry.
      console.error('[GlobalSidebar] Failed to open Session:', error);
    }
  }, [closeFlyout, onOpenSession, touchProject]);

  const handleConfirmDeleteSession = useCallback(async () => {
    if (!pendingDeleteSession) return;
    const target = pendingDeleteSession;
    setPendingDeleteSession(null);
    try {
      const result = await deleteSession(target.id);
      if (result.deleted) toastRef.current.success(tLauncher('rightRail.deleted'));
      else if (result.reason === 'in-use') toastRef.current.warning(tLauncher('rightRail.deleteBlockedByOwner'));
      else if (result.reason === 'transition-in-progress') toastRef.current.warning(tLauncher('rightRail.deleteTransitionInProgress'));
      else if (result.reason === 'activity-unavailable') toastRef.current.warning(tLauncher('rightRail.deleteActivityUnavailable'));
      else toastRef.current.error(tLauncher('rightRail.deleteFailedRetry'));
    } catch (error) {
      console.error('[GlobalSidebar] Failed to delete session:', error);
      toastRef.current.error(tLauncher('rightRail.deleteFailed'));
    } finally {
      restoreChildLayerFocus();
    }
  }, [deleteSession, pendingDeleteSession, restoreChildLayerFocus, tLauncher]);

  const handleToggleFavorite = useCallback(async (session: SessionMetadata) => {
    const success = await taskCenterData.actions.setSessionFavorite(session.id, !session.favorite);
    if (!success) toastRef.current.error(tLauncher('rightRail.favoriteFailedRetry'));
  }, [tLauncher, taskCenterData.actions]);

  const handleToggleSessionPin = useCallback(async (session: SessionMetadata) => {
    const mutationSequence = taskCenterData.actions.beginSessionMetadataMutation(session.id);
    try {
      const updated = await updateSession(session.id, { pinned: !session.pinnedAt });
      if (!updated) throw new Error('Session no longer exists.');
      taskCenterData.actions.applySessionMetadata(updated, mutationSequence);
    } catch (error) {
      console.error('[GlobalSidebar] Failed to update Session pinned state:', error);
      toastRef.current.error(tLauncher('rightRail.sessionPinFailedRetry'));
    }
  }, [tLauncher, taskCenterData.actions]);

  const handleCopySessionId = useCallback(async (session: SessionMetadata) => {
    try {
      await copyPlainText(`SessionID: ${session.id}`);
      toastRef.current.success(tLauncher('rightRail.copySessionIdSuccess'));
    } catch (error) {
      console.error('[GlobalSidebar] copy session id failed:', error);
      toastRef.current.error(tLauncher('rightRail.copyFailed'));
    }
  }, [tLauncher]);

  const handleSearchOpen = useCallback(() => {
    if (!isTauriEnvironment()) return;
    closeFlyout();
    closeNotificationCenter();
    setShowFeedback(false);
    resourceSurfaceInteractionGenerationRef.current += 1;
    setSearchOpen(true);
  }, [closeFlyout, closeNotificationCenter]);

  const handleSearchClose = useCallback(() => {
    resourceSurfaceInteractionGenerationRef.current += 1;
    setSearchOpen(false);
    if (historyTagIntent) onHistoryTagIntentConsumed?.(historyTagIntent.id);
  }, [historyTagIntent, onHistoryTagIntentConsumed]);

  useEffect(() => {
    if (!historyTagIntent || !isTauriEnvironment()) return;
    void loadHistorySearchOverlayContent();
    closeFlyout();
    closeNotificationCenter();
    setShowFeedback(false);
    resourceSurfaceInteractionGenerationRef.current += 1;
    setSearchOpen(true);
  }, [closeFlyout, closeNotificationCenter, historyTagIntent]);

  const activeView = activeTab?.view;
  const searchAvailable = isTauriEnvironment();
  const isWindows = typeof navigator !== 'undefined'
    && navigator.platform.toLowerCase().includes('win');
  const tree = (
    <WorkspaceTree
      fadeBottom={expanded}
      projects={activeProjects}
      archivedProjects={archivedProjects}
      projectsLoading={projectsLoading}
      projectsError={projectsError}
      taskCenterData={taskCenterData}
      tabs={tabs}
      activeTab={activeTab}
      activeWorkspacePath={activeWorkspacePath}
      expandedWorkspaceKeys={preference.expandedWorkspaceKeys}
      sessionLimits={sessionLimits}
      showAutomationSessions={preference.showAutomationSessions}
      sessionView={preference.sessionView}
      archivedExpanded={archivedExpanded}
      sessionNotificationBadgeCounts={sessionNotificationBadgeCounts}
      onToggleWorkspace={handleToggleWorkspace}
      onRetryProjects={() => { void refreshConfig(); }}
      onLoadMore={handleLoadMore}
      onToggleArchived={() => setArchivedExpanded((value) => !value)}
      onSetSessionView={(sessionView) => updatePreference((current) => ({ ...current, sessionView }))}
      onToggleAutomation={() => updatePreference((current) => ({
        ...current,
        showAutomationSessions: !current.showAutomationSessions,
      }))}
      onCreateAgent={handleOpenNewAgentPanel}
      recentlyCreatedWorkspaceKey={recentlyCreatedWorkspaceKey}
      onOpenWorkspace={handleOpenWorkspace}
      onOpenSession={handleOpenSession}
      onTogglePin={handleTogglePin}
      onAgentSettings={(project, origin) => {
        rememberChildLayerOrigin(origin);
        setAgentWorkspacePath(project.path);
      }}
      onArchive={handleArchive}
      onUnarchive={handleUnarchive}
      onOpenFolder={handleOpenFolder}
      onRemove={(project, origin) => {
        rememberChildLayerOrigin(origin);
        setProjectToRemove(project);
      }}
      onToggleFavorite={handleToggleFavorite}
      onToggleSessionPin={(session) => { void handleToggleSessionPin(session); }}
      onRenameSession={onRenameSession}
      onCopySessionId={(session) => { void handleCopySessionId(session); }}
      onShowStats={(session, origin) => {
        rememberChildLayerOrigin(origin);
        setStatsSession(session);
      }}
      onDeleteSession={(session, origin) => {
        rememberChildLayerOrigin(origin);
        setPendingDeleteSession(session);
      }}
      onNestedInteractionChange={handleNestedInteractionChange}
    />
  );

  return (
    <>
      <aside
        aria-label={t('globalSidebar.navigation')}
        data-global-sidebar-mode={effectiveMode}
        data-global-sidebar-motion={sidebarMotion ?? undefined}
        data-global-sidebar-titlebar-follow={isWindows ? 'full' : 'toggle-slot'}
        data-global-sidebar-toggle-visible={forceRail ? 'false' : 'true'}
        data-global-sidebar-tabbar-toggle={!isWindows && !forceRail && !expanded ? 'true' : 'false'}
        className={`global-sidebar relative z-40 flex h-screen shrink-0 flex-col [--global-sidebar-surface:var(--global-sidebar-bg)] text-[var(--ink)] ${
          expanded ? 'w-[var(--global-sidebar-expanded-width)]' : 'w-[var(--global-sidebar-rail-width)]'
        }`}
      >
        <div className="custom-titlebar relative h-11 shrink-0" data-tauri-drag-region>
          {!forceRail && (
            <div
              className={`absolute top-1.5 ${
                isWindows ? 'left-3' : 'left-[var(--global-sidebar-toggle-left)]'
              }`}
            >
              <Tip label={expanded ? t('globalSidebar.collapse') : t('globalSidebar.expand')} position="bottom">
                <button
                  type="button"
                  onClick={handleToggleMode}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  aria-label={expanded ? t('globalSidebar.collapse') : t('globalSidebar.expand')}
                  data-global-sidebar-toggle
                  data-no-drag
                >
                  <SidebarIcon className="h-4 w-4" data-global-sidebar-toggle-icon />
                </button>
              </Tip>
            </div>
          )}
        </div>

        <div
          className="global-sidebar-brand-row relative flex h-10 shrink-0 items-center"
          data-global-sidebar-brand-row
        >
          <button
            type="button"
            onClick={() => { void openExternal(APP_WEBSITE_URL); }}
            aria-label={t('globalSidebar.openWebsite')}
            aria-hidden={!expanded && searchAvailable}
            inert={!expanded && searchAvailable}
            className={`global-sidebar-brand-link flex h-8 items-center pr-1 text-left cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
              expanded ? 'min-w-0' : 'w-10 overflow-hidden'
            }`}
            data-global-sidebar-brand-link
          >
            <img
              src={APP_ICON_SRC}
              alt=""
              aria-hidden="true"
              className="global-sidebar-brand-icon shrink-0"
              data-global-sidebar-brand-icon
            />
            <span
              className="theme-product-wordmark global-sidebar-copy min-w-0 truncate text-sm font-medium"
              aria-hidden={!expanded}
              data-global-sidebar-brand-name
            >
              <MyAgentsLogotype variant="compact" className="global-sidebar-brand-logotype" title={APP_DISPLAY_NAME} />
            </span>
          </button>
          {searchAvailable && (
            <Tip label={t('globalSidebar.search')} position="right" disabled={searchOpen} className="global-sidebar-search-slot">
              <button
                type="button"
                onPointerEnter={() => { void loadHistorySearchOverlayContent(); }}
                onFocus={() => { void loadHistorySearchOverlayContent(); }}
                onClick={handleSearchOpen}
                aria-label={t('globalSidebar.search')}
                aria-haspopup="dialog"
                aria-expanded={searchOpen}
                className={`global-sidebar-row global-sidebar-action-button flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                  searchOpen
                    ? 'bg-[var(--paper-inset)] text-[var(--ink)]'
                    : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
                }`}
                data-global-sidebar-search-trigger
              >
                <SearchIcon className="h-4 w-4" />
              </button>
            </Tip>
          )}
        </div>

        <nav
          className={`shrink-0 ${expanded ? 'px-3 pb-1 pt-0' : 'global-sidebar-rail-stack pb-1 pt-0'}`}
          data-global-sidebar-primary-nav
        >
          <SidebarNavButton
            expanded={expanded}
            icon={<ComposeIcon className="h-4 w-4" />}
            label={t('globalSidebar.newChat')}
            onClick={onNewTab}
          />
          <div className="group/task-create relative">
            <SidebarNavButton
              expanded={expanded}
              active={activeView === 'taskcenter'}
              icon={<TasksIcon className="h-4 w-4" />}
              label={t('globalSidebar.tasks')}
              onClick={handleOpenTaskCenter}
            />
            {expanded && (
              <span className="absolute right-1 top-1">
                <Tip
                  label={t('globalSidebar.createTask')}
                  position="right"
                >
                  <button
                    type="button"
                    onClick={event => {
                      event.stopPropagation();
                      onCreateTask();
                    }}
                    aria-label={t('globalSidebar.createTask')}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--ink-muted)] opacity-0 transition-[opacity,color,background-color] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] group-hover/task-create:opacity-100 group-focus-within/task-create:opacity-100"
                  >
                    <PlusIcon className="h-3.5 w-3.5" />
                  </button>
                </Tip>
              </span>
            )}
          </div>

          <SidebarNavButton
            expanded={expanded}
            active={activeView === 'capabilities'}
            icon={<CapabilitiesIcon className="h-4 w-4" />}
            label={t('globalSidebar.capabilities')}
            onClick={() => onOpenCapabilities()}
          />
          <SidebarNavButton
            expanded={expanded}
            active={activeView === 'agentnetwork'}
            disabled={!onOpenAgentNetwork}
            icon={<RadioIcon className="h-4 w-4" />}
            label={t('globalSidebar.agentNetwork')}
            onClick={() => onOpenAgentNetwork?.()}
          />
          {teamSpaceAvailable && (
            <SidebarMore key={activeView ?? 'launcher'} expanded={expanded} activeView={activeView} onTeam={onOpenSpace} />
          )}
        </nav>

        <div className="relative min-h-0 flex-1" data-global-sidebar-workspace-shell>
          {expandedWorkspaceMounted && (
            <div
              className="absolute inset-y-0 left-0 w-[var(--global-sidebar-expanded-width)]"
              aria-hidden={!expanded}
              inert={!expanded}
              data-global-sidebar-workspace-region
            >
              {tree}
            </div>
          )}
          {!expanded && (
            <div
              className="global-sidebar-rail-stack absolute inset-0 min-h-0 pt-3"
              data-global-sidebar-workspace-rail
              onKeyDown={(event) => {
                if (isImeComposingEvent(event)) return;
                if (!flyoutOpen) return;
                if (event.key === 'Tab' && !event.shiftKey) {
                  const entry = flyoutRef.current?.querySelector<HTMLElement>(FLYOUT_FOCUS_ENTRY_SELECTOR);
                  if (!entry) return;
                  event.preventDefault();
                  entry.focus();
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  closeFlyout(true);
                }
              }}
            >
              <div
                onPointerEnter={handleFlyoutTriggerPointerEnter}
                onPointerLeave={handleFlyoutTriggerPointerLeave}
                onFocusCapture={handleFlyoutTriggerFocus}
                onBlurCapture={scheduleFlyoutClose}
              >
                <button
                  ref={flyoutTriggerRef}
                  type="button"
                  onClick={openFlyoutNow}
                  aria-label={t('globalSidebar.workspaces')}
                  aria-expanded={flyoutOpen}
                  className={`global-sidebar-row flex h-9 w-10 items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                    activeWorkspacePath
                      ? 'bg-[var(--paper-inset)] text-[var(--ink)]'
                      : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
                  }`}
                >
                  <FolderIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
          {expanded && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6"
              style={{
                background: 'linear-gradient(to bottom, var(--global-sidebar-bg-a0), var(--global-sidebar-bg))',
              }}
              data-global-sidebar-workspace-fade
            />
          )}
        </div>

        <div
          className={`shrink-0 pb-2 ${expanded ? 'pl-3 pr-[var(--global-sidebar-action-inset)] pt-0' : 'global-sidebar-rail-stack pt-3'}`}
          data-global-sidebar-footer-actions
        >
          <div
            ref={feedbackTriggerRef}
            className={`-mr-3 pr-3 ${expanded ? '' : 'flex justify-center'}`}
            data-feedback-popover-anchor
          >
            <SidebarNavButton
              expanded={expanded}
              icon={<HelperIcon className="h-4 w-4" />}
              label={t('globalSidebar.helper')}
              tooltipDisabled={showFeedback}
              onClick={toggleFeedback}
            />
            <FeedbackPopover
              open={showFeedback}
              onClose={() => setShowFeedback(false)}
              onOpenBugReport={() => { setShowFeedback(false); onOpenBugReport(); }}
              triggerRef={feedbackTriggerRef}
            />
          </div>
          <SidebarNavButton
            expanded={expanded}
            active={activeView === 'settings'}
            icon={<SettingsIcon className="h-4 w-4" />}
            label={t('globalSidebar.settings')}
            onClick={onOpenSettings}
          />
          <div className="global-sidebar-account-row grid grid-cols-[minmax(0,1fr)_var(--global-sidebar-action-size)]" data-global-sidebar-account-row>
            <AccountEntry expanded={expanded} available={teamSpaceAvailable}
              environment={config.spaceEnvironment ?? 'production'} onOpenSpace={onOpenSpace} />
            <span className="global-sidebar-notification-slot">
              <button
                ref={notificationTriggerRef}
                type="button"
                onClick={toggleNotificationCenter}
                aria-label={notificationCenter.snapshot.hasUnread
                  ? t('notificationCenter.bellUnread')
                  : t('notificationCenter.bell')}
                aria-haspopup="dialog"
                aria-expanded={notificationOpen}
                aria-controls="global-notification-center"
                className={`global-sidebar-row global-sidebar-action-button relative flex items-center justify-center text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                  notificationOpen
                    ? 'bg-[var(--paper-inset)] text-[var(--ink)]'
                    : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
                }`}
                data-notification-center-trigger
              >
                <span className="relative flex h-4 w-4 items-center justify-center">
                  <BellIcon className="h-4 w-4" />
                  {notificationCenter.snapshot.hasUnread && (
                    <span
                      className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-[var(--accent-warm)] ring-2 ring-[var(--global-sidebar-bg)]"
                      aria-hidden="true"
                    />
                  )}
                </span>
              </button>
            </span>
          </div>
        </div>
      </aside>

      {!expanded && flyoutOpen && (
        <div
          ref={flyoutRef}
          className={`fixed bottom-28 left-[calc(var(--global-sidebar-rail-width)+var(--space-2))] top-32 z-[240] w-[var(--global-sidebar-flyout-width)] [--global-sidebar-surface:var(--paper-elevated)] ${APP_SHELL_POPOVER_CHROME}`}
          data-global-sidebar-flyout
          onPointerEnter={handleFlyoutPointerEnter}
          onPointerLeave={handleFlyoutPointerLeave}
          onFocusCapture={clearFlyoutTimers}
          onBlurCapture={scheduleFlyoutClose}
          onKeyDown={(event) => {
            if (isImeComposingEvent(event)) return;
            if (event.key === 'Tab' && event.shiftKey) {
              const entry = flyoutRef.current?.querySelector<HTMLElement>(FLYOUT_FOCUS_ENTRY_SELECTOR);
              if (event.target !== entry || !flyoutTriggerRef.current) return;
              event.preventDefault();
              flyoutTriggerRef.current.focus();
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              closeFlyout(true);
            }
          }}
        >
          {tree}
        </div>
      )}

      {notificationOpen && createPortal(
        <div
          ref={notificationPanelRef}
          id="global-notification-center"
          role="dialog"
          aria-label={t('notificationCenter.title')}
          aria-modal="false"
          className={`fixed z-[245] ${APP_SHELL_POPOVER_CHROME}`}
          style={{
            left: expanded
              ? 'calc(var(--global-sidebar-expanded-width) + var(--space-2))'
              : 'calc(var(--global-sidebar-rail-width) + var(--space-2))',
            bottom: 'var(--space-5)',
            width: 'min(380px, calc(100vw - var(--global-sidebar-rail-width) - var(--space-5)))',
              height: 'min(440px, calc(100vh - var(--space-8)))',
          }}
          data-notification-center-shell
        >
          <NotificationCenterFlyout
            snapshot={notificationCenter.snapshot}
            onRefresh={notificationCenter.refresh}
            onLoadMore={notificationCenter.loadMore}
            onMarkAllRead={notificationCenter.markAllRead}
            onOpenAppRoute={onOpenAppRoute ?? (() => false)}
            onClose={() => closeNotificationCenter()}
          />
        </div>,
        document.body,
      )}

      {newAgentPanelOpen && (
        <NewAgentPanel
          onClose={() => {
            onNewAgentPanelOpenChange(false);
            // Launcher-opened panels never registered an origin; only restore ours.
            if (childLayerReturnFocusRef.current) restoreChildLayerFocus();
          }}
          onCreated={handleNewAgentCreated}
        />
      )}

      {projectToRemove && (
        <ConfirmDialog
          title={isSystemPresetProject(projectToRemove)
            ? tLauncher('dialogs.hideDefaultWorkspace')
            : tLauncher('dialogs.removeWorkspace')}
          message={isSystemPresetProject(projectToRemove)
            ? tLauncher('dialogs.hideWorkspaceMessage', { name: projectToRemove.displayName || projectToRemove.name })
            : tLauncher('dialogs.removeWorkspaceMessage', { name: projectToRemove.name })}
          confirmText={isSystemPresetProject(projectToRemove) ? tLauncher('dialogs.hide') : tLauncher('dialogs.remove')}
          confirmVariant="danger"
          onConfirm={handleConfirmRemoveProject}
          onCancel={() => {
            setProjectToRemove(null);
            restoreChildLayerFocus();
          }}
        />
      )}

      {pendingDeleteSession && (
        <ConfirmDialog
          title={tLauncher('rightRail.deleteDialogTitle')}
          message={tLauncher('rightRail.deleteDialogMessage', { title: getSessionDisplayText(pendingDeleteSession) })}
          confirmText={tLauncher('rightRail.delete')}
          confirmVariant="danger"
          onConfirm={handleConfirmDeleteSession}
          onCancel={() => {
            setPendingDeleteSession(null);
            restoreChildLayerFocus();
          }}
        />
      )}

      {statsSession && (
        <SessionStatsModal
          sessionId={statsSession.id}
          sessionTitle={getSessionDisplayText(statsSession)}
          onClose={() => {
            setStatsSession(null);
            restoreChildLayerFocus();
          }}
        />
      )}

      {agentWorkspacePath && (
        <Suspense fallback={null}>
          <WorkspaceConfigPanel
            agentDir={agentWorkspacePath}
            initialTab="agent"
            onClose={() => {
              setAgentWorkspacePath(null);
              restoreChildLayerFocus();
            }}
            onRequestInit={() => {
              const project = activeProjects.find((candidate) => workspacePathsEqual(candidate.path, agentWorkspacePath));
              setAgentWorkspacePath(null);
              childLayerReturnFocusRef.current = null;
              if (project) void handleOpenWorkspace(project, { text: '/init' }, 'workspace_init');
            }}
          />
        </Suspense>
      )}

      {searchOpen && (
        <HistorySearchOverlayFrame onClose={handleSearchClose}>
          <Suspense fallback={<HistorySearchOverlayFallback onClose={handleSearchClose} />}>
            <HistorySearchOverlayContent
              projects={activeProjects}
              taskCenterData={taskCenterData}
              onClose={handleSearchClose}
              onOpenSession={(session, project) => { void handleOpenSession(session, project); }}
              onRenameSession={onRenameSession}
              tagIntent={historyTagIntent}
              onTagIntentConsumed={onHistoryTagIntentConsumed}
            />
          </Suspense>
        </HistorySearchOverlayFrame>
      )}
    </>
  );
});

interface WorkspaceTreeProps {
  fadeBottom: boolean;
  projects: Project[];
  archivedProjects: Project[];
  projectsLoading: boolean;
  projectsError: string | null;
  taskCenterData: TaskCenterData;
  tabs: readonly Tab[];
  activeTab: Tab | undefined;
  activeWorkspacePath: string | null;
  expandedWorkspaceKeys: string[];
  sessionLimits: Record<string, number>;
  showAutomationSessions: boolean;
  sessionView: 'all' | 'favorites';
  archivedExpanded: boolean;
  sessionNotificationBadgeCounts?: ReadonlyMap<string, number>;
  onToggleWorkspace: (project: Project) => void;
  onRetryProjects: () => void;
  onLoadMore: (project: Project, total: number) => void;
  onToggleArchived: () => void;
  onSetSessionView: (view: 'all' | 'favorites') => void;
  onToggleAutomation: () => void;
  onCreateAgent: (origin?: HTMLElement | null) => void;
  recentlyCreatedWorkspaceKey: string | null;
  onOpenWorkspace: (project: Project) => void;
  onOpenSession: (session: SessionMetadata, project: Project) => void;
  onTogglePin: (project: Project) => void;
  onAgentSettings: (project: Project, origin?: HTMLElement | null) => void;
  onArchive: (project: Project) => void;
  onUnarchive: (project: Project) => void;
  onOpenFolder: (project: Project) => void;
  onRemove: (project: Project, origin?: HTMLElement | null) => void;
  onToggleFavorite: (session: SessionMetadata) => void;
  onToggleSessionPin: (session: SessionMetadata) => void;
  onRenameSession: (sessionId: string, title: string) => Promise<SessionMetadata | null>;
  onCopySessionId: (session: SessionMetadata) => void;
  onShowStats: (session: SessionMetadata, origin?: HTMLElement | null) => void;
  onDeleteSession: (session: SessionMetadata, origin?: HTMLElement | null) => void;
  onNestedInteractionChange: (key: string, open: boolean) => void;
}

function WorkspaceSessionBranch({
  expanded,
  children,
}: {
  expanded: boolean;
  children: ReactNode;
}) {
  const [rendered, setRendered] = useState(expanded);
  const [revealReady, setRevealReady] = useState(expanded);
  const branchRef = useRef<HTMLDivElement | null>(null);
  const visuallyExpanded = expanded && revealReady;

  // Keep the Session subtree mounted only for the closing transition. Opening
  // mounts content first, then reveals it on the next animation frame so CSS
  // receives a real 0fr → 1fr pair to interpolate. All state changes happen
  // in scheduled callbacks, keeping the effect itself free of cascading state.
  useEffect(() => {
    let revealFrame: number | undefined;
    if (expanded) {
      const mountTimer = window.setTimeout(() => {
        setRendered(true);
        revealFrame = window.requestAnimationFrame(() => {
          // Establish the mounted 0fr layout before switching to 1fr. This
          // one-shot read prevents React/browser batching from coalescing both
          // states into one paint and silently dropping the transition.
          branchRef.current?.getBoundingClientRect();
          setRevealReady(true);
        });
      }, 0);
      return () => {
        window.clearTimeout(mountTimer);
        if (revealFrame !== undefined) window.cancelAnimationFrame(revealFrame);
      };
    }
    const timeout = window.setTimeout(() => {
      setRendered(false);
      setRevealReady(false);
    }, WORKSPACE_BRANCH_TRANSITION_MS);
    return () => window.clearTimeout(timeout);
  }, [expanded]);

  return (
    <div
      ref={branchRef}
      role="group"
      aria-hidden={!expanded}
      inert={!expanded}
      data-global-sidebar-workspace-branch
      data-state={visuallyExpanded ? 'open' : 'closed'}
      className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
        visuallyExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
      }`}
    >
      <div
        className={`min-h-0 overflow-hidden transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none ${
          visuallyExpanded ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0'
        }`}
      >
        {rendered && (
          <div className="ml-6 border-l border-[var(--line-subtle)] pl-1.5">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

function WorkspaceTree({
  fadeBottom,
  projects,
  archivedProjects,
  projectsLoading,
  projectsError,
  taskCenterData,
  tabs,
  activeTab,
  activeWorkspacePath,
  expandedWorkspaceKeys,
  sessionLimits,
  showAutomationSessions,
  sessionView,
  archivedExpanded,
  sessionNotificationBadgeCounts,
  onToggleWorkspace,
  onRetryProjects,
  onLoadMore,
  onToggleArchived,
  onSetSessionView,
  onToggleAutomation,
  onCreateAgent,
  recentlyCreatedWorkspaceKey,
  onOpenWorkspace,
  onOpenSession,
  onTogglePin,
  onAgentSettings,
  onArchive,
  onUnarchive,
  onOpenFolder,
  onRemove,
  onToggleFavorite,
  onToggleSessionPin,
  onRenameSession,
  onCopySessionId,
  onShowStats,
  onDeleteSession,
  onNestedInteractionChange,
}: WorkspaceTreeProps) {
  const { t } = useTranslation('app');
  const { t: tLauncher } = useTranslation('launcher');
  const expandedSet = useMemo(() => new Set(expandedWorkspaceKeys), [expandedWorkspaceKeys]);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const viewMenuRef = useRef<HTMLButtonElement | null>(null);
  const workspaceRefs = useRef(new Map<string, HTMLDivElement>());

  const sessionsByWorkspace = useMemo(() => {
    const map = new Map<string, SessionMetadata[]>();
    for (const session of taskCenterData.sessions) {
      if (!showAutomationSessions && isAutomationHistoryOrigin(session.origin, {
        cronTaskId: session.cronTaskId,
        source: session.source,
      })) continue;
      if (sessionView === 'favorites' && !session.favorite) continue;
      const key = normalizeWorkspacePathIdentity(session.agentDir);
      const list = map.get(key) ?? [];
      list.push(session);
      map.set(key, list);
    }
    for (const [key, list] of map) {
      map.set(key, sortWorkspaceSessions(list));
    }
    return map;
  }, [sessionView, showAutomationSessions, taskCenterData.sessions]);

  const tabBySession = useMemo(() => {
    const map = new Map<string, Tab>();
    for (const tab of tabs) {
      if (tab.view === 'chat' && tab.sessionId) {
        map.set(tab.sessionId, tab);
      }
    }
    return map;
  }, [tabs]);

  const activeWorkspaceKey = activeWorkspacePath
    ? normalizeWorkspacePathIdentity(activeWorkspacePath)
    : null;
  const activeSessionId = activeTab?.view === 'chat' ? activeTab.sessionId : null;

  useEffect(() => {
    if (!activeWorkspaceKey) return;
    const workspaceNode = workspaceRefs.current.get(activeWorkspaceKey);
    if (typeof workspaceNode?.scrollIntoView === 'function') {
      workspaceNode.scrollIntoView({ block: 'nearest' });
    }
  }, [activeWorkspaceKey]);

  useEffect(() => {
    if (!recentlyCreatedWorkspaceKey) return;
    const workspaceNode = workspaceRefs.current.get(recentlyCreatedWorkspaceKey);
    if (typeof workspaceNode?.scrollIntoView === 'function') {
      workspaceNode.scrollIntoView({ block: 'nearest' });
    }
  }, [recentlyCreatedWorkspaceKey]);

  const setViewMenu = useCallback((open: boolean) => {
    setViewMenuOpen(open);
    onNestedInteractionChange('view-options', open);
  }, [onNestedInteractionChange]);
  useNestedInteractionCleanup((open) => onNestedInteractionChange('view-options', open));

  return (
    <section className="relative flex h-full min-h-0 flex-col" aria-label={t('globalSidebar.workspaces')}>
      <div className="flex h-8 shrink-0 items-center gap-1 pl-6 pr-[var(--global-sidebar-action-inset)]">
        <h2 className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
          {t('globalSidebar.workspaceSection')}
        </h2>
        <Tip label={tLauncher('workspaceCard.more')} position="bottom" align="end" disabled={viewMenuOpen}>
          <button
            ref={viewMenuRef}
            type="button"
            onClick={() => setViewMenu(!viewMenuOpen)}
            className="global-sidebar-action-button flex items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            aria-label={t('globalSidebar.workspaceViewOptions')}
          >
            <MoreIcon className="h-4 w-4" />
          </button>
        </Tip>
        <Popover
          open={viewMenuOpen}
          onClose={() => setViewMenu(false)}
          anchorRef={viewMenuRef}
          placement="bottom-end"
          className="global-sidebar-nested-layer w-56 py-1"
        >
          <MenuItem
            icon={sessionView === 'all' ? <CheckIcon className="h-3.5 w-3.5" /> : <GridIcon className="h-3.5 w-3.5" />}
            label={t('globalSidebar.allSessions')}
            active={sessionView === 'all'}
            onClick={() => { onSetSessionView('all'); setViewMenu(false); }}
          />
          <MenuItem
            icon={sessionView === 'favorites' ? <CheckIcon className="h-3.5 w-3.5" /> : <StarIcon className="h-3.5 w-3.5" />}
            label={t('globalSidebar.favoriteSessions')}
            active={sessionView === 'favorites'}
            onClick={() => { onSetSessionView('favorites'); setViewMenu(false); }}
          />
          <MenuItem
            icon={showAutomationSessions ? <EyeIcon className="h-3.5 w-3.5" /> : <EyeOffIcon className="h-3.5 w-3.5" />}
            label={showAutomationSessions
              ? t('globalSidebar.hideAutomationHistory')
              : t('globalSidebar.showAutomationHistory')}
            onClick={() => { onToggleAutomation(); setViewMenu(false); }}
          />
        </Popover>
        <Tip label={tLauncher('newAgentPanel.title')} position="bottom" align="end">
          <button
            type="button"
            onClick={(event) => onCreateAgent(event.currentTarget)}
            className="global-sidebar-action-button flex items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            aria-label={tLauncher('newAgentPanel.title')}
          >
            <PlusIcon className="h-3.5 w-3.5" />
          </button>
        </Tip>
      </div>

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-8 z-10 h-2"
        style={{
          background: 'linear-gradient(to bottom, var(--global-sidebar-bg), var(--global-sidebar-bg-a0))',
        }}
        data-global-sidebar-workspace-fade-top
      />

      <div
        className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-2 ${fadeBottom ? 'pb-6' : 'pb-3'}`}
        role="tree"
        style={{ scrollbarGutter: 'stable' }}
      >
        {projectsLoading ? (
          <div className="space-y-2 px-1 py-2" aria-label={t('common.loading')}>
            {[0, 1, 2].map((item) => (
              <div key={item} className="h-8 animate-pulse rounded-lg bg-[var(--paper-inset)]/70 motion-reduce:animate-none" />
            ))}
          </div>
        ) : projectsError ? (
          <div className="mx-1 my-2 rounded-lg border border-dashed border-[var(--line)] px-3 py-3">
            <div className="flex items-center gap-2 text-xs text-[var(--warning)]">
              <AlertIcon className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{projectsError}</span>
              <button
                type="button"
                onClick={onRetryProjects}
                className="rounded-md p-1 hover:bg-[var(--paper-inset)]"
                aria-label={tLauncher('rightRail.retry')}
              >
                <RefreshIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ) : projects.length === 0 && archivedProjects.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <p className="text-sm font-medium text-[var(--ink)]">{tLauncher('rightRail.emptyWorkspaceTitle')}</p>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">{tLauncher('rightRail.emptyWorkspaceDescription')}</p>
            <button
              type="button"
              onClick={(event) => onCreateAgent(event.currentTarget)}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-3 py-2 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              <span className="global-sidebar-label">{tLauncher('rightRail.addFolder')}</span>
            </button>
          </div>
        ) : (
          <div data-global-sidebar-workspace-list>
            {projects.map((project, index) => {
              const key = normalizeWorkspacePathIdentity(project.path);
              const sessions = sessionsByWorkspace.get(key) ?? [];
              const limit = sessionLimits[key] ?? SESSION_PAGE_SIZE;
              const workspaceSessionState = taskCenterData.workspaceSessionStates.get(key);
              const isActiveWorkspaceContext = activeWorkspaceKey === key;
              return (
                <div
                  key={project.id}
                  ref={(node) => {
                    if (node) workspaceRefs.current.set(key, node);
                    else workspaceRefs.current.delete(key);
                  }}
                >
                  <WorkspaceRow
                    project={project}
                    expanded={expandedSet.has(key)}
                    active={isActiveWorkspaceContext && !activeSessionId}
                    recentlyCreated={recentlyCreatedWorkspaceKey === key}
                    actionTipPosition={index === 0 ? 'bottom' : 'top'}
                    onToggle={() => onToggleWorkspace(project)}
                    onOpenWorkspace={() => onOpenWorkspace(project)}
                    onTogglePin={() => onTogglePin(project)}
                    onAgentSettings={(origin) => onAgentSettings(project, origin)}
                    onArchive={() => onArchive(project)}
                    onOpenFolder={() => onOpenFolder(project)}
                    onRemove={(origin) => onRemove(project, origin)}
                    onMenuOpenChange={(open) => onNestedInteractionChange(`workspace:${project.id}`, open)}
                  />
                  <WorkspaceSessionBranch expanded={expandedSet.has(key)}>
                      {workspaceSessionState?.isLoading && sessions.length === 0 ? (
                        <div className="space-y-1 py-1" data-global-sidebar-session-placeholder>
                          {[0, 1, 2].map((item) => (
                            <div key={item} className="h-8" aria-hidden="true" />
                          ))}
                        </div>
                      ) : (
                        <>
                          {workspaceSessionState?.error && (
                            <div className="my-1 rounded-lg border border-dashed border-[var(--line)] px-3 py-2">
                              <div className="flex items-center gap-2 text-xs text-[var(--warning)]">
                                <AlertIcon className="h-3.5 w-3.5" />
                                <span className="min-w-0 flex-1 truncate">{workspaceSessionState.error}</span>
                                <button
                                  type="button"
                                  onClick={() => ensureWorkspaceSessions([project.path], true)}
                                  className="rounded-md p-1 hover:bg-[var(--paper-inset)]"
                                  aria-label={tLauncher('rightRail.retry')}
                                >
                                  <RefreshIcon className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          )}
                          {sessions.length === 0 && !workspaceSessionState?.error ? (
                            <p className="px-3 py-2 text-xs text-[var(--ink-muted)]/70">
                              {sessionView === 'favorites'
                                ? tLauncher('rightRail.emptyFavorites')
                                : t('globalSidebar.emptyWorkspaceSessions')}
                            </p>
                          ) : sessions.slice(0, limit).map((session) => (
                            <SessionRow
                              key={session.id}
                              session={session}
                              project={project}
                              tab={tabBySession.get(session.id)}
                              active={activeTab?.view === 'chat' && activeTab.sessionId === session.id}
                              tags={taskCenterData.sessionTagsMap.get(session.id) ?? EMPTY_TAGS}
                              unreadNotificationCount={sessionNotificationBadgeCounts?.get(session.id) ?? 0}
                              deleteProtected={taskCenterData.deleteProtectedSessionIds.has(session.id)}
                              onOpen={() => onOpenSession(session, project)}
                              onToggleFavorite={() => onToggleFavorite(session)}
                              onTogglePin={() => onToggleSessionPin(session)}
                              onRenameSession={onRenameSession}
                              onCopySessionId={() => onCopySessionId(session)}
                              onShowStats={(origin) => onShowStats(session, origin)}
                              onDelete={(origin) => onDeleteSession(session, origin)}
                              onSessionMutationStart={taskCenterData.actions.beginSessionMetadataMutation}
                              onSessionUpdated={taskCenterData.actions.applySessionMetadata}
                              onGlobalTagChange={taskCenterData.actions.refreshSessions}
                              onMenuOpenChange={(open) => onNestedInteractionChange(`session:${session.id}`, open)}
                            />
                          ))}
                          {limit < sessions.length && (
                            <button
                              type="button"
                              onClick={() => onLoadMore(project, sessions.length)}
                              className="flex h-8 w-full items-center gap-2 rounded-lg pl-3 pr-3 text-xs font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                            >
                              <ChevronDownIcon className="h-3.5 w-3.5" />
                              {t('globalSidebar.loadMore')}
                            </button>
                          )}
                        </>
                      )}
                  </WorkspaceSessionBranch>
                </div>
              );
            })}

            {archivedProjects.length > 0 && (
              <div className="pt-2">
                <button
                  type="button"
                  onClick={onToggleArchived}
                  aria-expanded={archivedExpanded}
                  className="group/disclosure flex h-8 w-full items-center gap-3 rounded-lg pl-4 pr-3 text-sm text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                  data-global-sidebar-archived-toggle
                >
                  <SidebarDisclosureSlot expanded={archivedExpanded} group="archived">
                    <ArchiveIcon className="h-4 w-4" />
                  </SidebarDisclosureSlot>
                  <span className="global-sidebar-label min-w-0 flex-1 truncate text-left">{t('globalSidebar.archived')}</span>
                  <span className="text-xs tabular-nums text-[var(--ink-subtle)]">{archivedProjects.length}</span>
                </button>
                {archivedExpanded && (
                  <div className="ml-6 border-l border-[var(--line-subtle)] pl-1.5">
                    {archivedProjects.map((project) => (
                      <ArchivedWorkspaceRow
                        key={project.id}
                        project={project}
                        onUnarchive={() => onUnarchive(project)}
                        onAgentSettings={(origin) => onAgentSettings(project, origin)}
                        onOpenFolder={() => onOpenFolder(project)}
                        onRemove={(origin) => onRemove(project, origin)}
                        onMenuOpenChange={(open) => onNestedInteractionChange(`archived:${project.id}`, open)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

interface WorkspaceRowProps {
  project: Project;
  expanded: boolean;
  active: boolean;
  recentlyCreated: boolean;
  actionTipPosition: 'top' | 'bottom';
  onToggle: () => void;
  onOpenWorkspace: () => void;
  onTogglePin: () => void;
  onAgentSettings: (origin?: HTMLElement | null) => void;
  onArchive: () => void;
  onOpenFolder: () => void;
  onRemove: (origin?: HTMLElement | null) => void;
  onMenuOpenChange: (open: boolean) => void;
}

function WorkspaceRow({
  project,
  expanded,
  active,
  recentlyCreated,
  actionTipPosition,
  onToggle,
  onOpenWorkspace,
  onTogglePin,
  onAgentSettings,
  onArchive,
  onOpenFolder,
  onRemove,
  onMenuOpenChange,
}: WorkspaceRowProps) {
  const { t } = useTranslation('app');
  const { t: tLauncher } = useTranslation('launcher');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const displayName = project.displayName || project.name;

  const setMenu = useCallback((open: boolean) => {
    setMenuOpen(open);
    onMenuOpenChange(open);
  }, [onMenuOpenChange]);
  useNestedInteractionCleanup(onMenuOpenChange);

  return (
    <div
      role="treeitem"
      aria-expanded={expanded}
      aria-current={active ? 'page' : undefined}
      className="global-sidebar-row global-sidebar-resource-row group/workspace relative flex h-8 select-none items-center transition-colors"
      data-menu-open={menuOpen || undefined}
      data-recently-created={recentlyCreated || undefined}
      data-global-sidebar-workspace-row
      onMouseDown={(event) => {
        if (event.button === 2) {
          event.preventDefault();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        menuRef.current?.focus();
        setMenu(true);
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="group/disclosure flex h-full min-w-0 flex-1 items-center gap-3 pl-4 pr-2 text-left text-sm text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
      >
        <SidebarDisclosureSlot expanded={expanded} group="workspace">
          <WorkspaceIcon icon={project.icon} size={16} />
        </SidebarDisclosureSlot>
        <span
          className="global-sidebar-label min-w-0 flex-1 truncate font-medium"
          data-global-sidebar-workspace-title
        >
          {displayName}
        </span>
      </button>
      {/* Overlay the hover actions instead of reserving row width. The opaque
          end of the Theme-aware gradient hides any title underneath; its
          transparent lead-in avoids a hard vertical seam. The scroll owner
          supplies 8px, and the local right padding keeps controls outside
          Fluent's 16px overlay hit region. */}
      <div
        className={`global-sidebar-workspace-actions pointer-events-none absolute inset-y-0 right-0 flex items-center gap-1 pl-6 transition-opacity ${menuOpen ? 'opacity-100' : 'opacity-0 group-hover/workspace:opacity-100 group-focus-within/workspace:opacity-100'}`}
        data-global-sidebar-workspace-actions
      >
        <Tip label={tLauncher('workspaceCard.more')} position={actionTipPosition} align="end" disabled={menuOpen}>
          <button
            ref={menuRef}
            type="button"
            onClick={() => setMenu(!menuOpen)}
            className={`global-sidebar-action-button flex items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] ${menuOpen ? 'pointer-events-auto' : 'pointer-events-none group-hover/workspace:pointer-events-auto group-focus-within/workspace:pointer-events-auto'}`}
            aria-label={tLauncher('workspaceCard.more')}
          >
            <MoreIcon className="h-3.5 w-3.5" />
          </button>
        </Tip>
        <Tip label={t('globalSidebar.newChat')} position={actionTipPosition} align="end">
          <button
            type="button"
            onClick={onOpenWorkspace}
            className={`global-sidebar-action-button flex items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] ${menuOpen ? 'pointer-events-auto' : 'pointer-events-none group-hover/workspace:pointer-events-auto group-focus-within/workspace:pointer-events-auto'}`}
            aria-label={t('globalSidebar.newChatHere')}
          >
            <ComposeIcon className="h-3.5 w-3.5" />
          </button>
        </Tip>
      </div>
      <Popover
        open={menuOpen}
        onClose={() => {
          setMenu(false);
          menuRef.current?.focus();
        }}
        anchorRef={menuRef}
        placement="bottom-end"
        className="global-sidebar-nested-layer w-44 py-1"
      >
        <MenuItem icon={<SlidersIcon className="h-3.5 w-3.5" />} label={tLauncher('workspaceCard.agentSettings')} onClick={() => { setMenu(false); onAgentSettings(menuRef.current); }} />
        <MenuItem icon={<FolderOpenIcon className="h-3.5 w-3.5" />} label={tLauncher('workspaceCard.openFolder')} onClick={() => { setMenu(false); onOpenFolder(); }} />
        <MenuItem
          icon={project.pinnedAt ? <PinOffIcon className="h-3.5 w-3.5" /> : <PinIcon className="h-3.5 w-3.5" />}
          label={project.pinnedAt ? tLauncher('workspaceCard.unpin') : tLauncher('workspaceCard.pin')}
          onClick={() => { setMenu(false); onTogglePin(); }}
        />
        <MenuItem icon={<ArchiveIcon className="h-3.5 w-3.5" />} label={tLauncher('workspaceCard.archive')} onClick={() => { setMenu(false); onArchive(); }} />
        <MenuItem icon={<TrashIcon className="h-3.5 w-3.5" />} label={tLauncher('workspaceCard.remove')} tone="danger" onClick={() => { setMenu(false); onRemove(menuRef.current); }} />
      </Popover>
    </div>
  );
}

interface SessionRowProps {
  session: SessionMetadata;
  project: Project;
  tab: Tab | undefined;
  active: boolean;
  tags: SessionTag[];
  unreadNotificationCount: number;
  deleteProtected: boolean;
  onOpen: () => void;
  onToggleFavorite: () => void;
  onTogglePin: () => void;
  onRenameSession: (sessionId: string, title: string) => Promise<SessionMetadata | null>;
  onCopySessionId: () => void;
  onShowStats: (origin?: HTMLElement | null) => void;
  onDelete: (origin?: HTMLElement | null) => void;
  onSessionMutationStart: (sessionId: string, scope?: 'session' | 'global') => number;
  onSessionUpdated: (session: SessionMetadata, mutationSequence: number) => boolean;
  onGlobalTagChange: () => void;
  onMenuOpenChange: (open: boolean) => void;
}

function SessionRow({
  session,
  tab,
  active,
  tags,
  unreadNotificationCount,
  deleteProtected,
  onOpen,
  onToggleFavorite,
  onTogglePin,
  onRenameSession,
  onCopySessionId,
  onShowStats,
  onDelete,
  onSessionMutationStart,
  onSessionUpdated,
  onGlobalTagChange,
  onMenuOpenChange,
}: SessionRowProps) {
  const { t: tLauncher, i18n } = useTranslation('launcher');
  const locale = isSupportedLocale(i18n.language) ? i18n.language : 'zh-CN';
  const [menuOpen, setMenuOpen] = useState(false);
  const displayTitle = getSessionDisplayText(session);
  const fullTitle = getFullSessionDisplayText(session);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const setMenu = useCallback((open: boolean) => {
    setMenuOpen(open);
    onMenuOpenChange(open);
  }, [onMenuOpenChange]);
  useNestedInteractionCleanup(onMenuOpenChange);

  return (
    <div
      role="treeitem"
      aria-current={active ? 'page' : undefined}
      className={`global-sidebar-row global-sidebar-resource-row group/session relative flex h-8 select-none items-center pl-3 pr-1 transition-colors ${
        active ? 'text-[var(--ink)]' : 'text-[var(--ink-secondary)]'
      }`}
      data-menu-open={menuOpen || undefined}
      data-global-sidebar-session-row
      onMouseDown={(event) => {
        if (event.button === 2) {
          event.preventDefault();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        menuRef.current?.focus();
        setMenu(true);
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex h-full w-full min-w-0 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
      >
        <TabActivityIndicator
          isGenerating={tab?.view === 'chat' ? tab.isGenerating : undefined}
          hasUnread={tab?.view === 'chat' ? tab.hasUnread : undefined}
        />
        <OverflowNameTooltip
          label={displayTitle}
          tooltipLabel={fullTitle}
          contentIsTruncated={displayTitle !== fullTitle}
          delayMs={1_000}
          className="global-sidebar-label min-w-0 flex-1 truncate text-sm"
          data-global-sidebar-session-title
        />
        {session.favorite && <StarIcon className="h-3 w-3 shrink-0 text-[var(--accent)]" fill="currentColor" />}
        {session.pinnedAt && (
          <PinIcon
            role="img"
            aria-label={tLauncher('rightRail.pinned')}
            className="h-3 w-3 shrink-0 text-[var(--ink-muted)]"
            data-global-sidebar-session-pinned
          />
        )}
        {tags.map((tag, index) => <SessionTagBadge key={`${tag.type}-${index}`} tag={tag} />)}
        <UnreadNotificationIndicator
          count={unreadNotificationCount}
          label={tLauncher('rightRail.unreadNotifications', { count: unreadNotificationCount })}
        />
        <span
          className={`ml-auto shrink-0 text-xs tabular-nums text-[var(--ink-muted)] transition-opacity ${
            menuOpen ? 'opacity-0' : 'group-hover/session:opacity-0 group-focus-within/session:opacity-0'
          }`}
          data-global-sidebar-session-date
        >
          {formatTime(session.lastActiveAt, new Date(), locale)}
        </span>
      </button>
      <div
        className={`absolute inset-y-0 flex w-9 items-center justify-end transition-opacity ${
          menuOpen
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0 group-hover/session:pointer-events-auto group-hover/session:opacity-100 group-focus-within/session:pointer-events-auto group-focus-within/session:opacity-100'
        }`}
        data-global-sidebar-session-action-overlay
      >
        <Tip label={tLauncher('rightRail.more')} align="end" disabled={menuOpen}>
          <button
            ref={menuRef}
            type="button"
            onClick={() => setMenu(!menuOpen)}
            className="global-sidebar-action-button flex items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            aria-label={tLauncher('rightRail.more')}
          >
            <MoreIcon className="h-3.5 w-3.5" />
          </button>
        </Tip>
      </div>
      <SessionContextMenu
        open={menuOpen}
        onClose={() => {
          setMenu(false);
          menuRef.current?.focus();
        }}
        anchorRef={menuRef}
        session={session}
        deleteProtected={deleteProtected}
        onCopySessionId={onCopySessionId}
        onToggleFavorite={onToggleFavorite}
        onTogglePin={onTogglePin}
        onRenameSession={onRenameSession}
        onShowStats={onShowStats}
        onDelete={onDelete}
        onSessionMutationStart={onSessionMutationStart}
        onSessionUpdated={onSessionUpdated}
        onGlobalTagChange={onGlobalTagChange}
      />
    </div>
  );
}

interface ArchivedWorkspaceRowProps {
  project: Project;
  onUnarchive: () => void;
  onAgentSettings: (origin?: HTMLElement | null) => void;
  onOpenFolder: () => void;
  onRemove: (origin?: HTMLElement | null) => void;
  onMenuOpenChange: (open: boolean) => void;
}

function ArchivedWorkspaceRow({ project, onUnarchive, onAgentSettings, onOpenFolder, onRemove, onMenuOpenChange }: ArchivedWorkspaceRowProps) {
  const { t: tLauncher } = useTranslation('launcher');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const setMenu = useCallback((open: boolean) => {
    setMenuOpen(open);
    onMenuOpenChange(open);
  }, [onMenuOpenChange]);
  useNestedInteractionCleanup(onMenuOpenChange);
  return (
    <div className="group/archive flex h-8 items-center gap-2 rounded-lg px-3 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]">
      <WorkspaceIcon icon={project.icon} size={16} />
      <span className="global-sidebar-label min-w-0 flex-1 truncate">{project.displayName || project.name}</span>
      <Tip label={tLauncher('workspaceCard.more')} align="end" disabled={menuOpen}>
        <button
          ref={menuRef}
          type="button"
          onClick={() => setMenu(!menuOpen)}
          className={`flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] ${menuOpen ? '' : 'opacity-0 group-hover/archive:opacity-100 group-focus-within/archive:opacity-100'}`}
          aria-label={tLauncher('workspaceCard.more')}
        >
          <MoreIcon className="h-3.5 w-3.5" />
        </button>
      </Tip>
      <Popover
        open={menuOpen}
        onClose={() => {
          setMenu(false);
          menuRef.current?.focus();
        }}
        anchorRef={menuRef}
        placement="bottom-end"
        className="global-sidebar-nested-layer w-44 py-1"
      >
        <MenuItem icon={<UndoIcon className="h-3.5 w-3.5" />} label={tLauncher('workspaceCard.unarchive')} onClick={() => { setMenu(false); onUnarchive(); }} />
        <MenuItem icon={<SlidersIcon className="h-3.5 w-3.5" />} label={tLauncher('workspaceCard.agentSettings')} onClick={() => { setMenu(false); onAgentSettings(menuRef.current); }} />
        <MenuItem icon={<FolderOpenIcon className="h-3.5 w-3.5" />} label={tLauncher('workspaceCard.openFolder')} onClick={() => { setMenu(false); onOpenFolder(); }} />
        <MenuItem icon={<TrashIcon className="h-3.5 w-3.5" />} label={tLauncher('workspaceCard.remove')} tone="danger" onClick={() => { setMenu(false); onRemove(menuRef.current); }} />
      </Popover>
    </div>
  );
}
