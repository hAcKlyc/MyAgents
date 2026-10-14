import { APP_BUILD_PROFILE } from '../shared/appProfile';
import { DEFAULT_SPACE_ID } from '@/api/spaceCloud';
import { startAgentNetworkStore } from '@/features/agent-network/store';
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

import {
  initAnalytics,
  hashPrivateIdentity,
  track,
  setAnalyticsContext,
  clearAnalyticsContext,
  setPendingSessionBirth,
  clearPendingSessionBirth,
  birthContextForSurface,
  hashAgentName,
  hashAgentNameSync,
} from '@/analytics';
import {
  forwardRecordAnalyticsMilestone,
  type RecordAnalyticsMilestone,
} from '@/analytics/recordMilestones';
import type {
  AssistantEntry,
  EntryIntent,
  HistoryEntrySource,
  PendingSessionBirthContext,
  Surface,
} from '@/analytics';
import {
  stopTabSidecar,
  startGlobalSidecar,
  initGlobalSidecarReadyPromise,
  markGlobalSidecarReady,
  ensureSessionSidecar,
  releaseTabSession,
  reconcileSessionTabActivation,
  upgradeSessionId,
  hasSessionSidecar,
  getSessionGeneration,
  stopSseProxy,
  startBackgroundCompletion,
  startBackgroundCompletionForDeletion,
  canRestoreSession,
  getUserSchedulerLifecycleSnapshot,
  querySessionHasPersistentOwners,
  sessionHasPersistentOwners,
  setAppActiveCorrelation,
} from '@/api/tauriClient';
import ConfirmDialog from '@/components/ConfirmDialog';
import BugReportOverlay from '@/components/BugReportOverlay';
import { DispatchTaskDialog } from '@/components/task-center/DispatchTaskDialog';
import CustomTitleBar from '@/components/CustomTitleBar';
import GlobalSidebar from '@/components/global-sidebar/GlobalSidebar';
import LinkContextMenuProvider from '@/components/LinkContextMenuProvider';
import TabBar from '@/components/TabBar';
import { SessionDeletionContext } from '@/context/SessionDeletionContext';
import type { AdoptMigratedSessionOptions } from '@/context/TabContext';
import { useToast } from '@/components/Toast';
import type { HelperRequestDetail } from '@/utils/dispatchHelperRequest';
import { useUpdater } from '@/hooks/useUpdater';
import { useTrayEvents } from '@/hooks/useTrayEvents';
import { useHelperAgentModelDefaults } from '@/hooks/useHelperAgentModelDefaults';
import { useConfig } from '@/hooks/useConfig';
import { useSpaceBuildCapability } from '@/hooks/useSpaceBuildCapability';
import { useTabSwipeGesture } from '@/hooks/useTabSwipeGesture';
import { actions as taskCenterActions } from '@/hooks/taskCenterStore';
import { isProjectVisibleToUser, type Project } from '@/config/types';
import {
  type Tab,
  type ChatTab,
  type RecordTab,
  type CapabilitySection,
  type InitialMessage,
  type LaunchSessionBirthHint,
  type SidecarConfigDisposition,
  type FilePreviewIntent,
  createNewTab,
  getFolderName,
  buildChatFlipPatch,
  generateTabId,
  MAX_TABS,
} from '@/types/tab';
import { BuiltinTabSlot } from '@/tab-workspace/BuiltinTabSlot';
import {
  builtinTabModules,
  builtinTabWorkspacePolicy,
  composeBuiltinTabBindings,
  composeBuiltinTabLifecycle,
  type BuiltinTabBindings,
} from '@/tab-workspace/builtinComposition';
import { useTabWorkspaceController } from '@/tab-workspace/useTabWorkspaceController';
import {
  isRecordingSnapshotOlder,
  recordingSnapshotFromTab,
  recordingTabProjection,
  sameRecordingTabProjection,
} from '@/features/record/tabProjection';
import { createChatTabLifecycle } from '@/features/chat/tabLifecycle';
import { useRecordTabLifecycle } from '@/features/record/useRecordTabLifecycle';
import { useTabCloseController } from '@/tab-workspace/useTabCloseController';
import {
  buildRestoredTabs,
  saveOpenTabs,
  hydratePersistedState,
  pickDurableOverride,
  shouldOfferRestore,
  planRestoreTabs,
} from '@/utils/tabPersistence';
import {
  persistOpenTabsDurable,
  loadAndClearOpenTabsDurable,
  clearOpenTabsDurable,
} from '@/utils/tabPersistenceDurable';
import { consumeCleanExitMarker } from '@/utils/lastExitMarker';
import { perfMark } from '@/utils/perfMark';
import { RENDERER_PERF_PHASE } from '../shared/perfTrace';
import {
  type CronRecoverySummaryPayload,
  type CronTaskRecoveredPayload,
  CRON_EVENTS,
} from '@/types/cronEvents';
import { isBrowserDevMode, isTauriEnvironment } from '@/utils/browserMock';
import { apiGetJson } from '@/api/apiFetch';
import {
  recordingSnapshot,
  recordingStart,
  recordingStop,
} from '@/api/recording';
import { recordGet } from '@/api/taskCenter';
import { createSession, getSessions, updateSession } from '@/api/sessionClient';
import { dismissTopmost } from '@/utils/closeLayer';
import { dispatchAppShortcut } from '@/utils/appShortcuts';
import { handleSelectAllKeydown } from '@/utils/selectAllRouter';
import {
  forceFlushLogs,
  setLogServerReady,
  clearLogServerUrl,
  setAppActiveTabId,
} from '@/utils/frontendLogger';
import {
  resolveEffectiveRuntime,
  planSessionOpen,
  sessionRuntimeIdentityFromMetadataForOpen,
} from '@/utils/sessionOpenPlan';
import { resolveNotificationClickRoute } from '@/utils/notificationClickRoute';
import { projectProvidersForRuntime } from '@/utils/runtimeProviderProjection';
import {
  acknowledgeNotificationBadgeTarget,
  buildSessionNotificationBadgeCounts,
  countNotificationBadgeItems,
  isNotificationBadgeTargetVisible,
  normalizeNotificationBadgeIncrementPayload,
  upsertNotificationBadgeItem,
  type NotificationBadgeIncrementPayload,
  type NotificationBadgeItem,
  type NotificationBadgeTarget,
} from '@/utils/notificationBadgeRegistry';
import { resetTabToLauncher } from '@/utils/sessionTermination';
import {
  createSessionResourceTransitionState,
  deleteSessionThroughAppOwner,
  isSessionOpening,
  tryClaimSessionResourceTransition,
} from '@/utils/sessionDeletionCoordinator';
import { getSessionDisplayText } from '@/utils/sessionDisplay';
import { listenWithCleanup } from '@/utils/tauriListen';
import { migrateFloatingBallSessionBinding } from '@/floating-ball/sessionBinding';
import {
  CUSTOM_EVENTS,
  createPendingSessionId,
  isPendingSessionId,
} from '../shared/constants';
import { TASK_ALIGNMENT_SKILL_REQUIREMENT } from '../shared/systemSkills';
import type {
  PreparedTaskDiscussion,
  TaskCreateIntent,
  TaskCreateRequest,
  TaskDiscussionRequest,
} from '../shared/taskDiscussion';
import {
  normalizeOfficialToolIds,
  type OfficialToolId,
} from '../shared/official-tools';
import {
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  getManagedCodexProviderReadiness,
} from '../shared/config-types';
import { workspacePathsEqual } from '../shared/workspacePath';
import type { CapabilityInitialSelect } from '../shared/skillsTypes';
import {
  ensureSelfAwarenessWorkspace,
  resolveBuiltinSelection,
  pairBuiltinSelection,
  isProviderAvailable,
} from '@/config/configService';
import {
  getProjectAgent,
  getAgentById,
} from '@/config/services/agentConfigService';
import type { SessionMetadata } from '@/api/sessionClient';
import {
  runtimeSourceForRuntimeType,
  type RuntimeSource,
  type RuntimeType,
} from '../shared/types/runtime';
import type {
  RecordingChange,
  RecordingSnapshot,
  RecordingSourceSelection,
} from '../shared/types/record';
import {
  agentUsesManagedCodexProvider,
  createRuntimeBackedProviderIdentity,
  isRuntimeBackedProvider,
  toProviderExecutionIntent,
  type RuntimeBackedProviderIdentity,
} from '../shared/providerExecution';
import {
  originAnalyticsFields,
  originFromDesktopSurface,
  originFromSessionMetadataLike,
} from '../shared/session-origin';
import { buildRuntimeBackedInitialSessionBirth } from '@/utils/providerSwitchSessionBirth';
import { resolveGlobalSidebarWorkspace } from '@/utils/globalSidebarProjection';
import {
  createInitialMainWindowPresentation,
  reduceMainWindowPresentation,
} from '@/utils/mainWindowPresentation';
import {
  nowForSpaceMetric,
  trackSpaceToolMutation,
} from '@/pages/space/spaceMetrics';
import {
  createSpaceToolsAppRoute,
  serializeAppRoute,
  type AppRoute,
  type PendingAppRoute,
} from '../shared/appRoute';

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

function normalizeInitialPermissionMode(
  value: unknown,
): InitialMessage['permissionMode'] | undefined {
  return value === 'auto' || value === 'plan' || value === 'fullAgency'
    || value === 'approval-required' || value === 'workspace-autonomous' || value === 'full-autonomous'
    ? value
    : undefined;
}

function isRendererForegrounded(): boolean {
  if (typeof document === 'undefined') return false;
  return document.visibilityState === 'visible' && document.hasFocus();
}

function resolveInitialPermissionMode(args: {
  project: Pick<Project, 'permissionMode'>;
  agent?: { permissionMode?: unknown };
  defaultPermissionMode?: unknown;
}): InitialMessage['permissionMode'] | undefined {
  return (
    normalizeInitialPermissionMode(args.agent?.permissionMode) ??
    normalizeInitialPermissionMode(args.project.permissionMode) ??
    normalizeInitialPermissionMode(args.defaultPermissionMode)
  );
}

