import { useCallback, useEffect, useState, useRef, useTransition, memo } from 'react';
import { arrayMove } from '@dnd-kit/sortable';

import {
  initAnalytics,
  track,
  setAnalyticsContext,
  clearAnalyticsContext,
  setPendingSurface,
  clearPendingSurface,
  hashAgentName,
  hashAgentNameSync,
} from '@/analytics';
import type { Surface } from '@/analytics';
import { stopTabSidecar, startGlobalSidecar, initGlobalSidecarReadyPromise, markGlobalSidecarReady, getGlobalServerUrl, getSessionActivation, updateSessionTab, ensureSessionSidecar, releaseSessionSidecar, activateSession, deactivateSession, upgradeSessionId, getSessionPort, stopSseProxy, startBackgroundCompletion, cancelBackgroundCompletion, updateGlobalServerUrl, canRestoreSession } from '@/api/tauriClient';
import ConfirmDialog from '@/components/ConfirmDialog';
import BugReportOverlay from '@/components/BugReportOverlay';
import CustomTitleBar from '@/components/CustomTitleBar';
import LinkContextMenuProvider from '@/components/LinkContextMenuProvider';
import TabBar from '@/components/TabBar';
import TabProvider from '@/context/TabProvider';
import { useToast } from '@/components/Toast';
import { useUpdater } from '@/hooks/useUpdater';
import { useTrayEvents } from '@/hooks/useTrayEvents';
import { useHelperAgentModelDefaults } from '@/hooks/useHelperAgentModelDefaults';
import { useConfig } from '@/hooks/useConfig';
import { useThemeEffect } from '@/hooks/useTheme';
import { useTabSwipeGesture } from '@/hooks/useTabSwipeGesture';
import Chat from '@/pages/Chat';
import Launcher from '@/pages/Launcher';
import Settings from '@/pages/Settings';
import TaskCenter from '@/pages/TaskCenter';
import {
  type Project,
} from '@/config/types';
import { type Tab, type InitialMessage, createNewTab, getFolderName, MAX_TABS } from '@/types/tab';
import { buildRestoredTabs, saveOpenTabs } from '@/utils/tabPersistence';
import { tabContentKind, isRestoreAbandoned } from '@/utils/tabContentKind';
import type { ImageAttachment } from '@/components/SimpleChatInput';
import { getAllCronTasks, getTabCronTask, updateCronTaskTab } from '@/api/cronTaskClient';
import { type CronRecoverySummaryPayload, type CronTaskRecoveredPayload, CRON_EVENTS } from '@/types/cronEvents';
import { isBrowserDevMode, isTauriEnvironment } from '@/utils/browserMock';
import { apiGetJson } from '@/api/apiFetch';
import { updateSession } from '@/api/sessionClient';
import { dismissTopmost } from '@/utils/closeLayer';
import { forceFlushLogs, setLogServerUrl, clearLogServerUrl } from '@/utils/frontendLogger';
import { normalizeRuntime, planSessionOpen } from '@/utils/sessionOpenPlan';
import { shouldCommitSessionSwitch } from '@/utils/optionResolve';
import { applyTerminalSessionToTabs } from '@/utils/sessionTermination';
import { listenWithCleanup } from '@/utils/tauriListen';
import { CUSTOM_EVENTS, createPendingSessionId, isPendingSessionId } from '../shared/constants';
import type { CapabilityInitialSelect } from '../shared/skillsTypes';
import { ensureSelfAwarenessWorkspace, resolveBuiltinSelection, pairBuiltinSelection, isProviderAvailable } from '@/config/configService';
import { getAgentByWorkspacePath, getAgentById } from '@/config/services/agentConfigService';
import type { SessionMetadata } from '@/api/sessionClient';
import type { RuntimeType } from '../shared/types/runtime';

// ============================================================
// User Support Prompt Builder
// ============================================================

function buildSupportPrompt(description: string, appVersion: string): string {
  return [
    `## 用户反馈`,
    ``,
    `**App 版本**: ${appVersion}`,
    ``,
    `> ${description}`,
    ``,
    `请使用 /support skill 帮助用户解决这个问题。`,
  ].join('\n');
}

async function resolveSessionRuntimeForOpen(
  sessionId: string | null | undefined,
  fallbackRuntime: RuntimeType,
  multiAgentRuntime: boolean | undefined,
): Promise<RuntimeType> {
  if (!multiAgentRuntime || !sessionId || isPendingSessionId(sessionId)) {
    return fallbackRuntime;
  }
  try {
    const meta = await apiGetJson<{ success: boolean; session?: SessionMetadata }>(`/sessions/${encodeURIComponent(sessionId)}?limit=1`);
    return normalizeRuntime(meta.session?.runtime ?? fallbackRuntime);
  } catch (error) {
    // Non-fatal: sidecar spawn/switch paths remain authoritative. Falling
    // back only affects whether the UI opens a new tab proactively.
    console.warn(`[App] Failed to resolve runtime for session ${sessionId}, using fallback ${fallbackRuntime}:`, error);
    return fallbackRuntime;
  }
}

// ============================================================
// MemoizedTabContent — prevents re-rendering tabs whose props haven't changed.
// When switching tabs, only the newly active and previously active tabs re-render.
// ============================================================

interface TabContentProps {
  tab: Tab;
  isActive: boolean;
  isLoading: boolean;
  error: string | null;
  /**
   * When true, render only a cheap placeholder instead of the (heavy) tab
   * content. Set for a freshly created tab so its full subtree (e.g. the
   * Launcher: BrandSection + SimpleChatInput + selectors + RecentTasks +
   * WorkspaceCards) does NOT mount inside the synchronous click commit —
   * that mount is what janked the "+" / Cmd+T action. handleNewTab clears
   * the flag inside startTransition so React mounts the real content on a
   * time-sliced concurrent render that doesn't block the main thread.
   */
  isDeferredMount: boolean;
  settingsInitialSection: string | undefined;
  settingsInitialMcpId: string | undefined;
  settingsInitialSelect: CapabilityInitialSelect | undefined;
  // Launcher callbacks
  onLaunchProject: (project: Project, sessionId?: string, initialMessage?: InitialMessage) => void;
  // Chat callbacks
  onBack: () => Promise<void>;
  onSwitchSession: (tabId: string, sessionId: string) => Promise<void>;
  onNewSession: (tabId: string) => Promise<boolean>;
  onUpdateGenerating: (tabId: string, isGenerating: boolean) => void;
  onUpdateTitle: (tabId: string, title: string) => void;
  onUpdateUnread: (tabId: string, hasUnread: boolean) => void;
  onRenameSession: (tabId: string, newTitle: string) => void;
  onForkSession: (tabId: string, newSessionId: string, agentDir: string, title: string, initialMessage?: string) => void;
  onUpdateSessionId: (tabId: string, newSessionId: string) => Promise<void>;
  onClearInitialMessage: (tabId: string) => void;
  onClearJoinedExistingSidecar: (tabId: string) => void;
  // Settings callbacks
  onSettingsSectionChange: () => void;
  updateReady: boolean;
  updateVersion: string | null;
  updateChecking: boolean;
  updateDownloading: boolean;
  updateInstalling: boolean;
  /** Silent download is replacing pending bytes — UI button must hide. */
  updatePreparing: boolean;
  onCheckForUpdate: () => Promise<'up-to-date' | 'downloading' | 'error'>;
  onRestartAndUpdate: () => void;
  // Task Center intent carried by the most recent OPEN_TASK_CENTER event.
  // Only read by the `taskcenter` tab; other tab views ignore it.
  taskCenterPendingIntent: { autofocusSearch?: boolean; nonce: number } | null;
}

// Exported for the cold-restore behavior test (Issue #232) — asserts a cold
// tab renders a placeholder and never mounts TabProvider.
export const MemoizedTabContent = memo(function TabContent({
  tab, isActive, isLoading, error, isDeferredMount,
  onLaunchProject, onBack, onSwitchSession, onNewSession,
  onUpdateGenerating, onUpdateTitle, onUpdateUnread, onRenameSession, onForkSession, onUpdateSessionId, onClearInitialMessage,
  onClearJoinedExistingSidecar,
  settingsInitialSection, settingsInitialMcpId, settingsInitialSelect, onSettingsSectionChange,
  updateReady, updateVersion, updateChecking, updateDownloading, updateInstalling, updatePreparing,
  onCheckForUpdate, onRestartAndUpdate,
  taskCenterPendingIntent,
}: TabContentProps) {
  const kind = tabContentKind(tab, isDeferredMount);
  return (
    <div
      className={`absolute inset-0 ${isActive ? '' : 'pointer-events-none invisible'}`}
      style={isActive ? undefined : { contentVisibility: 'hidden' }}
    >
      {kind === 'deferred' ? (
        // One-frame placeholder: paper-colored fill so the just-activated
        // tab paints instantly with no flash, while the real subtree mounts
        // on the following transition render (see handleNewTab).
        <div className="h-full w-full bg-[var(--paper)]" />
      ) : kind === 'launcher' ? (
        <Launcher
          onLaunchProject={onLaunchProject}
          isStarting={isLoading}
          startError={error}
          isActive={isActive}
        />
      ) : kind === 'settings' ? (
        <Settings
          initialSection={settingsInitialSection}
          initialMcpId={settingsInitialMcpId}
          initialSelect={settingsInitialSelect}
          onSectionChange={onSettingsSectionChange}
          isActive={isActive}
          updateReady={updateReady}
          updateVersion={updateVersion}
          updateChecking={updateChecking}
          updateDownloading={updateDownloading}
          updateInstalling={updateInstalling}
          updatePreparing={updatePreparing}
          onCheckForUpdate={onCheckForUpdate}
          onRestartAndUpdate={onRestartAndUpdate}
        />
      ) : kind === 'taskcenter' ? (
        <TaskCenter isActive={isActive} pendingIntent={taskCenterPendingIntent} />
      ) : kind === 'cold' ? (
        // Restored-but-not-yet-activated chat tab (Issue #232). Render only a
        // cheap placeholder — crucially NO TabProvider, so no SSE connect, no
        // ensureSessionSidecar, no recovery timers fire for tabs the user hasn't
        // opened yet. App.activateRestoredTab clears `restoreState` on first
        // activation, after which the real TabProvider branch below mounts.
        <div className="h-full w-full bg-[var(--paper)]" />
      ) : (
        <TabProvider
          tabId={tab.id}
          agentDir={tab.agentDir ?? ''}
          sessionId={tab.sessionId}
          isActive={isActive}
          onGeneratingChange={(isGenerating) => onUpdateGenerating(tab.id, isGenerating)}
          onTitleChange={(title) => onUpdateTitle(tab.id, title)}
          onUnreadChange={(hasUnread) => onUpdateUnread(tab.id, hasUnread)}
          onSessionIdChange={(newSessionId) => onUpdateSessionId(tab.id, newSessionId)}
        >
          <Chat
            onBack={onBack}
            onSwitchSession={(sessionId) => onSwitchSession(tab.id, sessionId)}
            onNewSession={() => onNewSession(tab.id)}
            initialMessage={tab.initialMessage}
            onInitialMessageConsumed={() => onClearInitialMessage(tab.id)}
            joinedExistingSidecar={tab.joinedExistingSidecar}
            onJoinedExistingSidecarHandled={() => onClearJoinedExistingSidecar(tab.id)}
            sessionTitle={tab.title}
            onRenameSession={(newTitle: string) => onRenameSession(tab.id, newTitle)}
            onForkSession={(newSessionId: string, agentDir: string, title: string, initialMessage?: string) => onForkSession(tab.id, newSessionId, agentDir, title, initialMessage)}
          />
        </TabProvider>
      )}
    </div>
  );
}, (prev, next) => {
  // Return true = skip re-render
  // All callbacks are stable (via tabsRef/activeTabIdRef), so we only compare data props
  return (
    prev.tab === next.tab &&
    prev.isActive === next.isActive &&
    prev.isLoading === next.isLoading &&
    prev.error === next.error &&
    // Drives the deferred-mount → real-content transition for new tabs.
    prev.isDeferredMount === next.isDeferredMount &&
    prev.settingsInitialSection === next.settingsInitialSection &&
    prev.settingsInitialMcpId === next.settingsInitialMcpId &&
    prev.settingsInitialSelect === next.settingsInitialSelect &&
    prev.updateReady === next.updateReady &&
    prev.updateVersion === next.updateVersion &&
    prev.updateChecking === next.updateChecking &&
    prev.updateDownloading === next.updateDownloading &&
    prev.updateInstalling === next.updateInstalling &&
    prev.updatePreparing === next.updatePreparing &&
    // Reference equality — each OPEN_TASK_CENTER dispatch allocates a
    // fresh intent object (or `null`), so identity comparison is enough.
    // Without this line, a user re-clicking the Launcher's search icon
    // while Task Center is already active would see their new intent
    // dropped: isActive stays true, tab ref stays the same, so memo
    // returns true and the new `pendingIntent` prop never reaches the
    // TaskCenter tab. (v0.1.69 cross-review C1)
    prev.taskCenterPendingIntent === next.taskCenterPendingIntent
  );
});