function normalizeStringSetting(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

function cloneStringArray(value: string[] | undefined): string[] | undefined {
  return value ? [...value] : undefined;
}

interface SessionRuntimeOpenIdentity {
  runtime: RuntimeType;
  runtimeSource?: RuntimeSource;
}

function fallbackRuntimeForOpen(
  fallbackRuntime: RuntimeType,
  defaultIntegratedRuntime?: unknown,
): RuntimeType {
  return resolveEffectiveRuntime(
    fallbackRuntime,
    undefined,
    undefined,
    undefined,
    undefined,
    defaultIntegratedRuntime,
  );
}

function normalizeRuntimeSourceForOpen(
  runtime: RuntimeType,
  runtimeSource: RuntimeSource | undefined,
): RuntimeSource | undefined {
  return runtimeSourceForRuntimeType(runtime, runtimeSource);
}

function analyticsRuntimeSource(
  runtime: RuntimeType,
  runtimeSource: RuntimeSource | undefined,
): RuntimeSource | null {
  return runtimeSourceForRuntimeType(runtime, runtimeSource) ?? null;
}

async function resolveSessionRuntimeIdentityForOpen(
  sessionId: string | null | undefined,
  fallbackRuntime: RuntimeType,
  defaultIntegratedRuntime?: unknown,
): Promise<SessionRuntimeOpenIdentity> {
  const fallback = fallbackRuntimeForOpen(
    fallbackRuntime,
    defaultIntegratedRuntime,
  );
  if (!sessionId || isPendingSessionId(sessionId)) {
    return {
      runtime: fallback,
      runtimeSource: normalizeRuntimeSourceForOpen(fallback, undefined),
    };
  }
  try {
    const meta = await apiGetJson<{
      success: boolean;
      session?: SessionMetadata;
    }>(`/sessions/${encodeURIComponent(sessionId)}?limit=1`);
    return sessionRuntimeIdentityFromMetadataForOpen(meta.session, fallback);
  } catch (error) {
    // Non-fatal: runtime is used only for history-open analytics.
    console.warn(
      `[App] Failed to resolve runtime for session ${sessionId}, using fallback ${fallback}:`,
      error,
    );
    return {
      runtime: fallback,
      runtimeSource: normalizeRuntimeSourceForOpen(fallback, undefined),
    };
  }
}

export interface LaunchProjectAnalyticsContext {
  surface?: Surface;
  entryIntent?: EntryIntent;
  assistantEntry?: AssistantEntry;
}

export default function App() {
  const { t } = useTranslation('app');
  // Auto-update state (silent background updates)
  const {
    updateReady,
    updateVersion,
    restartAndUpdate,
    checking: updateChecking,
    downloading: updateDownloading,
    installing: updateInstalling,
    preparing: updatePreparing,
    checkForUpdate,
    pendingUpdateOnStartup,
    dismissPendingUpdate,
  } = useUpdater();

  // Stable callback for Settings prop — ref pattern ensures memo comparator correctness
  const [showUpdateRestartConfirmation, setShowUpdateRestartConfirmation] = useState(false);
  const restartAndUpdateRef = useRef(restartAndUpdate);
  restartAndUpdateRef.current = restartAndUpdate;

  // handleRestartAndUpdate is defined further down (after toastRef is declared)
  // — see the `// Update install handler` block.

  // App config for tray behavior (shared via ConfigProvider — no CONFIG_CHANGED event needed)
  // Also get projects + CRUD actions for bug report (ensureSelfAwarenessWorkspace needs them)
  const {
    config,
    isLoading: configLoading,
    providers: appProviders,
    apiKeys: appApiKeys,
    providerVerifyStatus: appProviderVerifyStatus,
    projects: configProjects,
    addProject: configAddProject,
    patchProject: configPatchProject,
  } = useConfig();
  const spaceBuildCapability = useSpaceBuildCapability(config.spaceEnvironment);
  const teamSpaceAvailable =
    !configLoading &&
    spaceBuildCapability.available &&
    config.teamSpaceDevGate !== false;
  const [windowPresentation, setWindowPresentation] = useState(() =>
    createInitialMainWindowPresentation(
      typeof document === 'undefined' || document.visibilityState === 'visible',
    ),
  );
  const handleWindowPresentationChanged = useCallback(
    (surfaceAvailable: boolean) => {
      setWindowPresentation((current) =>
        reduceMainWindowPresentation(current, surfaceAvailable),
      );
    },
    [],
  );

  // Helper Agent's persisted model defaults — used by BugReportOverlay for
  // initial picker selection + persist on pick. The LAUNCH_BUG_REPORT handler
  // intentionally does NOT read this: when no explicit hint is supplied, the
  // helper Tab autoSend resolves provider/model via currentAgent (= helper
  // Agent) — same path as opening ~/.myagents from the Launcher.
  const helperAgentDefaults = useHelperAgentModelDefaults();

  // Bug report overlay state (triggered from titlebar feedback button)
  const [showBugReport, setShowBugReport] = useState(false);
  // Owned by GlobalSidebar (which renders the single New Agent panel); lifted
  // here so launcher entry points open that same instance.
  const [newAgentPanelOpen, setNewAgentPanelOpen] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    if (isTauriEnvironment()) {
      import('@tauri-apps/api/app')
        .then((m) => m.getVersion())
        .then(setAppVersion)
        .catch(() => setAppVersion('unknown'));
    } else {
      setAppVersion('dev');
    }
  }, []);

  // Toast (ref-stabilized per react_stability_rules.md)
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const handleTabCapacityRejected = useCallback(() => {
    toastRef.current.info(t('appChrome.maxTabsReached'));
  }, [t]);

  // Multi-tab state.
  //
  // Startup behaviour (Issue #309): boot is ALWAYS a clean new launcher — we no
  // longer auto-restore the previous session. Restoring is opt-in via the
  // title-bar restore pill, surfaced only when the last exit was NOT a
  // deliberate quit (i.e. a crash or an update-restart — see the boot-decision
  // effect below). `buildRestoredTabs()` still runs synchronously here to
  // CAPTURE the prior session's restorable tabs BEFORE the post-commit persist
  // effect overwrites localStorage with this fresh launcher; the captured set
  // becomes the pill's restore candidate. Those Tabs are not mounted until the
  // user accepts the pill; the click path validates them before committing the
  // final live Tab projection.
  const [restoreCandidate] = useState(() => buildRestoredTabs());
  const [initialWorkspace] = useState(() => {
    const tab = createNewTab();
    return { tabs: [tab] as Tab[], activeTabId: tab.id };
  });
  const { state: tabWorkspace, controller: tabWorkspaceController } =
    useTabWorkspaceController<Tab, typeof builtinTabModules>({
      modules: builtinTabModules,
      initialTabs: initialWorkspace.tabs,
      initialActiveTabId: initialWorkspace.activeTabId,
      maxTabs: MAX_TABS,
      onCapacityRejected: handleTabCapacityRejected,
      createId: generateTabId,
      isLastTabProtected: builtinTabWorkspacePolicy.isLastTabProtected,
    });
  const tabs = tabWorkspace.tabs;
  const activeTabId = tabWorkspace.activeTabId;
  const deferredMountTabIds = tabWorkspace.deferredMountTabIds;
  const [externalNotificationBadges, setExternalNotificationBadges] = useState<
    NotificationBadgeItem[]
  >([]);
  const historyTagIntentSequenceRef = useRef(0);
  const [historyTagIntent, setHistoryTagIntent] = useState<{
    id: number;
    tag: string;
  } | null>(null);
  const handleOpenHistoryTag = useCallback((tag: string) => {
    setHistoryTagIntent({ id: ++historyTagIntentSequenceRef.current, tag });
  }, []);
  const handleHistoryTagIntentConsumed = useCallback((id: number) => {
    setHistoryTagIntent((current) => (current?.id === id ? null : current));
  }, []);
  const pendingSpaceRouteRef = useRef<PendingAppRoute | null>(null);
  const appRouteGenerationRef = useRef(0);
  const spaceRouteTabIdRef = useRef<string | null>(null);

  // Restore pill (Issue #309). `restorePillCount > 0` shows it; the resolved
  // candidate is held in a ref (NOT localStorage — the persist effect clears
  // that on the fresh boot) so the user can still restore after starting work.
  const restoreCandidateRef = useRef<{
    tabs: Tab[];
    activeTabId: string | null;
  } | null>(null);
  const [restorePillCount, setRestorePillCount] = useState(0);

  const handleLauncherWorkspaceSelectionChange = useCallback(
    (tabId: string, workspacePath: string | null) => {
      tabWorkspaceController.update(tabId, 'launcher', (tab) =>
        tab.launcherWorkspacePath === workspacePath
          ? tab
          : { ...tab, launcherWorkspacePath: workspacePath },
      );
    },
    [tabWorkspaceController],
  );

  const syncRendererCorrelationForTab = useCallback(
    (
      tabId: string | null | undefined,
      nextTabs: readonly Tab[] = tabWorkspaceController.getSnapshot().tabs,
    ) => {
      const activeTab = tabId
        ? nextTabs.find((t) => t.id === tabId)
        : undefined;
      setAppActiveTabId(
        tabId,
        nextTabs.map((t) => t.id),
      );
      setAppActiveCorrelation({
        tabId,
        sessionId:
          activeTab?.view === 'chat'
            ? (activeTab.sessionId ?? undefined)
            : undefined,
        tabs: nextTabs.map((tab) => ({
          id: tab.id,
          sessionId:
            tab.view === 'chat' ? (tab.sessionId ?? undefined) : undefined,
        })),
      });
    },
    [tabWorkspaceController],
  );

  const setActiveTabId = useCallback(
    (next: string | null | ((current: string) => string | null)) => {
      const current = tabWorkspaceController.getSnapshot().activeTabId;
      const resolved = typeof next === 'function' ? next(current) : next;
      if (resolved) tabWorkspaceController.focus(resolved);
    },
    [tabWorkspaceController],
  );

  useEffect(() => {
    if (configLoading || spaceBuildCapability.isLoading) return;
    const currentTabs = tabWorkspaceController.getSnapshot().tabs;
    const routeTabId = spaceRouteTabIdRef.current;
    if (
      routeTabId &&
      !currentTabs.some((tab) => tab.id === routeTabId && tab.view === 'space')
    ) {
      spaceRouteTabIdRef.current = null;
    }
    if (
      spaceBuildCapability.available &&
      (teamSpaceAvailable ||
        currentTabs.some(
          (tab) => tab.id === routeTabId && tab.view === 'space',
        ))
    )
      return;

    if (!currentTabs.some((tab) => tab.view === 'space')) return;

    const plans = currentTabs
      .filter((tab) => tab.view === 'space')
      .map((tab) => ({ captured: tabWorkspaceController.capture(tab.id)! }));
    tabWorkspaceController.removeMany(plans, createNewTab);
  }, [
    configLoading,
    spaceBuildCapability.available,
    spaceBuildCapability.isLoading,
    teamSpaceAvailable,
    tabWorkspaceController,
  ]);

  // Persist open Chat / Record tabs after every structural change (Issue #232).
  // a POST-COMMIT effect — it flushes shortly after each tabs/activeTabId change
  // (not synchronously inside the mutation). The payload is tiny (≤MAX_TABS × 4
  // fields), and we deliberately avoid `beforeunload` (unreliable in Tauri
  // WKWebView; update install + app quit both exit from the Rust side, not a
  // renderer unload handshake — see the hide/quit flush below and
  // handleRestartAndUpdate).
  useEffect(() => {
    saveOpenTabs(tabs, activeTabId);
  }, [tabs, activeTabId]);

  // Synchronous flush of the latest tab state. Used to close the narrow window
  // where the process exits (update relaunch, Cmd+Q / Dock quit) in the same
  // frame as a structural change, before the post-commit effect above runs.
  const flushOpenTabsNow = useCallback(() => {
    const snapshot = tabWorkspaceController.getSnapshot();
    saveOpenTabs([...snapshot.tabs], snapshot.activeTabId);
  }, [tabWorkspaceController]);

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

  // Boot startup-behaviour decision (Issue #309). Boot already rendered a fresh
  // launcher (no auto-restore); here we decide whether to OFFER restoring the
  // previous session via the title-bar pill, by the EXIT REASON:
  //   - Resolve the snapshot: the synchronous localStorage capture
  //     (restoreCandidate) wins; the fsync durable backstop — written by
  //     handleRestartAndUpdate right before the abrupt update-restart, where the
  //     async WebView localStorage flush can be lost — fills in when the local
  //     read came up EMPTY (pickDurableOverride).
  //   - Read the Rust clean-exit marker: PRESENT means the user deliberately
  //     quit (Cmd+Q / Dock / tray) → boot fresh, no pill. ABSENT means a crash
  //     or an update-restart → offer to restore (preserves the #232 intent as an
  //     opt-in, kills the #309 "stop force-restoring my session" complaint).
  // Single-shot under StrictMode via the ref; loadAndClearOpenTabsDurable +
  // consumeCleanExitMarker both delete on read, so a second pass is a no-op.
  const bootDecisionRef = useRef(false);
  useEffect(() => {
    if (bootDecisionRef.current) return;
    bootDecisionRef.current = true;
    void (async () => {
      const durable = await loadAndClearOpenTabsDurable();
      const override = pickDurableOverride(restoreCandidate != null, durable);
      const candidate = override
        ? hydratePersistedState(override)
        : restoreCandidate;
      const lastExitWasClean = await consumeCleanExitMarker();
      if (
        candidate &&
        shouldOfferRestore(lastExitWasClean, candidate.tabs.length)
      ) {
        restoreCandidateRef.current = candidate;
        setRestorePillCount(candidate.tabs.length);
      }
    })();
  }, [restoreCandidate]);

  // ✕ on the pill — dismiss without restoring (don't nag again this session).
  const handleDismissRestore = useCallback(() => {
    setRestorePillCount(0);
    restoreCandidateRef.current = null;
  }, []);

  // Helper-overlay launches must hand `handleLaunchProject` a real, committed
  // active launcher tab. Activating before React commits the workspace snapshot
  // produces `view=undefined` and can let the new Chat auto-send while hidden.
  const openLaunchTabNow = useCallback(
    (newTab: Tab) => {
      let accepted = false;
      flushSync(() => {
        accepted =
          tabWorkspaceController.append(newTab, { mount: 'immediate' }).kind !== 'rejected';
      });
      return accepted;
    },
    [tabWorkspaceController],
  );

  const removeUnusedPrecreatedLaunchTab = useCallback(
    (tabId: string) => {
      const snapshot = tabWorkspaceController.getSnapshot();
      const created = snapshot.tabs.find((tab) => tab.id === tabId);
      const captured = tabWorkspaceController.capture(tabId);
      if (created?.view !== 'launcher' || !captured) return;
      tabWorkspaceController.removeMany([{ captured }], createNewTab);
    },
    [tabWorkspaceController],
  );

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
    const sid = activeTab?.view === 'chat' ? activeTab.sessionId : null;
    setAnalyticsContext({
      tabId: activeTabId,
      sessionId: sid && !isPendingSessionId(sid) ? sid : null,
    });
  }, [activeTabId, tabs]);

  // Renderer correlation must follow the App-level active tab, not only mounted
  // Chat TabProviders. Launcher / Settings / TaskCenter do not mount a
  // TabProvider, but logs and proxy headers still need their tab id instead of
  // inheriting the previously-focused chat tab.
  useEffect(() => {
    syncRendererCorrelationForTab(activeTabId, tabs);
  }, [activeTabId, tabs, syncRendererCorrelationForTab]);

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

  // Stable render mirror for async App flows that need the latest config.
  const configRef = useRef(config);
  configRef.current = config;

  const unreadTabCount = tabs.reduce(
    (count, tab) => count + (tab.view === 'chat' && tab.hasUnread ? 1 : 0),
    0,
  );
  const externalNotificationBadgeCount = countNotificationBadgeItems(
    externalNotificationBadges,
  );
  const sessionNotificationBadgeCounts = useMemo(
    () => buildSessionNotificationBadgeCounts(externalNotificationBadges),
    [externalNotificationBadges],
  );
  const notificationBadgeEnabled =
    config.osNotifications && (config.notificationBadge ?? false);
  const notificationBadgeCount = notificationBadgeEnabled
    ? Math.min(unreadTabCount + externalNotificationBadgeCount, 999)
    : 0;

  useEffect(() => {
    if (!notificationBadgeEnabled && externalNotificationBadges.length !== 0) {
      setExternalNotificationBadges([]);
    }
  }, [externalNotificationBadges.length, notificationBadgeEnabled]);

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    void import('@tauri-apps/api/core')
      .then(({ invoke }) =>
        invoke('cmd_set_notification_badge', {
          count: notificationBadgeCount,
          enabled: notificationBadgeEnabled,
        }),
      )
      .catch((error) => {
        console.warn('[App] Failed to sync notification badge:', error);
      });
  }, [notificationBadgeCount, notificationBadgeEnabled]);

  const resolveSessionOriginFieldsForAnalytics = useCallback(
    async (sessionId: string, agentDir: string) => {
      try {
        const sessions = await getSessions(agentDir);
        const target = sessions.find((session) => session.id === sessionId);
        return originAnalyticsFields(originFromSessionMetadataLike(target));
      } catch (error) {
        console.warn(
          `[App] Failed to resolve session origin for ${sessionId}:`,
          error,
        );
        return originAnalyticsFields(null);
      }
    },
    [],
  );

  const trackHistorySessionOpenAsync = useCallback(
    (sessionId: string, agentDir: string, entrySource: HistoryEntrySource) => {
      void (async () => {
        const cfg = configRef.current;
        const agent = getProjectAgent(cfg, configProjects, agentDir);
        const runtimeIdentity = await resolveSessionRuntimeIdentityForOpen(
          sessionId,
          resolveEffectiveRuntime(agent?.runtime, agent?.runtimePreference, agent?.runtimeConfig?.source,
            agent?.providerId, undefined, cfg?.defaultIntegratedRuntime),
          cfg?.defaultIntegratedRuntime,
        );
        const originFields = await resolveSessionOriginFieldsForAnalytics(
          sessionId,
          agentDir,
        );
        track('history_open', {
          agent_hash: hashAgentNameSync(agent?.name ?? null),
          runtime: runtimeIdentity.runtime,
          runtime_source: analyticsRuntimeSource(
            runtimeIdentity.runtime,
            runtimeIdentity.runtimeSource,
          ),
          session_id: sessionId,
          entry_source: entrySource,
          ...originFields,
        });
      })().catch((error) => {
        console.warn(
          `[App] Failed to track history_open for session ${sessionId}:`,
          error,
        );
      });
    },
    [configProjects, resolveSessionOriginFieldsForAnalytics],
  );

  // Update install handler — toasts on failure so the user sees their click
  // had an effect. Silent failure here was the root cause of "重启更新 button
  // does nothing" reports on Windows: a flaky network would kill the install
  // verification round-trip, the JS only console.warn-ed, and the user
  // assumed the button was broken.
  const performRestartAndUpdate = useCallback(async () => {
    // Persist open-tab state before the install/relaunch exits the process from
    // Rust (Issue #232). flushOpenTabsNow() writes localStorage (the fast path),
    // but WebKit/WebView2 persist localStorage to disk ASYNCHRONOUSLY, so the
    // abrupt NSIS exit(0) (Windows) / relaunch() (macOS) can drop that last
    // write. persistOpenTabsDurable() additionally fsyncs a ~/.myagents/
    // open-tabs.json backstop and is AWAITED here, so the tabs the user had
    // open at the click are committed to disk before the process dies; boot
    // consumes the backstop and adopts it only if localStorage came up empty.
    flushOpenTabsNow();
    await persistOpenTabsDurable(
      tabWorkspaceController.getSnapshot().tabs,
      tabWorkspaceController.getSnapshot().activeTabId,
    );
    let outcome:
      | Awaited<ReturnType<typeof restartAndUpdateRef.current>>
      | undefined;
    try {
      outcome = await restartAndUpdateRef.current();
    } finally {
      // Drop the durable handoff UNLESS the restart is actually proceeding
      // (outcome 'ok' → the process is exiting and boot will consume it). Any
      // non-'ok' outcome OR a thrown error means the process stays alive, so the
      // backstop we wrote just before must not resurrect this now-frozen snapshot
      // on a later boot. Awaited (not fire-and-forget) so it can't race a retry's
      // fresh persist, and placed in `finally` so an uncaught throw still clears.
      if (outcome !== 'ok') {
        await clearOpenTabsDurable();
      }
    }
    if (outcome === 'network-error') {
      toastRef.current?.error(t('appChrome.updateVerifyFailed'));
    } else if (outcome === 'version-mismatch') {
      toastRef.current?.info(t('appChrome.updateExpiredRedownloading'));
    } else if (outcome === 'busy') {
      toastRef.current?.info(t('appChrome.updateTasksRunning'));
    } else if (outcome === 'activity-unknown') {
      toastRef.current?.error(t('appChrome.updateActivityUnknown'));
    } else if (outcome === 'signature-error') {
      toastRef.current?.error(t('appChrome.updateSignatureFailed'));
    } else if (outcome === 'blocked') {
      toastRef.current?.info(t('appChrome.updateInstallBlocked'));
    } else if (outcome === 'error') {
      toastRef.current?.error(t('appChrome.updateInstallFailed'));
    }
    // 'ok' → process is exiting via NSIS/relaunch, no toast needed
  }, [flushOpenTabsNow, t, tabWorkspaceController]);

  // Per-tab loading state (keyed by tabId)
  const [loadingTabs, setLoadingTabs] = useState<Record<string, boolean>>({});
  const recordingAdmissionTabsRef = useRef(new Set<string>());
  const recordingSnapshotEpochRef = useRef(0);
  const recordingChangeSequenceRef = useRef(0);
  const [tabErrors, setTabErrors] = useState<Record<string, string | null>>({});

  // One app-exit confirmation owns both scheduler and recording lifecycle.
  const [exitConfirmState, setExitConfirmState] = useState<{
    runningTaskCount: number;
    hasActiveRecording: boolean;
    recording: RecordingSnapshot | null;
    lifecycleUnknown: boolean;
    loading: boolean;
    resolve: (value: boolean) => void;
  } | null>(null);
  const pendingRecordNoteSubmittersRef = useRef(
    new Map<string, () => Promise<boolean>>(),
  );
  const registerPendingRecordNoteSubmitter = useCallback(
    (recordId: string, submit: () => Promise<boolean>) => {
      pendingRecordNoteSubmittersRef.current.set(recordId, submit);
      return () => {
        if (pendingRecordNoteSubmittersRef.current.get(recordId) === submit) {
          pendingRecordNoteSubmittersRef.current.delete(recordId);
        }
      };
    },
    [],
  );
  const flushPendingRecordNote = useCallback(
    async (recordId: string) =>
      pendingRecordNoteSubmittersRef.current.get(recordId)?.() ?? true,
    [],
  );

  // Same admission boundary as Record notes: only callbacks live here. The
  // mounted preview retains the draft and owns its IO/transition decision.
  const fileEditSubmittersRef = useRef(new Map<string, () => Promise<boolean>>());
  const registerFileEditSubmitter = useCallback((tabId: string, submit: () => Promise<boolean>) => {
    fileEditSubmittersRef.current.set(tabId, submit);
    return () => { if (fileEditSubmittersRef.current.get(tabId) === submit) fileEditSubmittersRef.current.delete(tabId); };
  }, []);
  const chatTabLifecycle = useMemo(
    () =>
      createChatTabLifecycle({
        flushFileEdits: async tabId => fileEditSubmittersRef.current.get(tabId)?.() ?? true,
        startBackgroundCompletion,
        stopSseProxy,
        releaseTabSession,
        stopLegacyTabSidecar: stopTabSidecar,
        notifyBackgroundContinuation: () =>
          toastRef.current.info(t('appChrome.backgroundCompletion')),
        log: (message, error) => console.error(message, error),
      }),
    [t],
  );
  const { adapter: recordTabLifecycle, dialog: recordCloseDialog } =
    useRecordTabLifecycle({
      isAdmissionPending: (tabId) =>
        recordingAdmissionTabsRef.current.has(tabId),
      getRecordingSnapshot: recordingSnapshot,
      stopRecording: recordingStop,
      flushPendingNote: flushPendingRecordNote,
      showStatusError: () =>
        toastRef.current.error(t('appChrome.recordCloseStatusFailed')),
      showStopError: () =>
        toastRef.current.error(t('appChrome.recordStopFailed')),
      labels: {
        title: t('appChrome.recordCloseTitle'),
        message: t('appChrome.recordCloseMessage'),
        confirm: t('appChrome.recordStopSaveClose'),
        cancel: t('appChrome.cancel'),
      },
      log: (message, error) => console.error(message, error),
    });
  const tabLifecycle = useMemo(
    () =>
      composeBuiltinTabLifecycle({
        chat: chatTabLifecycle,
        record: recordTabLifecycle,
      }),
    [chatTabLifecycle, recordTabLifecycle],
  );
  const requestCloseTab = useTabCloseController({
    workspace: tabWorkspaceController,
    lifecycle: tabLifecycle,
    defaultReason: builtinTabWorkspacePolicy.defaultCloseReason,
    createFallback: builtinTabWorkspacePolicy.createFallback,
    onBeforeDetach: (tab) => clearPendingSessionBirth(tab.id),
    onDetached: (result) =>
      track('tab_close', {
        view: result.tab.view,
        tab_count: result.tabCount,
      }),
    onCleanupError: (tab, error) =>
      console.error(`[App] Tab cleanup failed for ${tab.id}`, error),
  });

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

      setLogServerReady();
      console.log('[App] Global sidecar started; unified log sink ready');
    } catch (error) {
      if (!mountedRef.current) return;

      retryCountRef.current += 1;
      const currentRetry = retryCountRef.current;

      if (currentRetry <= MAX_RETRIES) {
        // Exponential backoff: 2s, 4s, 8s, 16s, 32s
        const delay = BASE_DELAY * Math.pow(2, currentRetry - 1);
        console.log(
          `[App] Global sidecar failed, retry ${currentRetry}/${MAX_RETRIES} in ${delay}ms`,
        );

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

  // app_launch (DAU) — fire exactly once, but only AFTER config finishes loading
  // from disk. Gating on `!configLoading` makes the runtimes_active adoption
  // snapshot accurate: DEFAULT_CONFIG has no `agents` key, so a genuine no-agents
  // user would otherwise be indistinguishable from "config not loaded yet"
  // (cross-review W1). isLoading always reaches false (ConfigProvider sets it in
  // a finally), so this is DAU-safe — app_launch will always fire. initAnalytics
  // is idempotent, so awaiting it here just guarantees device_id/version preload.
  const appLaunchTrackedRef = useRef(false);
  useEffect(() => {
    if (appLaunchTrackedRef.current || configLoading) return;
    appLaunchTrackedRef.current = true;
    void initAnalytics().then(() => {
      const cfg = configRef.current;
      // distinct effective external runtimes the user has configured agents for.
      // '' (not omitted) for a
      // loaded-but-no-agents user. Captures "configured but maybe never used"
      // runtimes that turn-level events (ai_turn_complete) can't see.
      const runtimesActive = Array.from(
        new Set(
          (cfg.agents ?? [])
            .map((a) =>
              resolveEffectiveRuntime(
                a.runtime,
                a.runtimePreference,
                a.runtimeConfig?.source,
                a.providerId,
                undefined,
                cfg.defaultIntegratedRuntime,
              ),
            )
            .filter((r) => r !== 'builtin'),
        ),
      )
        .sort()
        .join(',');
      track('app_launch', {
        launch_type: 'cold',
        runtimes_active: runtimesActive,
      });
    });
  }, [configLoading]);

  // Rust owns Record/Recording/Speech outcomes. This App-shell listener only
  // removes local identities, maps the fixed allowlist, and hands receipts to
  // the existing analytics queue. Marking the bridge ready releases any
  // startup recovery receipts that completed before the WebView mounted.
  useEffect(() => {
    if (!isTauriEnvironment()) return;
    const controller = new AbortController();
    void (async () => {
      await initAnalytics();
      if (controller.signal.aborted) return;
      const listener = await listenWithCleanup<RecordAnalyticsMilestone>(
        'analytics:record-milestone',
        ({ payload }) => {
          void forwardRecordAnalyticsMilestone(payload);
        },
        controller.signal,
      );
      if (!listener.isRegistered() || controller.signal.aborted) return;
      await tauriInvoke('cmd_record_analytics_bridge_ready');
    })().catch((error) => {
      if (!controller.signal.aborted) {
        console.warn(
          '[analytics] Failed to initialize Record milestone bridge:',
          error,
        );
      }
    });
    return () => controller.abort();
  }, []);

  // Start Global Sidecar on mount, cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    retryCountRef.current = 0;

    // Initialize analytics (async, non-blocking). app_launch itself is tracked
    // in a dedicated config-loaded effect (see above) so its runtimes_active
    // adoption snapshot reflects the real on-disk agent set, not DEFAULT_CONFIG.
    void initAnalytics();

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
          console.log(
            `[App] Background session completion finished: session=${sessionId}, sidecarStopped=${sidecarStopped}`,
          );

          for (const tab of tabWorkspaceController.getSnapshot().tabs) {
            if (
              tab.view === 'chat' &&
              tab.sessionId === sessionId &&
              tab.isGenerating
            ) {
              tabWorkspaceController.update(tab.id, 'chat', (current) => ({
                ...current,
                isGenerating: false,
              }));
            }
          }

          const matchingTab = tabWorkspaceController
            .getSnapshot()
            .tabs.find(
              (tab) => tab.view === 'chat' && tab.sessionId === sessionId,
            );
          if (matchingTab?.view === 'chat') {
            getSessions(matchingTab.agentDir)
              .then((sessions) => {
                if (!mountedRef.current) return;
                const refreshed = sessions.find(
                  (session) => session.id === sessionId,
                );
                if (!refreshed) return;
                const refreshedTitle = getSessionDisplayText(refreshed);
                for (const tab of tabWorkspaceController.getSnapshot().tabs) {
                  if (
                    tab.view === 'chat' &&
                    tab.sessionId === sessionId &&
                    tab.title !== refreshedTitle
                  ) {
                    tabWorkspaceController.update(
                      tab.id,
                      'chat',
                      (current) => ({ ...current, title: refreshedTitle }),
                    );
                  }
                }
                window.dispatchEvent(
                  new CustomEvent(CUSTOM_EVENTS.SESSION_TITLE_CHANGED),
                );
              })
              .catch((err) =>
                console.warn(
                  '[App] Failed to refresh background-completed session metadata:',
                  err,
                ),
              );
          }
        },
        listenerAc.signal,
      );

      // Floating ball "展开 ↗" (PRD 0.2.35): Rust raises the main window and
      // emits this; re-dispatch onto the existing OPEN_SESSION_IN_NEW_TAB
      // DOM-event path so the companion's session opens via the same
      // cron-aware plan→spawn flow as the task center.
      void listenWithCleanup<{
        sessionId: string;
        workspacePath: string;
        preview?: { path?: string; initialLineNumber?: number };
      }>(
        'fb:open-session',
        (event) => {
          if (!mountedRef.current) return;
          const { sessionId, workspacePath, preview } = event.payload ?? {};
          if (!sessionId || !workspacePath) return;
          window.dispatchEvent(
            new CustomEvent(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB, {
              detail: { sessionId, workspacePath, preview },
            }),
          );
        },
        listenerAc.signal,
      );

      void listenWithCleanup(
        'fb:open-desktop-pet-settings',
        () => {
          if (!mountedRef.current) return;
          window.dispatchEvent(
            new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
              detail: { section: 'desktop-pet' },
            }),
          );
        },
        listenerAc.signal,
      );

      // Listen for individual task recovered events
      void listenWithCleanup<CronTaskRecoveredPayload>(
        CRON_EVENTS.TASK_RECOVERED,
        (event) => {
          if (!mountedRef.current) return;
          const { taskId, sessionId, port } = event.payload;
          console.log(
            `[App] Cron task recovered: ${taskId} (session: ${sessionId}, port: ${port})`,
          );
        },
        listenerAc.signal,
      );

      // Listen for recovery summary event
      void listenWithCleanup<CronRecoverySummaryPayload>(
        CRON_EVENTS.RECOVERY_SUMMARY,
        (event) => {
          if (!mountedRef.current) return;
          const { totalTasks, recoveredCount, failedCount, failedTasks } =
            event.payload;
          if (totalTasks > 0) {
            console.log(
              `[App] Cron recovery summary: ${recoveredCount}/${totalTasks} recovered, ${failedCount} failed`,
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
      void listenWithCleanup(
        CRON_EVENTS.MANAGER_READY,
        () => {
          if (!mountedRef.current) return;
          console.log('[App] Cron manager ready (Rust recovery complete)');
        },
        listenerAc.signal,
      );

      void listenWithCleanup<NotificationBadgeIncrementPayload>(
        'notification:badge-increment',
        (event) => {
          if (!mountedRef.current) return;
          const cfg = configRef.current;
          if (!cfg.osNotifications || !(cfg.notificationBadge ?? false)) return;
          const createdAt = Date.now();
          const fallbackId = `legacy:${createdAt}:${Math.random().toString(36).slice(2, 8)}`;
          const item = normalizeNotificationBadgeIncrementPayload(
            event.payload,
            fallbackId,
            createdAt,
          );
          if (!item) return;
          const activeTab = tabWorkspaceController
            .getSnapshot()
            .tabs.find(
              (tab) =>
                tab.id === tabWorkspaceController.getSnapshot().activeTabId,
            );
          if (
            isRendererForegrounded() &&
            isNotificationBadgeTargetVisible(item.target, activeTab)
          ) {
            return;
          }
          setExternalNotificationBadges((items) =>
            upsertNotificationBadgeItem(items, item),
          );
        },
        listenerAc.signal,
      );

      // Listen for Global Sidecar auto-restart by Rust health monitor
      void listenWithCleanup<string>(
        'global-sidecar:restarted',
        () => {
          if (!mountedRef.current) return;
          console.log('[App] Global sidecar auto-restarted by health monitor');
          setLogServerReady();
          // Safety net: if the initial startGlobalSidecar() invoke is still blocked
          // (e.g., monitor killed the first sidecar during its TCP health check),
          // the ready promise would never resolve. Resolve it here so that components
          // waiting on waitForGlobalSidecar() can proceed with the new sidecar. (#58)
          markGlobalSidecarReady();
        },
        listenerAc.signal,
      );

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
      // clicks history → the canonical open path revives it with a higher
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
          while (mountedRef.current) {
            // `openingRevision` detects an opening that starts and finishes
            // entirely while either Rust read is in flight. An opening already
            // active here owns both its success and failure rollback.
            const openingRevision =
              sessionResourceTransitionsRef.current.openingRevision;
            if (
              isSessionOpening(sessionResourceTransitionsRef.current, sessionId)
            )
              return;

            // Generation check first: a same-session relaunch after this terminal
            // event gets a fresh generation. If that replacement is currently dead
            // but still ownerful and awaiting health-monitor recovery, a liveness
            // check alone would return false and incorrectly clear the new binding.
            const currentGeneration = await getSessionGeneration(sessionId);
            if (
              currentGeneration !== null &&
              currentGeneration !== generation
            ) {
              console.log(
                `[App] Ignoring stale terminal event for ${sessionId} (event gen=${generation}, current gen=${currentGeneration})`,
              );
              return;
            }
            // Presence check for the same-generation edge case. Readiness is
            // intentionally irrelevant here; any live entry means don't clear.
            if (await hasSessionSidecar(sessionId)) {
              console.log(
                `[App] Ignoring stale terminal event for ${sessionId} (gen=${generation}) — live sidecar entry present`,
              );
              return;
            }
            if (
              isSessionOpening(sessionResourceTransitionsRef.current, sessionId)
            )
              return;
            if (
              sessionResourceTransitionsRef.current.openingRevision !==
              openingRevision
            )
              continue;
            if (!mountedRef.current) return;

            // Commit in the same synchronous boundary as the stable revision
            // check so a later opening observes the terminal projection.
            flushSync(() => {
              const plans = tabWorkspaceController
                .getSnapshot()
                .tabs.filter(
                  (tab): tab is ChatTab =>
                    tab.view === 'chat' && tab.sessionId === sessionId,
                )
                .map((tab) => ({
                  captured: tabWorkspaceController.capture(tab.id)!,
                  replacement: resetTabToLauncher(tab),
                  mount: 'immediate' as const,
                }));
              const replaced = tabWorkspaceController.replaceMany(plans);
              if (replaced > 0) {
                console.log(
                  `[App] Tab.sessionId reset for terminated session ${sessionId}`,
                );
              }
            });
            return;
          }
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
      //      suspect, re-query Rust's current sidecar generation and only treat
      //      it as gone if Rust has no sidecar entry for that id. A newer
      //      generation must survive even if its process is temporarily dead
      //      and waiting for health-monitor recovery.
      //  (2) Candidates are taken from a workspace snapshot; new tabs may
      //      appear during our async work. To avoid clearing those, we
      //      apply cleanup tab-by-tab via `applyTerminalSessionToTabs`
      //      against the *current* prev, and only for the exact session
      //      ids we definitively confirmed gone.
      void listenWithCleanup<{ liveSessionIds: string[] }>(
        'session:sidecar-terminal-reconcile',
        async (event) => {
          if (!mountedRef.current) return;
          const stillLive = new Set<string>(event.payload.liveSessionIds);
          while (mountedRef.current) {
            const openingRevision =
              sessionResourceTransitionsRef.current.openingRevision;
            const candidates = tabWorkspaceController
              .getSnapshot()
              .tabs.filter(
                (tab): tab is ChatTab & { sessionId: string } =>
                  tab.view === 'chat' &&
                  !!tab.sessionId &&
                  !isPendingSessionId(tab.sessionId) &&
                  !stillLive.has(tab.sessionId) &&
                  !isSessionOpening(
                    sessionResourceTransitionsRef.current,
                    tab.sessionId,
                  ),
              )
              .map((tab) => tab.sessionId);
            const goneIds = (
              await Promise.all(
                candidates.map(async (sessionId) =>
                  (await getSessionGeneration(sessionId)) === null
                    ? sessionId
                    : null,
                ),
              )
            ).filter((sessionId): sessionId is string => sessionId !== null);
            if (!mountedRef.current || goneIds.length === 0) return;
            if (
              sessionResourceTransitionsRef.current.openingRevision !==
              openingRevision
            )
              continue;
            const stableGoneIds = goneIds.filter(
              (sessionId) =>
                !isSessionOpening(
                  sessionResourceTransitionsRef.current,
                  sessionId,
                ),
            );
            if (stableGoneIds.length === 0) return;

            flushSync(() => {
              const stableGone = new Set(stableGoneIds);
              const plans = tabWorkspaceController
                .getSnapshot()
                .tabs.filter(
                  (tab): tab is ChatTab =>
                    tab.view === 'chat' &&
                    !!tab.sessionId &&
                    stableGone.has(tab.sessionId),
                )
                .map((tab) => ({
                  captured: tabWorkspaceController.capture(tab.id)!,
                  replacement: resetTabToLauncher(tab),
                  mount: 'immediate' as const,
                }));
              const replaced = tabWorkspaceController.replaceMany(plans);
              if (replaced > 0) {
                console.log(
                  `[App] Reconcile cleared ${replaced} stale binding(s)`,
                );
              }
            });
            return;
          }
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
      // Rust owns application cleanup on RunEvent::ExitRequested. WebView
      // destruction is window-scoped and must never stop application resources.
    };
  }, [startGlobalSidecarSilent, tabWorkspaceController]);

  // Update tab isGenerating state (called from TabProvider via callback)
  const updateTabGenerating = useCallback(
    (tabId: string, isGenerating: boolean) => {
      tabWorkspaceController.update(tabId, 'chat', (tab) => ({
        ...tab,
        isGenerating,
      }));
    },
    [tabWorkspaceController],
  );

  // Update tab title (called from TabProvider when auto-title or rename occurs)
  const updateTabTitle = useCallback(
    (tabId: string, title: string) => {
      tabWorkspaceController.update(tabId, 'chat', (tab) => ({
        ...tab,
        title,
      }));
    },
    [tabWorkspaceController],
  );

  // Update tab unread state (called from TabProvider when message completes on non-active tab)
  const updateTabUnread = useCallback(
    (tabId: string, hasUnread: boolean) => {
      tabWorkspaceController.update(tabId, 'chat', (tab) =>
        tab.hasUnread === hasUnread ? tab : { ...tab, hasUnread },
      );
    },
    [tabWorkspaceController],
  );

  const clearActiveTabUnread = useCallback(() => {
    const activeTabId = tabWorkspaceController.getSnapshot().activeTabId;
    if (!activeTabId) return;
    updateTabUnread(activeTabId, false);
  }, [tabWorkspaceController, updateTabUnread]);
  const lastUnreadClearedActiveTabIdRef = useRef<string | null>(null);

  const acknowledgeNotificationTarget = useCallback(
    (target: NotificationBadgeTarget) => {
      setExternalNotificationBadges((items) =>
        acknowledgeNotificationBadgeTarget(items, target),
      );
    },
    [],
  );

  const acknowledgeActiveChatSessionNotifications = useCallback(() => {
    const activeTabId = tabWorkspaceController.getSnapshot().activeTabId;
    if (!activeTabId) return;
    const activeTab = tabWorkspaceController
      .getSnapshot()
      .tabs.find((tab) => tab.id === activeTabId);
    if (activeTab?.view !== 'chat') return;
    const sessionId = activeTab.sessionId?.trim();
    if (!sessionId || isPendingSessionId(sessionId)) return;
    acknowledgeNotificationTarget({ type: 'session', sessionId });
  }, [acknowledgeNotificationTarget, tabWorkspaceController]);

  const handleWindowFocused = useCallback(() => {
    clearActiveTabUnread();
    acknowledgeActiveChatSessionNotifications();
  }, [acknowledgeActiveChatSessionNotifications, clearActiveTabUnread]);

  // App-owned admission boundary for operations that can acquire, migrate, or
  // destroy a fixed Session identity. Claims are per Session, so unrelated
  // Tabs remain fully concurrent.
  const sessionResourceTransitionsRef = useRef(
    createSessionResourceTransitionState(),
  );
  const tabSessionIdentityTransitionsRef = useRef<Map<string, Promise<void>>>(
    new Map(),
  );

  // Update tab sessionId when backend creates real session (called from TabProvider)
  // This ensures Session singleton constraint works correctly:
  // - Tab.sessionId syncs with the actual session ID
  // - History dropdown can detect if session is already open in a Tab
  // - Rust HashMap keys are upgraded from "pending-xxx" to real session ID
  const updateTabSessionId = useCallback(
    (
      tabId: string,
      newSessionId: string,
      options?: AdoptMigratedSessionOptions,
    ): Promise<boolean> => {
      const predecessor =
        tabSessionIdentityTransitionsRef.current.get(tabId) ??
        Promise.resolve();
      const operation = predecessor
        .catch(() => undefined)
        .then(async (): Promise<boolean> => {
          // Find the current tab to get the old sessionId
          const currentTab = tabWorkspaceController
            .getSnapshot()
            .tabs.find((t) => t.id === tabId);
          if (currentTab?.view !== 'chat') {
            console.error(
              `[App] Refusing to update missing tab ${tabId} sessionId to ${newSessionId}`,
            );
            if (options?.sidecarAlreadyMigrated) {
              await Promise.allSettled([
                stopSseProxy(tabId),
                releaseTabSession(newSessionId, tabId),
              ]);
            }
            return false;
          }
          const oldSessionId = currentTab.sessionId;
          const identityChanges = oldSessionId !== newSessionId;
          const releaseTargetTransition = identityChanges
            ? tryClaimSessionResourceTransition(
                sessionResourceTransitionsRef.current,
                newSessionId,
                'opening',
                tabId,
              )
            : null;
          if (identityChanges && !releaseTargetTransition) {
            // A concrete identity already owned by another open/delete transition
            // cannot be adopted by this creator. Pending sidecars have no safe old
            // identity to resume, so terminate that exact Tab/owner instead of
            // leaving a continuation that can republish the contested Session.
            if (options?.sidecarAlreadyMigrated) {
              if (oldSessionId && isPendingSessionId(oldSessionId)) {
                clearPendingSessionBirth(tabId);
                const captured = tabWorkspaceController.capture(tabId);
                if (captured) {
                  tabWorkspaceController.replaceWith(
                    captured,
                    'launcher',
                    {},
                    { mount: 'immediate' },
                  );
                }
              }
              await Promise.allSettled([
                stopSseProxy(tabId),
                releaseTabSession(newSessionId, tabId),
              ]);
            } else if (oldSessionId && isPendingSessionId(oldSessionId)) {
              clearPendingSessionBirth(tabId);
              const captured = tabWorkspaceController.capture(tabId);
              if (captured) {
                tabWorkspaceController.replaceWith(
                  captured,
                  'launcher',
                  {},
                  { mount: 'immediate' },
                );
              }
              await Promise.allSettled([
                stopSseProxy(tabId),
                releaseTabSession(oldSessionId, tabId),
              ]);
            }
            return false;
          }

          try {
            console.log(
              `[App] Tab ${tabId} sessionId updating: ${oldSessionId} -> ${newSessionId}`,
            );

            // Ordinary Session birth upgrades the exact Tab owner here. A joint
            // channel migration has already moved the exact Tab + Agent owner set in
            // the proof-bearing Rust command, so repeating a weaker Tab-only upgrade
            // would both be redundant and violate the owner contract.
            if (
              oldSessionId &&
              oldSessionId !== newSessionId &&
              !options?.sidecarAlreadyMigrated
            ) {
              const upgraded = await upgradeSessionId(
                oldSessionId,
                newSessionId,
                tabId,
              );
              console.log(
                `[App] Rust HashMap upgrade: ${oldSessionId} -> ${newSessionId}, success=${upgraded}`,
              );
              if (!upgraded) {
                console.error(
                  `[App] Refusing to update tab ${tabId} sessionId because Rust sidecar upgrade failed: ${oldSessionId} -> ${newSessionId}`,
                );
                return false;
              }
              if (upgraded) {
                const fbResult = await migrateFloatingBallSessionBinding(
                  oldSessionId,
                  newSessionId,
                );
                if (fbResult.migrated) {
                  console.log(
                    `[App] Floating ball session binding migrated: ${oldSessionId} -> ${newSessionId}, notified=${fbResult.notified}`,
                  );
                }
              }
            }

            // Update UI state
            flushSync(() => {
              tabWorkspaceController.update(tabId, 'chat', (tab) => ({
                ...tab,
                sessionId: newSessionId,
                ...(options?.newConversation || (oldSessionId && !isPendingSessionId(oldSessionId) && identityChanges) ? { discussionId: undefined, initialMessage: undefined } : {}),
              }));
            });
            return true;
          } finally {
            releaseTargetTransition?.();
          }
        });
      const settled = operation.then(
        () => undefined,
        () => undefined,
      );
      tabSessionIdentityTransitionsRef.current.set(tabId, settled);
      void settled.finally(() => {
        if (tabSessionIdentityTransitionsRef.current.get(tabId) === settled) {
          tabSessionIdentityTransitionsRef.current.delete(tabId);
        }
      });
      return operation;
    },
    [tabWorkspaceController],
  );

  const performCloseTab = useCallback(
    (tabId: string) => requestCloseTab(tabId, 'user'),
    [requestCloseTab],
  );

  const closeTabWithConfirmation = performCloseTab;

  const closeCurrentTab = useCallback(() => {
    requestCloseTab(tabWorkspaceController.getSnapshot().activeTabId, 'user');
  }, [requestCloseTab, tabWorkspaceController]);
  // Application-level keyboard shortcuts (new/close/switch tab, task-center,
  // settings, reload-block). The bindings + matching live in the declarative
  // APP_SHORTCUTS table (utils/appShortcuts.ts) — the same source the Settings
  // 「快捷键」reference renders from. Here we only build the side-effecting
  // context and dispatch; callbacks are stabilized via refs so the empty-deps
  // closure resolves them at press time.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes('mac');
      if (
        dispatchAppShortcut(e, isMac, {
          tabs: tabWorkspaceController.getSnapshot().tabs,
          activeTabId: tabWorkspaceController.getSnapshot().activeTabId,
          setActiveTabId,
          newTab: handleNewTab,
          closeCurrentTab,
          dismissTopmost,
          hasBlockingBackdrop: () =>
            !!document.querySelector('.fixed.inset-0[class*="backdrop-blur"]'),
          openTaskCenter: () =>
            window.dispatchEvent(
              new CustomEvent(CUSTOM_EVENTS.OPEN_TASK_CENTER),
            ),
          openSettings: () =>
            window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS)),
        })
      )
        return;
      // ⌘/Ctrl+A for plain <input>/<textarea> (chat input, rename fields). The native
      // macOS "Select All" menu item was removed so ⌘A reaches the WebView (see
      // src-tauri/src/lib.rs); Monaco and the workspace tree own it via their own
      // keydown handlers, but a plain text control has no JS owner — handle it here
      // deterministically rather than depend on an undocumented WKWebView default.
      // Returns false (no-op) for Monaco/tree/everything else, so those still own ⌘A.
      handleSelectAllKeydown(e, isMac);
    };

    // Capture phase: application-level shortcuts (Cmd+W/T/Tab, etc.) MUST fire before
    // any component-level handlers. Without capture, Monaco editor (or any component
    // calling stopPropagation) blocks the event → our handler never fires →
    // e.preventDefault() never called → Tauri native Cmd+W closes the window.
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () =>
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- workspace commands and callbacks are stable
  }, [setActiveTabId]);

  // Stable capability passed to TabProvider recovery so it shares the same
  // fixed-identity admission boundary as App opens and deletion.
  const claimSessionOpeningTransition = useCallback(
    (sessionId: string, ownerId: string) =>
      tryClaimSessionResourceTransition(
        sessionResourceTransitionsRef.current,
        sessionId,
        'opening',
        ownerId,
      ),
    [],
  );

  /** Launch a workspace as a new Session. Existing Sessions use handleOpenTargetSession. */
  const handleLaunchProject = useCallback(
    async (
      project: Project,
      initialMessage?: InitialMessage,
      analyticsContext?: LaunchProjectAnalyticsContext,
      sessionBirthHint?: LaunchSessionBirthHint,
    ) => {
      const activeTabId = tabWorkspaceController.getSnapshot().activeTabId;
      if (!activeTabId) return false;

      // Per-tab launch guard: prevent concurrent launches on the same tab
      // A second launch would overwrite the first's initialMessage and kill its sidecar
      if (launchingTabRef.current === activeTabId) {
        console.warn(
          `[App] handleLaunchProject: launch already in progress for tab ${activeTabId}, ignoring`,
        );
        return false;
      }
      launchingTabRef.current = activeTabId;

      // Resolve agent meta for analytics. `getProjectAgent` may return
      // undefined when the workspace isn't bound to any agent (rare — happens
      // for ad-hoc paths) — in that case agent_hash=null + runtime='builtin'
      // as the natural fallback.
      //
      // Surface set is deferred until `targetTabId` is finalized below — when a
      // persistently-owned current Session requires a new tab, that TabProvider
      // consume the surface from THE NEW tabId, not the original activeTabId.
      // Tracked here for review feedback B2/H2 (Codex BLOCKER, Codex HIGH).
      const pendingSurfaceForLaunch: PendingSessionBirthContext = (() => {
        const fallbackLaunchContext = initialMessage
          ? {
              surface: 'launcher_input' as const,
              entryIntent: 'send_message' as const,
            }
          : {
              surface: 'agent_card' as const,
              entryIntent: 'open_workspace' as const,
            };
        return {
          surface: analyticsContext?.surface ?? fallbackLaunchContext.surface,
          entryIntent:
            analyticsContext?.entryIntent ?? fallbackLaunchContext.entryIntent,
          hasInitialMessage: !!initialMessage,
          assistantEntry: analyticsContext?.assistantEntry,
        };
      })();
      const workspaceOpenAnalytics: {
        surface: Surface;
        agent_hash: string | null;
        runtime: ReturnType<typeof resolveEffectiveRuntime>;
        entry_intent: EntryIntent;
        has_initial_message: boolean;
        session_id: null;
      } = (() => {
        const cfg = configRef.current;
        const agent = getProjectAgent(cfg, configProjects, project.path);
        return {
          surface: pendingSurfaceForLaunch.surface,
          agent_hash: hashAgentNameSync(agent?.name ?? null),
          runtime: resolveEffectiveRuntime(
            agent?.runtime,
            agent?.runtimePreference,
            agent?.runtimeConfig?.source,
            agent?.providerId,
            undefined,
            cfg.defaultIntegratedRuntime,
          ),
          entry_intent: pendingSurfaceForLaunch.entryIntent,
          has_initial_message: !!initialMessage,
          session_id: null,
        };
      })();

      setTabErrors((prev) => ({ ...prev, [activeTabId]: null }));
      setLoadingTabs((prev) => ({ ...prev, [activeTabId]: true }));
      let targetTabId = activeTabId;

      try {
        const activeTab = tabWorkspaceController
          .getSnapshot()
          .tabs.find((t) => t.id === activeTabId);
        perfMark('launch_start', { tabId: activeTabId });
        console.log(
          `[App][launch] START active=${activeTabId} view=${activeTab?.view} hasSession=${activeTab?.view === 'chat' && !!activeTab.sessionId} target-sessionId=NEW`,
        );

        // A Session with Task/Goal/background ownership must keep its Tab binding;
        // create the new conversation in a fresh Tab instead of releasing it.
        const currentSessionHasPersistentOwners =
          activeTab?.view === 'chat' && activeTab.sessionId
            ? await sessionHasPersistentOwners(activeTab.sessionId)
            : false;
        console.log(
          `[App][launch] persistent-owner-check ${activeTab?.view === 'chat' && activeTab.sessionId ? `present=${currentSessionHasPersistentOwners}` : 'skipped(no-session)'}`,
        );
        if (currentSessionHasPersistentOwners) {
          if (tabWorkspaceController.getSnapshot().tabs.length >= MAX_TABS) {
            toastRef.current.info(t('appChrome.maxTabsReached'));
            return false;
          }
          const newTab = createNewTab();
          tabWorkspaceController.append(newTab, {
            activate: false,
            mount: 'immediate',
          });
          targetTabId = newTab.id;
          setLoadingTabs((prev) => ({
            ...prev,
            [activeTabId]: false,
            [targetTabId]: true,
          }));
        }

        // ========================================
        // The target Tab releases its previous Session owner before starting the
        // new pending Session. Existing persisted Sessions never enter this path.
        // ========================================
        console.log(
          `[App] New Session launch - tab ${targetTabId}, project: ${project.path}`,
        );

        // If current tab has an active session, release it before launching new one
        const currentTabForLaunch = tabWorkspaceController
          .getSnapshot()
          .tabs.find((t) => t.id === targetTabId);
        const oldSessionForLaunch =
          currentTabForLaunch?.view === 'chat'
            ? currentTabForLaunch.sessionId
            : null;
        if (oldSessionForLaunch) {
          const bgResult = await startBackgroundCompletion(oldSessionForLaunch);
          if (bgResult.started) {
            console.log(
              `[App] AI running on ${oldSessionForLaunch}, background completion started`,
            );
          }
          // Always release old session regardless of AI state:
          // - If BG started: Sidecar stays alive via BG owner
          // - If idle: Sidecar stops (no more owners)
          await stopSseProxy(targetTabId);
          await releaseTabSession(oldSessionForLaunch, targetTabId);
        }

        const configForLaunchBirth = configRef.current;
        const agentForLaunchBirth = configForLaunchBirth
          ? getProjectAgent(configForLaunchBirth, configProjects, project.path)
          : undefined;
        const initialMessageHasExecutionSelection = Boolean(
          initialMessage?.providerExecutionIdentity ||
            initialMessage?.builtinSelection ||
            initialMessage?.runtimeModel ||
            sessionBirthHint?.providerExecutionIdentity ||
            sessionBirthHint?.builtinSelection ||
            sessionBirthHint?.runtimeModel,
        );
        const runtimeBackedProviderIdentityFromConfig = (() => {
          if (initialMessageHasExecutionSelection || !configForLaunchBirth) {
            return undefined;
          }
          if (
            !agentUsesManagedCodexProvider(agentForLaunchBirth) ||
            !getManagedCodexProviderReadiness(configForLaunchBirth).selectable
          ) {
            return undefined;
          }
          const model =
            normalizeStringSetting(agentForLaunchBirth?.model) ??
            normalizeStringSetting(project.model);
          if (!model) {
            return undefined;
          }
          return createRuntimeBackedProviderIdentity({
            providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
            model,
          });
        })();
        const runtimeBackedProviderIdentity =
          initialMessage?.providerExecutionIdentity ??
          sessionBirthHint?.providerExecutionIdentity ??
          runtimeBackedProviderIdentityFromConfig;

        // For ordinary new sessions (no sessionId), generate a temporary session ID;
        // the sidecar materializes it later. Runtime-backed providers are different:
        // Rust must read runtime/runtimeSource/providerExecutionIdentity from
        // sessions.json before spawning, so create a real session metadata row before
        // ensureSessionSidecar. This covers both explicit initial-message launches
        // and empty workspace opens whose Agent template uses Codex (订阅).
        let effectiveSessionId = createPendingSessionId(targetTabId);
        if (runtimeBackedProviderIdentity) {
          try {
            const identity = runtimeBackedProviderIdentity;
            const identityResolvedFromCurrentConfig =
              !initialMessage?.providerExecutionIdentity &&
              !sessionBirthHint?.providerExecutionIdentity;
            const birth = buildRuntimeBackedInitialSessionBirth({
              identity,
              permissionMode:
                initialMessage?.permissionMode ??
                sessionBirthHint?.permissionMode ??
                (identityResolvedFromCurrentConfig
                  ? resolveInitialPermissionMode({
                      project,
                      agent: agentForLaunchBirth,
                      defaultPermissionMode:
                        configForLaunchBirth?.defaultPermissionMode,
                    })
                  : undefined),
              reasoningEffort:
                initialMessage?.reasoningEffort ??
                sessionBirthHint?.reasoningEffort ??
                (identityResolvedFromCurrentConfig
                  ? (normalizeStringSetting(
                      agentForLaunchBirth?.runtimeConfig?.reasoningEffort,
                    ) ??
                    normalizeStringSetting(
                      agentForLaunchBirth?.reasoningEffort,
                    ))
                  : undefined),
              mcpEnabledServers:
                initialMessage?.mcpEnabledServers ??
                sessionBirthHint?.mcpEnabledServers ??
                (identityResolvedFromCurrentConfig
                  ? cloneStringArray(
                      agentForLaunchBirth?.mcpEnabledServers ??
                        project.mcpEnabledServers,
                    )
                  : undefined),
              enabledPluginIds:
                initialMessage?.enabledPluginIds ??
                sessionBirthHint?.enabledPluginIds ??
                (identityResolvedFromCurrentConfig
                  ? cloneStringArray(
                      agentForLaunchBirth?.enabledPluginIds ??
                        project.enabledPluginIds,
                    )
                  : undefined),
              enabledOfficialToolIds:
                initialMessage?.enabledOfficialToolIds ??
                sessionBirthHint?.enabledOfficialToolIds ??
                (identityResolvedFromCurrentConfig
                  ? normalizeOfficialToolIds(
                      agentForLaunchBirth?.enabledOfficialToolIds ??
                        project.enabledOfficialToolIds ??
                        [],
                    )
                  : undefined),
            });
            console.log(
              `[App] Runtime-backed provider launch birth: provider=${identity.providerId} runtime=${birth.runtime} source=${birth.opts.runtimeSource ?? 'none'} model=${identity.model}`,
            );
            const prepared = await createSession(project.path, birth.runtime, {
              ...birth.opts,
              origin:
                sessionBirthHint?.origin ??
                originFromDesktopSurface(pendingSurfaceForLaunch?.surface),
              prepareForFirstUserMessage: true,
              materializationSourceSessionId: effectiveSessionId,
            }, { type: 'tab', id: targetTabId, pendingSessionId: effectiveSessionId });
            effectiveSessionId = prepared.id;
          } catch (err) {
            console.error(
              '[App] Failed to create runtime-backed provider session:',
              err,
            );
            setTabErrors((prev) => ({
              ...prev,
              [targetTabId]: t('appChrome.codexSessionCreateFailed'),
            }));
            setLoadingTabs((prev) => ({ ...prev, [targetTabId]: false }));
            launchingTabRef.current = null;
            return false;
          }
        }

        // Ensure Sidecar is running for this Session, Tab as owner.
        //
        // Pattern 4: this call resolves only after the sidecar's /health/ready
        // returns 200 — i.e. deferred init (migration / skill-seed / sdk-init)
        // has finished. If readiness times out or reports `failed`, the Rust
        // call throws with the last-observed phase embedded in the error
        // string, which we surface via `setTabErrors` → Launcher.startError.
        // For finer-grained UX (inline phase banner during the brief
        // pending → ready window) callers can use `useSessionReady`.
        // Apply the pending surface to the final target tab (persistent ownership
        // may have rerouted `targetTabId` to a freshly-created tab).
        // Set BEFORE ensureSessionSidecar — the backend may emit chat:system-init
        // synchronously once readiness lands, and the target TabProvider needs to
        // consume the surface from this tabId at that moment.
        track('workspace_open', {
          ...workspaceOpenAnalytics,
          tab_id: targetTabId,
        });
        setPendingSessionBirth(targetTabId, pendingSurfaceForLaunch);

        // INSTANT-NAV: flip to the chat shell BEFORE awaiting the sidecar boot, so the
        // user lands in Chat instantly (the boot runs under the "AI 启动中" overlay).
        // `effectiveSessionId` is a prepared runtime-backed id or a fresh
        // `pending-<tabId>`, so the chat shell can mount before the cold boot.
        const flipTitle = project.displayName || getFolderName(project.path);
        perfMark('launch_flip', { tabId: targetTabId });
        console.log(
          `[App][launch] FLIP(flushSync) target=${targetTabId} active=${activeTabId} (chat shell should paint now)`,
        );
        // flushSync is load-bearing: without it React can coalesce this update with
        // the post-ensure updates, delaying the chat shell until after the cold boot.
        flushSync(() => {
          const captured = tabWorkspaceController.capture(targetTabId);
          const target = tabWorkspaceController
            .getSnapshot()
            .tabs.find((tab) => tab.id === targetTabId);
          if (!captured || !target) {
            throw new Error(`Launch target tab ${targetTabId} disappeared`);
          }
          tabWorkspaceController.replaceMany([
            {
              captured,
              replacement: buildChatFlipPatch(target, {
                agentDir: project.path,
                sessionId: effectiveSessionId,
                title: flipTitle,
                initialMessage,
                sidecarConfigDisposition: 'push',
              }),
              mount: 'immediate',
            },
          ]);
          if (targetTabId !== activeTabId) {
            setActiveTabId(targetTabId);
          }
        });
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            perfMark('chat_painted', { tabId: targetTabId });
            console.log(
              `[App][launch] chat_painted target=${targetTabId} (browser painted the flip)`,
            );
          }),
        );

        const result = await ensureSessionSidecar(
          effectiveSessionId,
          project.path,
          'tab',
          targetTabId,
        );
        perfMark('launch_ensured', { tabId: targetTabId });
        console.log(`[App] Session Sidecar ensured: isNew=${result.isNew}`);
        if (
          !(await reconcileSessionTabActivation(
            effectiveSessionId,
            targetTabId,
          ))
        ) {
          throw new Error(
            `Rust refused owner reconcile for session ${effectiveSessionId} and tab ${targetTabId}`,
          );
        }

        // Rust decides whether this owner joined a concurrently-created process.
        const resolved: SidecarConfigDisposition = result.isNew
          ? 'push'
          : 'adopt';
        // The shell already owns initialMessage; update only the disposition so it
        // cannot be re-attached and auto-sent twice.
        tabWorkspaceController.update(targetTabId, 'chat', (tab) => ({
          ...tab,
          sidecarConfigDisposition: resolved,
        }));
        setLoadingTabs((prev) => ({ ...prev, [targetTabId]: false }));
        return true;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error('[App] Failed to start:', errorMsg);

        // Clear pending analytics ownership so a later unrelated Session birth
        // cannot inherit it. Cover both candidate tab IDs after retargeting.
        clearPendingSessionBirth(targetTabId);
        if (targetTabId !== activeTabId) clearPendingSessionBirth(activeTabId);

        const errorTabId =
          targetTabId !== activeTabId ? targetTabId : activeTabId;
        setTabErrors((prev) => ({ ...prev, [errorTabId]: errorMsg }));

        // App startup errors reach both Launcher and Chat. Chat exposes the
        // saved discussion independently of transport readiness; the toast also
        // makes failure visible while the source form is still open.
        toastRef.current.error(
          t('appChrome.launchFailed', { message: errorMsg }),
        );

        // In browser dev mode, still allow navigation
        if (isBrowserDevMode()) {
          console.log('[App] Browser mode: continuing despite error');
          tabWorkspaceController.update(errorTabId, 'chat', (tab) => ({
            ...tab,
            agentDir: project.path,
            title: project.displayName || getFolderName(project.path),
            // Terminal: ensure failed — never leave a mounted chat 'pending'.
            sidecarConfigDisposition: 'push',
          }));
        }
        return false;
      } finally {
        launchingTabRef.current = null;
        setLoadingTabs((prev) => ({
          ...prev,
          [activeTabId]: false,
          [targetTabId]: false,
        }));
      }
    },
    [configProjects, setActiveTabId, t, tabWorkspaceController],
  );

  /**
   * Runtime-backed provider switches are fresh-session launches, not transcript
   * forks. App owns the launcher Tab, prepared metadata birth, Sidecar owner,
   * and activation as one canonical lifecycle transaction.
   */
  const handleLaunchRuntimeBackedProviderSession = useCallback(
    async (
      project: Project,
      sessionBirthHint: LaunchSessionBirthHint & {
        providerExecutionIdentity: RuntimeBackedProviderIdentity;
      },
      title: string,
    ): Promise<string | null> => {
      if (tabWorkspaceController.getSnapshot().tabs.length >= MAX_TABS) {
        toastRef.current.info(t('appChrome.maxTabsReached'));
        return null;
      }

      const launchTab = createNewTab();
      if (!openLaunchTabNow(launchTab)) return null;
      try {
        const opened = await handleLaunchProject(
          project,
          undefined,
          { surface: 'unknown', entryIntent: 'fork' },
          sessionBirthHint,
        );
        if (!opened) {
          removeUnusedPrecreatedLaunchTab(launchTab.id);
          return null;
        }

        const launchedTab = tabWorkspaceController
          .getSnapshot()
          .tabs.find((tab) => tab.id === launchTab.id);
        const launchedSessionId =
          launchedTab?.view === 'chat' ? launchedTab.sessionId : null;
        if (!launchedSessionId || isPendingSessionId(launchedSessionId)) {
          console.error(
            '[App] Runtime-backed provider launch completed without a materialized Session id',
          );
          return null;
        }

        tabWorkspaceController.update(launchTab.id, 'chat', (tab) => ({
          ...tab,
          title,
        }));
        return launchedSessionId;
      } catch (error) {
        console.error(
          '[App] Failed to launch runtime-backed provider Session:',
          error,
        );
        removeUnusedPrecreatedLaunchTab(launchTab.id);
        return null;
      }
    },
    [
      handleLaunchProject,
      openLaunchTabNow,
      removeUnusedPrecreatedLaunchTab,
      t,
      tabWorkspaceController,
    ],
  );

  // Clear initialMessage from a tab after it has been consumed by Chat
  const clearInitialMessage = useCallback(
    (tabId: string) => {
      tabWorkspaceController.update(tabId, 'chat', (tab) => ({
        ...tab,
        initialMessage: undefined,
      }));
    },
    [tabWorkspaceController],
  );

  // Called by Chat after it has adopted a joined sidecar's config. Move the tab to
  // 'push' so the user's SUBSEQUENT in-tab edits push to the sidecar normally (the
  // adoption is one-shot). Push effects don't replay on adopt→push because they key
  // on the `configPending` boolean, which stays false across this transition.
  const markSidecarConfigAdopted = useCallback(
    (tabId: string) => {
      tabWorkspaceController.update(tabId, 'chat', (tab) => ({
        ...tab,
        sidecarConfigDisposition: 'push',
      }));
    },
    [tabWorkspaceController],
  );

  const handleFilePreviewIntentConsumed = useCallback(
    (tabId: string, intentId: string) => {
      tabWorkspaceController.update(tabId, 'chat', (tab) =>
        tab.pendingFilePreview?.id === intentId
          ? { ...tab, pendingFilePreview: undefined }
          : tab,
      );
    },
    [tabWorkspaceController],
  );

  // Persist one canonical Product Session title, then converge every renderer
  // projection that App owns. Resource surfaces share this path with Chat so a
  // sidebar rename cannot leave an already-open tab showing an older title.
  const renamePersistedSession = useCallback(
    async (sessionId: string, newTitle: string) => {
      const mutationSequence =
        taskCenterActions.beginSessionMetadataMutation(sessionId);
      const updated = await updateSession(sessionId, {
        title: newTitle,
        titleSource: 'user',
      });
      if (!updated) return null;

      const applied = taskCenterActions.applySessionMetadata(
        updated,
        mutationSequence,
      );
      if (!applied) return updated;

      for (const tab of tabWorkspaceController.getSnapshot().tabs) {
        if (
          tab.view === 'chat' &&
          tab.sessionId === sessionId &&
          tab.title !== updated.title
        ) {
          tabWorkspaceController.update(tab.id, 'chat', (current) => ({
            ...current,
            title: updated.title,
          }));
        }
      }
      window.dispatchEvent(
        new CustomEvent(CUSTOM_EVENTS.SESSION_TITLE_CHANGED),
      );
      return updated;
    },
    [tabWorkspaceController],
  );

  const handleRenameSession = useCallback(
    (tabId: string, newTitle: string) => {
      const tab = tabWorkspaceController
        .getSnapshot()
        .tabs.find((candidate) => candidate.id === tabId);
      if (
        tab?.view !== 'chat' ||
        !tab.sessionId ||
        tab.sessionId.startsWith('pending-')
      ) {
        updateTabTitle(tabId, newTitle);
        return;
      }
      void renamePersistedSession(tab.sessionId, newTitle).catch((err) =>
        console.error('[App] Failed to persist renamed title:', err),
      );
    },
    [renamePersistedSession, tabWorkspaceController, updateTabTitle],
  );

  /**
   * Handle fork session: create a new tab for the forked session.
   * Called from Chat after the backend has created the forked session metadata + messages.
   */
  const handleForkSession = useCallback(
    async (
      _tabId: string,
      newSessionId: string,
      forkAgentDir: string,
      title: string,
      initialMessage?: string,
      context?: import("../shared/agentMentions").QueryMentionContext,
    ) => {
      // Check tab limit
      if (tabWorkspaceController.getSnapshot().tabs.length >= MAX_TABS) {
        toastRef.current.info(t('appChrome.maxTabsReached'));
        return false;
      }
      const releaseTransition = tryClaimSessionResourceTransition(
        sessionResourceTransitionsRef.current,
        newSessionId,
        'opening',
      );
      if (!releaseTransition) return false;

      const newTab: Tab = {
        id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        agentDir: forkAgentDir,
        sessionId: newSessionId,
        view: 'chat',
        title,
        // Fork mints a brand-new session id → fresh sidecar → 'push'. Metadata is
        // already visible to history, so the opening claim above still excludes
        // user deletion until this Tab owner is attached.
        sidecarConfigDisposition: 'push',
        ...(initialMessage ? { initialMessage: { text: initialMessage, agentMentions: context?.agentMentions, primaryContext: context?.primaryContext, requiredSystemSkill: context?.requiredSystemSkill } } : {}),
      };

      tabWorkspaceController.append(newTab, {
        activate: false,
        mount: 'immediate',
      });
      setLoadingTabs((prev) => ({ ...prev, [newTab.id]: true }));

      let ownerAcquired = false;
      try {
        await ensureSessionSidecar(
          newSessionId,
          forkAgentDir,
          'tab',
          newTab.id,
        );
        ownerAcquired = true;
        console.log(`[App] Fork tab ${newTab.id} sidecar ensured`);
        if (
          !tabWorkspaceController
            .getSnapshot()
            .tabs.some((t) => t.id === newTab.id)
        ) {
          await releaseTabSession(newSessionId, newTab.id).catch(() => {});
          return false;
        }
        if (!(await reconcileSessionTabActivation(newSessionId, newTab.id))) {
          throw new Error(
            `Rust refused owner reconcile for session ${newSessionId} and tab ${newTab.id}`,
          );
        }
        setActiveTabId(newTab.id);
        return true;
      } catch (error) {
        console.error(
          '[App] Failed to start sidecar for forked session:',
          error,
        );
        const captured = tabWorkspaceController.capture(newTab.id);
        if (captured) {
          tabWorkspaceController.removeMany([{ captured }], createNewTab);
        }
        if (ownerAcquired) {
          await releaseTabSession(newSessionId, newTab.id).catch(() => {});
        }
        return false;
      } finally {
        setLoadingTabs((prev) => ({ ...prev, [newTab.id]: false }));
        releaseTransition();
      }
    },
    [setActiveTabId, t, tabWorkspaceController],
  );

  /**
   * Reconcile one existing Session with the exact Tab that displays it.
   *
   * This is the single App-owned ensure/owner path for history opens and
   * restored Tabs. Rust atomically verifies the Tab owner after ensure so a
   * Task claim racing Session startup cannot be overwritten by Renderer.
   * Every await boundary is followed by a Tab identity check so a close/rebind
   * cannot leave a phantom owner behind.
   */
  const reconcileExistingSessionTabOwner = useCallback(
    async (
      tabId: string,
      sessionId: string,
      agentDir: string,
    ): Promise<{ isNew: boolean } | null> => {
      const tabStillTargetsSession = () =>
        tabWorkspaceController
          .getSnapshot()
          .tabs.some(
            (tab) =>
              tab.id === tabId &&
              tab.view === 'chat' &&
              tab.sessionId === sessionId,
          );
      let ownerAcquired = false;
      try {
        const result = await ensureSessionSidecar(
          sessionId,
          agentDir,
          'tab',
          tabId,
        );
        ownerAcquired = true;
        if (!tabStillTargetsSession()) {
          await releaseTabSession(sessionId, tabId).catch(() => {});
          ownerAcquired = false;
          return null;
        }

        const reconciled = await reconcileSessionTabActivation(
          sessionId,
          tabId,
        );
        if (!reconciled) {
          throw new Error(
            `Rust refused owner reconcile for session ${sessionId} and tab ${tabId}`,
          );
        }

        if (!tabStillTargetsSession()) {
          // releaseTabSession is idempotent when the close already removed the
          // owner.
          await releaseTabSession(sessionId, tabId).catch(() => {});
          ownerAcquired = false;
          return null;
        }
        return { isNew: result.isNew };
      } catch (error) {
        if (ownerAcquired)
          await releaseTabSession(sessionId, tabId).catch(() => {});
        throw error;
      }
    },
    [tabWorkspaceController],
  );

  /**
   * Materialize an already-mounted live Chat Tab for an existing Session.
   *
   * Both single-session navigation and bulk startup restore enter this exact
   * path after their UI planner has committed the target Tab. The ensure result
   * is the only authority for push/adopt; callers only decide how to roll back
   * their own UI projection when this returns false.
   */
  const materializeExistingSessionTab = useCallback(
    async (
      tabId: string,
      sessionId: string,
      agentDir: string,
    ): Promise<boolean> => {
      setTabErrors(current => ({ ...current, [tabId]: null }));
      setLoadingTabs((current) => ({ ...current, [tabId]: true }));
      try {
        const result = await reconcileExistingSessionTabOwner(
          tabId,
          sessionId,
          agentDir,
        );
        if (!result) return false;
        tabWorkspaceController.update(tabId, 'chat', (tab) =>
          tab.sessionId === sessionId
            ? {
                ...tab,
                sidecarConfigDisposition: result.isNew
                  ? 'push'
                  : tab.sidecarConfigDisposition === 'pending'
                    ? 'adopt'
                    : tab.sidecarConfigDisposition,
              }
            : tab,
        );
        return true;
      } catch (error) {
        console.error(
          `[App] Failed to materialize existing session ${sessionId} in tab ${tabId}:`,
          error,
        );
        if (tabWorkspaceController.getSnapshot().tabs.some(tab => tab.id === tabId && tab.view === 'chat' && tab.sessionId === sessionId)) {
          setTabErrors(current => ({ ...current, [tabId]: error instanceof Error ? error.message : String(error) }));
        }
        return false;
      } finally {
        setLoadingTabs((current) => ({ ...current, [tabId]: false }));
      }
    },
    [reconcileExistingSessionTabOwner, tabWorkspaceController],
  );

  /**
   * Spawn a fresh Tab bound to an EXISTING session and reconcile its owner.
   * Shared by every persisted-history entry point. Returns false (after a
   * toast) when the tab cap is hit.
   */
  const spawnTabForExistingSession = useCallback(
    async (
      sessionId: string,
      sessionAgentDir: string,
      title: string,
      opts?: { pendingFilePreview?: FilePreviewIntent },
    ): Promise<boolean> => {
      if (tabWorkspaceController.getSnapshot().tabs.length >= MAX_TABS) {
        toastRef.current.info(t('appChrome.maxTabsReached'));
        return false;
      }
      const newTab: ChatTab = {
        id: generateTabId(),
        agentDir: sessionAgentDir,
        sessionId,
        view: 'chat',
        title,
        ...(opts?.pendingFilePreview
          ? { pendingFilePreview: opts.pendingFilePreview }
          : {}),
        // Existing session pre-mounted before ensure → 'pending'; the post-ensure
        // step below resolves push|adopt from result.isNew (no stomp on a join).
        sidecarConfigDisposition: 'pending',
      };
      const previousActiveTabId =
        tabWorkspaceController.getSnapshot().activeTabId;
      // Existing-session opens are visually optimistic: mount and activate the
      // pending Tab immediately, then let Chat's existing boot surface cover
      // Sidecar startup. flushSync is load-bearing here: besides guaranteeing
      // instant visual feedback, it commits the workspace snapshot before a
      // warm Sidecar can resolve ensure and reach the post-ensure liveness check.
      // The controller serializes lifecycle mutations against that same authority.
      flushSync(() => {
        tabWorkspaceController.append(newTab, { mount: 'immediate' });
      });
      const materialized = await materializeExistingSessionTab(
        newTab.id,
        sessionId,
        sessionAgentDir,
      );
      if (!materialized) {
        const captured = tabWorkspaceController.capture(newTab.id);
        if (captured) {
          tabWorkspaceController.removeMany(
            [{ captured }],
            createNewTab,
            previousActiveTabId,
          );
        }
        return false;
      }
      return true;
    },
    [materializeExistingSessionTab, t, tabWorkspaceController],
  );

  /** Open a history session from any surface using an explicit target workspace. */
  const handleOpenTargetSession = useCallback(
    async (
      sessionId: string,
      sessionAgentDir: string,
      title: string,
      historyEntrySource?: HistoryEntrySource,
      options?: { pendingFilePreview?: FilePreviewIntent },
    ): Promise<boolean> => {
      const releaseTransition = tryClaimSessionResourceTransition(
        sessionResourceTransitionsRef.current,
        sessionId,
        'opening',
      );
      if (!releaseTransition) return false;
      try {
        if (historyEntrySource) {
          trackHistorySessionOpenAsync(
            sessionId,
            sessionAgentDir,
            historyEntrySource,
          );
        }

        const plan = planSessionOpen({
          tabs: tabWorkspaceController.getSnapshot().tabs,
          targetSessionId: sessionId,
        });
        if (plan.type === 'jump-to-tab') {
          // Acquiring the exact Tab owner is idempotent for a healthy process and
          // revives a stale binding without a probe/ensure TOCTOU window.
          const targetTabId = plan.tabId;
          if (options?.pendingFilePreview) {
            tabWorkspaceController.update(targetTabId, 'chat', (tab) => ({
              ...tab,
              pendingFilePreview: options.pendingFilePreview,
            }));
          }
          // The existing Tab is already the navigation authority. Activate it
          // synchronously, then reconcile its process owner without yanking focus
          // back if the user moves elsewhere during a slow revive.
          setActiveTabId(targetTabId);
          const materialized = await materializeExistingSessionTab(
            targetTabId,
            sessionId,
            sessionAgentDir,
          );
          if (!materialized) {
            // The opening claim suppresses predecessor terminal events while
            // revive is in flight, so this path owns rollback for the existing
            // Tab just as the optimistic new/restore paths own theirs.
            flushSync(() => {
              const captured = tabWorkspaceController.capture(targetTabId);
              const target = tabWorkspaceController
                .getSnapshot()
                .tabs.find(
                  (tab) =>
                    tab.id === targetTabId &&
                    tab.view === 'chat' &&
                    tab.sessionId === sessionId,
                );
              if (captured && target?.view === 'chat') {
                tabWorkspaceController.replaceMany([
                  {
                    captured,
                    replacement: resetTabToLauncher(target),
                    mount: 'immediate',
                  },
                ]);
              }
            });
            return false;
          }
          console.log(
            `[App] handleOpenTargetSession: Session ${sessionId} owned by tab ${targetTabId}`,
          );
          return true;
        }
        return await spawnTabForExistingSession(
          sessionId,
          sessionAgentDir,
          title || getFolderName(sessionAgentDir),
          {
            pendingFilePreview: options?.pendingFilePreview,
          },
        );
      } finally {
        releaseTransition();
      }
    },
    [
      materializeExistingSessionTab,
      setActiveTabId,
      spawnTabForExistingSession,
      tabWorkspaceController,
      trackHistorySessionOpenAsync,
    ],
  );

  // Startup restore reuses the existing Tab persistence owner for both Chat and
  // Record. Chat candidates keep their Session opening admission; Record
  // candidates are validated through RecordStore before the shell commits them.
  // A deleted Record becomes the existing Record-list surface at the same Tab
  // position instead of creating an empty detail owner.
  const handleRestoreLastSession = useCallback(async () => {
    const candidate = restoreCandidateRef.current;
    setRestorePillCount(0);
    restoreCandidateRef.current = null;
    if (!candidate || candidate.tabs.length === 0) return;

    type ValidatedRestoreTarget =
      | {
          kind: 'chat';
          tab: ChatTab & { sessionId: string };
          releaseTransition: () => void;
        }
      | {
          kind: 'record';
          tab: RecordTab;
          releaseTransition: null;
        }
      | {
          kind: 'record-fallback';
          tab: Extract<Tab, { view: 'taskcenter' }>;
          releaseTransition: null;
        };
    const validated = (
      await Promise.all(
        candidate.tabs.map(
          async (tab): Promise<ValidatedRestoreTarget | null> => {
            if (tab.view === 'record') {
              try {
                const record = await recordGet(tab.recordId);
                if (record) {
                  return {
                    kind: 'record',
                    tab: {
                      ...tab,
                      view: 'record',
                      recordId: tab.recordId,
                      title: record.title || tab.title,
                    },
                    releaseTransition: null,
                  };
                }
                console.warn(
                  `[App] Restore candidate ${tab.id}: Record ${tab.recordId} is gone`,
                );
              } catch (error) {
                console.error(
                  `[App] Failed to validate Record restore candidate ${tab.id}:`,
                  error,
                );
              }
              return {
                kind: 'record-fallback',
                tab: {
                  id: tab.id,
                  view: 'taskcenter',
                  title: t('tabs.taskCenter'),
                },
                releaseTransition: null,
              };
            }
            if (tab.view !== 'chat' || !tab.agentDir || !tab.sessionId) {
              return null;
            }
            const target = tab as ChatTab & { sessionId: string };
            const releaseTransition = tryClaimSessionResourceTransition(
              sessionResourceTransitionsRef.current,
              target.sessionId,
              'opening',
              target.id,
            );
            if (!releaseTransition) return null;
            try {
              const savedDiscussion = target.discussionId
                ? await tauriInvoke<import('../shared/taskDiscussion').TaskDiscussionInput | null>('cmd_task_read_discussion_input', { discussionId: target.discussionId }).catch(() => null)
                : null;
              if ((target.discussionId && isPendingSessionId(target.sessionId)) || (savedDiscussion && savedDiscussion.primaryContext.input.workspacePath === target.agentDir) || await canRestoreSession(target.sessionId, target.agentDir)) {
                return { kind: 'chat', tab: target, releaseTransition };
              }
              console.warn(
                `[App] Restore candidate ${target.id}: session ${target.sessionId} or workspace is gone`,
              );
            } catch (error) {
              console.error(
                `[App] Failed to validate restore candidate ${target.id}:`,
                error,
              );
            }
            releaseTransition();
            return null;
          },
        ),
      )
    ).filter((target): target is ValidatedRestoreTarget => target !== null);

    if (validated.length === 0) return;
    const validTabs = validated.map(({ tab }) => tab);
    const validActiveTabId = validTabs.some(
      (tab) => tab.id === candidate.activeTabId,
    )
      ? candidate.activeTabId
      : null;
    let restoreResult:
      | ReturnType<typeof tabWorkspaceController.restoreWithPolicy>
      | undefined;
    let restoreBlockedByCapacity = false;
    flushSync(() => {
      restoreResult = tabWorkspaceController.restoreWithPolicy(
        { tabs: validTabs, activeTabId: validActiveTabId },
        (currentTabs, restoreCandidate) => {
          const plan = planRestoreTabs(currentTabs, restoreCandidate);
          restoreBlockedByCapacity =
            plan === null &&
            currentTabs.length >= MAX_TABS &&
            planRestoreTabs(currentTabs, restoreCandidate, Infinity) !== null;
          return plan;
        },
      );
    });
    const committedRestore = restoreResult;
    if (!committedRestore || committedRestore.kind === 'no-op') {
      validated.forEach(({ releaseTransition }) => releaseTransition?.());
      if (restoreBlockedByCapacity) {
        toastRef.current.info(t('appChrome.maxTabsReached'));
      }
      return;
    }

    const { addedTabs, previousActiveTabId } = committedRestore;
    const addedTabIds = new Set(addedTabs.map((tab) => tab.id));
    const addedTargets = validated.filter(({ tab }) => addedTabIds.has(tab.id));
    validated.forEach(({ tab, releaseTransition }) => {
      if (!addedTabIds.has(tab.id)) releaseTransition?.();
    });
    if (addedTargets.length === 0) return;
    if (addedTargets.some((target) => target.kind === 'record-fallback')) {
      toastRef.current.info(t('appChrome.recordRestoreMissing'));
    }

    track('restore_last_session', { count: addedTargets.length });

    const addedChatTargets = addedTargets.filter(
      (target): target is Extract<ValidatedRestoreTarget, { kind: 'chat' }> =>
        target.kind === 'chat',
    );
    const results = await Promise.allSettled(
      addedChatTargets.map(async ({ tab, releaseTransition }) => {
        try {
          if (tab.discussionId && isPendingSessionId(tab.sessionId)) {
            // Reload restores custody only. A pending managed birth must use
            // the ordinary launch owner before a Sidecar can be attached.
            setTabErrors(current => ({ ...current, [tab.id]: t('appChrome.taskDiscussionStartFailed') }));
            return true;
          }
          return await materializeExistingSessionTab(
            tab.id,
            tab.sessionId,
            tab.agentDir,
          );
        } finally {
          releaseTransition();
        }
      }),
    );
    const failedTabIds = new Set<string>();
    results.forEach((result, index) => {
      if ((result.status === 'rejected' || !result.value) && !addedChatTargets[index].tab.discussionId) {
        failedTabIds.add(addedChatTargets[index].tab.id);
      }
    });
    if (failedTabIds.size === 0) return;

    flushSync(() => {
      const removals = [...failedTabIds]
        .map((tabId) => tabWorkspaceController.capture(tabId))
        .filter((captured): captured is NonNullable<typeof captured> =>
          Boolean(captured),
        )
        .map((captured) => ({ captured }));
      tabWorkspaceController.removeMany(
        removals,
        createNewTab,
        previousActiveTabId,
      );
    });
  }, [materializeExistingSessionTab, t, tabWorkspaceController]);

  /** Chat-local adapter: all history selections use the canonical new/jump/revive path. */
  const handleOpenChatHistorySession = useCallback(
    async (
      tabId: string,
      sessionId: string,
      title: string,
      historyEntrySource: HistoryEntrySource = 'chat_dropdown',
    ) => {
      const sourceTab = tabWorkspaceController
        .getSnapshot()
        .tabs.find((tab) => tab.id === tabId);
      if (sourceTab?.view !== 'chat' || !sourceTab.agentDir) {
        console.error(
          '[App] Cannot open history session: source tab has no agentDir',
        );
        return;
      }
      await handleOpenTargetSession(
        sessionId,
        sourceTab.agentDir,
        title,
        historyEntrySource,
      );
    },
    [handleOpenTargetSession, tabWorkspaceController],
  );

  /**
   * Handle "New Session" from Chat component.
   * If AI is running, starts background completion on old session and creates new Sidecar.
   * Returns true if handled (Chat should NOT call resetSession), false if AI is idle (Chat falls back to resetSession).
   */
  const handleNewSession = useCallback(
    async (tabId: string): Promise<boolean> => {
      const currentTab = tabWorkspaceController
        .getSnapshot()
        .tabs.find((t) => t.id === tabId);
      if (
        currentTab?.view !== 'chat' ||
        !currentTab.sessionId ||
        !currentTab.agentDir
      ) {
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
      console.log(
        `[App] handleNewSession: AI running on ${oldSessionId}, background completion started`,
      );

      try {
        await stopSseProxy(tabId);
        await releaseTabSession(oldSessionId, tabId);

        // PRD 0.2.19 cross-review fix (B4): mark the upcoming session_new as
        // 'new_chat_button' provenance. handleNewSession is the AI-running variant
        // of resetSession (user clicked "新对话" while AI was still streaming) —
        // without this, chat:system-init would fall back to 'launcher_input' and
        // silently misclassify all AI-running new-session opens.
        setPendingSessionBirth(
          tabId,
          birthContextForSurface('new_chat_button'),
        );

        // Create new pending session with new Sidecar
        const pendingSessionId = createPendingSessionId(tabId);
        await ensureSessionSidecar(
          pendingSessionId,
          currentTab.agentDir,
          'tab',
          tabId,
        );
        if (!(await reconcileSessionTabActivation(pendingSessionId, tabId))) {
          throw new Error(
            `Rust refused owner reconcile for session ${pendingSessionId} and tab ${tabId}`,
          );
        }

        // Update tab state → TabProvider will detect sessionId change and reconnect
        // Fresh sidecar for the new session → 'push' (overwrites any stale disposition)
        // on the new session (e.g. user clicks "New Session" while still in IM Bot adoption window)
        tabWorkspaceController.update(tabId, 'chat', (tab) => ({
          ...tab,
          sessionId: pendingSessionId,
          discussionId: undefined,
          initialMessage: undefined,
          sidecarConfigDisposition: 'push',
        }));
        const fbResult = await migrateFloatingBallSessionBinding(
          oldSessionId,
          pendingSessionId,
        );
        if (fbResult.migrated) {
          console.log(
            `[App] Floating ball session binding migrated to pending session: ${oldSessionId} -> ${pendingSessionId}, notified=${fbResult.notified}`,
          );
        }
        console.log(
          `[App] handleNewSession: Created new Sidecar for pending session ${pendingSessionId}`,
        );
        return true;
      } catch (error) {
        console.error('[App] handleNewSession failed:', error);
        throw error;
      }
    },
    [tabWorkspaceController],
  );

  const handleSelectTab = useCallback(
    (tabId: string) => {
      setActiveTabId(tabId);
    },
    [setActiveTabId],
  );

  // Clear unread indicator only when the active tab identity changes. Do not key
  // this effect on `tabs`: a hidden-but-active tab marks itself unread when a
  // turn completes, and clearing on that same tabs update erases the Dock/tray
  // badge before the user returns. Window focus still clears through
  // useTrayEvents.onWindowFocused.
  useEffect(() => {
    if (!activeTabId) {
      lastUnreadClearedActiveTabIdRef.current = null;
      return;
    }
    if (lastUnreadClearedActiveTabIdRef.current === activeTabId) return;
    lastUnreadClearedActiveTabIdRef.current = activeTabId;
    clearActiveTabUnread();
  }, [activeTabId, clearActiveTabUnread]);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeTabView = activeTab?.view ?? null;
  const activeChatSessionId =
    activeTab?.view === 'chat' ? (activeTab.sessionId ?? null) : null;
  useEffect(() => {
    if (!activeChatSessionId || isPendingSessionId(activeChatSessionId)) return;
    acknowledgeNotificationTarget({
      type: 'session',
      sessionId: activeChatSessionId,
    });
  }, [acknowledgeNotificationTarget, activeChatSessionId]);

  useEffect(() => {
    if (activeTabView === 'taskcenter') {
      acknowledgeNotificationTarget({ type: 'task-center' });
    }
  }, [acknowledgeNotificationTarget, activeTabView]);

  // Trackpad two-finger horizontal swipe to switch tabs (follow-along animation)
  useTabSwipeGesture({
    contentRef,
    getTabs: () => tabWorkspaceController.getSnapshot().tabs,
    getActiveTabId: () => tabWorkspaceController.getSnapshot().activeTabId,
    onSwitchTab: handleSelectTab,
  });

  const handleCloseTab = useCallback((tabId: string) => {
    // Special case: If only one launcher tab, do nothing
    const currentTabs = tabWorkspaceController.getSnapshot().tabs;
    const tab = currentTabs.find((t) => t.id === tabId);
    if (currentTabs.length === 1 && tab?.view === 'launcher') {
      return;
    }

    void closeTabWithConfirmation(tabId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- workspace commands and callbacks are stable
  }, []);

  const handleNewTab = useCallback(() => {
    const currentLength = tabWorkspaceController.getSnapshot().tabs.length;
    const result = tabWorkspaceController.open('launcher', {
      reuseExisting: false,
    });
    if (result.kind === 'rejected') {
      return;
    }
    perfMark(RENDERER_PERF_PHASE.newTabReveal, { tabId: result.tab.id });

    // Track tab_new event
    track('tab_new', { tab_count: currentLength + 1 });
  }, [tabWorkspaceController]);

  const handleSidebarNewChat = useCallback(() => {
    const currentTabs = tabWorkspaceController.getSnapshot().tabs;
    const leftmostLauncher = currentTabs.find((tab) => tab.view === 'launcher');
    if (leftmostLauncher) {
      setActiveTabId(leftmostLauncher.id);
      return;
    }
    handleNewTab();
  }, [handleNewTab, setActiveTabId, tabWorkspaceController]);

  const handleOpenWorkspaceFromSidebar = useCallback(
    async (
      project: Project,
      initialMessage?: InitialMessage,
      entryIntent: 'open_workspace' | 'workspace_init' = 'open_workspace',
    ): Promise<boolean> => {
      if (tabWorkspaceController.getSnapshot().tabs.length >= MAX_TABS) {
        toastRef.current.info(t('appChrome.maxTabsReached'));
        return false;
      }

      const launchTab = createNewTab();
      if (!openLaunchTabNow(launchTab)) return false;
      try {
        await handleLaunchProject(project, initialMessage, {
          surface: 'global_sidebar',
          entryIntent,
        });
        return tabWorkspaceController
          .getSnapshot()
          .tabs.some((tab) => tab.id === launchTab.id);
      } catch (error) {
        console.error(
          '[App] Failed to open workspace from global sidebar:',
          error,
        );
        removeUnusedPrecreatedLaunchTab(launchTab.id);
        return false;
      }
    },
    [
      handleLaunchProject,
      openLaunchTabNow,
      removeUnusedPrecreatedLaunchTab,
      t,
      tabWorkspaceController,
    ],
  );

  // Handle tab reordering via drag and drop
  const handleReorderTabs = useCallback(
    (activeId: string, overId: string) => {
      tabWorkspaceController.reorder(activeId, overId);
    },
    [tabWorkspaceController],
  );

  // Open Settings as a new tab (or switch to existing one)
  // Optional initialSection parameter to open a specific section (e.g., 'providers')
  // Optional initialSelect to open a specific item's detail (skill/command/agent)
  const handleOpenSettings = useCallback(
    async (initialSection?: string) => {
      // Track settings_open event
      track('settings_open', { section: initialSection ?? null });
      tabWorkspaceController.open('settings', {
        title: t('tabs.settings'),
        navigationIntent: {
          generation: tabWorkspaceController.nextIntentGeneration(),
          section: initialSection,
        },
      });
    },
    [t, tabWorkspaceController],
  );

  const handleOpenCapabilities = useCallback(
    (
      initialSection?: CapabilitySection,
      mcpServerId?: string,
      initialSelect?: CapabilityInitialSelect,
      officialToolId?: OfficialToolId,
    ) => {
      const resolvedSection: CapabilitySection =
        initialSection === 'mcp'
          ? 'mcp'
          : initialSection === 'plugins'
            ? 'plugins'
            : 'skills';
      const hasNavigation = Boolean(
        initialSection || mcpServerId || initialSelect || officialToolId,
      );
      tabWorkspaceController.open('capabilities', {
        title: t('tabs.capabilities'),
        ...(hasNavigation
          ? {
              navigationIntent: {
                generation: tabWorkspaceController.nextIntentGeneration(),
                section: resolvedSection,
                mcpServerId,
                officialToolId,
                select: initialSelect,
              },
            }
          : {}),
      });
    },
    [t, tabWorkspaceController],
  );

  const handleRecordingSnapshotChange = useCallback(
    (recordId: string, snapshot: RecordingSnapshot | null) => {
      recordingSnapshotEpochRef.current += 1;
      const recordTab = tabWorkspaceController
        .getSnapshot()
        .tabs.find((tab) => tab.view === 'record' && tab.recordId === recordId);
      if (!recordTab) return;
      tabWorkspaceController.update(recordTab.id, 'record', (tab) => {
        if (!snapshot) {
          if (
            tab.recordingStatus === undefined &&
            tab.recordingMediaDurationMs === undefined &&
            tab.recordingGeneration === undefined
          ) {
            return tab;
          }
          return {
            ...tab,
            recordingStatus: undefined,
            recordingMediaDurationMs: undefined,
            recordingStartedAtWallTime: undefined,
            recordingPausedWallMs: undefined,
            recordingRevision: undefined,
            recordingGeneration: undefined,
            recordingSources: undefined,
            recordingSourceActivity: undefined,
            recordingWarnings: undefined,
          };
        }
        const currentSnapshot = recordingSnapshotFromTab(tab);
        if (
          currentSnapshot &&
          isRecordingSnapshotOlder(currentSnapshot, snapshot)
        ) {
          return tab;
        }
        if (sameRecordingTabProjection(tab, snapshot)) return tab;
        return { ...tab, ...recordingTabProjection(snapshot) };
      });
    },
    [tabWorkspaceController],
  );

  const handleRecordTitleChange = useCallback(
    (recordId: string, title: string) => {
      const recordTab = tabWorkspaceController
        .getSnapshot()
        .tabs.find((tab) => tab.view === 'record' && tab.recordId === recordId);
      if (!recordTab) return;
      tabWorkspaceController.update(recordTab.id, 'record', (tab) =>
        tab.title === title ? tab : { ...tab, title },
      );
    },
    [tabWorkspaceController],
  );

  const handleRecordDeleted = useCallback(
    (tabId: string) => {
      requestCloseTab(tabId, 'record-deleted');
    },
    [requestCloseTab],
  );

  const openOrFocusRecord = useCallback(
    async (
      recordId: string,
      options: {
        sourceTabId?: string;
        snapshot?: RecordingSnapshot;
        title?: string;
        activeRecording?: boolean;
        mediaMs?: number;
        openInNewTab?: boolean;
      } = {},
    ): Promise<boolean> => {
      const currentTabs = tabWorkspaceController.getSnapshot().tabs;
      const existing = currentTabs.find(
        (tab) => tab.view === 'record' && tab.recordId === recordId,
      );
      if (existing) {
        tabWorkspaceController.open('record', {
          recordId,
          title: options.title ?? existing.title,
          snapshot: options.snapshot,
          mediaMs: options.mediaMs,
        });
        return true;
      }

      const activeTab = currentTabs.find(
        (tab) => tab.id === tabWorkspaceController.getSnapshot().activeTabId,
      );
      const sourceTab = options.sourceTabId
        ? currentTabs.find(
            (tab) =>
              tab.id === options.sourceTabId &&
              (tab.view === 'launcher' || options.activeRecording),
          )
        : undefined;
      const functionalTab = options.activeRecording
        ? currentTabs.find(
            (tab) => tab.view === 'launcher' || tab.view === 'taskcenter',
          )
        : undefined;
      const mustReuseStopSurface =
        Boolean(options.activeRecording) && currentTabs.length >= MAX_TABS;
      const reusable =
        options.openInNewTab && !mustReuseStopSurface
          ? undefined
          : (sourceTab ??
            (options.activeRecording &&
            (activeTab?.view === 'launcher' || activeTab?.view === 'taskcenter')
              ? activeTab
              : functionalTab));
      const title = options.title ?? t('tabs.record');
      const intent = {
        recordId,
        title,
        snapshot: options.snapshot,
        mediaMs: options.mediaMs,
      };

      if (reusable) {
        const captured = tabWorkspaceController.capture(reusable.id);
        if (!captured) return false;
        const replaced = tabWorkspaceController.replaceWith(
          captured,
          'record',
          intent,
        );
        if (replaced.kind === 'rejected') return false;
      } else {
        if (currentTabs.length >= MAX_TABS) {
          if (!options.activeRecording) {
            toastRef.current.info(t('appChrome.maxTabsReached'));
            return false;
          }
          // The active capture must always keep a stop/save surface. When a
          // full tab strip contains no reusable Launcher/Task Center tab, one
          // bounded emergency Record tab is safer than replacing a live Chat.
        }
        const opened = tabWorkspaceController.open('record', intent, {
          allowOverCapacity: Boolean(options.activeRecording),
        });
        if (opened.kind === 'rejected') return false;
      }

      void recordGet(recordId)
        .then((loaded) => {
          if (loaded?.kind === 'audio')
            handleRecordTitleChange(recordId, loaded.title || t('tabs.record'));
        })
        .catch(() => undefined);
      return true;
    },
    [handleRecordTitleChange, t, tabWorkspaceController],
  );

  const handleStartRecording = useCallback(
    async (tabId: string, selection: RecordingSourceSelection) => {
      const openInNewTab = tabWorkspaceController
        .getSnapshot()
        .tabs.some((tab) => tab.id === tabId && tab.view === 'taskcenter');
      recordingAdmissionTabsRef.current.add(tabId);
      setLoadingTabs((current) => ({ ...current, [tabId]: true }));
      try {
        const result = await recordingStart(selection);
        await openOrFocusRecord(result.snapshot.recordId, {
          sourceTabId: tabId,
          snapshot: result.snapshot,
          activeRecording: true,
          openInNewTab,
        });
      } finally {
        recordingAdmissionTabsRef.current.delete(tabId);
        setLoadingTabs((current) => ({ ...current, [tabId]: false }));
      }
    },
    [openOrFocusRecord, tabWorkspaceController],
  );

  const handleOpenRecord = useCallback(
    (
      recordId: string,
      mediaMs?: number,
      surface: Surface = 'unknown',
      activeRecording = false,
    ) => {
      void openOrFocusRecord(recordId, { mediaMs, activeRecording }).then(
        async (opened) => {
          if (!opened) return;
          const recordHash = await hashPrivateIdentity('record', recordId);
          track('record_use', {
            event_schema_version: 1,
            record_hash: recordHash ?? undefined,
            record_kind: 'audio',
            operation: 'open',
            source: 'desktop',
            surface,
          });
        },
      );
    },
    [openOrFocusRecord],
  );

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    const controller = new AbortController();
    void listenWithCleanup<RecordingChange>(
      'recording:changed',
      ({ payload }) => {
        if (payload.sequence <= recordingChangeSequenceRef.current) return;
        recordingChangeSequenceRef.current = payload.sequence;
        handleRecordingSnapshotChange(
          payload.recordId,
          payload.snapshot ?? null,
        );
      },
      controller.signal,
    );
    void listenWithCleanup<{ recordId: string }>(
      'tray:open-record',
      ({ payload }) => {
        handleOpenRecord(payload.recordId, undefined, 'unknown', true);
      },
      controller.signal,
    );
    return () => controller.abort();
  }, [handleOpenRecord, handleRecordingSnapshotChange]);

  const activeRecordingTab = tabs.find(
    (tab): tab is RecordTab =>
      tab.view === 'record' &&
      ['preparing', 'recording', 'paused', 'stopping', 'finalizing'].includes(
        tab.recordingStatus ?? '',
      ),
  );
  const activeRecordingRecordId = activeRecordingTab?.recordId;
  const activeRecordingSnapshot = activeRecordingTab
    ? recordingSnapshotFromTab(activeRecordingTab)
    : null;
  useEffect(() => {
    if (!isTauriEnvironment() || !activeRecordingRecordId) return;
    let cancelled = false;
    let timer: number | undefined;
    const refreshActiveRecording = async () => {
      const epoch = recordingSnapshotEpochRef.current;
      try {
        const active = await recordingSnapshot();
        if (cancelled || recordingSnapshotEpochRef.current !== epoch) return;
        handleRecordingSnapshotChange(
          activeRecordingRecordId,
          active?.recordId === activeRecordingRecordId ? active : null,
        );
      } catch {
        // Lifecycle events and the next authoritative poll remain available.
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(refreshActiveRecording, 500);
        }
      }
    };
    void refreshActiveRecording();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeRecordingRecordId, handleRecordingSnapshotChange]);

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    const epoch = recordingSnapshotEpochRef.current;
    void recordingSnapshot()
      .then((active) => {
        if (recordingSnapshotEpochRef.current !== epoch) return;
        if (!active) return;
        const sourceTab = tabWorkspaceController
          .getSnapshot()
          .tabs.find((tab) => tab.view === 'launcher');
        void openOrFocusRecord(active.recordId, {
          sourceTabId: sourceTab?.id,
          snapshot: active,
          activeRecording: true,
        });
      })
      .catch(() => undefined);
  }, [openOrFocusRecord, tabWorkspaceController]);

  // Listen for OPEN_SETTINGS custom event from child components
  useEffect(() => {
    const handleOpenSettingsEvent = (
      event: CustomEvent<{
        section?: string;
        mcpServerId?: string;
        officialToolId?: OfficialToolId;
        selectItem?: CapabilityInitialSelect;
      }>,
    ) => {
      const section = event.detail?.section;
      if (
        section === 'skills' ||
        section === 'sub-agents' ||
        section === 'plugins' ||
        section === 'mcp'
      ) {
        handleOpenCapabilities(
          section === 'sub-agents' ? 'skills' : section,
          event.detail?.mcpServerId,
          event.detail?.selectItem,
          event.detail?.officialToolId,
        );
        return;
      }
      handleOpenSettings(section);
    };
    window.addEventListener(
      CUSTOM_EVENTS.OPEN_SETTINGS,
      handleOpenSettingsEvent as EventListener,
    );
    return () => {
      window.removeEventListener(
        CUSTOM_EVENTS.OPEN_SETTINGS,
        handleOpenSettingsEvent as EventListener,
      );
    };
  }, [handleOpenCapabilities, handleOpenSettings]);

  const handleOpenProjectBoard = useCallback((project: Project) => {
    tabWorkspaceController.open('projectboard', {
      workspacePath: project.path,
      title: t('task:projectBoard.tabTitle', { name: project.displayName || project.name }),
    });
  }, [tabWorkspaceController, t]);

  // Open TaskCenter as a singleton tab. Reopen intents live on that exact tab,
  // so repeated search/route requests cannot leak into a later instance.
  const handleOpenTaskCenter = useCallback(
    (options?: {
      autofocusSearch?: boolean;
      clearSearchIntent?: boolean;
      routeIntent?: PendingAppRoute;
    }): boolean => {
      const currentTabs = tabWorkspaceController.getSnapshot().tabs;
      const sourceTab = currentTabs.find(
        (tab) => tab.id === tabWorkspaceController.getSnapshot().activeTabId,
      );
      let updateCurrentSession = false;
      let currentSessionId: string | null = null;
      if (sourceTab?.view === 'chat') {
        const sourceSessionId = sourceTab.sessionId?.trim();
        updateCurrentSession = true;
        currentSessionId =
          sourceSessionId && !isPendingSessionId(sourceSessionId)
            ? sourceSessionId
            : null;
      } else if (sourceTab?.view !== 'taskcenter') {
        updateCurrentSession = true;
      }
      const result = tabWorkspaceController.open('taskcenter', {
        title: t('tabs.taskCenter'),
        ...(options?.autofocusSearch
          ? {
              searchIntent: {
                generation: tabWorkspaceController.nextIntentGeneration(),
                autofocusSearch: true as const,
              },
            }
          : {}),
        clearSearchIntent: options?.clearSearchIntent,
        routeIntent: options?.routeIntent,
        updateCurrentSession,
        currentSessionId,
      });
      if (result.kind === 'rejected') {
        return false;
      }
      acknowledgeNotificationTarget({ type: 'task-center' });
      return true;
    },
    [acknowledgeNotificationTarget, t, tabWorkspaceController],
  );

  const [taskCreateIntent, setTaskCreateIntent] =
    useState<TaskCreateIntent | null>(null);

  const handleOpenTaskCreate = useCallback((request: TaskCreateRequest) => {
    setTaskCreateIntent({
      ...request,
      id: `task-create-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
  }, []);
  const handleSidebarCreateTask = useCallback(() => {
    const taskCenterCurrentSessionId = tabWorkspaceController
      .getSnapshot()
      .tabs.find((tab) => tab.view === 'taskcenter')?.currentSessionId;
    handleOpenTaskCreate({
      initialMode: 'smart',
      source: 'sidebar',
      currentSessionId: taskCenterCurrentSessionId ?? null,
    });
  }, [handleOpenTaskCreate, tabWorkspaceController]);

  // Listen for OPEN_TASK_CENTER custom event from child components
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { autofocusSearch?: boolean }
        | undefined;
      handleOpenTaskCenter({
        autofocusSearch: detail?.autofocusSearch,
        clearSearchIntent: !detail?.autofocusSearch,
      });
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_TASK_CENTER, handler);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.OPEN_TASK_CENTER, handler);
  }, [handleOpenTaskCenter]);

  useEffect(() => {
    const handler = (raw: Event) => {
      const request = (raw as CustomEvent<TaskCreateRequest>).detail;
      if (!request || !['smart', 'manual'].includes(request.initialMode))
        return;
      if (!['sidebar', 'task-center', 'thought'].includes(request.source))
        return;
      handleOpenTaskCreate(request);
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_TASK_CREATE, handler);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.OPEN_TASK_CREATE, handler);
  }, [handleOpenTaskCreate]);

  const lastNativeAppRouteGenerationRef = useRef(0);
  const openedSpaceRouteGenerationRef = useRef(0);
  const openSpaceRoute = useCallback(
    (pending: PendingAppRoute): boolean => {
      if (openedSpaceRouteGenerationRef.current >= pending.generation) {
        return true;
      }
      const result = tabWorkspaceController.open('space', {
        title: t('tabs.team'),
        navigationIntent: pending,
      });
      if (result.kind === 'rejected') {
        if (pendingSpaceRouteRef.current?.generation === pending.generation) {
          pendingSpaceRouteRef.current = null;
        }
        return false;
      }
      openedSpaceRouteGenerationRef.current = pending.generation;
      spaceRouteTabIdRef.current = result.tab.id;
      if (pendingSpaceRouteRef.current?.generation === pending.generation) {
        pendingSpaceRouteRef.current = null;
      }
      return true;
    },
    [t, tabWorkspaceController],
  );
  const handleOpenAppRoute = useCallback(
    (route: AppRoute, nativeGeneration?: number): boolean => {
      try {
        serializeAppRoute(route);
      } catch {
        toastRef.current.error(t('notificationCenter.routeInvalid'));
        return false;
      }
      if (
        nativeGeneration !== undefined &&
        nativeGeneration <= lastNativeAppRouteGenerationRef.current
      ) {
        return true;
      }
      if (route.name === 'task.comment') {
        const currentTabs = tabWorkspaceController.getSnapshot().tabs;
        const existing = currentTabs.find((tab) => tab.view === 'taskcenter');
        if (!existing && currentTabs.length >= MAX_TABS) {
          toastRef.current.info(t('appChrome.maxTabsReached'));
          return false;
        }
        if (nativeGeneration !== undefined) {
          lastNativeAppRouteGenerationRef.current = nativeGeneration;
        }
        appRouteGenerationRef.current += 1;
        const opened = handleOpenTaskCenter({
          clearSearchIntent: true,
          routeIntent: {
            generation: appRouteGenerationRef.current,
            route,
          },
        });
        if (!opened) return false;
        return true;
      }
      if (!configLoading && config.teamSpaceDevGate === false) {
        toastRef.current.info(t('titlebar.teamUnavailable'));
        return false;
      }
      if (!spaceBuildCapability.isLoading && !spaceBuildCapability.available) {
        toastRef.current.info(
          spaceBuildCapability.reason ?? t('titlebar.teamBuildUnavailable'),
        );
        return false;
      }
      const existing = tabWorkspaceController
        .getSnapshot()
        .tabs.find((tab) => tab.view === 'space');
      if (
        !existing &&
        tabWorkspaceController.getSnapshot().tabs.length >= MAX_TABS
      ) {
        toastRef.current.info(t('appChrome.maxTabsReached'));
        return false;
      }
      if (nativeGeneration !== undefined) {
        lastNativeAppRouteGenerationRef.current = nativeGeneration;
      }
      appRouteGenerationRef.current += 1;
      const pending = {
        generation: appRouteGenerationRef.current,
        route,
      } satisfies PendingAppRoute;
      pendingSpaceRouteRef.current = pending;
      return configLoading || spaceBuildCapability.isLoading ? true : openSpaceRoute(pending);
    },
    [
      handleOpenTaskCenter,
      configLoading,
      config.teamSpaceDevGate,
      openSpaceRoute,
      spaceBuildCapability.available,
      spaceBuildCapability.isLoading,
      spaceBuildCapability.reason,
      t,
      tabWorkspaceController,
    ],
  );

  useEffect(() => {
    const pending = pendingSpaceRouteRef.current;
    if (!pending || configLoading || spaceBuildCapability.isLoading) return;
    if (!spaceBuildCapability.available || config.teamSpaceDevGate === false) {
      if (openedSpaceRouteGenerationRef.current < pending.generation) {
        openedSpaceRouteGenerationRef.current = pending.generation;
        toastRef.current.info(
          config.teamSpaceDevGate === false ? t('titlebar.teamUnavailable') : spaceBuildCapability.reason ?? t('titlebar.teamBuildUnavailable'),
        );
      }
      if (pendingSpaceRouteRef.current?.generation === pending.generation) {
        pendingSpaceRouteRef.current = null;
      }
      return;
    }
    openSpaceRoute(pending);
  }, [
    openSpaceRoute,
    configLoading,
    config.teamSpaceDevGate,
    spaceBuildCapability.available,
    spaceBuildCapability.isLoading,
    spaceBuildCapability.reason,
    t,
  ]);

  const handleSpaceRouteConsumed = useCallback(
    (tabId: string, generation: number) => {
      tabWorkspaceController.update(tabId, 'space', (tab) =>
        tab.navigationIntent?.generation === generation
          ? { ...tab, navigationIntent: undefined }
          : tab,
      );
    },
    [tabWorkspaceController],
  );

  useEffect(() => {
    const handler = (event: Event) => {
      handleOpenAppRoute((event as CustomEvent<AppRoute>).detail);
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_APP_ROUTE, handler);
    return () => window.removeEventListener(CUSTOM_EVENTS.OPEN_APP_ROUTE, handler);
  }, [handleOpenAppRoute]);

  const handleTaskRouteConsumed = useCallback(
    (tabId: string, generation: number) => {
      tabWorkspaceController.update(tabId, 'taskcenter', (tab) =>
        tab.routeIntent?.generation === generation
          ? { ...tab, routeIntent: undefined }
          : tab,
      );
    },
    [tabWorkspaceController],
  );

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    const ac = new AbortController();
    const drain = async () => {
      try {
        const pending = await tauriInvoke<PendingAppRoute | null>(
          'cmd_take_pending_app_route',
        );
        if (pending && !ac.signal.aborted) {
          handleOpenAppRoute(pending.route, pending.generation);
        }
      } catch (error) {
        console.warn('[AppRoute] Failed to consume native route:', error);
      }
    };
    void drain();
    void listenWithCleanup<number>(
      'app-route:available',
      () => {
        void drain();
      },
      ac.signal,
    );
    return () => ac.abort();
  }, [handleOpenAppRoute]);

  const handleOpenSpace = useCallback(() => {
    if (configLoading || spaceBuildCapability.isLoading) {
      toastRef.current.info(t('titlebar.teamLoading'));
      return;
    }
    if (!spaceBuildCapability.available) {
      toastRef.current.info(
        spaceBuildCapability.reason ?? t('titlebar.teamBuildUnavailable'),
      );
      return;
    }
    if (!teamSpaceAvailable) {
      toastRef.current.info(t('titlebar.teamUnavailable'));
      return;
    }
    tabWorkspaceController.open('space', {
      title: t('tabs.team'),
    });
  }, [
    configLoading,
    spaceBuildCapability.isLoading,
    spaceBuildCapability.available,
    spaceBuildCapability.reason,
    teamSpaceAvailable,
    tabWorkspaceController,
    t,
  ]);

  const handleOpenToolMarket = useCallback(() => {
    if (!teamSpaceAvailable) {
      handleOpenSpace();
      return;
    }
    handleOpenAppRoute(createSpaceToolsAppRoute(DEFAULT_SPACE_ID));
  }, [handleOpenAppRoute, handleOpenSpace, teamSpaceAvailable]);

  useEffect(() => {
    window.addEventListener(CUSTOM_EVENTS.OPEN_SPACE, handleOpenSpace);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.OPEN_SPACE, handleOpenSpace);
  }, [handleOpenSpace]);

  // All Task discussion entry points converge here. The visible user text is
  // carried after a hidden product reminder, while the exact app-owned Skill
  // contract is admitted again at the moment the first turn is dispatched.
  const handleStartTaskDiscussion = useCallback(
    async ({
      sourceRecordId,
      sourceRecordKind = 'text',
      content,
      workspaceId,
    }: {
      sourceRecordId?: string;
      sourceRecordKind?: 'text' | 'audio';
      content?: string;
      workspaceId?: string;
    }): Promise<boolean> => {
      if (sourceRecordKind === 'audio' && !sourceRecordId) {
        toastRef.current?.error(t('appChrome.recordDiscussionDocumentFailed'));
        return false;
      }
      if (sourceRecordKind !== 'audio' && !content?.trim()) {
        toastRef.current?.error(t('appChrome.taskDiscussionContentRequired'));
        return false;
      }

      try {
        const currentTabs = tabWorkspaceController.getSnapshot().tabs;
        if (currentTabs.length >= MAX_TABS) {
          toastRef.current.info(t('appChrome.maxTabsReached'));
          return false;
        }

        const projects = configProjectsRef.current.filter(
          isProjectVisibleToUser,
        );
        if (projects.length === 0) {
          toastRef.current?.error(t('appChrome.noWorkspaceForDiscussion'));
          return false;
        }
        const workspace =
          (workspaceId
            ? projects.find((p) => p.id === workspaceId)
            : undefined) ?? projects[0];

        // PRD 0.2.3: 从前端唯一 builtin selection helper 解析出成对的 (provider, model)。
        // 早期实现直接吃 config.defaultProviderId、跳过 workspace/agent 两层，导致
        //   provider = openrouter（全局默认）+ model = claude-opus（agent snapshot）
        // 这种 (provider X, model Y) 错配，触发 API key 验证失败。
        // helper 优先级：agent → workspace → defaultProviderId → first available，
        //   每层 isProviderAvailable 检查；返回的 model 一定 ∈ provider.models。
        const workspaceAgent =
          workspace.agentId && configRef.current
            ? getAgentById(configRef.current, workspace.agentId)
            : undefined;
        const workspaceRuntime = resolveEffectiveRuntime(
          workspaceAgent?.runtime,
          workspaceAgent?.runtimePreference,
          workspaceAgent?.runtimeConfig?.source,
          workspaceAgent?.providerId,
          undefined,
          configRef.current?.defaultIntegratedRuntime,
        );
        const workspaceUsesProductProvider =
          workspaceRuntime === 'builtin' || workspaceRuntime === 'dsh';
        const workspaceProviders = projectProvidersForRuntime(
          appProvidersRef.current,
          workspaceRuntime,
        );
        const sel = workspaceUsesProductProvider
          ? resolveBuiltinSelection(
              { agent: workspaceAgent, workspace },
              configRef.current!,
              workspaceProviders,
              appApiKeysRef.current,
              appProviderVerifyStatusRef.current,
            )
          : undefined;
        if (workspaceUsesProductProvider && !sel) {
          toastRef.current?.error(t('appChrome.noModelProviderForDiscussion'));
          return false;
        }

        if (!isTauriEnvironment()) {
          throw new Error('Task discussion requires the desktop Task store');
        }
        const sourceRecordDiscussionContext =
          sourceRecordKind === 'audio'
            ? await tauriInvoke<{
                documentPath: string;
                audioSources: Array<{
                  track: 'microphone' | 'system' | 'mixed';
                  path: string;
                }>;
              }>('cmd_record_discussion_context', { id: sourceRecordId })
            : undefined;
        const discussionId = `discussion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const prepared = await tauriInvoke<PreparedTaskDiscussion>(
          'cmd_task_prepare_discussion',
          {
            discussionId,
            workspaceId: workspace.id,
            workspacePath: workspace.path,
            sourceRecordId: sourceRecordId || undefined,
          },
        );
        const discussionContext = {
          candidatesDir: prepared.candidatesDir,
          workspaceId: workspace.id,
          workspacePath: workspace.path,
          sourceRecordId: sourceRecordId || undefined,
          sourceRecordAudioPaths: sourceRecordDiscussionContext?.audioSources,
          sourceRecordDocumentPath: sourceRecordDiscussionContext?.documentPath,
          visibleUserMessage:
            sourceRecordKind === 'audio'
              ? '请完整读取 sourceRecordDocumentPath 指向的录音文稿。文稿包含转写内容、说话人信息、现场笔记和重点标记。请以文件中的当前内容为准，理解记录并与我进一步讨论；如需核对原始声音，可读取 sourceRecordAudioPaths 中列出的音频文件。'
              : (content ?? ''),
        };

        const alignmentProviderIntent =
          sel && isRuntimeBackedProvider(sel.provider)
            ? toProviderExecutionIntent(sel.provider, sel.model)
            : undefined;
        const alignmentProviderExecutionIdentity =
          alignmentProviderIntent?.kind === 'runtime-backed-provider'
            ? alignmentProviderIntent
            : undefined;
        const alignmentPermissionMode = resolveInitialPermissionMode({
          project: workspace,
          agent: workspaceAgent,
          defaultPermissionMode: configRef.current?.defaultPermissionMode,
        });
        const initialMessage: InitialMessage = {
          discussionId,
          clientRequestId: crypto.randomUUID(),
          text: discussionContext.visibleUserMessage,
          primaryContext: { kind: 'task-discussion', input: discussionContext },
          requiredSystemSkill: TASK_ALIGNMENT_SKILL_REQUIREMENT,
          ...(alignmentPermissionMode
            ? { permissionMode: alignmentPermissionMode }
            : {}),
          ...(alignmentProviderExecutionIdentity
            ? {
                providerExecutionIdentity: alignmentProviderExecutionIdentity,
                runtimeModel: alignmentProviderExecutionIdentity.model,
              }
            : sel
              ? {
                  builtinSelection: {
                    providerId: sel.provider.id,
                    model: sel.model,
                  },
                }
              : {}),
        };

        // Durable input precedes closing the source form or starting execution.
        // A queue receipt or a later skill rejection cannot erase this artifact.
        await tauriInvoke('cmd_task_save_discussion_input', {
          discussionId,
          input: { text: initialMessage.text, clientRequestId: initialMessage.clientRequestId,
            primaryContext: initialMessage.primaryContext, requiredSystemSkill: initialMessage.requiredSystemSkill },
        });

        // Pre-seed the tab as a Chat tab before awaiting sidecar startup.
        // Without this, the user sees the Launcher briefly while
        // handleLaunchProject waits on ensureSessionSidecar, then the tab
        // "jumps" to Chat. createPendingSessionId is deterministic
        // (`pending-<tabId>`), so handleLaunchProject's internal call
        // resolves to the same id and its later controller update is a no-op for
        // view/agentDir/sessionId.
        const newTab = createNewTab();
        const seeded: ChatTab = {
          id: newTab.id, view: 'chat', agentDir: workspace.path,
          sessionId: createPendingSessionId(newTab.id), title: t('appChrome.discussionTabTitle'),
          discussionId, initialMessage, sidecarConfigDisposition: 'pending',
        };
        const opened = tabWorkspaceController.append(seeded, { mount: 'immediate' });
        if (opened.kind === 'rejected') return false;

        const launched = await handleLaunchProject(workspace, initialMessage, {
          surface: 'task_center',
          entryIntent: 'thought_alignment',
        });
        if (!launched) return false;

        // handleLaunchProject's internal controller update overwrites `title` with the
        // workspace display name. Restore the "任务讨论" title afterwards so
        // the tab consistently reads as a discussion session, not the
        // workspace's generic name.
        tabWorkspaceController.update(newTab.id, 'chat', (tab) => ({
          ...tab,
          title: t('appChrome.discussionTabTitle'),
        }));
        return true;
      } catch (err) {
        console.error('[App] OPEN_AI_DISCUSSION failed:', err);
        const message = err instanceof Error ? err.message : String(err);
        toastRef.current?.error(
          message.includes('RECORD_DISCUSSION_DOCUMENT_')
            ? t('appChrome.recordDiscussionDocumentFailed')
            : message || t('appChrome.taskDiscussionStartFailed'),
        );
        return false;
      }
    },
    [handleLaunchProject, t, tabWorkspaceController],
  );

  const handleCreateDialogDiscussion = useCallback(
    async (request: TaskDiscussionRequest) => {
      const opened = await handleStartTaskDiscussion({
        sourceRecordId: request.sourceRecordId,
        sourceRecordKind: 'text',
        content: request.content,
        workspaceId: request.workspaceId,
      });
      if (opened) setTaskCreateIntent(null);
      return opened;
    },
    [handleStartTaskDiscussion],
  );

  useEffect(() => {
    const handler = (raw: Event) => {
      const detail = (
        raw as CustomEvent<Parameters<typeof handleStartTaskDiscussion>[0]>
      ).detail;
      if (!detail) return;
      void handleStartTaskDiscussion(detail).catch(() => undefined);
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_AI_DISCUSSION, handler);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.OPEN_AI_DISCUSSION, handler);
  }, [handleStartTaskDiscussion]);

  // DOM/Tauri ingress adapter for Task, notification, and Companion opens.
  // App's canonical history owner still decides jump / revive / spawn.
  useEffect(() => {
    const handler = async (raw: Event) => {
      const event = raw as CustomEvent<{
        sessionId: string;
        workspacePath: string;
        preview?: { path?: string; initialLineNumber?: number };
        historyEntrySource?: HistoryEntrySource;
      }>;
      const { sessionId, workspacePath, preview, historyEntrySource } =
        event.detail ?? {};
      if (!sessionId || !workspacePath) return;
      const pendingFilePreview: FilePreviewIntent | undefined = preview?.path
        ? {
            id: `fp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            path: preview.path,
            ...(preview.initialLineNumber
              ? { initialLineNumber: preview.initialLineNumber }
              : {}),
          }
        : undefined;

      const workspace = configProjectsRef.current.find((p) =>
        workspacePathsEqual(p.path, workspacePath),
      );
      if (!workspace) {
        console.warn(
          '[App] OPEN_SESSION_IN_NEW_TAB workspace not in projects; opening by path:',
          workspacePath,
        );
      }
      await handleOpenTargetSession(
        sessionId,
        workspace?.path ?? workspacePath,
        workspace?.displayName ||
          getFolderName(workspace?.path ?? workspacePath),
        historyEntrySource,
        { pendingFilePreview },
      );
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB, handler);
    return () =>
      window.removeEventListener(
        CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB,
        handler,
      );
  }, [handleOpenTargetSession]);

  // Listen for JUMP_TO_TAB custom event (Session singleton constraint)
  useEffect(() => {
    const handleJumpToTab = (
      event: CustomEvent<{ targetTabId: string; sessionId: string }>,
    ) => {
      const { targetTabId, sessionId } = event.detail;
      console.log(`[App] Jump to tab ${targetTabId} for session ${sessionId}`);
      // Check if target Tab exists
      const targetTab = tabWorkspaceController
        .getSnapshot()
        .tabs.find((t) => t.id === targetTabId);
      if (targetTab) {
        setActiveTabId(targetTabId);
      } else {
        console.warn(`[App] Target tab ${targetTabId} not found, cannot jump`);
      }
    };
    window.addEventListener(
      CUSTOM_EVENTS.JUMP_TO_TAB,
      handleJumpToTab as EventListener,
    );
    return () => {
      window.removeEventListener(
        CUSTOM_EVENTS.JUMP_TO_TAB,
        handleJumpToTab as EventListener,
      );
    };
  }, [setActiveTabId, tabWorkspaceController]);

  // Listen for LAUNCH_BUG_REPORT custom event (AI-powered bug reporting)
  useEffect(() => {
    const handleLaunchBugReport = async (
      event: CustomEvent<HelperRequestDetail>,
    ) => {
      const {
        description,
        appVersion,
        providerId,
        model,
        resumeSessionId,
        assistantEntry,
        scenario = 'support',
      } = event.detail;
      const helperLaunchStartedAt = nowForSpaceMetric();
      try {
        // Existing helper Sessions use the same new/jump/revive owner as every
        // other history surface. The canonical path applies the tab limit only
        // when it actually needs to allocate a Tab.
        if (resumeSessionId) {
          const project = await ensureSelfAwarenessWorkspace(
            configProjectsRef.current,
            configAddProject,
            configPatchProject,
          );
          if (!project) {
            console.error('[App] ensureSelfAwarenessWorkspace returned null');
            return;
          }
          await handleOpenTargetSession(
            resumeSessionId,
            project.path,
            project.displayName || getFolderName(project.path),
            'settings_helper_history',
          );
          return;
        }

        if (tabWorkspaceController.getSnapshot().tabs.length >= MAX_TABS) {
          console.warn(
            `[App] Max tabs (${MAX_TABS}) reached, cannot open bug report`,
          );
          if (scenario === 'space_tool_install') {
            trackSpaceToolMutation({
              operation: 'helper_launch',
              toolKind: 'custom_install_prompt',
              result: 'failure',
              ok: false,
              durationMs: Math.round(
                nowForSpaceMetric() - helperLaunchStartedAt,
              ),
              error: new Error('Maximum tab count reached'),
            });
          }
          toastRef.current.info(t('appChrome.maxTabsReached'));
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
          if (scenario === 'space_tool_install') {
            trackSpaceToolMutation({
              operation: 'helper_launch',
              toolKind: 'custom_install_prompt',
              result: 'failure',
              ok: false,
              durationMs: Math.round(
                nowForSpaceMetric() - helperLaunchStartedAt,
              ),
              error: new Error('Helper workspace unavailable'),
            });
            toastRef.current?.error(t('space.tools.helperLaunchFailed'));
          }
          return;
        }

        // Two paths to a paired (provider, model):
        //   A. Explicit picker (BugReportOverlay): caller supplied (providerId, model)
        //      and the provider is still available — honor via pairBuiltinSelection.
        //   B. Implicit (Chat error banner / Settings mcp dialog) OR explicit-but-
        //      provider-unavailable: resolve via priority chain
        //      (helperAgent → helperProject → defaultProviderId → first available),
        //      each layer guarded by isProviderAvailable.
        // Always pass an explicit execution identity (when any provider is available)
        // so Chat tab autoSend doesn't race against the invalid-model correction
        // useEffect when helper Agent's persisted (provider, model) has gone stale.
        const helperAgent =
          project.agentId && configRef.current
            ? getAgentById(configRef.current, project.agentId)
            : undefined;
        const helperRuntime = resolveEffectiveRuntime(
          helperAgent?.runtime,
          helperAgent?.runtimePreference,
          helperAgent?.runtimeConfig?.source,
          helperAgent?.providerId,
          undefined,
          configRef.current?.defaultIntegratedRuntime,
        );
        const helperUsesProductProvider =
          helperRuntime === 'builtin' || helperRuntime === 'dsh';
        const helperProviders = projectProvidersForRuntime(
          appProvidersRef.current,
          helperRuntime,
        );
        let builtinSelection: { providerId: string; model: string } | undefined;
        let providerExecutionIdentity:
          | RuntimeBackedProviderIdentity
          | undefined;
        if (providerId && helperUsesProductProvider) {
          const provider = helperProviders.find((p) => p.id === providerId);
          if (
            provider &&
            isProviderAvailable(
              provider,
              appApiKeysRef.current,
              appProviderVerifyStatusRef.current,
            )
          ) {
            const targetModel = model ?? provider.primaryModel;
            if (isRuntimeBackedProvider(provider)) {
              const intent = toProviderExecutionIntent(provider, targetModel);
              if (intent.kind === 'runtime-backed-provider') {
                providerExecutionIdentity = intent;
              }
            } else {
              builtinSelection = pairBuiltinSelection(provider, model);
            }
          }
        }
        if (
          helperUsesProductProvider &&
          !builtinSelection &&
          !providerExecutionIdentity
        ) {
          const sel = resolveBuiltinSelection(
            { agent: helperAgent, workspace: project },
            configRef.current!,
            helperProviders,
            appApiKeysRef.current,
            appProviderVerifyStatusRef.current,
          );
          if (sel) {
            if (isRuntimeBackedProvider(sel.provider)) {
              const intent = toProviderExecutionIntent(sel.provider, sel.model);
              if (intent.kind === 'runtime-backed-provider') {
                providerExecutionIdentity = intent;
              }
            } else {
              builtinSelection = {
                providerId: sel.provider.id,
                model: sel.model,
              };
            }
          }
          // else: no provider available system-wide — let Chat tab show its
          // empty-state guidance ("请先设置模型服务").
        }
        const helperPermissionMode = resolveInitialPermissionMode({
          project,
          agent: helperAgent,
          defaultPermissionMode: configRef.current?.defaultPermissionMode,
        });

        const initialMessage: InitialMessage = {
          text:
            scenario === 'space_tool_install'
              ? description
              : buildSupportPrompt(description, appVersion ?? ''),
          ...(helperPermissionMode
            ? { permissionMode: helperPermissionMode }
            : {}),
          ...(builtinSelection ? { builtinSelection } : {}),
          ...(providerExecutionIdentity
            ? {
                providerExecutionIdentity,
                runtimeModel: providerExecutionIdentity.model,
              }
            : {}),
          images: event.detail.images,
        };

        const newTab = createNewTab();
        if (!openLaunchTabNow(newTab)) return;

        try {
          const launched = await handleLaunchProject(
            project,
            initialMessage,
            scenario === 'space_tool_install'
              ? {
                  surface: 'space_tools',
                  entryIntent: 'tool_install',
                  assistantEntry: 'space_tool_install',
                }
              : {
                  surface: 'bug_report',
                  entryIntent: 'support_diagnostics',
                  assistantEntry: assistantEntry ?? 'other',
                },
          );
          if (!launched) {
            throw new Error('Helper Session failed to start');
          }
          if (scenario === 'space_tool_install') {
            trackSpaceToolMutation({
              operation: 'helper_launch',
              toolKind: 'custom_install_prompt',
              result: 'success',
              ok: true,
              durationMs: Math.round(
                nowForSpaceMetric() - helperLaunchStartedAt,
              ),
            });
          }

          // Override tab title
          tabWorkspaceController.update(newTab.id, 'chat', (tab) => ({
            ...tab,
            title:
              scenario === 'space_tool_install'
                ? t('space.tools.installSessionTitle')
                : t('appChrome.diagnosticsTabTitle'),
          }));
        } finally {
          removeUnusedPrecreatedLaunchTab(newTab.id);
        }
      } catch (err) {
        if (scenario === 'space_tool_install') {
          trackSpaceToolMutation({
            operation: 'helper_launch',
            toolKind: 'custom_install_prompt',
            result: 'failure',
            ok: false,
            durationMs: Math.round(nowForSpaceMetric() - helperLaunchStartedAt),
            error: err,
          });
          toastRef.current?.error(t('space.tools.helperLaunchFailed'));
        }
        console.error('[App] Failed to launch bug report:', err);
      }
    };
    const listener = ((e: Event) => {
      void handleLaunchBugReport(e as CustomEvent);
    }) as EventListener;
    window.addEventListener(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, listener);
    return () => {
      window.removeEventListener(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, listener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stabilized via refs, configAdd/patchProject are stable useCallbacks
  }, [configAddProject, configPatchProject, t]);

  // Stable callback for Settings onSectionChange — avoids inline arrow creating new ref every render
  const handleSettingsSectionChange = useCallback(
    (tabId: string, generation: number) => {
      tabWorkspaceController.update(tabId, 'settings', (tab) =>
        tab.navigationIntent?.generation === generation
          ? { ...tab, navigationIntent: undefined }
          : tab,
      );
    },
    [tabWorkspaceController],
  );

  const handleCapabilitySectionChange = useCallback(
    (tabId: string, generation: number) => {
      tabWorkspaceController.update(tabId, 'capabilities', (tab) =>
        tab.navigationIntent?.generation === generation
          ? { ...tab, navigationIntent: undefined }
          : tab,
      );
    },
    [tabWorkspaceController],
  );

  const handleTaskSearchIntentConsumed = useCallback(
    (tabId: string, generation: number) => {
      tabWorkspaceController.update(tabId, 'taskcenter', (tab) =>
        tab.searchIntent?.generation === generation
          ? {
              ...tab,
              searchIntent: { ...tab.searchIntent, consumed: true },
            }
          : tab,
      );
    },
    [tabWorkspaceController],
  );

  const handleOpenGeneralSettings = useCallback(() => {
    void handleOpenSettings('general');
  }, [handleOpenSettings]);

  const handleOpenBugReport = useCallback(() => setShowBugReport(true), []);

  const handleOpenSidebarSession = useCallback(
    (session: SessionMetadata, project: Project) =>
      handleOpenTargetSession(
        session.id,
        project.path,
        getSessionDisplayText(session),
        'global_sidebar',
      ),
    [handleOpenTargetSession],
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      const releaseTransition = tryClaimSessionResourceTransition(
        sessionResourceTransitionsRef.current,
        sessionId,
        'deleting',
      );
      if (!releaseTransition) {
        return {
          deleted: false as const,
          reason: 'transition-in-progress' as const,
        };
      }

      try {
        return await deleteSessionThroughAppOwner({
          sessionId,
          getTabs: () => tabWorkspaceController.getSnapshot().tabs,
          terminateTabsForSession: (targetSessionId) => {
            const plans = [];
            for (const tab of tabWorkspaceController.getSnapshot().tabs) {
              if (tab.view === 'chat' && tab.sessionId === targetSessionId) {
                clearPendingSessionBirth(tab.id);
                const captured = tabWorkspaceController.capture(tab.id);
                if (captured) {
                  plans.push({
                    captured,
                    replacement: resetTabToLauncher(tab),
                    mount: 'immediate' as const,
                  });
                }
              }
            }
            tabWorkspaceController.replaceMany(plans);
          },
          hasPersistentOwners: querySessionHasPersistentOwners,
          handoffMountedSessionActivity: startBackgroundCompletionForDeletion,
          stopSseProxy,
          deletePersistedSession: (targetSessionId, releasableTabIds) =>
            taskCenterActions.deleteSession(targetSessionId, releasableTabIds),
        });
      } finally {
        releaseTransition();
      }
    },
    [tabWorkspaceController],
  );

  const requestLifecycleExitConfirmation =
    useCallback(async (): Promise<boolean> => {
      // Query both authoritative owners before presenting one confirmation.
      // Ordinary Cron lists intentionally exclude Goal and cannot protect exit.
      const [schedulerResult, recordingResult] = await Promise.allSettled([
        getUserSchedulerLifecycleSnapshot(),
        recordingSnapshot(),
      ]);
      const runningTaskCount =
        schedulerResult.status === 'fulfilled'
          ? schedulerResult.value.runningTaskCount
          : 0;
      const recording =
        recordingResult.status === 'fulfilled' ? recordingResult.value : null;
      const hasActiveRecording = recording !== null;
      const lifecycleUnknown =
        schedulerResult.status === 'rejected' ||
        recordingResult.status === 'rejected';

      if (schedulerResult.status === 'rejected') {
        console.error(
          '[App] Failed to check scheduler lifecycle:',
          schedulerResult.reason,
        );
      }
      if (recordingResult.status === 'rejected') {
        console.error(
          '[App] Failed to check recording lifecycle:',
          recordingResult.reason,
        );
      }

      if (runningTaskCount > 0 || hasActiveRecording || lifecycleUnknown) {
        return new Promise<boolean>((resolve) => {
          setExitConfirmState({
            runningTaskCount,
            hasActiveRecording,
            recording,
            lifecycleUnknown,
            loading: false,
            resolve,
          });
        });
      }
      return true;
    }, []);

  const handleRestartAndUpdate = useCallback(async (confirmed = false) => {
    if (APP_BUILD_PROFILE === 'moxbot') {
      // Updates never offer to interrupt work; Rust rejects busy/unknown owners.
      if (!confirmed) { setShowUpdateRestartConfirmation(true); return; }
      await performRestartAndUpdate();
      return;
    }
    if (!(await requestLifecycleExitConfirmation())) return;
    await performRestartAndUpdate();
  }, [performRestartAndUpdate, requestLifecycleExitConfirmation]);

  // System tray event handling (minimize to tray, exit confirmation)
  useTrayEvents({
    minimizeToTray: config.minimizeToTray,
    onOpenSettings: () => handleOpenSettings('general'),
    onCmdWCloseTab: () => {
      // Cmd+W bottom: overlay → split → tab → launcher → STOP.
      closeCurrentTab(); // Last tab auto-creates launcher; launcher is a no-op.
    },
    onWindowPresentationChanged: handleWindowPresentationChanged,
    onWindowFocused: handleWindowFocused,
    onExitRequested: requestLifecycleExitConfirmation,
  });

  // Listen for notification clicks. Rust emits this from exact native
  // per-toast callbacks on Windows, macOS, and Linux. All converge here so
  // routing has one entry point. Chat completion toasts
  // usually carry a tabId and can jump directly; cron/background toasts carry
  // sessionId + workspacePath so they can open a session even when no Tab exists.
  useEffect(() => {
    if (!isTauriEnvironment()) return;
    const ac = new AbortController();
    void listenWithCleanup<{
      tabId?: string;
      sessionId?: string;
      workspacePath?: string;
    }>(
      'notification:click',
      (event) => {
        const route = resolveNotificationClickRoute(
          event.payload,
          (tabId, sessionId) => {
            const tab = tabWorkspaceController
              .getSnapshot()
              .tabs.find((t) => t.id === tabId);
            if (!tab) return false;
            return (
              !sessionId || (tab.view === 'chat' && tab.sessionId === sessionId)
            );
          },
        );
        if (route.type === 'select-tab') {
          console.log(
            '[App] notification:click → handleSelectTab',
            route.tabId,
          );
          if (route.sessionId) {
            acknowledgeNotificationTarget({
              type: 'session',
              sessionId: route.sessionId,
            });
          }
          handleSelectTab(route.tabId);
          updateTabUnread(route.tabId, false);
          return;
        }

        if (route.type === 'open-session') {
          console.log(
            '[App] notification:click → open session',
            route.sessionId,
          );
          window.dispatchEvent(
            new CustomEvent(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB, {
              detail: {
                sessionId: route.sessionId,
                workspacePath: route.workspacePath,
              },
            }),
          );
          return;
        }

        console.warn(
          '[App] notification:click without routable target:',
          event.payload,
        );
      },
      ac.signal,
    );
    return () => ac.abort();
  }, [
    acknowledgeNotificationTarget,
    handleSelectTab,
    tabWorkspaceController,
    updateTabUnread,
  ]);

  useEffect(() => startAgentNetworkStore(), []);
  const activeWorkspacePath = resolveGlobalSidebarWorkspace(activeTab);
  const launcherBinding = useMemo<BuiltinTabBindings['launcher']>(
    () => ({
      isStarting: (tabId) => loadingTabs[tabId] ?? false,
      startError: (tabId) => tabErrors[tabId] ?? null,
      onWorkspaceSelectionChange: handleLauncherWorkspaceSelectionChange,
      onLaunchProject: handleLaunchProject,
      onStartRecording: handleStartRecording,
      onOpenRecord: (recordId) =>
        handleOpenRecord(recordId, undefined, 'launcher_input'),
      onOpenNewAgentPanel: () => setNewAgentPanelOpen(true),
    }),
    [
      handleLaunchProject,
      handleLauncherWorkspaceSelectionChange,
      handleOpenRecord,
      handleStartRecording,
      loadingTabs,
      tabErrors,
    ],
  );
  const retryDiscussionStartup = useCallback(async (tabId: string) => {
    const tab = tabWorkspaceController.getSnapshot().tabs.find(item => item.id === tabId);
    if (tab?.view !== 'chat' || !tab.discussionId || !tab.sessionId) return;
    const birthHint = tab.initialMessage;
    clearInitialMessage(tabId);
    if (!isPendingSessionId(tab.sessionId)) {
      setTabErrors(current => ({ ...current, [tabId]: null }));
      await materializeExistingSessionTab(tabId, tab.sessionId, tab.agentDir);
      return;
    }
    const workspace = configProjectsRef.current.find(project => project.path === tab.agentDir && isProjectVisibleToUser(project));
    if (!workspace || tabWorkspaceController.getSnapshot().activeTabId !== tabId) return;
    await handleLaunchProject(workspace, undefined, { surface: 'task_center', entryIntent: 'thought_alignment' }, birthHint);
  }, [clearInitialMessage, handleLaunchProject, materializeExistingSessionTab, tabWorkspaceController]);
  const chatBinding = useMemo<BuiltinTabBindings['chat']>(
    () => ({
      registerFileEditSubmitter,
      windowPresentation,
      startupError: (tabId) => tabErrors[tabId] ?? null,
      onRetryStartup: retryDiscussionStartup,
      onOpenHistorySession: handleOpenChatHistorySession,
      onOpenHistoryTag: handleOpenHistoryTag,
      onNewSession: handleNewSession,
      onLaunchRuntimeBackedProviderSession:
        handleLaunchRuntimeBackedProviderSession,
      onUpdateGenerating: updateTabGenerating,
      onUpdateTitle: updateTabTitle,
      onUpdateUnread: updateTabUnread,
      onRenameSession: handleRenameSession,
      onForkSession: handleForkSession,
      onUpdateSessionId: updateTabSessionId,
      claimSessionOpeningTransition,
      onClearInitialMessage: clearInitialMessage,
      onSidecarConfigAdopted: markSidecarConfigAdopted,
      onFilePreviewIntentConsumed: handleFilePreviewIntentConsumed,
      sessionNotificationBadgeCounts,
    }),
    [
      registerFileEditSubmitter,
      retryDiscussionStartup,
      tabErrors,
      claimSessionOpeningTransition,
      clearInitialMessage,
      handleFilePreviewIntentConsumed,
      handleForkSession,
      handleLaunchRuntimeBackedProviderSession,
      handleNewSession,
      handleOpenChatHistorySession,
      handleOpenHistoryTag,
      handleRenameSession,
      markSidecarConfigAdopted,
      sessionNotificationBadgeCounts,
      updateTabGenerating,
      updateTabSessionId,
      updateTabTitle,
      updateTabUnread,
      windowPresentation,
    ],
  );
  const settingsUpdaterBinding = useMemo(
    () => ({
      updateReady,
      updateVersion,
      updateChecking,
      updateDownloading,
      updateInstalling,
      updatePreparing,
      onCheckForUpdate: checkForUpdate,
      onRestartAndUpdate: () => void handleRestartAndUpdate(),
    }),
    [
      checkForUpdate,
      handleRestartAndUpdate,
      updateChecking,
      updateDownloading,
      updateInstalling,
      updatePreparing,
      updateReady,
      updateVersion,
    ],
  );
  const settingsBinding = useMemo<BuiltinTabBindings['settings']>(
    () => ({
      ...settingsUpdaterBinding,
      onNavigationConsumed: handleSettingsSectionChange,
    }),
    [handleSettingsSectionChange, settingsUpdaterBinding],
  );
  const capabilitiesBinding = useMemo<BuiltinTabBindings['capabilities']>(
    () => ({
      ...settingsUpdaterBinding,
      onNavigationConsumed: handleCapabilitySectionChange,
      onOpenToolMarket: handleOpenToolMarket,
    }),
    [handleCapabilitySectionChange, handleOpenToolMarket, settingsUpdaterBinding],
  );
  const taskCenterBinding = useMemo<BuiltinTabBindings['taskcenter']>(
    () => ({
      activeRecordingSnapshot,
      onStartRecording: handleStartRecording,
      onOpenRecord: (recordId, mediaMs, activeRecording) =>
        handleOpenRecord(recordId, mediaMs, 'task_center', activeRecording),
      onSearchIntentConsumed: handleTaskSearchIntentConsumed,
      onRouteConsumed: handleTaskRouteConsumed,
    }),
    [
      activeRecordingSnapshot,
      handleOpenRecord,
      handleStartRecording,
      handleTaskRouteConsumed,
      handleTaskSearchIntentConsumed,
    ],
  );
  const spaceBinding = useMemo<BuiltinTabBindings['space']>(
    () => ({ onRouteConsumed: handleSpaceRouteConsumed }),
    [handleSpaceRouteConsumed],
  );
  const recordBinding = useMemo<BuiltinTabBindings['record']>(
    () => ({
      onRecordingSnapshotChange: handleRecordingSnapshotChange,
      registerPendingNoteSubmitter: registerPendingRecordNoteSubmitter,
      onTitleChange: handleRecordTitleChange,
      onDeleted: handleRecordDeleted,
    }),
    [
      handleRecordDeleted,
      handleRecordTitleChange,
      handleRecordingSnapshotChange,
      registerPendingRecordNoteSubmitter,
    ],
  );
  const tabBindings = useMemo<BuiltinTabBindings>(
    () => composeBuiltinTabBindings({
      launcher: launcherBinding,
      chat: chatBinding,
      settings: settingsBinding,
      capabilities: capabilitiesBinding,
      taskcenter: taskCenterBinding,
      space: spaceBinding,
      agentnetwork: null,
      projectboard: null,
      record: recordBinding,
    }),
    [
      capabilitiesBinding,
      chatBinding,
      launcherBinding,
      recordBinding,
      settingsBinding,
      spaceBinding,
      taskCenterBinding,
    ],
  );

  return (
    <SessionDeletionContext.Provider value={handleDeleteSession}>
      <LinkContextMenuProvider>
        <div className="flex h-screen bg-[var(--paper)]">
          <GlobalSidebar
            newAgentPanelOpen={newAgentPanelOpen}
            onNewAgentPanelOpenChange={setNewAgentPanelOpen}
            tabs={tabs}
            activeTab={activeTab}
            activeWorkspacePath={activeWorkspacePath}
            sessionNotificationBadgeCounts={sessionNotificationBadgeCounts}
            teamSpaceAvailable={teamSpaceAvailable}
            onNewTab={handleSidebarNewChat}
            onOpenTaskCenter={handleOpenTaskCenter}
            onCreateTask={handleSidebarCreateTask}
            onOpenSpace={handleOpenSpace}
            onOpenAgentNetwork={() => tabWorkspaceController.open('agentnetwork', { title: t('tabs.agentNetwork') })}
            onOpenAppRoute={handleOpenAppRoute}
            onOpenCapabilities={handleOpenCapabilities}
            onOpenSettings={handleOpenGeneralSettings}
            onOpenBugReport={handleOpenBugReport}
            onOpenProjectBoard={handleOpenProjectBoard}
            onOpenWorkspace={handleOpenWorkspaceFromSidebar}
            onOpenSession={handleOpenSidebarSession}
            onRenameSession={renamePersistedSession}
            historyTagIntent={historyTagIntent}
            onHistoryTagIntentConsumed={handleHistoryTagIntentConsumed}
          />
          <div className="flex min-w-0 flex-1 flex-col" data-tab-workspace>
            {/* Chrome-style titlebar with tabs */}
            <CustomTitleBar
              updateReady={updateReady}
              updateVersion={updateVersion}
              updateInstalling={updateInstalling}
              updatePreparing={updatePreparing}
              onRestartAndUpdate={() => void handleRestartAndUpdate()}
              restoreCount={restorePillCount}
              onRestoreSession={handleRestoreLastSession}
              onDismissRestore={handleDismissRestore}
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
            <div
              ref={contentRef}
              className="relative flex-1 overflow-hidden"
              data-tab-content-workspace
            >
              {tabs.map((tab) => (
                <BuiltinTabSlot
                  key={tab.id}
                  tab={tab}
                  isActive={tab.id === activeTabId}
                  isDeferred={deferredMountTabIds.has(tab.id)}
                  bindings={tabBindings}
                />
              ))}
            </div>
          </div>

          {taskCreateIntent && (
            <DispatchTaskDialog
              key={taskCreateIntent.id}
              thought={taskCreateIntent.thought}
              defaultWorkspacePath={taskCreateIntent.defaultWorkspacePath}
              currentSessionId={taskCreateIntent.currentSessionId ?? null}
              initialMode={taskCreateIntent.initialMode}
              onClose={() => setTaskCreateIntent(null)}
              onDiscuss={handleCreateDialogDiscussion}
              onDispatched={(created) => {
                track('task_create', {
                  source: 'desktop',
                  origin: taskCreateIntent.source,
                  has_workspace: !!created.workspacePath,
                });
                setTaskCreateIntent(null);
              }}
            />
          )}

          {recordCloseDialog}

          {/* One exit confirmation for scheduler and recording lifecycle. */}
          {exitConfirmState && (
            <ConfirmDialog
              title={t('appChrome.exitAppTitle')}
              message={
                exitConfirmState.lifecycleUnknown
                  ? t('appChrome.exitLifecycleUnknownMessage')
                  : exitConfirmState.hasActiveRecording &&
                      exitConfirmState.runningTaskCount > 0
                    ? t('appChrome.exitRecordingAndTasksMessage', {
                        count: exitConfirmState.runningTaskCount,
                      })
                    : exitConfirmState.hasActiveRecording
                      ? t('appChrome.exitRecordingMessage')
                      : t('appChrome.exitRunningTasksMessage', {
                          count: exitConfirmState.runningTaskCount,
                        })
              }
              confirmText={
                exitConfirmState.hasActiveRecording
                  ? t('appChrome.recordStopSaveExit')
                  : t('appChrome.exit')
              }
              cancelText={t('appChrome.cancel')}
              confirmVariant="danger"
              loading={exitConfirmState.loading}
              onConfirm={() => {
                const pending = exitConfirmState;
                setExitConfirmState((current) =>
                  current ? { ...current, loading: true } : current,
                );
                void (async () => {
                  if (
                    pending.recording &&
                    !(await flushPendingRecordNote(pending.recording.recordId))
                  ) {
                    setExitConfirmState((current) =>
                      current ? { ...current, loading: false } : current,
                    );
                    return;
                  }
                  pending.resolve(true);
                  setExitConfirmState(null);
                })();
              }}
              onCancel={() => {
                exitConfirmState.resolve(false);
                setExitConfirmState(null);
              }}
            />
          )}

          {/* Windows/macOS: startup dialog for a deferred update from the previous session.
          Hidden while a silent download is replacing the pending bytes —
          confirming "安装" mid-replacement could land on inconsistent
          cache/disk state. Comes back into view automatically when the
          download completes (the dialog reads pendingUpdateOnStartup, which
          is unchanged; only the visibility gate is `updatePreparing`). */}
          {showUpdateRestartConfirmation && !updatePreparing && (
            <ConfirmDialog
              title={t('appChrome.updateRestartTitle')}
              message={t('appChrome.updateRestartMessage', { version: updateVersion })}
              confirmText={t('appChrome.updateRestartConfirm')}
              cancelText={t('appChrome.later')}
              confirmVariant="primary"
              onConfirm={() => {
                setShowUpdateRestartConfirmation(false);
                void handleRestartAndUpdate(true);
              }}
              onCancel={() => setShowUpdateRestartConfirmation(false)}
            />
          )}
          {pendingUpdateOnStartup && !updatePreparing && (
            <ConfirmDialog
              title={t('appChrome.newVersionTitle')}
              message={t(APP_BUILD_PROFILE === 'moxbot' ? 'appChrome.updateRestartMessage' : 'appChrome.newVersionMessage', {
                version: pendingUpdateOnStartup,
              })}
              confirmText={t(APP_BUILD_PROFILE === 'moxbot' ? 'appChrome.updateRestartConfirm' : 'appChrome.install')}
              cancelText={t('appChrome.later')}
              confirmVariant="primary"
              onConfirm={() => {
                dismissPendingUpdate();
                // Route through handleRestartAndUpdate so toast feedback fires
                // on failure modes (network error / version mismatch).
                void handleRestartAndUpdate(true);
              }}
              onCancel={dismissPendingUpdate}
            />
          )}

          {/* Bug report overlay triggered from titlebar feedback button */}
          {showBugReport && (
            <BugReportOverlay
              onClose={() => setShowBugReport(false)}
              onNavigateToProviders={() => {
                setShowBugReport(false);
                handleOpenSettings('providers');
              }}
              appVersion={appVersion}
              providers={appProviders}
              apiKeys={appApiKeys}
              providerVerifyStatus={appProviderVerifyStatus}
              initialProviderId={helperAgentDefaults.initialProviderId}
              initialModel={helperAgentDefaults.initialModel}
              onModelChange={helperAgentDefaults.onModelChange}
              assistantEntry="tab_top"
            />
          )}
        </div>
      </LinkContextMenuProvider>
    </SessionDeletionContext.Provider>
  );
}