export default function App() {
  // Auto-update state (silent background updates)
  const { updateReady, updateVersion, restartAndUpdate, checking: updateChecking, downloading: updateDownloading, installing: updateInstalling, preparing: updatePreparing, checkForUpdate, pendingUpdateOnStartup, dismissPendingUpdate } = useUpdater();

  // Stable callback for Settings prop — ref pattern ensures memo comparator correctness
  const restartAndUpdateRef = useRef(restartAndUpdate);
  restartAndUpdateRef.current = restartAndUpdate;

  // handleRestartAndUpdate is defined further down (after toastRef is declared)
  // — see the `// Update install handler` block.

  // App config for tray behavior (shared via ConfigProvider — no CONFIG_CHANGED event needed)
  // Also get projects + CRUD actions for bug report (ensureSelfAwarenessWorkspace needs them)
  const { config, providers: appProviders, apiKeys: appApiKeys, providerVerifyStatus: appProviderVerifyStatus, projects: configProjects, addProject: configAddProject, patchProject: configPatchProject } = useConfig();

  // Helper Agent's persisted model defaults — used by BugReportOverlay for
  // initial picker selection + persist on pick. The LAUNCH_BUG_REPORT handler
  // intentionally does NOT read this: when no explicit hint is supplied, the
  // helper Tab autoSend resolves provider/model via currentAgent (= helper
  // Agent) — same path as opening ~/.myagents from the Launcher.
  const helperAgentDefaults = useHelperAgentModelDefaults();

  // Apply theme (light/dark/system) to <html> element
  useThemeEffect();

  // Settings initial section state (for deep linking to specific section)
  const [settingsInitialSection, setSettingsInitialSection] = useState<string | undefined>(undefined);
  const [settingsInitialMcpId, setSettingsInitialMcpId] = useState<string | undefined>(undefined);
  const [settingsInitialSelect, setSettingsInitialSelect] = useState<CapabilityInitialSelect | undefined>(undefined);

  // Bug report overlay state (triggered from titlebar feedback button)
  const [showBugReport, setShowBugReport] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    if (isTauriEnvironment()) {
      import('@tauri-apps/api/app').then(m => m.getVersion()).then(setAppVersion).catch(() => setAppVersion('unknown'));
    } else {
      setAppVersion('dev');
    }
  }, []);

  // Multi-tab state.
  //
  // Restore previously-open chat tabs after a restart / update (Issue #232).
  // buildRestoredTabs() reads localStorage and hydrates them flagged
  // `restoreState:'cold'` — they render as lightweight tab chrome only, with NO
  // TabProvider / sidecar / SSE, until first activation (see activateRestoredTab
  // + MemoizedTabContent). Falls back to a fresh launcher tab when nothing is
  // stored. Validation that each session/workspace still exists happens lazily
  // at activation (canRestoreSession), decoupled from global sidecar readiness.
  const [restoredInitialState] = useState(() => buildRestoredTabs());
  const [tabs, setTabs] = useState<Tab[]>(() => restoredInitialState?.tabs ?? [createNewTab()]);
  const [activeTabId, setActiveTabId] = useState<string | null>(
    () => restoredInitialState?.activeTabId ?? tabs[0]?.id ?? null,
  );

  // Refs for stable callback access (avoids re-creating callbacks when tabs/activeTabId change)
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const sessionSwitchSeqRef = useRef(0);
  const latestSessionSwitchRef = useRef(new Map<string, { token: number; sessionId: string }>());

  // Persist open chat tabs after every structural change (Issue #232). This is
  // a POST-COMMIT effect — it flushes shortly after each tabs/activeTabId change
  // (not synchronously inside the mutation). The payload is tiny (≤MAX_TABS × 4
  // fields), and we deliberately avoid `beforeunload` (unreliable in Tauri
  // WKWebView; update install + app quit both exit from the Rust side, not a
  // renderer unload handshake — see the hide/quit flush below and
  // handleRestartAndUpdate). Restored "cold" tabs are persisted too (they carry
  // a real sessionId) — serializeTabs strips the runtime-only restoreState flag.
  useEffect(() => {
    saveOpenTabs(tabs, activeTabId);
  }, [tabs, activeTabId]);

  // Synchronous flush of the latest tab state. Used to close the narrow window
  // where the process exits (update relaunch, Cmd+Q / Dock quit) in the same
  // frame as a structural change, before the post-commit effect above runs.
  const flushOpenTabsNow = useCallback(() => {
    saveOpenTabs(tabsRef.current, activeTabIdRef.current);
  }, []);

  // Flush on window hide / pagehide — the Tauri-appropriate quit signal (the
  // analytics tracker uses the same visibilitychange→hidden hook; beforeunload
  // is unreliable here). Covers Cmd+Q / Dock-quit so a tab closed immediately
  // before quitting doesn't resurrect on next launch.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushOpenTabsNow();
    };
    const onPageHide = () => flushOpenTabsNow();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [flushOpenTabsNow]);

  // Deferred-mount set for freshly created tabs. A tab whose id is in here
  // renders only a placeholder (see MemoizedTabContent), so clicking "+" /
  // Cmd+T does not synchronously mount the heavy Launcher subtree in the
  // click commit. handleNewTab adds the id urgently (instant chip + active
  // highlight) then clears it inside startTransition, letting React mount
  // the real content on a non-blocking, time-sliced concurrent render.
  const [, startNewTabTransition] = useTransition();
  const [deferredMountTabIds, setDeferredMountTabIds] = useState<Set<string>>(() => new Set());

  // Single source of truth for opening a NEW tab whose view mounts a large
  // renderer-only subtree (Launcher / Settings / TaskCenter). It appends and
  // activates the tab in the urgent commit — so the chip + active highlight
  // paint instantly with only a cheap placeholder as content — then clears
  // the deferral inside a transition, letting React mount the heavy subtree on
  // a non-blocking, time-sliced concurrent render. This keeps the open action
  // from janking the frame regardless of how heavy the view is (e.g. the
  // 5.8k-line Settings tree). The urgent commit stays trivial by construction.
  //
  // NOT for Chat / session opens (handleLaunchProject / fork / switch): those
  // await a Sidecar and wire up SSE before the Chat is usable, so their mount
  // cannot be hidden behind a placeholder — they intentionally do not use this.
  const openNewTabDeferred = useCallback((newTab: Tab) => {
    setDeferredMountTabIds((prev) => {
      if (prev.has(newTab.id)) return prev;
      const next = new Set(prev);
      next.add(newTab.id);
      return next;
    });
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
    startNewTabTransition(() => {
      setDeferredMountTabIds((prev) => {
        if (!prev.has(newTab.id)) return prev;
        const next = new Set(prev);
        next.delete(newTab.id);
        return next;
      });
    });
  }, [startNewTabTransition]);

  // Analytics Active Context — propagate active tab's sessionId/tabId so that
  // downstream track() calls auto-inject these into params (see analytics/tracker.ts).
  // Pending session ids (createPendingSessionId placeholders) are filtered out:
  // they're per-tab UI scaffolding, not the real SDK session id, and would not
  // join with session_new in the analytics pipeline.
  useEffect(() => {
    if (!activeTabId) {
      clearAnalyticsContext();
      return;
    }
    const activeTab = tabs.find((t) => t.id === activeTabId);
    const sid = activeTab?.sessionId ?? null;
    setAnalyticsContext({
      tabId: activeTabId,
      sessionId: sid && !isPendingSessionId(sid) ? sid : null,
    });
  }, [activeTabId, tabs]);

  // PRD 0.2.19 cross-review fix: prewarm agent_hash cache when config.agents
  // loads/changes, so the first `workspace_open` / `session_new` for each agent
  // already has agent_hash populated. Without this, `hashAgentNameSync` returns
  // null on first call (computes async + caches), creating a small tail of
  // null-hash events. Prewarm reduces the tail to near zero.
  useEffect(() => {
    const agents = config?.agents ?? [];
    for (const a of agents) {
      if (a.name) void hashAgentName(a.name);
    }
  }, [config]);

  const appProvidersRef = useRef(appProviders);
  appProvidersRef.current = appProviders;

  const appApiKeysRef = useRef(appApiKeys);
  appApiKeysRef.current = appApiKeys;

  const appProviderVerifyStatusRef = useRef(appProviderVerifyStatus);
  appProviderVerifyStatusRef.current = appProviderVerifyStatus;

  const configProjectsRef = useRef(configProjects);
  configProjectsRef.current = configProjects;

  // Ref for full AppConfig — needed by session-switch flow (T12) to resolve per-workspace
  // agent.runtime for cross-runtime detection without putting `config` into the
  // handleSwitchSession useCallback deps (it's intentionally a stable empty-deps callback).
  const configRef = useRef(config);
  configRef.current = config;

  // Toast (ref-stabilized per CLAUDE.md rules)
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // Update install handler — toasts on failure so the user sees their click
  // had an effect. Silent failure here was the root cause of "重启更新 button
  // does nothing" reports on Windows: a flaky network would kill the install
  // verification round-trip, the JS only console.warn-ed, and the user
  // assumed the button was broken.
  const handleRestartAndUpdate = useCallback(async () => {
    // Flush open-tab state synchronously before the install/relaunch exits the
    // process from Rust (Issue #232) — guarantees the tabs the user had open at
    // the moment of clicking "重启更新" are restored on the next launch.
    flushOpenTabsNow();
    const outcome = await restartAndUpdateRef.current();
    if (outcome === 'network-error') {
      toastRef.current?.error('无法验证更新（网络异常），请稍后重试');
    } else if (outcome === 'version-mismatch') {
      toastRef.current?.info('已下载的更新已过期，正在重新下载新版本…');
    } else if (outcome === 'error') {
      toastRef.current?.error('安装更新失败，请重试或前往设置页手动重新检查');
    }
    // 'ok' → process is exiting via NSIS/relaunch, no toast needed
  }, [flushOpenTabsNow]);

  // Per-tab loading state (keyed by tabId)
  const [loadingTabs, setLoadingTabs] = useState<Record<string, boolean>>({});
  const [tabErrors, setTabErrors] = useState<Record<string, string | null>>({});

  // Exit confirmation state (for cron tasks)
  const [exitConfirmState, setExitConfirmState] = useState<{
    runningTaskCount: number;
    resolve: (value: boolean) => void;
  } | null>(null);

  // Content container ref for tab swipe gesture
  const contentRef = useRef<HTMLDivElement>(null);

  // Per-tab launch guard — prevents concurrent launches overwriting each other's state
  const launchingTabRef = useRef<string | null>(null);

  // Global Sidecar silent retry mechanism
  const mountedRef = useRef(true);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);

  // Silent background retry with exponential backoff
  const startGlobalSidecarSilent = useCallback(async () => {
    const MAX_RETRIES = 5;
    const BASE_DELAY = 2000; // 2 seconds

    try {
      // NOTE: Do NOT reset the ready promise on retry.
      // Existing waiters (useTaskCenterData etc.) hold a reference to the original promise.
      // Resetting it would orphan those waiters — they'd wait for a dead promise until
      // the 60s timeout expires, even if the sidecar is already running.
      // Keep the original promise; markGlobalSidecarReady() resolves it for ALL waiters.

      await startGlobalSidecar();

      if (!mountedRef.current) return;

      markGlobalSidecarReady();
      retryCountRef.current = 0; // Reset on success

      // Set log server URL to global sidecar for unified logging
      try {
        const globalUrl = await getGlobalServerUrl();
        setLogServerUrl(globalUrl);
        console.log('[App] Global sidecar started, log URL set:', globalUrl);
      } catch (e) {
        console.warn('[App] Failed to set log server URL:', e);
      }
    } catch (error) {
      if (!mountedRef.current) return;

      retryCountRef.current += 1;
      const currentRetry = retryCountRef.current;

      if (currentRetry <= MAX_RETRIES) {
        // Exponential backoff: 2s, 4s, 8s, 16s, 32s
        const delay = BASE_DELAY * Math.pow(2, currentRetry - 1);
        console.log(`[App] Global sidecar failed, retry ${currentRetry}/${MAX_RETRIES} in ${delay}ms`);

        retryTimeoutRef.current = setTimeout(() => {
          if (mountedRef.current) {
            void startGlobalSidecarSilent();
          }
        }, delay);
      } else {
        // Max retries reached, mark as ready to unblock waiting components
        markGlobalSidecarReady();
        console.error('[App] Global sidecar failed after max retries:', error);
      }
    }
  }, []);

  // 方案 A: Rust 统一恢复 - 前端不再主动恢复，只监听事件
  // Rust 层 initialize_cron_manager 会自动恢复所有 running 状态的任务

  // Start Global Sidecar on mount, cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    retryCountRef.current = 0;

    // Initialize analytics (async, non-blocking)
    void initAnalytics().then(() => {
      // Track app launch event
      track('app_launch', { launch_type: 'cold' });
    });

    // Initialize the ready promise BEFORE starting the sidecar
    // This allows other components to wait for it
    initGlobalSidecarReadyPromise();

    // Start Global Sidecar immediately on app launch
    // This ensures MCP and other global API calls work from any page
    void startGlobalSidecarSilent();

    // NOTE: Bundled workspace (mino) initialization is handled by
    // ensureBundledWorkspace() inside ConfigProvider.load(), which runs
    // before loadProjects() to eliminate race conditions.

    // 方案 A: Rust 统一恢复 - 监听恢复事件（仅用于日志和 UI 反馈）
    // Rust 层会自动恢复任务，前端只需要监听结果
    const listenerAc = new AbortController();

    if (isTauriEnvironment()) {
      // Listen for background session completion events
      void listenWithCleanup<{ sessionId: string; sidecarStopped: boolean }>(
        'session:background-complete',
        (event) => {
          if (!mountedRef.current) return;
          const { sessionId, sidecarStopped } = event.payload;
          console.log(`[App] Background session completion finished: session=${sessionId}, sidecarStopped=${sidecarStopped}`);
        },
        listenerAc.signal,
      );

      // Listen for individual task recovered events
      void listenWithCleanup<CronTaskRecoveredPayload>(
        CRON_EVENTS.TASK_RECOVERED,
        (event) => {
          if (!mountedRef.current) return;
          const { taskId, sessionId, port } = event.payload;
          console.log(`[App] Cron task recovered: ${taskId} (session: ${sessionId}, port: ${port})`);
        },
        listenerAc.signal,
      );

      // Listen for recovery summary event
      void listenWithCleanup<CronRecoverySummaryPayload>(
        CRON_EVENTS.RECOVERY_SUMMARY,
        (event) => {
          if (!mountedRef.current) return;
          const { totalTasks, recoveredCount, failedCount, failedTasks } = event.payload;
          if (totalTasks > 0) {
            console.log(
              `[App] Cron recovery summary: ${recoveredCount}/${totalTasks} recovered, ${failedCount} failed`
            );
            if (failedTasks.length > 0) {
              console.warn('[App] Failed tasks:', failedTasks);
            }
            track('cron_recover', {
              recovered_count: recoveredCount,
              failed_count: failedCount,
            });
          }
        },
        listenerAc.signal,
      );

      // Listen for manager ready event (indicates recovery is complete)
      void listenWithCleanup(CRON_EVENTS.MANAGER_READY, () => {
        if (!mountedRef.current) return;
        console.log('[App] Cron manager ready (Rust recovery complete)');
      }, listenerAc.signal);

      // Listen for Global Sidecar auto-restart by Rust health monitor
      void listenWithCleanup<string>('global-sidecar:restarted', (event) => {
        if (!mountedRef.current) return;
        const newUrl = event.payload;
        console.log('[App] Global sidecar auto-restarted by health monitor:', newUrl);
        updateGlobalServerUrl(newUrl);
        setLogServerUrl(newUrl);
        // Safety net: if the initial startGlobalSidecar() invoke is still blocked
        // (e.g., monitor killed the first sidecar during its TCP health check),
        // the ready promise would never resolve. Resolve it here so that components
        // waiting on waitForGlobalSidecar() can proceed with the new sidecar. (#58)
        markGlobalSidecarReady();
      }, listenerAc.signal);

      // session:sidecar-terminal — emitted by Rust ONLY when a Session
      // Sidecar is removed with no remaining owners (so the health monitor
      // will not auto-restart it). This is the single source of truth for
      // "the underlying session is gone for good"; reset any Tab whose
      // sessionId matches so the next `planSessionOpen` doesn't jump-to-tab
      // into a Tab whose sidecar has been dead for hours. The crash-with-
      // owners path stays handled by `session-sidecar:restarted` in
      // TabProvider — this listener deliberately doesn't fire for that case.
      //
      // Stale-event guard (Codex review CRIT-1): a same-session-id relaunch
      // can happen between Rust emitting and us receiving the event (user
      // clicks history → Scenario 4 spins up a fresh sidecar with a higher
      // generation — Rust's `instance_counter` guarantees uniqueness). The
      // stale terminal event would then wipe a tab that's already bound to
      // the live new sidecar. Re-query Rust at handling time: if a sidecar
      // entry exists for this sessionId NOW, the event is stale and the
      // current binding must NOT be cleared.
      void listenWithCleanup<{ sessionId: string; generation: number }>(
        'session:sidecar-terminal',
        async (event) => {
          if (!mountedRef.current) return;
          const { sessionId, generation } = event.payload;
          // Presence check — Rust returns a port iff a sidecar entry
          // exists in the manager (a relaunch since the event was emitted
          // would re-create one with a fresh generation). Non-null ⇒
          // event is stale; current binding is valid. (`getSessionPort`
          // is presence, not process-health — adequate here.)
          const livePort = await getSessionPort(sessionId);
          if (livePort !== null) {
            console.log(
              `[App] Ignoring stale terminal event for ${sessionId} (gen=${generation}) — live sidecar present on port ${livePort}`
            );
            return;
          }
          if (!mountedRef.current) return;
          setTabs((prev) => {
            const next = applyTerminalSessionToTabs(prev, sessionId);
            if (next !== prev) {
              console.log(`[App] Tab.sessionId reset for terminated session ${sessionId}`);
            }
            return next as typeof prev;
          });
        },
        listenerAc.signal,
      );

      // Reconcile path — Rust emits this when its terminal_events broadcast
      // lagged (capacity 64 exceeded by a shutdown burst). Payload is the
      // currently-live session id list snapshotted at lag-detection time;
      // any Tab.sessionId NOT in that set is suspect.
      //
      // Two layers of guarding (Codex review CRIT-2):
      //  (1) The snapshot can be stale by the time we receive — for each
      //      suspect, re-query Rust live state and only treat it as gone
      //      if Rust currently has no sidecar for that id.
      //  (2) Candidates are taken from a tabsRef snapshot; new tabs may
      //      appear during our async work. To avoid clearing those, we
      //      apply cleanup tab-by-tab via `applyTerminalSessionToTabs`
      //      against the *current* prev, and only for the exact session
      //      ids we definitively confirmed gone.
      void listenWithCleanup<{ liveSessionIds: string[] }>(
        'session:sidecar-terminal-reconcile',
        async (event) => {
          if (!mountedRef.current) return;
          const stillLive = new Set<string>(event.payload.liveSessionIds);
          const candidates = tabsRef.current
            .filter((t) => t.sessionId && !isPendingSessionId(t.sessionId))
            .map((t) => t.sessionId as string)
            .filter((sid) => !stillLive.has(sid));
          const goneIds: string[] = [];
          await Promise.all(
            candidates.map(async (sid) => {
              const port = await getSessionPort(sid);
              if (port === null) goneIds.push(sid);
            })
          );
          if (!mountedRef.current || goneIds.length === 0) return;
          setTabs((prev) => {
            let next = prev;
            for (const sid of goneIds) {
              next = applyTerminalSessionToTabs(next, sid) as typeof prev;
            }
            if (next !== prev) {
              console.log(`[App] Reconcile cleared ${goneIds.length} stale binding(s)`);
            }
            return next;
          });
        },
        listenerAc.signal,
      );
    }

    return () => {
      mountedRef.current = false;
      // Clear any pending retry
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      // Tear down all listeners registered above (each listenWithCleanup
      // wires its own teardown on `signal.abort`, so a single abort here
      // reaches every one).
      listenerAc.abort();
      // Flush any pending frontend logs before shutdown
      forceFlushLogs();
      clearLogServerUrl();
      // NOTE: Do NOT call stopAllSidecars() here.
      // This cleanup runs on ANY unmount (including error boundary recovery),
      // not just app exit. Killing the sidecar during error recovery creates a
      // death loop: error → unmount → kill sidecar → sidecar unavailable → more errors.
      // Rust handles sidecar cleanup on actual exit (WindowEvent::Destroyed, ExitRequested).
    };
  }, [startGlobalSidecarSilent]);

  // Update tab isGenerating state (called from TabProvider via callback)
  const updateTabGenerating = useCallback((tabId: string, isGenerating: boolean) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, isGenerating } : t
    ));
  }, []);

  // Update tab title (called from TabProvider when auto-title or rename occurs)
  const updateTabTitle = useCallback((tabId: string, title: string) => {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, title } : t));
  }, []);

  // Update tab unread state (called from TabProvider when message completes on non-active tab)
  const updateTabUnread = useCallback((tabId: string, hasUnread: boolean) => {
    setTabs(prev => {
      const tab = prev.find(t => t.id === tabId);
      if (tab && tab.hasUnread !== hasUnread) {
        return prev.map(t => t.id === tabId ? { ...t, hasUnread } : t);
      }
      return prev; // no-op: avoid unnecessary re-render
    });
  }, []);

  // Update tab sessionId when backend creates real session (called from TabProvider)
  // This ensures Session singleton constraint works correctly:
  // - Tab.sessionId syncs with the actual session ID
  // - History dropdown can detect if session is already open in a Tab
  // - Rust HashMap keys are upgraded from "pending-xxx" to real session ID
  const updateTabSessionId = useCallback(async (tabId: string, newSessionId: string) => {
    // Find the current tab to get the old sessionId
    const currentTab = tabsRef.current.find(t => t.id === tabId);
    const oldSessionId = currentTab?.sessionId;

    console.log(`[App] Tab ${tabId} sessionId updating: ${oldSessionId} -> ${newSessionId}`);

    // Upgrade the session ID in Rust HashMap (sidecars + session_activations)
    // This is a no-op if oldSessionId is null or same as newSessionId
    if (oldSessionId && oldSessionId !== newSessionId) {
      const upgraded = await upgradeSessionId(oldSessionId, newSessionId);
      console.log(`[App] Rust HashMap upgrade: ${oldSessionId} -> ${newSessionId}, success=${upgraded}`);
    }

    // Update UI state
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, sessionId: newSessionId } : t
    ));
  }, []);

  // Perform the actual tab close operation (pure function, no confirmation)
  // UI updates are immediate; resource cleanup runs in background (non-blocking)
  const performCloseTab = useCallback((tabId: string) => {
    const currentTabs = tabsRef.current;

    // Double-check: tab might have been removed
    const tab = currentTabs.find(t => t.id === tabId);
    if (!tab) return;

    // Calculate actual tab_count after close:
    // - If closing the last tab, a new launcher is created, so count = 1
    // - Otherwise, count = currentTabs.length - 1
    const isLastTab = currentTabs.length === 1;
    const actualTabCount = isLastTab ? 1 : currentTabs.length - 1;

    // Track tab_close event with correct count
    track('tab_close', { view: tab.view, tab_count: actualTabCount });

    // Drop any leftover pending surface for this tab to avoid leaking it into
    // a later (unrelated) session_new — the analytics module keeps these
    // module-level until consumed.
    clearPendingSurface(tabId);

    // ========== IMMEDIATE UI UPDATE (non-blocking) ==========
    // Update UI state first for instant response
    if (isLastTab) {
      // Special case: If this is the last tab, replace with launcher (don't close the app)
      const newTab = createNewTab();
      setTabs([newTab]);
      setActiveTabId(newTab.id);
    } else {
      // Normal case: close the tab
      const newTabs = currentTabs.filter((t) => t.id !== tabId);

      // If closing the active tab, switch to the last remaining tab
      if (tabId === activeTabIdRef.current && newTabs.length > 0) {
        setActiveTabId(newTabs[newTabs.length - 1].id);
      }

      setTabs(newTabs);
    }

    // ========== BACKGROUND CLEANUP (non-blocking) ==========
    // Capture tab data before cleanup to avoid stale closure issues
    const tabSessionId = tab.sessionId;
    const tabAgentDir = tab.agentDir;

    // Resource cleanup runs asynchronously without blocking UI
    // CRITICAL: SSE proxy must be stopped BEFORE Sidecar to avoid "unexpected EOF" errors
    // When Sidecar dies, open HTTP connections break mid-stream causing errors
    const cleanupResources = async () => {
      try {
        // Step 1: Try to start background completion if AI is running
        // This keeps the Sidecar alive so AI can finish its response
        if (tabSessionId) {
          const bgResult = await startBackgroundCompletion(tabSessionId);
          if (bgResult.started) {
            console.log(`[App] Tab ${tabId} closing: AI still running, background completion started for session ${tabSessionId}`);
          }
        }

        // Step 2: Stop SSE proxy FIRST to ensure clean disconnection
        // This prevents "unexpected EOF" errors when Sidecar is stopped
        await stopSseProxy(tabId);

        // Step 3: Release Tab's ownership of the Session Sidecar
        // If background completion is active, Sidecar continues running (BG owner keeps it alive)
        if (tabSessionId) {
          try {
            // Update cron task tab association if exists
            const cronTask = await getTabCronTask(tabId);
            if (cronTask && cronTask.status === 'running') {
              await updateCronTaskTab(cronTask.id, undefined);
            }

            const stopped = await releaseSessionSidecar(tabSessionId, 'tab', tabId);
            console.log(`[App] Tab ${tabId} released session ${tabSessionId}, sidecar stopped: ${stopped}`);

            // Clean up session activation
            if (!cronTask || cronTask.status !== 'running') {
              await deactivateSession(tabSessionId);
            }
          } catch (error) {
            console.error(`[App] Error releasing session sidecar for tab ${tabId}:`, error);
            // Fallback to legacy stopTabSidecar
            void stopTabSidecar(tabId);
          }
        } else if (tabAgentDir) {
          // No sessionId but has agentDir - legacy case, use stopTabSidecar
          void stopTabSidecar(tabId);
        }
      } catch (error) {
        console.error(`[App] Background cleanup error for tab ${tabId}:`, error);
      }
    };

    // Runs in background — catch ensures no unhandled rejection
    cleanupResources().catch(err =>
      console.error(`[App] Unhandled cleanup error for tab ${tabId}:`, err)
    );
  }, []);

  // Close tab — if AI is generating, close immediately and let it finish in background.
  // No confirmation dialog: background completion keeps the Sidecar alive.
  const closeTabWithConfirmation = useCallback(async (tabId: string) => {
    const tab = tabsRef.current.find(t => t.id === tabId);

    if (tab?.isGenerating && tab.sessionId) {
      void performCloseTab(tabId);
      toastRef.current.info('AI 继续在后台完成任务');
      return;
    }

    void performCloseTab(tabId);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stabilized via tabsRef
  }, []);

  // Close current active tab (for Cmd+W)
  const closeCurrentTab = useCallback(() => {
    const currentActiveTabId = activeTabIdRef.current;
    if (!currentActiveTabId) return;

    const currentTabs = tabsRef.current;
    const activeTab = currentTabs.find(t => t.id === currentActiveTabId);

    // Special case: If only one launcher tab, do nothing
    if (currentTabs.length === 1 && activeTab?.view === 'launcher') {
      return;
    }

    // Multiple tabs OR last tab is chat/settings: use the unified confirmation logic
    void closeTabWithConfirmation(currentActiveTabId);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stabilized via tabsRef
  }, []);

  // Keyboard shortcuts: Cmd+T, Cmd+W, Cmd+Shift+[/], Cmd+1~9, Ctrl+Tab/Ctrl+Shift+Tab
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes('mac');
      const modKey = isMac ? e.metaKey : e.ctrlKey;

      // Block reload shortcuts (F5 / Ctrl+F5 / Cmd|Ctrl+R / Cmd|Ctrl+Shift+R).
      // Reload wipes in-memory tab state (Tab.sessionId / Sidecar owner /
      // loading flags live in React state, not on disk), tears down every
      // tab's Sidecar (~30 s to cold-start back), and interrupts in-flight
      // AI conversations. Windows WebView2 enables these accelerators by
      // default (`AreBrowserAcceleratorKeysEnabled`); on macOS / Linux the
      // WebView still honors a JS `preventDefault()` on the keydown.
      // `e.code === 'KeyR'` covers non-Latin keyboard layouts where the
      // physical R key produces a non-`r`/`R` `e.key`.
      if (
        e.key === 'F5'
        || (modKey && !e.altKey && (e.key === 'r' || e.key === 'R' || e.code === 'KeyR'))
      ) {
        e.preventDefault();
        return;
      }

      // --- Ctrl+Tab / Ctrl+Shift+Tab: cycle through tabs (both platforms use Ctrl) ---
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
        e.preventDefault();
        const tabs = tabsRef.current;
        const activeId = activeTabIdRef.current;
        if (tabs.length <= 1 || !activeId) return;
        const idx = tabs.findIndex((t) => t.id === activeId);
        if (idx === -1) return;
        const newIdx = e.shiftKey
          ? (idx - 1 + tabs.length) % tabs.length   // wrap backward
          : (idx + 1) % tabs.length;                 // wrap forward
        setActiveTabId(tabs[newIdx].id);
        return;
      }

      if (!modKey) return;

      // --- Cmd/Ctrl + 1~9: jump to Nth tab (9 = last tab) ---
      const digit = parseInt(e.key, 10);
      if (digit >= 1 && digit <= 9 && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const tabs = tabsRef.current;
        if (tabs.length === 0) return;
        const targetIdx = digit === 9 ? tabs.length - 1 : digit - 1;
        if (targetIdx < tabs.length) {
          setActiveTabId(tabs[targetIdx].id);
        }
        return;
      }

      if (!e.shiftKey && !e.altKey && (e.key === 't' || e.key === 'T')) {
        // Cmd/Ctrl+T — new tab. `!e.shiftKey` guard lets Cmd+Shift+T
        // flow through to page-level handlers (e.g. Launcher BrandSection
        // uses it as the 任务/想法 mode-toggle chord). Without this guard
        // Cmd+Shift+T would silently collapse onto "new tab" and users
        // couldn't reach the mode toggle from the keyboard at all.
        e.preventDefault();
        // Route through handleNewTab so Cmd+T shares the deferred-mount path
        // (instant chip + non-blocking Launcher mount) and the MAX_TABS guard,
        // instead of duplicating tab-creation logic. handleNewTab is a stable
        // useCallback, so this empty-deps effect's keydown closure resolves it
        // correctly at press time.
        handleNewTab();
      } else if (!e.shiftKey && !e.altKey && (e.key === 'y' || e.key === 'Y')) {
        // Cmd/Ctrl+Y — open Task Center as a singleton tab. Mirrors the
        // header button's CUSTOM_EVENTS.OPEN_TASK_CENTER dispatch so both
        // entry points converge on the same handler (see line ~1544).
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_TASK_CENTER));
      } else if (!e.shiftKey && !e.altKey && (e.key === 'u' || e.key === 'U')) {
        // Cmd/Ctrl+U — open Settings. `OPEN_SETTINGS` is already the
        // designated cross-component entry (line ~1489); reusing it keeps
        // the shortcut and the titlebar button path identical.
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS));
      } else if (e.key === 'w' || e.key === 'W') {
        // macOS: native menu (Window > Close Tab, Cmd+W) emits window:cmd-w
        // and useTrayEvents handles it — this branch is normally dead code.
        // Kept as a defensive fallback if the menu accelerator ever misfires.
        // Windows/Linux: no native menu with Ctrl+W, so this is the primary path.
        e.preventDefault();
        if (!dismissTopmost()) {
          if (!document.querySelector('.fixed.inset-0[class*="backdrop-blur"]')) {
            closeCurrentTab();
          }
        }
      } else if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        // Cmd+Shift+[ = previous tab, Cmd+Shift+] = next tab
        e.preventDefault();
        const tabs = tabsRef.current;
        const activeId = activeTabIdRef.current;
        if (tabs.length <= 1 || !activeId) return;
        const idx = tabs.findIndex((t) => t.id === activeId);
        if (idx === -1) return;
        const newIdx = e.code === 'BracketLeft' ? idx - 1 : idx + 1;
        if (newIdx >= 0 && newIdx < tabs.length) {
          setActiveTabId(tabs[newIdx].id);
        }
      }
    };

    // Capture phase: application-level shortcuts (Cmd+W/T/Tab, etc.) MUST fire before
    // any component-level handlers. Without capture, Monaco editor (or any component
    // calling stopPropagation) blocks the event → our handler never fires →
    // e.preventDefault() never called → Tauri native Cmd+W closes the window.
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stabilized via tabsRef
  }, []);

  /**
   * Launch a project with Session Singleton Architecture
   *
   * Four scenarios (evaluated in order):
   * 1. Session already open in a Tab → Jump to that Tab
   * 2. Session has running cron task (no Tab) → New Tab connects to Cron Sidecar
   * 3. Current Tab has running cron task → New Tab + New Sidecar
   * 4. Normal switch → Current Tab switches Session
   */
  const handleLaunchProject = useCallback(async (
    project: Project,
    sessionId?: string,
    initialMessage?: InitialMessage
  ) => {
    const activeTabId = activeTabIdRef.current;
    if (!activeTabId) return;

    // Per-tab launch guard: prevent concurrent launches on the same tab
    // A second launch would overwrite the first's initialMessage and kill its sidecar
    if (launchingTabRef.current === activeTabId) {
      console.warn(`[App] handleLaunchProject: launch already in progress for tab ${activeTabId}, ignoring`);
      return;
    }
    launchingTabRef.current = activeTabId;

    // Resolve agent meta for analytics. `getAgentByWorkspacePath` may return
    // undefined when the workspace isn't bound to any agent (rare — happens
    // for ad-hoc paths) — in that case agent_hash=null + runtime='builtin'
    // as the natural fallback.
    //
    // Surface set is DEFERRED to after `targetTabId` is finalized below — when
    // Scenario 3 creates a new tab, the new TabProvider's chat:system-init must
    // consume the surface from THE NEW tabId, not the original activeTabId.
    // Tracked here for review feedback B2/H2 (Codex BLOCKER, Codex HIGH).
    let pendingSurfaceForLaunch: Surface | null = null;
    {
      const cfg = configRef.current;
      const agent = getAgentByWorkspacePath(cfg, project.path);
      const runtime = agent ? normalizeRuntime(agent.runtime) : 'builtin';
      const agent_hash = hashAgentNameSync(agent?.name ?? null);

      if (sessionId) {
        // history_click path: switching to existing session, no new session
        // minted, so we do NOT plan a surface. Explicit `session_id: null`
        // suppresses Active Context auto-injection of a stale source-session id.
        track('history_open', { agent_hash, runtime, session_id: null });
      } else {
        // workspace_open path: agent_card (no initialMessage) vs launcher_input
        // (initialMessage present). Stored locally; applied with final targetTabId.
        pendingSurfaceForLaunch = initialMessage ? 'launcher_input' : 'agent_card';
        track('workspace_open', { agent_hash, runtime, session_id: null });
      }
    }

    setTabErrors((prev) => ({ ...prev, [activeTabId]: null }));
    setLoadingTabs((prev) => ({ ...prev, [activeTabId]: true }));
    let targetTabId = activeTabId;

    try {
      const activeTab = tabsRef.current.find(t => t.id === activeTabId);

      if (sessionId) {
        const cfg = configRef.current;
        const targetAgentRuntime = normalizeRuntime(getAgentByWorkspacePath(cfg, project.path)?.runtime);
        const currentAgentRuntime = activeTab?.agentDir
          ? normalizeRuntime(getAgentByWorkspacePath(cfg, activeTab.agentDir)?.runtime)
          : targetAgentRuntime;
        const [
          targetRuntime,
          resolvedCurrentRuntime,
          activation,
          currentTabCronTask,
        ] = await Promise.all([
          resolveSessionRuntimeForOpen(sessionId, targetAgentRuntime, cfg?.multiAgentRuntime),
          resolveSessionRuntimeForOpen(activeTab?.sessionId, currentAgentRuntime, cfg?.multiAgentRuntime),
          getSessionActivation(sessionId),
          getTabCronTask(activeTabId),
        ]);
        const currentRuntime = activeTab?.sessionId ? resolvedCurrentRuntime : targetRuntime;
        const plan = planSessionOpen({
          tabs: tabsRef.current,
          targetSessionId: sessionId,
          multiAgentRuntime: !!cfg?.multiAgentRuntime,
          currentRuntime,
          targetRuntime,
          targetActivation: activation,
          currentTabCronRunning: currentTabCronTask?.status === 'running',
        });
        console.log(`[App] handleLaunchProject: session-open plan=${plan.type}${plan.type === 'open-new-tab' ? ` reason=${plan.reason}` : ''}, target=${sessionId}`);

        if (plan.type === 'jump-to-tab') {
          // Defensive presence check — race window between Rust emitting
          // `session:sidecar-terminal` and the renderer applying the cleanup.
          // The terminal-event listener above is the primary fix (clears
          // stale Tab.sessionId), but if the user clicks task center inside
          // that tiny window, the planner can still match the not-yet-cleaned
          // tab and we'd "jump" to a tab whose sidecar is dead. A direct
          // `getSessionPort` query asks Rust whether ANY sidecar entry
          // currently exists for this session id (this is presence, not
          // process-health — sufficient for "is something around to talk to"
          // because the auto-restart path keeps the entry resident through
          // brief restart windows). Null means the manager has nothing,
          // which is the exact stale-binding case. Fall through to
          // Scenario 4 (`ensureSessionSidecar` re-spawns the session, adds
          // this Tab as owner) so the user always gets a working session,
          // never an empty UI. (Codex review AI-2 wording fix.)
          const livePort = await getSessionPort(sessionId);
          if (livePort === null) {
            console.warn(
              `[App] Scenario 1 stale: tab ${plan.tabId} bound to session ${sessionId} but no live sidecar — falling through to relaunch`
            );
            // Continue to Scenario 4 below. We do NOT pre-rewrite the tab's
            // sessionId here (the terminal-event listener will catch up
            // shortly, and Scenario 4's setTabs at the tail of this function
            // sets it authoritatively after `ensureSessionSidecar` succeeds).
            targetTabId = plan.tabId;
            if (plan.tabId !== activeTabId) {
              setActiveTabId(plan.tabId);
            }
            setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false, [plan.tabId]: true }));
          } else {
            console.log(`[App] Scenario 1: Session ${sessionId} already in tab ${plan.tabId}, jumping to it`);
            setActiveTabId(plan.tabId);
            setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false }));
            launchingTabRef.current = null;
            return;
          }
        }

        if (plan.type === 'open-new-tab') {
          if (tabsRef.current.length >= MAX_TABS) {
            setTabErrors((prev) => ({ ...prev, [activeTabId]: '已达到最大标签页数量，请关闭其他标签页后重试' }));
            setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false }));
            launchingTabRef.current = null;
            return;
          }
          const newTab = createNewTab();
          setTabs((prev) => [...prev, newTab]);
          targetTabId = newTab.id;
          setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false, [targetTabId]: true }));
        }

        if (plan.type === 'attach-existing-sidecar') {
          console.log(`[App] Scenario 2: Session ${sessionId} has cron task ${plan.taskId} on port ${activation?.port}`);
          const result = await ensureSessionSidecar(sessionId, project.path, 'tab', targetTabId);
          console.log(`[App] Tab ${targetTabId} added as owner to session ${sessionId} Sidecar on port ${result.port}`);

          await updateSessionTab(sessionId, targetTabId);

          const oldSessionId = tabsRef.current.find(t => t.id === targetTabId)?.sessionId;
          if (oldSessionId && oldSessionId !== sessionId) {
            await stopSseProxy(targetTabId);
            await releaseSessionSidecar(oldSessionId, 'tab', targetTabId);
            await deactivateSession(oldSessionId);
          }

          setTabs((prev) =>
            prev.map((t) =>
              t.id === targetTabId
                ? {
                  ...t,
                  agentDir: project.path,
                  sessionId,
                  view: 'chat',
                  title: project.displayName || getFolderName(project.path),
                  joinedExistingSidecar: !result.isNew,
                }
                : t
            )
          );

          if (targetTabId !== activeTabId) {
            setActiveTabId(targetTabId);
          }
          setLoadingTabs((prev) => ({ ...prev, [targetTabId]: false }));
          launchingTabRef.current = null;
          return;
        }
      } else {
        // ========================================
        // New session: current Tab has running cron task
        // ========================================
        const currentTabCronTask = await getTabCronTask(activeTabId);
        if (currentTabCronTask && currentTabCronTask.status === 'running') {
          console.log(`[App] Scenario 3: Current tab ${activeTabId} has running cron task ${currentTabCronTask.id}, creating new tab`);

          if (tabsRef.current.length >= MAX_TABS) {
            setTabErrors((prev) => ({ ...prev, [activeTabId]: '已达到最大标签页数量，请关闭其他标签页后重试' }));
            setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false }));
            launchingTabRef.current = null;
            return;
          }

          const newTab = createNewTab();
          setTabs((prev) => [...prev, newTab]);
          targetTabId = newTab.id;
          setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false, [targetTabId]: true }));
        }
      }

      // ========================================
      // Scenario 4: Normal switch (or Scenario 3 continuation)
      // Using Session-centric API: Tab becomes owner of Session's Sidecar
      // ========================================
      console.log(`[App] Scenario 4: Normal launch - tab ${targetTabId}, project: ${project.path}, sessionId: ${sessionId}`);

      // If current tab has an active session, release it before launching new one
      const currentTabForLaunch = tabsRef.current.find(t => t.id === targetTabId);
      const oldSessionForLaunch = currentTabForLaunch?.sessionId;
      if (oldSessionForLaunch) {
        const bgResult = await startBackgroundCompletion(oldSessionForLaunch);
        if (bgResult.started) {
          console.log(`[App] Scenario 4: AI running on ${oldSessionForLaunch}, background completion started`);
        }
        // Always release old session regardless of AI state:
        // - If BG started: Sidecar stays alive via BG owner
        // - If idle: Sidecar stops (no more owners)
        await stopSseProxy(targetTabId);
        await releaseSessionSidecar(oldSessionForLaunch, 'tab', targetTabId);
        await deactivateSession(oldSessionForLaunch);
      }

      // For new sessions (no sessionId), generate a temporary session ID
      // The actual session ID will be created by the backend when the session starts
      const effectiveSessionId = sessionId ?? createPendingSessionId(targetTabId);

      // Ensure Sidecar is running for this Session, Tab as owner.
      //
      // Pattern 4: this call resolves only after the sidecar's /health/ready
      // returns 200 — i.e. deferred init (migration / skill-seed / sdk-init)
      // has finished. If readiness times out or reports `failed`, the Rust
      // call throws with the last-observed phase embedded in the error
      // string, which we surface via `setTabErrors` → Launcher.startError.
      // For finer-grained UX (inline phase banner during the brief
      // pending → ready window) callers can use `useSessionReady`.
      // PRD 0.2.19 review fix (H2): apply pending surface to the FINAL target tab
      // (Scenario 3 may have rerouted `targetTabId` to a freshly-created tab).
      // Set BEFORE ensureSessionSidecar — the backend may emit chat:system-init
      // synchronously once readiness lands, and the target TabProvider needs to
      // consume the surface from this tabId at that moment.
      if (pendingSurfaceForLaunch) {
        setPendingSurface(targetTabId, pendingSurfaceForLaunch);
      }

      const result = await ensureSessionSidecar(effectiveSessionId, project.path, 'tab', targetTabId);
      console.log(`[App] Session Sidecar ensured: port=${result.port}, isNew=${result.isNew}`);

      // Cancel background completion AFTER Tab is registered as an owner.
      // (Order matters — calling cancel first when BG is the last owner causes
      // the sidecar to stop on the BG release, which kills any in-flight
      // streaming turn before its content can be persisted. With Tab already
      // an owner via ensureSessionSidecar above, the BG release is safe and
      // the in-flight turn keeps streaming into the new Tab's SSE.)
      if (sessionId) {
        await cancelBackgroundCompletion(sessionId);
      }

      // Activate session with Tab (for Session singleton tracking and fallback port lookup)
      // Always use effectiveSessionId to ensure session_activations has entry for this Tab
      await activateSession(effectiveSessionId, targetTabId, null, result.port, project.path, false);

      // Update tab state with effectiveSessionId (matches the Sidecar's session)
      // For new sessions, this is "pending-{tabId}" until backend creates the real session
      setTabs((prev) =>
        prev.map((t) =>
          t.id === targetTabId
            ? {
              ...t,
              agentDir: project.path,
              sessionId: effectiveSessionId,
              view: 'chat',
              title: project.displayName || getFolderName(project.path),
              // Only set initialMessage when explicitly provided (from Launcher send).
              // Omitting undefined prevents overwriting a prior initialMessage in race conditions.
              ...(initialMessage ? { initialMessage } : {}),
              joinedExistingSidecar: !result.isNew,
            }
            : t
        )
      );

      if (targetTabId !== activeTabId) {
        setActiveTabId(targetTabId);
      }
      setLoadingTabs((prev) => ({ ...prev, [targetTabId]: false }));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[App] Failed to start:', errorMsg);

      // PRD 0.2.19 review fix (H3): clear pending surface on launch failure so
      // a later unrelated session_new doesn't inherit a stale surface from this
      // failed attempt. Cover both candidate tabIds (Scenario 3 retarget case).
      clearPendingSurface(targetTabId);
      if (targetTabId !== activeTabId) clearPendingSurface(activeTabId);

      // Surface the error on the tab the user is actually looking at — when
      // the stale jump-to-tab fallthrough rerouted us to `plan.tabId`, the
      // visible tab is `targetTabId`, not the originally-active one. Writing
      // to `activeTabId` would silently drop the error on a hidden tab while
      // the user stares at a stuck loader. (Codex review WARN-2.)
      const errorTabId = targetTabId !== activeTabId ? targetTabId : activeTabId;
      setTabErrors((prev) => ({ ...prev, [errorTabId]: errorMsg }));

      // In browser dev mode, still allow navigation
      if (isBrowserDevMode()) {
        console.log('[App] Browser mode: continuing despite error');
        setTabs((prev) =>
          prev.map((t) =>
            t.id === errorTabId
              ? {
                ...t,
                agentDir: project.path,
                view: 'chat',
                title: project.displayName || getFolderName(project.path),
              }
              : t
          )
        );
      }
    } finally {
      launchingTabRef.current = null;
      setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false, [targetTabId]: false }));
    }
  }, []);

  // Clear initialMessage from a tab after it has been consumed by Chat
  const clearInitialMessage = useCallback((tabId: string) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, initialMessage: undefined } : t
    ));
  }, []);

  const clearJoinedExistingSidecar = useCallback((tabId: string) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, joinedExistingSidecar: undefined } : t
    ));
  }, []);

  // Rename session: update tab title + persist to backend + notify listeners
  const handleRenameSession = useCallback((tabId: string, newTitle: string) => {
    updateTabTitle(tabId, newTitle);
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (tab?.sessionId) {
      updateSession(tab.sessionId, { title: newTitle, titleSource: 'user' })
        .then(() => window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.SESSION_TITLE_CHANGED)))
        .catch(err => console.error('[App] Failed to persist renamed title:', err));
    }
  }, [updateTabTitle]);

  /**
   * Handle fork session: create a new tab for the forked session.
   * Called from Chat after the backend has created the forked session metadata + messages.
   */
  const handleForkSession = useCallback(async (_tabId: string, newSessionId: string, forkAgentDir: string, title: string, initialMessage?: string) => {
    // Check tab limit
    if (tabsRef.current.length >= MAX_TABS) {
      toastRef.current.error('标签页已达上限，请关闭一个后重试');
      return;
    }

    const newTab: Tab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentDir: forkAgentDir,
      sessionId: newSessionId,
      view: 'chat',
      title,
      ...(initialMessage ? { initialMessage: { text: initialMessage } } : {}),
    };

    setTabs(prev => [...prev, newTab]);
    setLoadingTabs(prev => ({ ...prev, [newTab.id]: true }));

    try {
      const result = await ensureSessionSidecar(newSessionId, forkAgentDir, 'tab', newTab.id);
      console.log(`[App] Fork tab ${newTab.id} sidecar ensured: port=${result.port}`);
      await activateSession(newSessionId, newTab.id, null, result.port, forkAgentDir, false);
      setActiveTabId(newTab.id);
    } catch (error) {
      console.error('[App] Failed to start sidecar for forked session:', error);
      setTabs(prev => prev.filter(t => t.id !== newTab.id));
    } finally {
      setLoadingTabs(prev => ({ ...prev, [newTab.id]: false }));
    }
  }, []);

  /**
   * Handle session switch from within Chat (history dropdown)
   * Implements Session singleton with all 4 scenarios
   */
  const handleSwitchSession = useCallback(async (tabId: string, sessionId: string) => {
    const switchToken = ++sessionSwitchSeqRef.current;
    latestSessionSwitchRef.current.set(tabId, { token: switchToken, sessionId });
    const isLatestSwitch = (phase: string): boolean => {
      const latest = latestSessionSwitchRef.current.get(tabId);
      const ok = shouldCommitSessionSwitch({
        requestedToken: switchToken,
        latestToken: latest?.token,
        requestedSessionId: sessionId,
        latestSessionId: latest?.sessionId,
        tabStillPresent: tabsRef.current.some(t => t.id === tabId),
      });
      if (!ok) {
        console.log(`[App] Ignoring stale session switch ${sessionId} for tab ${tabId} at ${phase}`);
      }
      return ok;
    };

    const tabsSnapshot = tabsRef.current;
    const currentTab = tabsSnapshot.find(t => t.id === tabId);

    // Fast path: Session already open in a Tab → Jump to that Tab.
    // Skip the ~100ms of runtime/activation/cron IO below if we already know we're
    // jumping. Hard-coded inputs (`multiAgentRuntime: false`, no activation, no cron
    // running) ensure this call can only return `jump-to-tab` (when an existing
    // tab matches) or `switch-current-tab` (otherwise). The `switch-current-tab`
    // result is intentionally ignored — the full re-plan below uses real values.
    const jumpPlan = planSessionOpen({
      tabs: tabsSnapshot,
      targetSessionId: sessionId,
      multiAgentRuntime: false,
      targetActivation: null,
      currentTabCronRunning: false,
    });
    if (jumpPlan.type === 'jump-to-tab') {
      console.log(`[App] handleSwitchSession Scenario 1: Session ${sessionId} already in tab ${jumpPlan.tabId}, jumping to it`);
      if (!isLatestSwitch('jump-fast-path')) {
        return;
      }
      setActiveTabId(jumpPlan.tabId);
      return;
    }

    const cfg = configRef.current;
    const currentAgentRuntime = currentTab?.agentDir
      ? normalizeRuntime(getAgentByWorkspacePath(cfg, currentTab.agentDir)?.runtime)
      : 'builtin';

    const [
      targetRuntime,
      resolvedCurrentRuntime,
      activation,
      currentTabCronTask,
    ] = await Promise.all([
      resolveSessionRuntimeForOpen(sessionId, currentAgentRuntime, cfg?.multiAgentRuntime),
      resolveSessionRuntimeForOpen(currentTab?.sessionId, currentAgentRuntime, cfg?.multiAgentRuntime),
      getSessionActivation(sessionId),
      getTabCronTask(tabId),
    ]);
    if (!isLatestSwitch('resolved-open-plan-inputs')) {
      return;
    }
    // When the current Tab has no session yet (fresh chat), there's no "current
    // session runtime" to compare against — treat target's runtime as current,
    // so cross-runtime check doesn't false-positive on an empty Tab. Mirrors
    // handleLaunchProject's identical guard.
    const currentRuntime = currentTab?.sessionId ? resolvedCurrentRuntime : targetRuntime;

    const plan = planSessionOpen({
      tabs: tabsRef.current,
      targetSessionId: sessionId,
      multiAgentRuntime: !!cfg?.multiAgentRuntime,
      currentRuntime,
      targetRuntime,
      targetActivation: activation,
      currentTabCronRunning: currentTabCronTask?.status === 'running',
    });

    if (plan.type === 'jump-to-tab') {
      console.log(`[App] handleSwitchSession Scenario 1: Session ${sessionId} already in tab ${plan.tabId}, jumping to it`);
      if (!isLatestSwitch('jump-after-plan')) {
        return;
      }
      setActiveTabId(plan.tabId);
      return;
    }

    // Scenario 1.5 (T12): Cross-runtime session → Open in NEW Tab.
    // The comparison is session-vs-session, not target session-vs-current agent:
    // an existing tab's sidecar belongs to the session it already loaded, while
    // the agent runtime is only the template for future sessions.
    if (plan.type === 'open-new-tab' && plan.reason === 'runtime-mismatch') {
      console.log(`[App] handleSwitchSession Scenario 1.5: Cross-runtime session (session=${plan.targetRuntime}, current=${plan.currentRuntime}), opening in new tab`);
      if (tabsRef.current.length >= MAX_TABS) {
        toastRef.current.error('标签页已达上限，请关闭一个后重试');
        return;
      }
      if (!currentTab?.agentDir) {
        console.error('[App] Cannot switch: current tab has no agentDir');
        return;
      }
      const newTab: Tab = {
        ...createNewTab(),
        agentDir: currentTab.agentDir,
        sessionId,
        view: 'chat',
        title: currentTab.title || getFolderName(currentTab.agentDir),
      };
      setTabs(prev => [...prev, newTab]);
      setLoadingTabs(prev => ({ ...prev, [newTab.id]: true }));
      try {
        const result = await ensureSessionSidecar(sessionId, currentTab.agentDir, 'tab', newTab.id);
        await activateSession(sessionId, newTab.id, null, result.port, currentTab.agentDir, false);
        if (!isLatestSwitch('cross-runtime-new-tab-commit')) {
          await releaseSessionSidecar(sessionId, 'tab', newTab.id).catch(err =>
            console.warn('[App] Failed to release stale cross-runtime tab owner:', err)
          );
          setTabs(prev => prev.filter(t => t.id !== newTab.id));
          return;
        }
        setTabs(prev => prev.map(t =>
          t.id === newTab.id
            ? { ...t, joinedExistingSidecar: !result.isNew }
            : t,
        ));
        setActiveTabId(newTab.id);
      } catch (error) {
        console.error('[App] Failed to open cross-runtime session in new tab:', error);
        setTabs(prev => prev.filter(t => t.id !== newTab.id));
      } finally {
        setLoadingTabs(prev => ({ ...prev, [newTab.id]: false }));
      }
      return;
    }

    // Scenario 2: Session has running cron task (no Tab) → Add Tab as owner to existing Sidecar
    if (plan.type === 'attach-existing-sidecar') {
      console.log(`[App] handleSwitchSession Scenario 2: Session ${sessionId} has cron task ${plan.taskId}`);

      // Get current tab info to find agentDir
      if (!currentTab?.agentDir) {
        console.error('[App] Cannot switch: current tab has no agentDir');
        return;
      }

      const oldSessionId = currentTab.sessionId;
      // Capture narrowed agentDir post-guard for use across await boundaries.
      const tabAgentDir: string = currentTab.agentDir;

      try {
        // Step 1: Add Tab as owner to the cron task's Sidecar FIRST
        const result = await ensureSessionSidecar(sessionId, currentTab.agentDir, 'tab', tabId);
        console.log(`[App] Tab ${tabId} added as owner to session ${sessionId} Sidecar on port ${result.port}`);
        await updateSessionTab(sessionId, tabId);

        // Step 2: Stop SSE proxy FIRST before releasing old session (avoids EOF errors)
        if (oldSessionId) {
          await stopSseProxy(tabId);
          const stopped = await releaseSessionSidecar(oldSessionId, 'tab', tabId);
          console.log(`[App] Released old session ${oldSessionId}, sidecar stopped: ${stopped}`);
        }
        if (!isLatestSwitch('attach-existing-sidecar-commit')) {
          return;
        }

        // Step 3: Update UI state (TabProvider will reconnect SSE to new Sidecar)
        //
        // Race-defensive: same reasoning as Scenario 4's setTabs — the
        // `await releaseSessionSidecar(oldSessionId, …)` above may trigger a
        // `session:sidecar-terminal` whose listener resets this tab to
        // launcher view before our setTabs runs. Explicit `view: 'chat'`,
        // `agentDir`, and `title` make this setTabs the authoritative final
        // state. (Same workspace as before — currentTab.agentDir captured
        // pre-await is stable across the switch.)
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? {
                ...t,
                sessionId,
                joinedExistingSidecar: !result.isNew,
                view: 'chat',
                agentDir: tabAgentDir,
                title: currentTab.title || getFolderName(tabAgentDir),
              }
              : t
          )
        );
      } catch (error) {
        console.error('[App] Failed to switch to cron task session:', error);
      }
      return;
    }

    // Scenario 3: Current Tab has running cron task → Create new Tab + new Sidecar
    if (plan.type === 'open-new-tab' && plan.reason === 'current-cron-running') {
      console.log(`[App] handleSwitchSession Scenario 3: Current tab ${tabId} has cron task, creating new tab`);

      // Check max tabs limit
      if (tabsRef.current.length >= MAX_TABS) {
        console.warn('[App] Cannot create new tab: max tabs reached');
        return;
      }

      // Get agentDir from current tab
      const currentTabForScenario3 = tabsRef.current.find(t => t.id === tabId);
      if (!currentTabForScenario3?.agentDir) {
        console.error('[App] Cannot switch: current tab has no agentDir');
        return;
      }

      // Create new tab
      const newTab = createNewTab();
      setTabs((prev) => [...prev, newTab]);
      setLoadingTabs((prev) => ({ ...prev, [newTab.id]: true }));

      try {
        // Ensure Sidecar for new Tab as owner of this Session
        const result = await ensureSessionSidecar(sessionId, currentTabForScenario3.agentDir, 'tab', newTab.id);
        console.log(`[App] New tab ${newTab.id} Sidecar ensured: port=${result.port}, isNew=${result.isNew}`);
        if (!isLatestSwitch('current-cron-new-tab-commit')) {
          await releaseSessionSidecar(sessionId, 'tab', newTab.id).catch(err =>
            console.warn('[App] Failed to release stale cron-switch tab owner:', err)
          );
          setTabs((prev) => prev.filter(t => t.id !== newTab.id));
          return;
        }

        // Update new tab state
        setTabs((prev) =>
          prev.map((t) =>
            t.id === newTab.id
              ? {
                ...t,
                agentDir: currentTabForScenario3.agentDir,
                sessionId,
                view: 'chat',
                title: currentTabForScenario3.title || getFolderName(currentTabForScenario3.agentDir ?? ''),
                joinedExistingSidecar: !result.isNew,
              }
              : t
          )
        );

        // Jump to new tab
        setActiveTabId(newTab.id);
        console.log(`[App] handleSwitchSession Scenario 3: Created new tab ${newTab.id} for session ${sessionId}`);
      } catch (error) {
        console.error('[App] Failed to ensure Sidecar for new tab:', error);
        // Remove the failed tab
        setTabs((prev) => prev.filter(t => t.id !== newTab.id));
      } finally {
        setLoadingTabs((prev) => ({ ...prev, [newTab.id]: false }));
      }
      return;
    }

    // Scenario 4: Normal switch
    //
    // Two sub-paths:
    // A) AI is idle → hot-swap Sidecar via upgradeSessionId (no new process)
    // B) AI is running → start background completion for old session,
    //    release Tab from old Sidecar, create new Sidecar for new session
    console.log(`[App] handleSwitchSession Scenario 4: Switching tab ${tabId} to session ${sessionId}`);

    // Get current tab info
    const currentTabForScenario4 = tabsRef.current.find(t => t.id === tabId);
    if (!currentTabForScenario4?.agentDir) {
      console.error('[App] Cannot switch: current tab has no agentDir');
      return;
    }

    const oldSessionId = currentTabForScenario4.sessionId;
    // Capture narrowed agentDir post-guard. TS loses the narrowing across the
    // many `await` boundaries below, so we re-narrow once here.
    const tabAgentDir: string = currentTabForScenario4.agentDir;

    try {
      // NOTE: cancelBackgroundCompletion is deliberately deferred to AFTER all
      // ensure-and-activate paths below. If we cancel BG here while it's the
      // last owner of the target session's sidecar, the sidecar stops, the SDK
      // subprocess dies, and any in-flight streaming turn (with thinking,
      // tool_use blocks, and pending text) never gets persisted to disk —
      // resume from history then loads only the messages saved before the
      // turn started. The fix is to register Tab as an owner first via
      // ensureSessionSidecar, then release BG safely.

      // Track whether Tab is joining a pre-existing sidecar (e.g. IM Bot session)
      // to skip automatic config sync in Chat.tsx mount
      let joinedExisting = false;

      if (oldSessionId) {
        // Check if AI is running on old session → background completion
        const bgResult = await startBackgroundCompletion(oldSessionId);

        if (bgResult.started) {
          // AI is running → old Sidecar stays alive via BG owner, create new Sidecar for target
          console.log(`[App] AI running on ${oldSessionId}, starting background completion`);
          await stopSseProxy(tabId);
          await releaseSessionSidecar(oldSessionId, 'tab', tabId);
          await deactivateSession(oldSessionId);

          // Create/reuse Sidecar for the target session
          const result = await ensureSessionSidecar(sessionId, currentTabForScenario4.agentDir, 'tab', tabId);
          await activateSession(sessionId, tabId, null, result.port, currentTabForScenario4.agentDir, false);
          joinedExisting = !result.isNew;
          console.log(`[App] Created new Sidecar for session ${sessionId} on port ${result.port}`);
        } else {
          // AI is idle → check if target session already has a sidecar (e.g., from BG completion)
          // If yes, we can't use upgradeSessionId — it would overwrite the existing sidecar
          const targetPort = await getSessionPort(sessionId);

          if (targetPort !== null) {
            // Target session has existing sidecar → release current, reconnect to existing
            console.log(`[App] Target session ${sessionId} has existing sidecar on port ${targetPort}, reconnecting`);
            await stopSseProxy(tabId);
            await releaseSessionSidecar(oldSessionId, 'tab', tabId);
            await deactivateSession(oldSessionId);
            const result = await ensureSessionSidecar(sessionId, currentTabForScenario4.agentDir, 'tab', tabId);
            await activateSession(sessionId, tabId, null, result.port, currentTabForScenario4.agentDir, false);
            joinedExisting = !result.isNew;
          } else {
            // No existing sidecar for target → hot-swap via upgradeSessionId (efficient, no new process)
            const upgraded = await upgradeSessionId(oldSessionId, sessionId);

            if (upgraded) {
              await deactivateSession(oldSessionId);
              const port = await getSessionPort(sessionId);
              if (port !== null) {
                await activateSession(sessionId, tabId, null, port, currentTabForScenario4.agentDir, false);
                console.log(`[App] Session ${sessionId} took over Sidecar from ${oldSessionId} on port ${port}`);
                // upgradeSessionId: Tab already owned this sidecar → joinedExisting stays false
              } else {
                console.warn(`[App] Port not found after upgrade, creating new Sidecar`);
                const result = await ensureSessionSidecar(sessionId, currentTabForScenario4.agentDir, 'tab', tabId);
                await activateSession(sessionId, tabId, null, result.port, currentTabForScenario4.agentDir, false);
                joinedExisting = !result.isNew;
              }
            } else {
              console.log(`[App] Sidecar upgrade failed, creating new Sidecar for session ${sessionId}`);
              await deactivateSession(oldSessionId);
              const result = await ensureSessionSidecar(sessionId, currentTabForScenario4.agentDir, 'tab', tabId);
              await activateSession(sessionId, tabId, null, result.port, currentTabForScenario4.agentDir, false);
              joinedExisting = !result.isNew;
            }
          }
        }
      } else {
        // No old Session → Create new Sidecar
        console.log(`[App] No previous session, creating new Sidecar for session ${sessionId}`);
        const result = await ensureSessionSidecar(sessionId, currentTabForScenario4.agentDir, 'tab', tabId);
        await activateSession(sessionId, tabId, null, result.port, currentTabForScenario4.agentDir, false);
        joinedExisting = !result.isNew;
      }

      // Tab is now an owner of the target session's sidecar (via every
      // ensureSessionSidecar branch above). Safe to cancel any BG completion
      // now — releasing the BG owner with Tab still attached keeps the sidecar
      // alive and the streaming turn intact.
      if (!isLatestSwitch('scenario4-before-bg-cancel')) {
        return;
      }
      await cancelBackgroundCompletion(sessionId);
      if (!isLatestSwitch('scenario4-commit')) {
        return;
      }

      // Update UI state - TabProvider will detect sessionId change and call loadSession()
      //
      // Race-defensive set: explicitly carry `view: 'chat'`, `agentDir`, and
      // `title` because the `await releaseSessionSidecar(oldSessionId, …)`
      // above may have caused Rust to drop the old sidecar (when the Tab
      // was its last owner — common for IM-bot sessions opened in a desktop
      // tab whose heartbeat owner has already moved on). That drop fires
      // `session:sidecar-terminal` for `oldSessionId`, whose listener
      // (`applyTerminalSessionToTabs`) sees a tab still pointing at the old
      // id (we haven't called this setTabs yet) and resets it to launcher
      // (sets view='launcher', sessionId=null, agentDir=null, title='New Tab').
      // If we only patched `sessionId` here the launcher fields would
      // linger via `...t` and the user would land on launcher with the new
      // sessionId attached — exactly the "click history → bounced to
      // launcher" symptom. Explicit fields make this setTabs the source of
      // truth for the post-switch tab state. (The proper title arrives
      // shortly via TabProvider.loadSession → updateTabTitle; preserving
      // the pre-switch title here avoids a transient "New Tab" flash for
      // sessions whose stored title is empty.)
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? {
              ...t,
              sessionId,
              joinedExistingSidecar: joinedExisting,
              view: 'chat',
              agentDir: tabAgentDir,
              title: currentTabForScenario4.title || getFolderName(tabAgentDir),
            }
            : t
        )
      );
      console.log(`[App] handleSwitchSession Scenario 4 complete: tab ${tabId} now on session ${sessionId}`);
    } catch (error) {
      console.error('[App] Failed to switch session:', error);
    }
  }, []);

  const handleBackToLauncher = useCallback(async () => {
    const activeTabId = activeTabIdRef.current;
    if (!activeTabId) return;

    // Get current tab to access sessionId
    const currentTab = tabsRef.current.find(t => t.id === activeTabId);

    // Step 1: Try to start background completion if AI is running
    if (currentTab?.sessionId) {
      const bgResult = await startBackgroundCompletion(currentTab.sessionId);
      if (bgResult.started) {
        console.log(`[App] Back to launcher: AI still running, background completion started for session ${currentTab.sessionId}`);
      }
    }

    // Step 2: Stop SSE proxy FIRST to avoid EOF errors when Sidecar stops
    await stopSseProxy(activeTabId);

    // Step 3: Release Tab's ownership of the Session Sidecar
    // If BackgroundCompletion or CronTask also owns it, Sidecar continues running
    if (currentTab?.sessionId) {
      try {
        // Check if this Tab has an active cron task to update associations
        const cronTask = await getTabCronTask(activeTabId);
        if (cronTask && cronTask.status === 'running') {
          // Clear tab association in cron task
          await updateCronTaskTab(cronTask.id, undefined);
          // Update session activation to remove tab_id but keep task_id
          await updateSessionTab(currentTab.sessionId, undefined);
        }

        // Release Tab's ownership - Sidecar stops only if no other owners
        const stopped = await releaseSessionSidecar(currentTab.sessionId, 'tab', activeTabId);
        console.log(`[App] Tab ${activeTabId} released session ${currentTab.sessionId}, sidecar stopped: ${stopped}`);

        // Clean up session activation (Tab no longer owns this session)
        // If cron task is active, updateSessionTab above already handled it
        if (!cronTask || cronTask.status !== 'running') {
          await deactivateSession(currentTab.sessionId);
        }
      } catch (error) {
        console.error(`[App] Error releasing session sidecar for tab ${activeTabId}:`, error);
        // Fallback to legacy stopTabSidecar
        void stopTabSidecar(activeTabId);
      }
    }

    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabId
          ? { ...t, agentDir: null, sessionId: null, view: 'launcher', title: 'New Tab' }
          : t
      )
    );
  }, []);

  /**
   * Handle "New Session" from Chat component.
   * If AI is running, starts background completion on old session and creates new Sidecar.
   * Returns true if handled (Chat should NOT call resetSession), false if AI is idle (Chat falls back to resetSession).
   */
  const handleNewSession = useCallback(async (tabId: string): Promise<boolean> => {
    const currentTab = tabsRef.current.find(t => t.id === tabId);
    if (!currentTab?.sessionId || !currentTab?.agentDir) {
      return false;
    }

    const oldSessionId = currentTab.sessionId;

    // Check if AI is running → start background completion
    const bgResult = await startBackgroundCompletion(oldSessionId);
    if (!bgResult.started) {
      // AI is idle → let Chat handle it via resetSession (more efficient, reuses Sidecar)
      return false;
    }

    // AI is running → release old Sidecar (BG owner keeps it alive), create new one
    console.log(`[App] handleNewSession: AI running on ${oldSessionId}, background completion started`);

    try {
      await stopSseProxy(tabId);
      await releaseSessionSidecar(oldSessionId, 'tab', tabId);
      await deactivateSession(oldSessionId);

      // PRD 0.2.19 cross-review fix (B4): mark the upcoming session_new as
      // 'new_chat_button' provenance. handleNewSession is the AI-running variant
      // of resetSession (user clicked "新对话" while AI was still streaming) —
      // without this, chat:system-init would fall back to 'launcher_input' and
      // silently misclassify all AI-running new-session opens.
      setPendingSurface(tabId, 'new_chat_button');

      // Create new pending session with new Sidecar
      const pendingSessionId = createPendingSessionId(tabId);
      const result = await ensureSessionSidecar(pendingSessionId, currentTab.agentDir, 'tab', tabId);
      await activateSession(pendingSessionId, tabId, null, result.port, currentTab.agentDir, false);

      // Update tab state → TabProvider will detect sessionId change and reconnect
      // Explicitly clear joinedExistingSidecar to prevent stale flag from blocking config sync
      // on the new session (e.g. user clicks "New Session" while still in IM Bot adoption window)
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? { ...t, sessionId: pendingSessionId, joinedExistingSidecar: undefined }
            : t
        )
      );
      console.log(`[App] handleNewSession: Created new Sidecar for pending session ${pendingSessionId} on port ${result.port}`);
      return true;
    } catch (error) {
      console.error('[App] handleNewSession failed:', error);
      return false;
    }
  }, []);

  // ---- Restored-tab activation (Issue #232) ---------------------------------
  // A cold restored tab carries a real sessionId/agentDir but has NO sidecar and
  // does NOT mount TabProvider (see MemoizedTabContent). The first time one
  // becomes active we lazily validate it still exists on disk, ensure its
  // sidecar + activate it, then clear `restoreState` so TabProvider mounts and
  // runs its normal SSE/loadSession flow. Dedup guard prevents the startup
  // auto-activation and a near-simultaneous user click from double-spawning.
  const restoreActivationInFlight = useRef<Set<string>>(new Set());

  // Remove a restored tab that can no longer be activated (deleted session or
  // missing/moved workspace). Always keeps ≥1 tab and re-points activeTabId.
  // Decisions are computed from the current committed list BEFORE the state
  // updates so we never call setActiveTabId inside the setTabs updater (which
  // would be a side-effecting, StrictMode-double-invoke-unsafe updater).
  const dropRestoredTab = useCallback((tabId: string) => {
    const remaining = tabsRef.current.filter((t) => t.id !== tabId);
    if (remaining.length === 0) {
      // Last tab gone → replace with a fresh launcher (never leave 0 tabs).
      const fresh = createNewTab();
      setTabs([fresh]);
      setActiveTabId(fresh.id);
      return;
    }
    setTabs((prev) => prev.filter((t) => t.id !== tabId));
    setActiveTabId((curr) => (curr === tabId ? remaining[remaining.length - 1].id : curr));
  }, []);

  // Attach an already-on-disk session to a tab WITHOUT going through
  // planSessionOpen — the planner would see the tab already holds this
  // sessionId and return `jump-to-tab`, self-jumping and never ensuring a
  // sidecar (handleLaunchProject's early return at the jump branch). This is the
  // minimal ensure→activate path for a tab that owns no prior session.
  const attachSessionToTab = useCallback(
    async (tabId: string, sessionId: string, agentDir: string): Promise<{ joinedExisting: boolean }> => {
      const result = await ensureSessionSidecar(sessionId, agentDir, 'tab', tabId);
      await activateSession(sessionId, tabId, null, result.port, agentDir, false);
      // Tab now owns the sidecar — safe to release any background-completion
      // owner that may have kept it warm.
      await cancelBackgroundCompletion(sessionId);
      return { joinedExisting: !result.isNew };
    },
    [],
  );

  // Release a sidecar owner we acquired during a restore activation that was
  // then abandoned (tab closed/switched mid-flight) or that threw partway.
  // Idempotent — releaseSessionSidecar/deactivateSession no-op for an unknown
  // owner, so it's safe even if the owner was never registered or already
  // released by performCloseTab.
  const releaseAbandonedRestore = useCallback(async (sessionId: string, tabId: string) => {
    try {
      await releaseSessionSidecar(sessionId, 'tab', tabId);
      await deactivateSession(sessionId);
    } catch (err) {
      console.error(`[App] Error releasing abandoned restore for ${sessionId}:`, err);
    }
  }, []);

  const activateRestoredTab = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab || tab.restoreState !== 'cold') return;
      if (!tab.agentDir || !tab.sessionId) { dropRestoredTab(tabId); return; }
      if (restoreActivationInFlight.current.has(tabId)) return;
      restoreActivationInFlight.current.add(tabId);
      const { sessionId, agentDir } = tab;
      try {
        // Lazy validation, decoupled from global sidecar readiness: reads
        // sessions.json + workspace dir directly via Rust.
        const ok = await canRestoreSession(sessionId, agentDir);
        // If the user closed/switched the tab during validation, bail before
        // acquiring any sidecar (nothing to release yet).
        if (isRestoreAbandoned(tabsRef.current.find((t) => t.id === tabId), sessionId, agentDir)) return;
        if (!ok) {
          console.warn(`[App] Restored tab ${tabId}: session ${sessionId} or workspace gone, dropping`);
          dropRestoredTab(tabId);
          return;
        }
        const { joinedExisting } = await attachSessionToTab(tabId, sessionId, agentDir);
        // attachSessionToTab registered Tab(tabId) as a sidecar owner. If the
        // user closed/switched the tab while we were ensuring the sidecar,
        // performCloseTab's release ran BEFORE our owner existed (no-op) → we
        // now hold an orphan. Release it ourselves rather than leak it.
        if (isRestoreAbandoned(tabsRef.current.find((t) => t.id === tabId), sessionId, agentDir)) {
          await releaseAbandonedRestore(sessionId, tabId);
          return;
        }
        // Clear restoreState → MemoizedTabContent mounts TabProvider, which
        // connects SSE and loadSession()s the history from JSONL.
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId ? { ...t, restoreState: undefined, joinedExistingSidecar: joinedExisting } : t,
          ),
        );
      } catch (err) {
        console.error(`[App] Failed to activate restored tab ${tabId}:`, err);
        // ensureSessionSidecar may have registered the owner before a later
        // await threw — release defensively so a partial acquisition can't leak.
        await releaseAbandonedRestore(sessionId, tabId);
        dropRestoredTab(tabId);
      } finally {
        restoreActivationInFlight.current.delete(tabId);
      }
    },
    [attachSessionToTab, dropRestoredTab, releaseAbandonedRestore],
  );

  const handleSelectTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
  }, []);

  // Activate a restored cold tab whenever it becomes active — via ANY path
  // (click, Cmd+Tab/Cmd+1-9, swipe, session jump, or the initial active tab on
  // startup). Centralizing on `activeTabId` rather than each switch handler is
  // pit-of-success: no activation path can forget to wake a restored tab, and
  // only the active tab spawns a sidecar at boot (the rest stay cold). The
  // in-flight guard + post-activation `restoreState` clear make it idempotent.
  useEffect(() => {
    if (!activeTabId) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab?.restoreState === 'cold') {
      void activateRestoredTab(activeTabId);
    }
  }, [activeTabId, tabs, activateRestoredTab]);

  // Clear unread indicator whenever active tab changes (covers all activation paths:
  // handleSelectTab, keyboard shortcuts, session jumps, cron navigation, etc.)
  useEffect(() => {
    if (activeTabId) {
      setTabs(prev => {
        const tab = prev.find(t => t.id === activeTabId);
        if (tab?.hasUnread) {
          return prev.map(t => t.id === activeTabId ? { ...t, hasUnread: false } : t);
        }
        return prev;
      });
    }
  }, [activeTabId]);

  // Trackpad two-finger horizontal swipe to switch tabs (follow-along animation)
  useTabSwipeGesture({ contentRef, tabsRef, activeTabIdRef, onSwitchTab: handleSelectTab });

  const handleCloseTab = useCallback((tabId: string) => {
    // Special case: If only one launcher tab, do nothing
    const currentTabs = tabsRef.current;
    const tab = currentTabs.find(t => t.id === tabId);
    if (currentTabs.length === 1 && tab?.view === 'launcher') {
      return;
    }

    void closeTabWithConfirmation(tabId);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stabilized via tabsRef
  }, []);

  const handleNewTab = useCallback(() => {
    const currentLength = tabsRef.current.length;
    if (currentLength >= MAX_TABS) {
      console.warn(`[App] Max tabs (${MAX_TABS}) reached`);
      return;
    }
    const newTab = createNewTab();
    openNewTabDeferred(newTab);

    // Track tab_new event
    track('tab_new', { tab_count: currentLength + 1 });
  }, [openNewTabDeferred]);

  // Handle tab reordering via drag and drop
  const handleReorderTabs = useCallback((activeId: string, overId: string) => {
    setTabs((prev) => {
      const oldIndex = prev.findIndex((t) => t.id === activeId);
      const newIndex = prev.findIndex((t) => t.id === overId);
      if (oldIndex === -1 || newIndex === -1) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  }, []);

  // Open Settings as a new tab (or switch to existing one)
  // Optional initialSection parameter to open a specific section (e.g., 'providers')
  // Optional initialSelect to open a specific item's detail (skill/command/agent)
  const handleOpenSettings = useCallback(async (
    initialSection?: string,
    mcpServerId?: string,
    initialSelect?: CapabilityInitialSelect,
  ) => {
    // Track settings_open event
    track('settings_open', { section: initialSection ?? null });

    // Set initial section for Settings component
    setSettingsInitialSection(initialSection);
    setSettingsInitialMcpId(mcpServerId);
    setSettingsInitialSelect(initialSelect);

    // Check if there's already a Settings tab
    const currentTabs = tabsRef.current;
    const existingSettingsTab = currentTabs.find((t) => t.view === 'settings');
    if (existingSettingsTab) {
      // Switch to existing Settings tab
      setActiveTabId(existingSettingsTab.id);
      return;
    }

    // Create new Settings tab
    if (currentTabs.length >= MAX_TABS) {
      console.warn(`[App] Max tabs (${MAX_TABS}) reached`);
      return;
    }

    // Create Tab first (instant UI response). The 5.8k-line Settings subtree
    // is a renderer-only mount with the same click-frame jank as the Launcher,
    // so it goes through the shared deferred-mount path (placeholder this
    // commit → real Settings on a transition render). settingsInitialSection
    // etc. are set urgently above, so Settings reads the right section when it
    // mounts on the transition.
    const newTab: Tab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentDir: null,
      sessionId: null,
      view: 'settings',
      title: '设置',
    };
    openNewTabDeferred(newTab);

    // Global Sidecar is now started on App mount, no need to start here
  }, [openNewTabDeferred]);

  // Listen for OPEN_SETTINGS custom event from child components
  useEffect(() => {
    const handleOpenSettingsEvent = (event: CustomEvent<{
      section?: string;
      mcpServerId?: string;
      selectItem?: CapabilityInitialSelect;
    }>) => {
      handleOpenSettings(event.detail?.section, event.detail?.mcpServerId, event.detail?.selectItem);
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_SETTINGS, handleOpenSettingsEvent as EventListener);
    return () => {
      window.removeEventListener(CUSTOM_EVENTS.OPEN_SETTINGS, handleOpenSettingsEvent as EventListener);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- callback stabilized via tabsRef
  }, []);

  // Open TaskCenter as a singleton tab (mirrors handleOpenSettings)
  const handleOpenTaskCenter = useCallback(() => {
    const currentTabs = tabsRef.current;
    const existing = currentTabs.find((t) => t.view === 'taskcenter');
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    if (currentTabs.length >= MAX_TABS) {
      console.warn(`[App] Max tabs (${MAX_TABS}) reached`);
      return;
    }
    const newTab: Tab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentDir: null,
      sessionId: null,
      view: 'taskcenter',
      title: '任务中心',
    };
    openNewTabDeferred(newTab);
  }, [openNewTabDeferred]);

  // Intent carried across `OPEN_TASK_CENTER` — the event dispatcher
  // (Launcher "我的任务" tab's search icon) wants more than just "open
  // the tab": it wants the Task Center's search box focused on arrival.
  // Propagating via a direct `window` listener in TaskListPanel misses
  // the first-mount case (the event fires before the tab exists), so
  // we stash the intent in state here and pass it down as a prop.
  //
  // Intent lifecycle (cross-review C2):
  //   1. Every event overwrites state — including with `null` when the
  //      event carries no focus request. Otherwise a stale intent from
  //      an earlier search path would persist and trigger unexpected
  //      focus when the user later opens Task Center via the titlebar
  //      icon or any other entry.
  //   2. Each intent gets a monotonically-increasing `nonce` (not
  //      `Date.now()`) so back-to-back same-millisecond firings still
  //      produce distinct dep-array values for the consuming effect.
  //      `useRef + ++` is cheap and collision-free.
  const taskCenterIntentCounterRef = useRef(0);
  const [taskCenterPendingIntent, setTaskCenterPendingIntent] = useState<
    { autofocusSearch?: boolean; nonce: number } | null
  >(null);

  // Listen for OPEN_TASK_CENTER custom event from child components
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { autofocusSearch?: boolean }
        | undefined;
      if (detail?.autofocusSearch) {
        taskCenterIntentCounterRef.current += 1;
        setTaskCenterPendingIntent({
          autofocusSearch: true,
          nonce: taskCenterIntentCounterRef.current,
        });
      } else {
        // Non-focus open (titlebar icon, Chat 新建 dispatch, etc.) —
        // clear any lingering search intent so returning to Task Center
        // doesn't auto-focus the search field unexpectedly.
        setTaskCenterPendingIntent(null);
      }
      handleOpenTaskCenter();
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_TASK_CENTER, handler);
    return () => window.removeEventListener(CUSTOM_EVENTS.OPEN_TASK_CENTER, handler);
  }, [handleOpenTaskCenter]);

  // One-shot legacy CronTask → Task sweep at app startup (PRD §11.4,
  // v0.1.69 UX round). The Launcher's 「我的任务」 tab reads new-model
  // Task[] — users who never open the Task Center page would see an
  // empty list even though they have legacy crons on disk. Running the
  // upgrade sweep here (not inside TaskListPanel's mount) guarantees
  // the data is ready before the Launcher is user-visible.
  //
  // Guards:
  //   - taskCenterAvailable() — Tauri-only, silent no-op in browser dev
  //   - configProjects.length > 0 — eligibility check needs workspace
  //     resolution; Config loads async, so we wait for projects to
  //     populate before sweeping
  //   - useRef one-shot — only run once per session; refocusing the
  //     window or a user navigating won't re-trigger the work
  const startupSweepDoneRef = useRef(false);
  useEffect(() => {
    if (startupSweepDoneRef.current) return;
    if (configProjects.length === 0) return;
    startupSweepDoneRef.current = true;
    void (async () => {
      try {
        const { sweepAppStartupLegacyCrons } = await import(
          '@/components/task-center/legacyUpgrade'
        );
        const stats = await sweepAppStartupLegacyCrons(configProjects);
        if (stats.upgraded > 0) {
          console.info(
            `[legacy-sweep] upgraded ${stats.upgraded} legacy cron(s) at startup ` +
              `(skipped ${stats.skippedIneligible} ineligible, ${stats.failed} failed)`,
          );
        }
      } catch (err) {
        console.warn('[legacy-sweep] startup sweep crashed:', err);
      }
    })();
  }, [configProjects]);

  // PRD §8.3 — "AI 讨论" flow. Open a new Chat tab, auto-dispatch the
  // `/task-alignment` skill with the thought content + instructions to call
  // `myagents task create-from-alignment` at the end.
  useEffect(() => {
    const handler = async (raw: Event) => {
      const event = raw as CustomEvent<{
        thoughtId: string;
        content: string;
        tags: string[];
        /** Explicit workspace pick from the ThoughtCard popover (v0.1.69
         *  polish). When present we use it directly; when absent (old
         *  callers or programmatic triggers) we fall back to the smart
         *  tag→project match so behavior degrades gracefully. */
        workspaceId?: string;
      }>;
      const { thoughtId, content, tags, workspaceId } = event.detail ?? {
        thoughtId: '',
        content: '',
        tags: [],
      };
      if (!thoughtId || !content) return;

      try {
        const currentTabs = tabsRef.current;
        if (currentTabs.length >= MAX_TABS) {
          toastRef.current?.error(`已达标签页上限（${MAX_TABS} 个），请先关闭一个再开始 AI 讨论`);
          return;
        }

        const projects = configProjectsRef.current.filter((p) => !p.internal);
        if (projects.length === 0) {
          toastRef.current?.error('还没有工作区，无法开始 AI 讨论');
          return;
        }
        // Prefer the explicit pick; fall back to smart default for legacy
        // callers / programmatic use.
        const lowerTags = tags.map((t) => t.toLowerCase());
        const workspace =
          (workspaceId ? projects.find((p) => p.id === workspaceId) : undefined) ??
          projects.find((p) => lowerTags.includes(p.name.toLowerCase())) ??
          projects[0];

        // PRD 0.2.3: 从前端唯一 builtin selection helper 解析出成对的 (provider, model)。
        // 早期实现直接吃 config.defaultProviderId、跳过 workspace/agent 两层，导致
        //   provider = openrouter（全局默认）+ model = claude-opus（agent snapshot）
        // 这种 (provider X, model Y) 错配，触发 API key 验证失败。
        // helper 优先级：agent → workspace → defaultProviderId → first available，
        //   每层 isProviderAvailable 检查；返回的 model 一定 ∈ provider.models。
        const workspaceAgent = workspace.agentId && configRef.current
          ? getAgentById(configRef.current, workspace.agentId)
          : undefined;
        const sel = resolveBuiltinSelection(
          { agent: workspaceAgent, workspace },
          configRef.current!,
          appProvidersRef.current,
          appApiKeysRef.current,
          appProviderVerifyStatusRef.current,
        );
        if (!sel) {
          toastRef.current?.error('未配置可用模型供应商，无法开始 AI 讨论');
          return;
        }

        // Pre-mint the alignment session id (CC review W8) so the AI doesn't
        // have to infer a placeholder. This becomes the subdir under
        // `~/.myagents/tasks/<id>/` where alignment.md/task.md/verify.md/
        // progress.md land, and the exact value the
        // `task create-from-alignment` CLI takes (it renames that directory
        // to `~/.myagents/tasks/<newTaskId>/` on promotion).
        //
        // v0.1.69 relocation: the task-alignment skill writes via the `Write`
        // tool using the absolute home-dir path (task docs moved out of the
        // workspace so moving/renaming the workspace doesn't orphan them).
        const alignmentSessionId = `align-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

        // Persist the workspace/thought context to
        // `~/.myagents/tasks/<alignmentSessionId>/metadata.json` so that
        // when the AI later calls `myagents task create-from-alignment`
        // it only needs to pass `--name`; the backend inherits the rest
        // from this file. Without this, the AI had to re-type 3 long
        // UUIDs that it already had in its prompt context — fragile
        // (one typo → task hung on wrong workspace, silently).
        // Fire-and-forget is safe: the prompt still carries the same
        // context as a fallback, so even if the write fails the AI can
        // pass the params explicitly and the flow still works.
        if (isTauriEnvironment()) {
          try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('cmd_task_write_alignment_metadata', {
              alignmentSessionId,
              workspaceId: workspace.id,
              workspacePath: workspace.path,
              sourceThoughtId: thoughtId,
            });
          } catch (err) {
            console.warn(
              '[App] OPEN_AI_DISCUSSION: write alignment metadata failed, AI will need to pass params explicitly:',
              err,
            );
          }
        }

        // Prompt stays minimal by design — operational details (how to
        // write the four docs, when to call `create-from-alignment`, what
        // each of the 4 discussion outcomes looks like, CLI syntax) ALL
        // live in `bundled-skills/task-alignment/SKILL.md`. The prompt
        // only carries per-conversation data the skill can't know: the
        // original thought text + four context-parameter values. Fewer
        // instructions here means the AI doesn't get steered into "write
        // files first" before the alignment dialog actually happens.
        const alignmentPrompt = [
          '我有一个想法希望进行讨论，请使用 Skill `/task-alignment` 与我讨论对齐。',
          '本次上下文参数：',
          `- alignmentSessionId: ${alignmentSessionId}`,
          `- workspaceId: ${workspace.id}`,
          `- workspacePath: ${workspace.path}`,
          `- sourceThoughtId: ${thoughtId}`,
          '',
          '[我的想法]',
          content,
        ].join('\n');

        const initialMessage: InitialMessage = {
          text: alignmentPrompt,
          builtinSelection: { providerId: sel.provider.id, model: sel.model },
        };

        // Pre-seed the tab as a Chat tab before awaiting sidecar startup.
        // Without this, the user sees the Launcher briefly while
        // handleLaunchProject waits on ensureSessionSidecar, then the tab
        // "jumps" to Chat. createPendingSessionId is deterministic
        // (`pending-<tabId>`), so handleLaunchProject's internal call
        // resolves to the same id and its later setTabs is a no-op for
        // view/agentDir/sessionId.
        const newTab = createNewTab();
        const seeded = {
          ...newTab,
          view: 'chat' as const,
          agentDir: workspace.path,
          sessionId: createPendingSessionId(newTab.id),
          title: '任务讨论',
          initialMessage,
        };
        setTabs((prev) => [...prev, seeded]);
        setActiveTabId(newTab.id);
        activeTabIdRef.current = newTab.id;

        await handleLaunchProject(
          workspace,
          undefined,
          initialMessage,
        );

        // handleLaunchProject's internal setTabs overwrites `title` with the
        // workspace display name. Restore the "任务讨论" title afterwards so
        // the tab consistently reads as a discussion session, not the
        // workspace's generic name.
        setTabs((prev) =>
          prev.map((t) =>
            t.id === newTab.id ? { ...t, title: '任务讨论' } : t,
          ),
        );
      } catch (err) {
        console.error('[App] OPEN_AI_DISCUSSION failed:', err);
      }
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_AI_DISCUSSION, handler);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.OPEN_AI_DISCUSSION, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable via refs
  }, []);

  // Listen for OPEN_SESSION_IN_NEW_TAB — task center's 任务执行 session list
  // dispatches this to open a historical execution in a fresh chat tab.
  //
  // Forces a NEW tab unconditionally. An earlier version delegated to
  // `handleLaunchProject` which falls back to the active tab in its common
  // Scenario 4 branch — that could silently replace the user's current
  // chat session if they clicked a row while inside another Chat tab.
  // We pre-seed a new tab here (mirroring OPEN_AI_DISCUSSION's approach)
  // so the user always lands in a fresh tab and their active session stays
  // put. Failures surface as toasts, not silent console.warn — otherwise
  // the click looks dead and the user has no signal.
  useEffect(() => {
    const handler = async (raw: Event) => {
      const event = raw as CustomEvent<{
        sessionId: string;
        workspacePath: string;
      }>;
      const { sessionId, workspacePath } = event.detail ?? {};
      if (!sessionId || !workspacePath) return;

      const workspace = configProjectsRef.current.find(
        (p) => p.path === workspacePath,
      );
      if (!workspace) {
        toastRef.current?.error('找不到对应的工作区，可能已被删除');
        return;
      }

      if (tabsRef.current.length >= MAX_TABS) {
        toastRef.current?.error(`已达 Tab 上限 (${MAX_TABS})，请先关闭一个 Tab`);
        return;
      }

      // Pre-seed a chat tab with the target session id so the user lands
      // directly in Chat view, not Launcher. `handleLaunchProject` below
      // uses `activeTabIdRef.current` as its target; we've just updated
      // that to the new tab so no existing tab gets hijacked.
      const newTab = createNewTab();
      const seeded = {
        ...newTab,
        view: 'chat' as const,
        agentDir: workspace.path,
        sessionId,
      };
      setTabs((prev) => [...prev, seeded]);
      setActiveTabId(newTab.id);
      activeTabIdRef.current = newTab.id;

      try {
        await handleLaunchProject(workspace, sessionId);
      } catch (err) {
        console.error('[App] OPEN_SESSION_IN_NEW_TAB failed:', err);
        toastRef.current?.error('打开 session 失败，请稍后重试');
      }
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB, handler);
    return () =>
      window.removeEventListener(
        CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB,
        handler,
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable via refs
  }, []);

  // Listen for JUMP_TO_TAB custom event (Session singleton constraint)
  useEffect(() => {
    const handleJumpToTab = (event: CustomEvent<{ targetTabId: string; sessionId: string }>) => {
      const { targetTabId, sessionId } = event.detail;
      console.log(`[App] Jump to tab ${targetTabId} for session ${sessionId}`);
      // Check if target Tab exists
      const targetTab = tabsRef.current.find(t => t.id === targetTabId);
      if (targetTab) {
        setActiveTabId(targetTabId);
      } else {
        console.warn(`[App] Target tab ${targetTabId} not found, cannot jump`);
      }
    };
    window.addEventListener(CUSTOM_EVENTS.JUMP_TO_TAB, handleJumpToTab as EventListener);
    return () => {
      window.removeEventListener(CUSTOM_EVENTS.JUMP_TO_TAB, handleJumpToTab as EventListener);
    };
  }, []);

  // Listen for LAUNCH_BUG_REPORT custom event (AI-powered bug reporting)
  useEffect(() => {
    const handleLaunchBugReport = async (event: CustomEvent<{
      description: string;
      providerId?: string;
      model?: string;
      appVersion: string;
      images?: ImageAttachment[];
      resumeSessionId?: string;
    }>) => {
      const { description, appVersion, providerId, model, resumeSessionId } = event.detail;
      try {
        // Resume path runs FIRST and out-of-order with the MAX_TABS guard:
        // if the helper session is already owned by another Tab, we just
        // jump there (Session : Tab = 1:1 invariant), which doesn't consume
        // a Tab slot — so MAX_TABS shouldn't block it.
        if (resumeSessionId) {
          const existing = tabsRef.current.find(t => t.sessionId === resumeSessionId);
          if (existing) {
            if (activeTabIdRef.current !== existing.id) {
              setActiveTabId(existing.id);
              activeTabIdRef.current = existing.id;
            }
            return;
          }
          // No existing owner — we'll need a fresh Tab. Apply MAX_TABS now.
          if (tabsRef.current.length >= MAX_TABS) {
            console.warn(`[App] Max tabs (${MAX_TABS}) reached, cannot resume helper session`);
            return;
          }
          const project = await ensureSelfAwarenessWorkspace(
            configProjectsRef.current,
            configAddProject,
            configPatchProject,
          );
          if (!project) {
            console.error('[App] ensureSelfAwarenessWorkspace returned null');
            return;
          }
          // Pre-create a Tab so handleLaunchProject's `switch-current-tab`
          // default doesn't overwrite the Settings tab (which IS the active
          // tab when the inbox dispatches). Then reap it post-call if the
          // planner chose `open-new-tab` (handleLaunchProject creates its
          // own Tab internally for that branch and our pre-created one is
          // left empty).
          const newTab = createNewTab();
          setTabs((prev) => [...prev, newTab]);
          setActiveTabId(newTab.id);
          activeTabIdRef.current = newTab.id;
          try {
            await handleLaunchProject(project, resumeSessionId, undefined);
          } finally {
            setTabs((prev) => {
              const created = prev.find(t => t.id === newTab.id);
              if (created && !created.sessionId && !created.agentDir) {
                return prev.filter(t => t.id !== newTab.id);
              }
              return prev;
            });
          }
          return;
        }

        if (tabsRef.current.length >= MAX_TABS) {
          console.warn(`[App] Max tabs (${MAX_TABS}) reached, cannot open bug report`);
          return;
        }

        // Ensure ~/.myagents registered as internal project
        // (CLAUDE.md + skills are synced at startup via cmd_sync_admin_agent)
        const project = await ensureSelfAwarenessWorkspace(
          configProjectsRef.current,
          configAddProject,
          configPatchProject,
        );
        if (!project) {
          console.error('[App] ensureSelfAwarenessWorkspace returned null');
          return;
        }

        // Two paths to a paired (provider, model):
        //   A. Explicit picker (BugReportOverlay): caller supplied (providerId, model)
        //      and the provider is still available — honor via pairBuiltinSelection.
        //   B. Implicit (Chat error banner / Settings mcp dialog) OR explicit-but-
        //      provider-unavailable: resolve via priority chain
        //      (helperAgent → helperProject → defaultProviderId → first available),
        //      each layer guarded by isProviderAvailable.
        // Always pass an explicit builtinSelection (when any provider is available)
        // so Chat tab autoSend doesn't race against the invalid-model correction
        // useEffect when helper Agent's persisted (provider, model) has gone stale.
        let builtinSelection: { providerId: string; model: string } | undefined;
        if (providerId) {
          const provider = appProvidersRef.current.find(p => p.id === providerId);
          if (provider && isProviderAvailable(
            provider,
            appApiKeysRef.current,
            appProviderVerifyStatusRef.current,
          )) {
            builtinSelection = pairBuiltinSelection(provider, model);
          }
        }
        if (!builtinSelection) {
          const helperAgent = project.agentId && configRef.current
            ? getAgentById(configRef.current, project.agentId)
            : undefined;
          const sel = resolveBuiltinSelection(
            { agent: helperAgent, workspace: project },
            configRef.current!,
            appProvidersRef.current,
            appApiKeysRef.current,
            appProviderVerifyStatusRef.current,
          );
          if (sel) {
            builtinSelection = { providerId: sel.provider.id, model: sel.model };
          }
          // else: no provider available system-wide — let Chat tab show its
          // empty-state guidance ("请先设置模型服务").
        }

        const initialMessage: InitialMessage = {
          text: buildSupportPrompt(description, appVersion),
          ...(builtinSelection ? { builtinSelection } : {}),
          images: event.detail.images,
        };

        const newTab = createNewTab();
        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(newTab.id);
        activeTabIdRef.current = newTab.id;

        await handleLaunchProject(project, undefined, initialMessage);

        // Override tab title
        setTabs((prev) =>
          prev.map((t) =>
            t.id === newTab.id ? { ...t, title: '问题诊断' } : t
          )
        );
      } catch (err) {
        console.error('[App] Failed to launch bug report:', err);
      }
    };
    const listener = ((e: Event) => { void handleLaunchBugReport(e as CustomEvent); }) as EventListener;
    window.addEventListener(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, listener);
    return () => {
      window.removeEventListener(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, listener);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stabilized via refs, configAdd/patchProject are stable useCallbacks
  }, [configAddProject, configPatchProject]);

  // Note: CRON_TASK_STOPPED event listener removed
  // With Session-centric Sidecar (Owner model), stopping a cron task only releases
  // the CronTask owner. If Tab still owns the Sidecar, it continues running.
  // No SSE reconnection or Sidecar restart is needed.

  // Stable callback for Settings onSectionChange — avoids inline arrow creating new ref every render
  const handleSettingsSectionChange = useCallback(() => {
    setSettingsInitialSection(undefined);
    setSettingsInitialMcpId(undefined);
    setSettingsInitialSelect(undefined);
  }, []);

  // System tray event handling (minimize to tray, exit confirmation)
  useTrayEvents({
    minimizeToTray: config.minimizeToTray,
    onOpenSettings: () => handleOpenSettings('general'),
    onCmdWCloseTab: () => {
      // Cmd+W bottom: overlay → split → tab → launcher → STOP.
      closeCurrentTab(); // Last tab auto-creates launcher; launcher is a no-op.
    },
    onExitRequested: async () => {
      // Check for running cron tasks
      try {
        const tasks = await getAllCronTasks();
        const runningTasks = tasks.filter(t => t.status === 'running');

        if (runningTasks.length > 0) {
          // Show confirmation dialog
          return new Promise<boolean>((resolve) => {
            setExitConfirmState({
              runningTaskCount: runningTasks.length,
              resolve,
            });
          });
        }
      } catch (error) {
        console.error('[App] Failed to check cron tasks:', error);
      }

      // No running tasks, allow exit
      return true;
    },
  });

  // Listen for notification clicks. Rust emits this from two paths:
  // - Windows: directly from the WinRT toast `Activated` callback
  // - macOS / Linux: when the front-end calls `cmd_consume_notification_click`
  //   on focus-regain (handled inside `useTrayEvents`)
  // Both converge here so tab routing has one entry point.
  useEffect(() => {
    if (!isTauriEnvironment()) return;
    const ac = new AbortController();
    void listenWithCleanup<{ tabId: string }>(
      'notification:click',
      (event) => {
        const { tabId } = event.payload;
        if (!tabId) return;
        const exists = tabsRef.current.some((t) => t.id === tabId);
        if (exists) {
          console.log('[App] notification:click → handleSelectTab', tabId);
          handleSelectTab(tabId);
        } else {
          console.warn('[App] notification:click for missing tab:', tabId);
        }
      },
      ac.signal,
    );
    return () => ac.abort();
  }, [handleSelectTab]);

  return (
    <LinkContextMenuProvider>
    <div className="flex h-screen flex-col bg-[var(--paper)]">
      {/* Chrome-style titlebar with tabs */}
      <CustomTitleBar
        onSettingsClick={handleOpenSettings}
        onOpenBugReport={() => setShowBugReport(true)}
        updateReady={updateReady}
        updateVersion={updateVersion}
        updateInstalling={updateInstalling}
        updatePreparing={updatePreparing}
        onRestartAndUpdate={() => void handleRestartAndUpdate()}
      >
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={handleSelectTab}
          onCloseTab={handleCloseTab}
          onNewTab={handleNewTab}
          onReorderTabs={handleReorderTabs}
        />
      </CustomTitleBar>

      {/* Tab content - only Chat views need TabProvider for sidecar communication */}
      <div ref={contentRef} className="relative flex-1 overflow-hidden">
        {tabs.map((tab) => (
          <MemoizedTabContent
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            isLoading={loadingTabs[tab.id] ?? false}
            error={tabErrors[tab.id] ?? null}
            isDeferredMount={deferredMountTabIds.has(tab.id)}
            onLaunchProject={handleLaunchProject}
            onBack={handleBackToLauncher}
            onSwitchSession={handleSwitchSession}
            onNewSession={handleNewSession}
            onUpdateGenerating={updateTabGenerating}
            onUpdateTitle={updateTabTitle}
            onUpdateUnread={updateTabUnread}
            onRenameSession={handleRenameSession}
            onForkSession={handleForkSession}
            onUpdateSessionId={updateTabSessionId}
            onClearInitialMessage={clearInitialMessage}
            onClearJoinedExistingSidecar={clearJoinedExistingSidecar}
            settingsInitialSection={tab.view === 'settings' ? settingsInitialSection : undefined}
            settingsInitialMcpId={tab.view === 'settings' ? settingsInitialMcpId : undefined}
            settingsInitialSelect={tab.view === 'settings' ? settingsInitialSelect : undefined}
            onSettingsSectionChange={handleSettingsSectionChange}
            updateReady={updateReady}
            updateVersion={updateVersion}
            updateChecking={updateChecking}
            updateDownloading={updateDownloading}
            updateInstalling={updateInstalling}
            updatePreparing={updatePreparing}
            onCheckForUpdate={checkForUpdate}
            onRestartAndUpdate={handleRestartAndUpdate}
            taskCenterPendingIntent={taskCenterPendingIntent}
          />
        ))}
      </div>

      {/* Exit confirmation dialog for running cron tasks */}
      {exitConfirmState && (
        <ConfirmDialog
          title="退出应用"
          message={`有 ${exitConfirmState.runningTaskCount} 个循环任务正在运行中。退出后任务将被停止。确定要退出吗？`}
          confirmText="退出"
          cancelText="取消"
          confirmVariant="danger"
          onConfirm={() => {
            exitConfirmState.resolve(true);
            setExitConfirmState(null);
          }}
          onCancel={() => {
            exitConfirmState.resolve(false);
            setExitConfirmState(null);
          }}
        />
      )}

      {/* Windows: startup dialog for pending update from previous session.
          Hidden while a silent download is replacing the pending bytes —
          confirming "安装" mid-replacement could land on inconsistent
          cache/disk state. Comes back into view automatically when the
          download completes (the dialog reads pendingUpdateOnStartup, which
          is unchanged; only the visibility gate is `updatePreparing`). */}
      {pendingUpdateOnStartup && !updatePreparing && (
        <ConfirmDialog
          title="发现新版本"
          message={`最新版本 v${pendingUpdateOnStartup} 已下载完成，是否立即安装？`}
          confirmText="安装"
          cancelText="稍后"
          confirmVariant="primary"
          onConfirm={() => {
            dismissPendingUpdate();
            // Route through handleRestartAndUpdate so toast feedback fires
            // on failure modes (network error / version mismatch).
            void handleRestartAndUpdate();
          }}
          onCancel={dismissPendingUpdate}
        />
      )}

      {/* Bug report overlay triggered from titlebar feedback button */}
      {showBugReport && (
        <BugReportOverlay
          onClose={() => setShowBugReport(false)}
          onNavigateToProviders={() => { setShowBugReport(false); handleOpenSettings('providers'); }}
          appVersion={appVersion}
          providers={appProviders}
          apiKeys={appApiKeys}
          providerVerifyStatus={appProviderVerifyStatus}
          initialProviderId={helperAgentDefaults.initialProviderId}
          initialModel={helperAgentDefaults.initialModel}
          onModelChange={helperAgentDefaults.onModelChange}
        />
      )}
    </div>
    </LinkContextMenuProvider>
  );
}
