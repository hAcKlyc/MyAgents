import { TASK_ALIGNMENT_SKILL_REQUIREMENT } from "../shared/systemSkills";
import { composeQueryReminder } from "../shared/agentMentions";
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useContext, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../shared/config-types';
import { CUSTOM_EVENTS } from '../shared/constants';
import type { SessionMetadata } from '@/api/sessionClient';
import { ensureSelfAwarenessWorkspace } from '@/config/configService';
import { SessionDeletionContext } from '@/context/SessionDeletionContext';
import { useTabStateOptional } from '@/context/TabContext';

const tauriCoreMocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(
    async () => undefined,
  ),
}));

vi.mock('@tauri-apps/api/core', () => tauriCoreMocks);

const mocks = vi.hoisted(() => {
  const project = {
    id: 'helper-project',
    path: '/Users/me/.myagents',
    displayName: 'MA Helper',
    agentId: 'helper-agent',
  };
  const agent = {
    id: 'helper-agent',
    name: 'MA Helper',
    workspacePath: project.path,
    providerId: undefined as string | undefined,
    model: undefined as string | undefined,
    runtime: 'builtin',
    permissionMode: 'auto',
    reasoningEffort: undefined as string | undefined,
    runtimeConfig: undefined as { source?: string; permissionMode?: string; reasoningEffort?: string } | undefined,
  };
  const provider = {
    id: 'provider-1',
    name: 'Provider',
    type: 'openai-compatible',
    baseUrl: 'https://example.com',
    primaryModel: 'mimo-v2.5-pro',
    models: [{ id: 'mimo-v2.5-pro', name: 'mimo-v2.5-pro' }],
  };

  return {
    project,
    spaceDevGate: undefined as boolean | undefined,
    spaceBuildAvailable: true,
    configLoading: false,
    agent,
    provider,
    resolveBuiltinSelection: vi.fn((): { provider: typeof provider; model: string } | undefined => ({
      provider,
      model: 'mimo-v2.5-pro',
    })),
    createSession: vi.fn(async () => ({
      id: 'prepared-managed-session',
      agentDir: project.path,
      title: 'Prepared',
      createdAt: '2026-06-27T00:00:00.000Z',
      lastActiveAt: '2026-06-27T00:00:00.000Z',
    })),
    deleteSession: vi.fn(async () => ({ deleted: true as const })),
    updateSession: vi.fn<(
      sessionId: string,
      updates: { title?: string; titleSource?: 'user' | 'auto' },
    ) => Promise<SessionMetadata | undefined>>(async () => undefined),
    deleteTargetSessionId: null as string | null,
    deleteResults: [] as Array<{ deleted: boolean; reason?: string }>,
    startGlobalSidecar: vi.fn(async () => undefined),
    initGlobalSidecarReadyPromise: vi.fn(),
    markGlobalSidecarReady: vi.fn(),
    getGlobalServerUrl: vi.fn(async () => 'http://127.0.0.1:31415'),
    ensureSessionSidecar: vi.fn(async () => ({ port: 31417, isNew: true })),
    activateSession: vi.fn(async () => undefined),
    reconcileSessionTabActivation: vi.fn(async (_sessionId: string, _tabId: string) => true),
    upgradeSessionId: vi.fn(async () => true),
    getSessionActivation: vi.fn(async () => null as {
      tab_id: string | null;
      task_id: string | null;
      port?: number;
      workspace_path?: string;
      is_cron_task?: boolean;
    } | null),
    updateSessionTab: vi.fn(async () => undefined),
    cancelBackgroundCompletion: vi.fn(async () => undefined),
    releaseTabSession: vi.fn(async () => false),
    getSessionPort: vi.fn(async () => null),
    hasSessionSidecar: vi.fn(async () => true),
    getSessionGeneration: vi.fn(async () => 1 as number | null),
    startBackgroundCompletion: vi.fn(async () => ({ started: false, sessionId: 'session' })),
    querySessionHasPersistentOwners: vi.fn(async () => false),
    canRestoreSession: vi.fn(async () => true),
    recordGet: vi.fn(async (recordId: string) => ({
      id: recordId,
      kind: 'audio' as const,
      title: 'Recovered Record',
      tags: [],
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      convertedTaskIds: [],
      revision: 1,
    }) as {
      id: string;
      kind: 'audio';
      title: string;
      tags: string[];
      createdAt: number;
      updatedAt: number;
      archived: boolean;
      convertedTaskIds: string[];
      revision: number;
    } | null),
    recordingStart: vi.fn(async () => ({
      snapshot: {
        recordId: 'active-record',
        revision: 1,
        generation: 1,
        captureStatus: 'recording' as const,
        startedAtWallTime: 1_700_000_000_000,
        mediaDurationMs: 0,
        pausedWallMs: 0,
        sources: [],
        sourceActivity: [],
        warnings: [],
      },
      attachedToExisting: false,
    })),
    durableTabs: null as null | {
      version: 1;
      tabs: Array<
        | {
            view: 'chat';
            id: string;
            agentDir: string;
            sessionId: string;
            title: string;
            discussionId?: string;
          }
        | {
            view: 'record';
            id: string;
            recordId: string;
            title: string;
          }
      >;
      activeTabId: string | null;
    },
    lastExitWasClean: true,
    setAppActiveCorrelation: vi.fn(),
    setAppActiveTabId: vi.fn(),
    useRealTabProvider: false,
    tauriEnvironment: false,
    listeners: new Map<string, (event: { payload: unknown }) => void | Promise<void>>(),
    sessionSidecarFetch: vi.fn(),
    track: vi.fn(),
    chatProps: [] as Array<Record<string, unknown>>,
    tabProviderProps: [] as Array<Record<string, unknown>>,
    launcherProps: [] as Array<Record<string, unknown>>,
    sidebarProps: [] as Array<Record<string, unknown>>,
    tabbarProps: [] as Array<Record<string, unknown>>,
    settingsProps: [] as Array<Record<string, unknown>>,
    spaceProps: [] as Array<Record<string, unknown>>,
    taskCenterProps: [] as Array<Record<string, unknown>>,
    toast: {
      error: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
    },
    selfAwarenessProject: project as typeof project | null,
  };
});
vi.mock('@/analytics', () => ({
  initAnalytics: vi.fn(async () => undefined),
  track: mocks.track,
  setAnalyticsContext: vi.fn(),
  clearAnalyticsContext: vi.fn(),
  setPendingSurface: vi.fn(),
  clearPendingSurface: vi.fn(),
  setPendingSessionBirth: vi.fn(),
  clearPendingSessionBirth: vi.fn(),
  consumePendingSessionBirth: vi.fn(),
  peekPendingSessionBirth: vi.fn(),
  birthContextForSurface: vi.fn((surface: string) => ({
    surface,
    entryIntent: surface === 'new_chat_button' ? 'new_chat' : 'unknown',
    hasInitialMessage: surface !== 'new_chat_button',
  })),
  hashAgentName: vi.fn(async () => 'agent-hash'),
  hashAgentNameSync: vi.fn(() => 'agent-hash'),
}));

vi.mock('@/api/tauriClient', () => ({
  stopTabSidecar: vi.fn(async () => undefined),
  setAppActiveCorrelation: mocks.setAppActiveCorrelation,
  startGlobalSidecar: mocks.startGlobalSidecar,
  initGlobalSidecarReadyPromise: mocks.initGlobalSidecarReadyPromise,
  markGlobalSidecarReady: mocks.markGlobalSidecarReady,
  getGlobalServerUrl: mocks.getGlobalServerUrl,
  getSessionActivation: mocks.getSessionActivation,
  updateSessionTab: mocks.updateSessionTab,
  ensureSessionSidecar: mocks.ensureSessionSidecar,
  releaseTabSession: mocks.releaseTabSession,
  activateSession: mocks.activateSession,
  reconcileSessionTabActivation: mocks.reconcileSessionTabActivation,
  upgradeSessionId: mocks.upgradeSessionId,
  getSessionPort: mocks.getSessionPort,
  getTabServerUrl: vi.fn(async () => 'http://127.0.0.1:31417'),
  sessionSidecarFetch: mocks.sessionSidecarFetch,
  isTauri: () => false,
  resetTabServerUrlCache: vi.fn(),
  setActiveCorrelation: vi.fn(),
  hasSessionSidecar: mocks.hasSessionSidecar,
  getSessionGeneration: mocks.getSessionGeneration,
  stopSseProxy: vi.fn(async () => undefined),
  startBackgroundCompletion: mocks.startBackgroundCompletion,
  startBackgroundCompletionForDeletion: mocks.startBackgroundCompletion,
  cancelBackgroundCompletion: mocks.cancelBackgroundCompletion,
  updateGlobalServerUrl: vi.fn(),
  canRestoreSession: mocks.canRestoreSession,
  getUserSchedulerLifecycleSnapshot: vi.fn(async () => ({ runningTaskCount: 0, deleteProtectedSessionIds: [] })),
  querySessionHasPersistentOwners: mocks.querySessionHasPersistentOwners,
  sessionHasPersistentOwners: vi.fn(async () => false),
}));

vi.mock('@/api/SseConnection', () => ({
  createSseConnection: () => {
    let statusHandler: ((status: 'connected' | 'disconnected' | 'reconnecting' | 'failed') => void) | null = null;
    return {
      setEventHandler: vi.fn(),
      setStatusHandler: vi.fn((handler: typeof statusHandler) => {
        statusHandler = handler;
      }),
      connect: vi.fn(async () => {
        statusHandler?.('connected');
      }),
      disconnect: vi.fn(async () => undefined),
      isActive: vi.fn(() => true),
      getConnectionGeneration: vi.fn(() => 1),
    };
  },
}));

vi.mock('@/api/apiFetch', () => ({
  apiGetJson: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/api/cronTaskClient', () => ({
  getAllCronTasks: vi.fn(async () => []),
  getTabCronTask: vi.fn(async () => null),
  updateCronTaskTab: vi.fn(async () => undefined),
}));

vi.mock('@/api/sessionClient', () => ({
  createSession: mocks.createSession,
  deleteSession: mocks.deleteSession,
  getSessions: vi.fn(async () => []),
  updateSession: mocks.updateSession,
}));

vi.mock('@/api/taskCenter', () => ({
  recordGet: mocks.recordGet,
}));

vi.mock('@/api/recording', () => ({
  recordingSnapshot: vi.fn(async () => null),
  recordingStart: mocks.recordingStart,
  recordingStop: vi.fn(async (snapshot: unknown) => snapshot),
}));

vi.mock('@/components/ChatBootOverlay', () => ({
  default: () => <div data-testid="chat-boot-overlay" />,
}));

vi.mock('@/components/ConfirmDialog', () => ({
  default: () => <div data-testid="confirm-dialog" />,
}));

vi.mock('@/components/BugReportOverlay', () => ({
  default: () => <div data-testid="bug-report-overlay" />,
}));

vi.mock('@/components/CustomTitleBar', () => ({
  default: ({
    children,
    restoreCount = 0,
    onRestoreSession,
  }: {
    children: React.ReactNode;
    restoreCount?: number;
    onRestoreSession?: () => void;
  }) => (
    <div data-testid="titlebar">
      {restoreCount > 0 && (
        <button data-testid="restore-session" onClick={onRestoreSession} />
      )}
      {children}
    </div>
  ),
}));

vi.mock('@/components/global-sidebar/GlobalSidebar', () => ({
  default: function MockGlobalSidebar(props: Record<string, unknown>) {
    mocks.sidebarProps.push(props);
    const deleteSession = useContext(SessionDeletionContext);
    return (
      <aside data-testid="global-sidebar">
        <button
          data-testid="app-delete-session"
          onClick={() => {
            if (!mocks.deleteTargetSessionId || !deleteSession) return;
            void deleteSession(mocks.deleteTargetSessionId).then((result) => {
              mocks.deleteResults.push(result);
            });
          }}
        />
      </aside>
    );
  },
}));

vi.mock('@/components/LinkContextMenuProvider', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/TabBar', () => ({
  default: (props: { tabs: Array<{ id: string; title: string; sessionId?: string | null; view?: string; recordId?: string; sidecarConfigDisposition?: string }>; activeTabId: string | null; onSelectTab: (tabId: string) => void; onCloseTab: (tabId: string) => Promise<void>; onNewTab: () => void }) => {
    mocks.tabbarProps.push(props);
    return <div data-testid="tabbar-active">{props.tabs.find(t => t.id === props.activeTabId)?.title ?? 'missing'}</div>;
  },
}));

vi.mock('@/context/TabProvider', async () => {
  const actual = await vi.importActual<typeof import('@/context/TabProvider')>('@/context/TabProvider');
  const RealTabProvider = actual.default;
  return {
    default: function TestTabProvider(props: React.ComponentProps<typeof RealTabProvider>) {
      mocks.tabProviderProps.push(props as unknown as Record<string, unknown>);
      if (mocks.useRealTabProvider) {
        return <RealTabProvider {...props} />;
      }
      return <div data-testid="tab-provider" data-tab-id={props.tabId}>{props.children}</div>;
    },
  };
});

vi.mock('@/pages/Chat', () => {
  function MockChat(props: Record<string, unknown>) {
    const [streamChunks, setStreamChunks] = useState(0);
    const tabState = useTabStateOptional();
    mocks.chatProps.push(props);
    const historyText = tabState?.historyMessages
      .map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
      .join('\n');
    return (
      <button data-testid="chat-page" onClick={() => setStreamChunks((count) => count + 1)}>
        {historyText || streamChunks}
      </button>
    );
  }
  return { default: MockChat };
});

vi.mock('@/pages/Launcher', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.launcherProps.push(props);
    return <div data-testid="launcher-page" />;
  },
}));

vi.mock('@/pages/Settings', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.settingsProps.push(props);
    return <div data-testid="settings-page">
      {props.mode === 'capabilities' && <button type="button" onClick={props.onOpenToolMarket as () => void}>open tool market</button>}
    </div>;
  },
}));

vi.mock('@/pages/Space', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.spaceProps.push(props);
    return <div data-testid="space-page" />;
  },
}));

vi.mock('@/pages/TaskCenter', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.taskCenterProps.push(props);
    return <div data-testid="taskcenter-page" />;
  },
}));

vi.mock('@/pages/RecordDetail', () => ({
  default: ({ recordId }: { recordId: string }) => (
    <div data-testid="record-detail-page">{recordId}</div>
  ),
}));

vi.mock('@/components/Toast', () => ({
  useToastOptional: () => mocks.toast,
  useToast: () => mocks.toast,
}));

vi.mock('@/hooks/useUpdater', () => ({
  useUpdater: () => ({
    updateReady: false,
    updateVersion: null,
    updateChecking: false,
    updateDownloading: false,
    updateInstalling: false,
    updatePreparing: false,
    pendingUpdateOnStartup: null,
    dismissPendingUpdate: vi.fn(),
    checkForUpdate: vi.fn(async () => 'up-to-date'),
    restartAndUpdate: vi.fn(),
  }),
}));

vi.mock('@/hooks/useTrayEvents', () => ({
  useTrayEvents: vi.fn(),
}));

vi.mock('@/hooks/useHelperAgentModelDefaults', () => ({
  useHelperAgentModelDefaults: () => ({
    providerId: mocks.provider.id,
    model: 'mimo-v2.5-pro',
    setDefaults: vi.fn(),
  }),
}));

vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({
    config: {
      projects: [mocks.project],
      agents: [mocks.agent],
      managedCodexProviderDevGate: true,
      managedCodexRuntimeInstall: { status: 'installed', usable: true },
      managedCodexAuth: { status: 'valid', authMethod: 'chatgpt' },
      defaultPermissionMode: 'auto',
      teamSpaceEnabled: false, // Legacy Lab opt-out must not hide the released entry.
      teamSpaceDevGate: mocks.spaceDevGate,
    },
    isLoading: mocks.configLoading,
    error: null,
    projects: [mocks.project],
    providers: [mocks.provider],
    apiKeys: { [mocks.provider.id]: 'key' },
    providerVerifyStatus: { [mocks.provider.id]: { status: 'valid' } },
    addProject: vi.fn(async () => mocks.project),
    updateProject: vi.fn(async () => undefined),
    patchProject: vi.fn(async () => undefined),
    removeProject: vi.fn(async () => undefined),
    touchProject: vi.fn(async () => undefined),
    addCustomProvider: vi.fn(async () => undefined),
    updateCustomProvider: vi.fn(async () => undefined),
    deleteCustomProvider: vi.fn(async () => undefined),
    refreshProviders: vi.fn(async () => undefined),
    savePresetCustomModels: vi.fn(async () => undefined),
    removePresetCustomModel: vi.fn(async () => undefined),
    savePrimaryModel: vi.fn(async () => undefined),
    saveProviderModelAliases: vi.fn(async () => undefined),
    saveApiKey: vi.fn(async () => undefined),
    deleteApiKey: vi.fn(async () => undefined),
    saveProviderVerifyStatus: vi.fn(async () => undefined),
    updateConfig: vi.fn(async () => undefined),
    patchProxySettings: vi.fn(async () => undefined),
    refreshConfig: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    refreshProviderData: vi.fn(async () => undefined),
  }),
}));

vi.mock('@/config/useConfigData', () => ({
  useConfigData: () => ({ config: {  } }),
}));

vi.mock('@/config/services/appConfigService', () => ({
  atomicModifyConfig: vi.fn(async (
    modifier: (config: Record<string, unknown>) => Record<string, unknown>,
  ) => modifier({})),
  notifyConfigChanged: vi.fn(),
}));

vi.mock('@/hooks/useTabSwipeGesture', () => ({
  useTabSwipeGesture: vi.fn(),
}));

vi.mock('@/hooks/useSpaceBuildCapability', () => ({
  useSpaceBuildCapability: () => ({ isLoading: false, available: mocks.spaceBuildAvailable, reason: null }),
}));

vi.mock('@/utils/browserMock', () => ({
  isBrowserDevMode: () => false,
  isTauriEnvironment: () => mocks.tauriEnvironment,
}));

vi.mock('@/utils/frontendLogger', () => ({
  forceFlushLogs: vi.fn(async () => undefined),
  setLogServerReady: vi.fn(),
  clearLogServerUrl: vi.fn(),
  setAppActiveTabId: mocks.setAppActiveTabId,
  subscribeFrontendLogs: () => () => undefined,
  setCurrentTabId: vi.fn(),
}));

vi.mock('@/utils/lastExitMarker', () => ({
  consumeCleanExitMarker: vi.fn(async () => mocks.lastExitWasClean),
}));

vi.mock('@/utils/tabPersistenceDurable', () => ({
  persistOpenTabsDurable: vi.fn(async () => undefined),
  loadAndClearOpenTabsDurable: vi.fn(async () => mocks.durableTabs),
  clearOpenTabsDurable: vi.fn(async () => undefined),
}));

vi.mock('@/utils/tauriListen', () => ({
  listenWithCleanup: vi.fn(async (
    eventName: string,
    handler: (event: { payload: unknown }) => void | Promise<void>,
  ) => {
    mocks.listeners.set(eventName, handler);
    return { isRegistered: () => true, unlisten: () => { if (mocks.listeners.get(eventName) === handler) mocks.listeners.delete(eventName); } };
  }),
}));

vi.mock('@/config/configService', () => ({
  ensureSelfAwarenessWorkspace: vi.fn(async () => mocks.selfAwarenessProject),
  resolveBuiltinSelection: mocks.resolveBuiltinSelection,
  pairBuiltinSelection: vi.fn((_provider, model) => ({ providerId: mocks.provider.id, model })),
  isProviderAvailable: vi.fn(() => true),
}));

vi.mock('@/config/services/agentConfigService', () => ({
  getProjectAgent: vi.fn(() => mocks.agent),
  getAgentById: vi.fn(() => mocks.agent),
}));

import App from './App';

describe('App helper launch', () => {
  afterEach(() => {
  mocks.configLoading = false;
  mocks.spaceDevGate = undefined;
  mocks.spaceBuildAvailable = true;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    localStorage.clear();
    mocks.chatProps.length = 0;
    mocks.tabProviderProps.length = 0;
    mocks.launcherProps.length = 0;
    mocks.sidebarProps.length = 0;
    mocks.tabbarProps.length = 0;
    mocks.settingsProps.length = 0;
    mocks.spaceProps.length = 0;
    mocks.taskCenterProps.length = 0;
    mocks.selfAwarenessProject = mocks.project;
    mocks.deleteTargetSessionId = null;
    mocks.deleteResults.length = 0;
    mocks.durableTabs = null;
    mocks.lastExitWasClean = true;
    mocks.useRealTabProvider = false;
    mocks.tauriEnvironment = false;
    mocks.listeners.clear();
    tauriCoreMocks.invoke.mockImplementation(async () => undefined);
    mocks.sessionSidecarFetch.mockReset();
    mocks.agent.runtime = 'builtin';
    mocks.agent.providerId = undefined;
    mocks.agent.model = undefined;
    mocks.agent.permissionMode = 'auto';
    mocks.agent.reasoningEffort = undefined;
    mocks.agent.runtimeConfig = undefined;
    mocks.hasSessionSidecar.mockResolvedValue(true);
    mocks.getSessionGeneration.mockResolvedValue(1);
    mocks.ensureSessionSidecar.mockResolvedValue({ port: 31417, isNew: true });
    mocks.activateSession.mockResolvedValue(undefined);
    mocks.reconcileSessionTabActivation.mockResolvedValue(true);
    mocks.upgradeSessionId.mockResolvedValue(true);
    mocks.getSessionActivation.mockResolvedValue(null);
    mocks.updateSessionTab.mockResolvedValue(undefined);
    mocks.updateSession.mockReset();
    mocks.updateSession.mockResolvedValue(undefined);
    mocks.cancelBackgroundCompletion.mockResolvedValue(undefined);
    mocks.querySessionHasPersistentOwners.mockResolvedValue(false);
    mocks.canRestoreSession.mockResolvedValue(true);
    mocks.recordGet.mockResolvedValue({
      id: 'restored-record',
      kind: 'audio',
      title: 'Recovered Record',
      tags: [],
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      convertedTaskIds: [],
      revision: 1,
    });
    mocks.recordingStart.mockResolvedValue({
      snapshot: {
        recordId: 'active-record',
        revision: 1,
        generation: 1,
        captureStatus: 'recording',
        startedAtWallTime: 1_700_000_000_000,
        mediaDurationMs: 0,
        pausedWallMs: 0,
        sources: [],
        sourceActivity: [],
        warnings: [],
      },
      attachedToExisting: false,
    });
    mocks.resolveBuiltinSelection.mockReturnValue({ provider: mocks.provider, model: 'mimo-v2.5-pro' });
  });

  function managedCodexProvider() {
    return {
      ...mocks.provider,
      id: CODEX_SUBSCRIPTION_PROVIDER_ID,
      name: 'Codex Subscription',
      type: 'subscription',
      baseUrl: '',
      execution: { kind: 'runtime-backed' as const, runtime: 'codex' as const, source: 'managed-provider' as const },
      primaryModel: 'gpt-5.5',
      models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
    };
  }

  function latestLauncherProps() {
    const props = mocks.launcherProps.at(-1);
    if (!props) throw new Error('Launcher props were not captured');
    return props as {
      onLaunchProject: (
        project: typeof mocks.project,
        initialMessage?: unknown,
        analyticsContext?: unknown,
        sessionBirthHint?: unknown,
      ) => Promise<boolean>;
    };
  }

  function latestChatProps() {
    const props = mocks.chatProps.at(-1);
    if (!props) throw new Error('Chat props were not captured');
    return props as {
      onLaunchRuntimeBackedProviderSession: (
        project: typeof mocks.project,
        sessionBirthHint: {
          providerExecutionIdentity: {
            kind: 'runtime-backed-provider';
            providerId: string;
            runtime: 'codex';
            runtimeSource: 'managed-provider';
            model: string;
          };
          permissionMode?: string;
          reasoningEffort?: string;
          mcpEnabledServers?: string[];
          enabledPluginIds?: string[];
          origin?: { kind: 'desktop'; surface: 'session_fork' };
        },
        title: string,
      ) => Promise<string | null>;
    };
  }

  function latestSidebarProps() {
    const props = mocks.sidebarProps.at(-1);
    if (!props) throw new Error('GlobalSidebar props were not captured');
    return props as {
      onNewTab: () => void;
      onOpenCapabilities: () => void;
      onOpenSettings: () => void;
      onOpenTaskCenter: () => void;
      onOpenSpace: () => void;
      teamSpaceAvailable: boolean;
      onOpenWorkspace: (
        project: typeof mocks.project,
        initialMessage?: unknown,
        entryIntent?: 'open_workspace' | 'workspace_init',
      ) => Promise<boolean>;
      onOpenSession: (session: { id: string; agentDir: string; title: string }, project: typeof mocks.project) => Promise<boolean>;
      onRenameSession: (sessionId: string, newTitle: string) => Promise<SessionMetadata | null>;
    };
  }

  function latestTabbarProps() {
    const props = mocks.tabbarProps.at(-1);
    if (!props) throw new Error('TabBar props were not captured');
    return props as {
      tabs: Array<{ id: string; title: string; sessionId?: string | null; view?: string; recordId?: string }>;
      activeTabId: string | null;
      onSelectTab: (tabId: string) => void;
      onNewTab: () => void;
    };
  }

  function latestSettingsProps() {
    const props = [...mocks.settingsProps]
      .reverse()
      .find((candidate) => candidate.mode === 'capabilities');
    if (!props) throw new Error('Capabilities Settings props were not captured');
    return props;
  }

  function latestTaskCenterProps() {
    const props = mocks.taskCenterProps.at(-1);
    if (!props) throw new Error('Task Center props were not captured');
    return props as {
      onStartRecording: (selection: { microphone: boolean; system: boolean }) => Promise<void>;
    };
  }

  it('reuses the leftmost Launcher from the sidebar while the Tab plus keeps creating', () => {
    render(<App />);
    const firstLauncherId = latestTabbarProps().tabs[0].id;

    act(() => latestTabbarProps().onNewTab());
    expect(latestTabbarProps().tabs).toHaveLength(2);
    expect(latestTabbarProps().activeTabId).not.toBe(firstLauncherId);

    act(() => latestSidebarProps().onNewTab());
    expect(latestTabbarProps().tabs).toHaveLength(2);
    expect(latestTabbarProps().activeTabId).toBe(firstLauncherId);

    act(() => latestTabbarProps().onNewTab());
    expect(latestTabbarProps().tabs).toHaveLength(3);
    expect(latestTabbarProps().activeTabId).toBe(latestTabbarProps().tabs[2].id);
  });

  it('creates a Launcher from the sidebar when no Launcher Tab exists', async () => {
    render(<App />);

    await act(async () => {
      await latestLauncherProps().onLaunchProject(mocks.project);
    });
    expect(latestTabbarProps().tabs.some((tab) => tab.view === 'launcher')).toBe(false);

    act(() => latestSidebarProps().onNewTab());
    const current = latestTabbarProps();
    expect(current.tabs).toHaveLength(2);
    expect(current.tabs.find((tab) => tab.id === current.activeTabId)?.view).toBe('launcher');
  });

  it('prepares managed Codex from the Agent product permission, not stale runtime permission', async () => {
    mocks.agent.providerId = CODEX_SUBSCRIPTION_PROVIDER_ID;
    mocks.agent.model = 'gpt-5.5';
    mocks.agent.runtimeConfig = {
      permissionMode: 'suggest',
      reasoningEffort: 'xhigh',
    };
    mocks.resolveBuiltinSelection.mockReturnValue({
      provider: managedCodexProvider(),
      model: 'gpt-5.5',
    });

    render(<App />);

    await act(async () => {
      latestLauncherProps().onLaunchProject(mocks.project);
    });

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith(
        mocks.project.path,
        'codex',
        expect.objectContaining({
          runtimeSource: 'managed-provider',
          providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
          model: 'gpt-5.5',
          permissionMode: 'auto-edit',
          reasoningEffort: 'xhigh',
          providerExecutionIdentity: expect.objectContaining({
            kind: 'runtime-backed-provider',
            providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
            runtime: 'codex',
            runtimeSource: 'managed-provider',
            model: 'gpt-5.5',
          }),
          prepareForFirstUserMessage: true,
          materializationSourceSessionId: expect.stringMatching(/^pending-/),
        }),
        expect.objectContaining({ type: 'tab', id: expect.any(String), pendingSessionId: expect.stringMatching(/^pending-/) }),
      );
    });
    expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
      'prepared-managed-session',
      mocks.project.path,
      'tab',
      expect.stringMatching(/^tab-/),
    );
  });

  it('keeps the readable legacy codex/managed-provider Agent identity on empty launch', async () => {
    mocks.agent.providerId = CODEX_SUBSCRIPTION_PROVIDER_ID;
    mocks.agent.model = 'gpt-5.5';
    mocks.agent.runtime = 'codex';
    mocks.agent.runtimeConfig = { source: 'managed-provider' };
    mocks.resolveBuiltinSelection.mockReturnValue({
      provider: managedCodexProvider(),
      model: 'gpt-5.5',
    });

    render(<App />);
    await act(async () => {
      latestLauncherProps().onLaunchProject(mocks.project);
    });

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith(
        mocks.project.path,
        'codex',
        expect.objectContaining({
          runtimeSource: 'managed-provider',
          permissionMode: 'auto-edit',
          prepareForFirstUserMessage: true,
        }),
        expect.objectContaining({ type: 'tab', id: expect.any(String), pendingSessionId: expect.stringMatching(/^pending-/) }),
      );
    });
  });

  it('prepares managed Codex from the Agent template before its runtime model catalog loads', async () => {
    mocks.agent.providerId = CODEX_SUBSCRIPTION_PROVIDER_ID;
    mocks.agent.model = 'gpt-5.6-sol';
    mocks.resolveBuiltinSelection.mockReturnValue(undefined);

    render(<App />);
    await act(async () => {
      latestLauncherProps().onLaunchProject(mocks.project);
    });

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith(
        mocks.project.path,
        'codex',
        expect.objectContaining({
          runtimeSource: 'managed-provider',
          providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
          model: 'gpt-5.6-sol',
          providerExecutionIdentity: expect.objectContaining({
            kind: 'runtime-backed-provider',
            providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
            runtime: 'codex',
            runtimeSource: 'managed-provider',
            model: 'gpt-5.6-sol',
          }),
          prepareForFirstUserMessage: true,
        }),
        expect.objectContaining({ type: 'tab', id: expect.any(String), pendingSessionId: expect.stringMatching(/^pending-/) }),
      );
    });
  });

  it('uses a Launcher birth hint before stale config when opening an empty workspace', async () => {
    const providerExecutionIdentity = {
      kind: 'runtime-backed-provider' as const,
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      runtime: 'codex' as const,
      runtimeSource: 'managed-provider' as const,
      model: 'gpt-5.5',
    };

    render(<App />);

    await act(async () => {
      latestLauncherProps().onLaunchProject(
        mocks.project,
        undefined,
        { surface: 'agent_card', entryIntent: 'open_workspace' },
        {
          providerExecutionIdentity,
          permissionMode: 'fullAgency',
          reasoningEffort: 'xhigh',
          mcpEnabledServers: ['filesystem'],
          enabledPluginIds: ['plugin-a'],
        },
      );
    });

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith(
        mocks.project.path,
        'codex',
        expect.objectContaining({
          runtimeSource: 'managed-provider',
          providerExecutionIdentity,
          providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
          model: 'gpt-5.5',
          permissionMode: 'no-restrictions',
          reasoningEffort: 'xhigh',
          mcpEnabledServers: ['filesystem'],
          enabledPluginIds: ['plugin-a'],
          prepareForFirstUserMessage: true,
          materializationSourceSessionId: expect.stringMatching(/^pending-/),
        }),
        expect.objectContaining({ type: 'tab', id: expect.any(String), pendingSessionId: expect.stringMatching(/^pending-/) }),
      );
    });
  });

  it('opens a provider-switched Managed Codex session through the prepared App launch path', async () => {
    const providerExecutionIdentity = {
      kind: 'runtime-backed-provider' as const,
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      runtime: 'codex' as const,
      runtimeSource: 'managed-provider' as const,
      model: 'gpt-5.5',
    };

    render(<App />);
    await act(async () => {
      await latestLauncherProps().onLaunchProject(mocks.project);
    });
    await waitFor(() => expect(mocks.chatProps.length).toBeGreaterThan(0));
    const sourceTab = latestTabbarProps().tabs.find(
      (tab) => tab.id === latestTabbarProps().activeTabId,
    );
    expect(sourceTab?.view).toBe('chat');

    mocks.createSession.mockClear();
    mocks.ensureSessionSidecar.mockClear();
    mocks.reconcileSessionTabActivation.mockClear();

    let openedSessionId: string | null = null;
    await act(async () => {
      openedSessionId = await latestChatProps().onLaunchRuntimeBackedProviderSession(
        mocks.project,
        {
          providerExecutionIdentity,
          permissionMode: 'fullAgency',
          reasoningEffort: 'xhigh',
          mcpEnabledServers: ['filesystem'],
          enabledPluginIds: ['plugin-a'],
          origin: { kind: 'desktop', surface: 'session_fork' },
        },
        'Codex Subscription 会话',
      );
    });

    expect(openedSessionId).toBe('prepared-managed-session');
    expect(mocks.createSession).toHaveBeenCalledWith(
      mocks.project.path,
      'codex',
      expect.objectContaining({
        runtimeSource: 'managed-provider',
        providerExecutionIdentity,
        providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
        model: 'gpt-5.5',
        permissionMode: 'no-restrictions',
        reasoningEffort: 'xhigh',
        mcpEnabledServers: ['filesystem'],
        enabledPluginIds: ['plugin-a'],
        origin: { kind: 'desktop', surface: 'session_fork' },
        prepareForFirstUserMessage: true,
        materializationSourceSessionId: expect.stringMatching(/^pending-/),
      }),
        expect.objectContaining({ type: 'tab', id: expect.any(String), pendingSessionId: expect.stringMatching(/^pending-/) }),
      );
    const active = latestTabbarProps().tabs.find(
      (tab) => tab.id === latestTabbarProps().activeTabId,
    );
    expect(latestTabbarProps().tabs).toHaveLength(2);
    expect(active?.id).not.toBe(sourceTab?.id);
    expect(active?.sessionId).toBe('prepared-managed-session');
    expect(active?.view).toBe('chat');
    expect(active?.title).toBe('Codex Subscription 会话');
    expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
      'prepared-managed-session',
      mocks.project.path,
      'tab',
      active?.id,
    );
    expect(mocks.reconcileSessionTabActivation).toHaveBeenCalledWith(
      'prepared-managed-session',
      active?.id,
    );
    expect(latestTabbarProps().tabs.find((tab) => tab.id === sourceTab?.id)).toEqual(sourceTab);
  });

  it('opens a sidebar Session from a no-workspace functional Tab and reconciles the exact same Tab owner on reopen', async () => {
    render(<App />);
    act(() => latestSidebarProps().onOpenCapabilities());
    await waitFor(() => {
      expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(2);
    });

    const session = {
      id: 'sidebar-session',
      agentDir: mocks.project.path,
      title: 'Sidebar history',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    };
    await act(async () => {
      await latestSidebarProps().onOpenSession(session, mocks.project);
    });
    await waitFor(() => {
      expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
        session.id,
        mocks.project.path,
        'tab',
        expect.stringMatching(/^tab-/),
      );
      expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(3);
    });
    const sessionTab = (mocks.tabbarProps.at(-1)?.tabs as Array<{ id: string; sessionId?: string }>).find(
      (tab) => tab.sessionId === session.id,
    );
    expect(sessionTab).toBeTruthy();

    await act(async () => {
      await latestSidebarProps().onOpenSession(session, mocks.project);
    });

    expect(mocks.ensureSessionSidecar).toHaveBeenLastCalledWith(
      session.id,
      mocks.project.path,
      'tab',
      sessionTab?.id,
    );
    expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(3);

    await act(async () => {
      await (mocks.tabbarProps.at(-1)?.onCloseTab as (tabId: string) => Promise<void>)(sessionTab!.id);
    });
    expect(mocks.releaseTabSession).toHaveBeenCalledWith(session.id, sessionTab!.id);
    expect(mocks.deleteSession).not.toHaveBeenCalled();
    expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(2);
    await waitFor(() => {
      expect(mocks.track).toHaveBeenCalledWith('history_open', expect.objectContaining({
        session_id: session.id,
        entry_source: 'global_sidebar',
      }));
    });
  });

  it('does not let an older sidebar rename response overwrite the latest Tab title', async () => {
    const session: SessionMetadata = {
      id: 'rename-race-session',
      agentDir: mocks.project.path,
      title: 'Original title',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    };
    let resolveOlder!: (session: SessionMetadata) => void;
    let resolveNewer!: (session: SessionMetadata) => void;
    mocks.updateSession
      .mockReturnValueOnce(new Promise((resolve) => { resolveOlder = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveNewer = resolve; }));

    render(<App />);
    await act(async () => {
      await latestSidebarProps().onOpenSession(session, mocks.project);
    });

    let olderRename!: Promise<SessionMetadata | null>;
    let newerRename!: Promise<SessionMetadata | null>;
    act(() => {
      olderRename = latestSidebarProps().onRenameSession(session.id, 'Older response');
      newerRename = latestSidebarProps().onRenameSession(session.id, 'Newest title');
    });

    await act(async () => {
      resolveNewer({ ...session, title: 'Newest title', titleSource: 'user' });
      await newerRename;
    });
    expect(latestTabbarProps().tabs.find((tab) => tab.sessionId === session.id)?.title)
      .toBe('Newest title');

    await act(async () => {
      resolveOlder({ ...session, title: 'Older response', titleSource: 'user' });
      await olderRename;
    });
    expect(latestTabbarProps().tabs.find((tab) => tab.sessionId === session.id)?.title)
      .toBe('Newest title');
  });

  it('releases an owner acquired after the existing target Tab closes during reconcile', async () => {
    const session = {
      id: 'closing-reconcile-session',
      agentDir: mocks.project.path,
      title: 'Closing reconcile history',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    };
    render(<App />);
    await act(async () => {
      await latestSidebarProps().onOpenSession(session, mocks.project);
    });
    const sessionTab = (mocks.tabbarProps.at(-1)?.tabs as Array<{ id: string; sessionId?: string }>).find(
      (tab) => tab.sessionId === session.id,
    );
    expect(sessionTab).toBeTruthy();

    let resolveEnsure!: (result: { port: number; isNew: boolean }) => void;
    mocks.ensureSessionSidecar.mockReturnValueOnce(new Promise((resolve) => {
      resolveEnsure = resolve;
    }));
    let reopenPromise!: Promise<boolean>;
    act(() => {
      reopenPromise = latestSidebarProps().onOpenSession(session, mocks.project);
    });
    await waitFor(() => {
      expect(mocks.ensureSessionSidecar).toHaveBeenLastCalledWith(
        session.id,
        mocks.project.path,
        'tab',
        sessionTab!.id,
      );
    });

    await act(async () => {
      await (mocks.tabbarProps.at(-1)?.onCloseTab as (tabId: string) => Promise<void>)(sessionTab!.id);
    });
    let reopened = true;
    await act(async () => {
      resolveEnsure({ port: 31417, isNew: true });
      reopened = await reopenPromise;
    });

    expect(reopened).toBe(false);
    expect((mocks.tabbarProps.at(-1)?.tabs as Array<{ id: string }>).some((tab) => tab.id === sessionTab!.id)).toBe(false);
    expect(mocks.releaseTabSession).toHaveBeenLastCalledWith(session.id, sessionTab!.id);
  });

  it('releases a target Tab closed while Rust activation reconciliation is pending', async () => {
    const session = {
      id: 'closing-during-cancel-session',
      agentDir: mocks.project.path,
      title: 'Closing during cancel',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    };
    render(<App />);
    await act(async () => {
      await latestSidebarProps().onOpenSession(session, mocks.project);
    });
    const sessionTab = (mocks.tabbarProps.at(-1)?.tabs as Array<{ id: string; sessionId?: string }>).find(
      (tab) => tab.sessionId === session.id,
    );
    expect(sessionTab).toBeTruthy();

    mocks.reconcileSessionTabActivation.mockClear();
    mocks.releaseTabSession.mockClear();
    let resolveReconcile!: (value: boolean) => void;
    mocks.reconcileSessionTabActivation.mockReturnValueOnce(new Promise((resolve) => {
      resolveReconcile = resolve;
    }));
    let reopenPromise!: Promise<boolean>;
    act(() => {
      reopenPromise = latestSidebarProps().onOpenSession(session, mocks.project);
    });
    await waitFor(() => expect(mocks.reconcileSessionTabActivation).toHaveBeenCalledWith(
      session.id,
      sessionTab!.id,
    ));

    await act(async () => {
      await (mocks.tabbarProps.at(-1)?.onCloseTab as (tabId: string) => Promise<void>)(sessionTab!.id);
    });
    let reopened = true;
    await act(async () => {
      resolveReconcile(true);
      reopened = await reopenPromise;
    });

    expect(reopened).toBe(false);
    expect(mocks.releaseTabSession).toHaveBeenLastCalledWith(session.id, sessionTab!.id);
  });

  it('refreshes activation when ensure replaces the process behind the same Tab', async () => {
    const session = {
      id: 'replacement-port-session',
      agentDir: mocks.project.path,
      title: 'Replacement port',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    };
    render(<App />);
    await act(async () => {
      await latestSidebarProps().onOpenSession(session, mocks.project);
    });
    const sessionTab = (mocks.tabbarProps.at(-1)?.tabs as Array<{ id: string; sessionId?: string }>).find(
      (tab) => tab.sessionId === session.id,
    );
    expect(sessionTab).toBeTruthy();

    mocks.reconcileSessionTabActivation.mockClear();
    mocks.ensureSessionSidecar.mockResolvedValueOnce({ port: 32001, isNew: true });
    await act(async () => {
      await latestSidebarProps().onOpenSession(session, mocks.project);
    });

    expect(mocks.reconcileSessionTabActivation).toHaveBeenCalledWith(
      session.id,
      sessionTab!.id,
    );
  });

  it('opens developer Chat history through the same new-or-jump path as the sidebar', async () => {
    render(<App />);
    const sourceSession = {
      id: 'chat-history-source',
      agentDir: mocks.project.path,
      title: 'Source history',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    };
    await act(async () => {
      await latestSidebarProps().onOpenSession(sourceSession, mocks.project);
    });

    const chatProps = mocks.chatProps.at(-1) as {
      onOpenSession: (sessionId: string, title: string, source: string) => Promise<void>;
    };
    await act(async () => {
      await chatProps.onOpenSession('chat-history-target', 'Target history', 'chat_dropdown');
    });

    const tabs = mocks.tabbarProps.at(-1)?.tabs as Array<{ sessionId?: string }>;
    expect(tabs.filter(tab => tab.sessionId === sourceSession.id)).toHaveLength(1);
    expect(tabs.filter(tab => tab.sessionId === 'chat-history-target')).toHaveLength(1);
    expect(mocks.ensureSessionSidecar).toHaveBeenLastCalledWith(
      'chat-history-target',
      mocks.project.path,
      'tab',
      expect.stringMatching(/^tab-/),
    );
    expect(mocks.releaseTabSession).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(mocks.track).toHaveBeenCalledWith('history_open', expect.objectContaining({
        session_id: 'chat-history-target',
        entry_source: 'chat_dropdown',
      }));
    });
  });

  it('activates a new sidebar Session tab before its Sidecar is ready', async () => {
    let resolveEnsure!: (result: { port: number; isNew: boolean }) => void;
    mocks.ensureSessionSidecar.mockReturnValueOnce(new Promise((resolve) => {
      resolveEnsure = resolve;
    }));
    const session = {
      id: 'slow-sidebar-session',
      agentDir: mocks.project.path,
      title: 'Slow sidebar history',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    };
    render(<App />);

    let openPromise!: Promise<boolean>;
    act(() => {
      openPromise = latestSidebarProps().onOpenSession(session, mocks.project);
    });

    await waitFor(() => {
      expect(screen.getByTestId('tabbar-active')).toHaveTextContent('Slow sidebar history');
      expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(2);
    });
    const pendingTab = (mocks.tabbarProps.at(-1)?.tabs as Array<{
      sessionId?: string;
      sidecarConfigDisposition?: string;
    }>).find((tab) => tab.sessionId === session.id);
    expect(pendingTab?.sidecarConfigDisposition).toBe('pending');
    expect(screen.getByTestId('tab-provider')).toBeInTheDocument();
    expect(screen.getByTestId('chat-page')).toBeInTheDocument();
    expect(mocks.activateSession).not.toHaveBeenCalled();

    await act(async () => {
      resolveEnsure({ port: 31417, isNew: true });
      await openPromise;
    });
    expect(mocks.reconcileSessionTabActivation).toHaveBeenCalledWith(
      session.id,
      expect.stringMatching(/^tab-/),
    );
    expect(screen.getByTestId('tab-provider')).toBeInTheDocument();
  });

  it('admits only one custom-event open transition for the same Session', async () => {
    let resolveActivation!: (value: boolean) => void;
    mocks.reconcileSessionTabActivation.mockReturnValueOnce(new Promise((resolve) => {
      resolveActivation = resolve;
    }));
    render(<App />);

    const detail = {
      sessionId: 'task-center-session',
      workspacePath: mocks.project.path,
    };
    act(() => {
      window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB, { detail }));
      window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB, { detail }));
    });

    await waitFor(() => {
      expect(mocks.reconcileSessionTabActivation).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      resolveActivation(true);
    });
    await waitFor(() => {
      expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
        detail.sessionId,
        detail.workspacePath,
        'tab',
        expect.stringMatching(/^tab-/),
      );
    });
  });

  it('routes custom-event opens through the same existing-tab revive path', async () => {
    render(<App />);
    const session = {
      id: 'custom-event-revive-session',
      agentDir: mocks.project.path,
      title: 'Custom event session',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    };
    await act(async () => {
      await latestSidebarProps().onOpenSession(session, mocks.project);
    });
    const sessionTab = (mocks.tabbarProps.at(-1)?.tabs as Array<{ id: string; sessionId?: string }>).find(
      (tab) => tab.sessionId === session.id,
    );
    expect(sessionTab).toBeTruthy();

    act(() => {
      window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB, {
        detail: {
          sessionId: session.id,
          workspacePath: mocks.project.path,
          preview: { path: 'notes/review.md', initialLineNumber: 12 },
        },
      }));
    });

    await waitFor(() => {
      expect(mocks.ensureSessionSidecar).toHaveBeenLastCalledWith(
        session.id,
        mocks.project.path,
        'tab',
        sessionTab!.id,
      );
    });
    expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(2);
  });

  it('serializes Settings helper resume with deletion of the same Session', async () => {
    let resolveActivation!: (value: boolean) => void;
    mocks.reconcileSessionTabActivation.mockReturnValueOnce(new Promise((resolve) => {
      resolveActivation = resolve;
    }));
    mocks.deleteTargetSessionId = 'helper-resume-session';
    render(<App />);

    act(() => {
      window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, {
        detail: {
          description: '',
          appVersion: '0.4.1',
          resumeSessionId: mocks.deleteTargetSessionId,
        },
      }));
    });
    await waitFor(() => {
      expect(mocks.reconcileSessionTabActivation).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByTestId('app-delete-session'));
    await waitFor(() => {
      expect(mocks.deleteResults).toEqual([{
        deleted: false,
        reason: 'transition-in-progress',
      }]);
    });
    expect(mocks.deleteSession).not.toHaveBeenCalled();

    await act(async () => {
      resolveActivation(true);
    });
    await waitFor(() => {
      expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
        mocks.deleteTargetSessionId,
        mocks.project.path,
        'tab',
        expect.stringMatching(/^tab-/),
      );
    });
  });

  it('restores a persisted Record tab without creating a Session owner', async () => {
    localStorage.clear();
    mocks.lastExitWasClean = false;
    mocks.durableTabs = {
      version: 1,
      tabs: [
        {
          view: 'record',
          id: 'restored-record-tab',
          recordId: 'restored-record',
          title: 'Persisted Record title',
        },
      ],
      activeTabId: 'restored-record-tab',
    };
    render(<App />);

    fireEvent.click(await screen.findByTestId('restore-session'));

    await waitFor(() => {
      const latest = latestTabbarProps();
      const restored = latest.tabs.find(
        (tab) => tab.id === 'restored-record-tab',
      );
      expect(restored).toEqual(
        expect.objectContaining({
          view: 'record',
          recordId: 'restored-record',
          title: 'Recovered Record',
        }),
      );
      expect(restored).not.toHaveProperty('sessionId');
      expect(latest.activeTabId).toBe('restored-record-tab');
    });
    expect(mocks.recordGet).toHaveBeenCalledWith('restored-record');
    expect(mocks.canRestoreSession).not.toHaveBeenCalled();
    expect(mocks.ensureSessionSidecar).not.toHaveBeenCalled();
  });

  it('falls back to the Records list when a persisted Record was deleted', async () => {
    localStorage.clear();
    mocks.lastExitWasClean = false;
    mocks.recordGet.mockResolvedValueOnce(null);
    mocks.durableTabs = {
      version: 1,
      tabs: [
        {
          view: 'record',
          id: 'missing-record-tab',
          recordId: 'deleted-record',
          title: 'Deleted Record',
        },
      ],
      activeTabId: 'missing-record-tab',
    };
    render(<App />);

    fireEvent.click(await screen.findByTestId('restore-session'));

    await waitFor(() => {
      const latest = latestTabbarProps();
      const fallback = latest.tabs.find(
        (tab) => tab.id === 'missing-record-tab',
      );
      expect(fallback).toEqual(
        expect.objectContaining({
          view: 'taskcenter',
        }),
      );
      expect(fallback).not.toHaveProperty('sessionId');
      expect(fallback).not.toHaveProperty('recordId');
      expect(latest.activeTabId).toBe('missing-record-tab');
    });
    expect(mocks.toast.info).toHaveBeenCalledTimes(1);
    expect(mocks.canRestoreSession).not.toHaveBeenCalled();
    expect(mocks.ensureSessionSidecar).not.toHaveBeenCalled();
  });

  it('collapses multiple deleted Record restore fallbacks into one Task Center', async () => {
    localStorage.clear();
    mocks.lastExitWasClean = false;
    mocks.recordGet.mockResolvedValue(null);
    mocks.durableTabs = {
      version: 1,
      tabs: [
        { view: 'record', id: 'missing-record-a', recordId: 'deleted-a', title: 'Deleted A' },
        { view: 'record', id: 'missing-record-b', recordId: 'deleted-b', title: 'Deleted B' },
      ],
      activeTabId: 'missing-record-b',
    };
    render(<App />);

    fireEvent.click(await screen.findByTestId('restore-session'));

    await waitFor(() => {
      const taskTabs = latestTabbarProps().tabs.filter((tab) => tab.view === 'taskcenter');
      expect(taskTabs).toHaveLength(1);
      expect(taskTabs[0]?.id).toBe('missing-record-a');
      expect(latestTabbarProps().activeTabId).toBe('missing-record-a');
    });
  });

  it('does not add a deleted Record fallback beside an already-open Task Center', async () => {
    localStorage.clear();
    mocks.lastExitWasClean = false;
    mocks.recordGet.mockResolvedValue(null);
    mocks.durableTabs = {
      version: 1,
      tabs: [{ view: 'record', id: 'missing-record', recordId: 'deleted-record', title: 'Deleted' }],
      activeTabId: 'missing-record',
    };
    render(<App />);
    act(() => latestSidebarProps().onOpenTaskCenter());
    await waitFor(() => expect(latestTabbarProps().tabs.filter((tab) => tab.view === 'taskcenter')).toHaveLength(1));

    fireEvent.click(await screen.findByTestId('restore-session'));

    await waitFor(() => expect(latestTabbarProps().tabs.filter((tab) => tab.view === 'taskcenter')).toHaveLength(1));
    expect(latestTabbarProps().tabs.some((tab) => tab.id === 'missing-record')).toBe(false);
  });

  it('holds Session opening admission while a restore candidate is validated', async () => {
    const sessionId = '11111111-2222-4333-8444-555555555555';
    let resolveRestoreCheck!: (value: boolean) => void;
    mocks.canRestoreSession.mockReturnValueOnce(new Promise((resolve) => {
      resolveRestoreCheck = resolve;
    }));
    mocks.deleteTargetSessionId = sessionId;
    mocks.lastExitWasClean = false;
    mocks.durableTabs = {
      version: 1,
      tabs: [{
        view: 'chat',
        id: 'restored-tab',
        agentDir: mocks.project.path,
        sessionId,
        title: 'Restored history',
      }],
      activeTabId: 'restored-tab',
    };
    render(<App />);

    fireEvent.click(await screen.findByTestId('restore-session'));
    await waitFor(() => {
      expect(mocks.canRestoreSession).toHaveBeenCalledWith(sessionId, mocks.project.path);
    });

    fireEvent.click(screen.getByTestId('app-delete-session'));
    await waitFor(() => {
      expect(mocks.deleteResults).toEqual([{
        deleted: false,
        reason: 'transition-in-progress',
      }]);
    });
    expect(mocks.deleteSession).not.toHaveBeenCalled();

    await act(async () => {
      resolveRestoreCheck(true);
    });
    await waitFor(() => {
      expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
        sessionId,
        mocks.project.path,
        'tab',
        'restored-tab',
      );
    });
  });

  it('restores every Session lifecycle immediately but reveals Chat active-first', async () => {
    const frames: FrameRequestCallback[] = [];
    let nextFrameHandle = 1;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return nextFrameHandle++;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const flushQueuedFrame = (timestamp: number) => {
      const callbacks = frames.splice(0);
      callbacks.forEach((callback) => callback(timestamp));
    };
    mocks.lastExitWasClean = false;
    mocks.durableTabs = {
      version: 1,
      tabs: [
        {
          view: 'chat',
        id: 'restore-active',
          agentDir: mocks.project.path,
          sessionId: '11111111-2222-4333-8444-555555555551',
          title: 'Active history',
        },
        {
          view: 'chat',
        id: 'restore-inactive',
          agentDir: mocks.project.path,
          sessionId: '11111111-2222-4333-8444-555555555552',
          title: 'Inactive history',
        },
      ],
      activeTabId: 'restore-active',
    };
    render(<App />);

    fireEvent.click(await screen.findByTestId('restore-session'));
    await waitFor(() => {
      expect(mocks.ensureSessionSidecar).toHaveBeenCalledTimes(2);
    });

    const providers = screen.getAllByTestId('tab-provider');
    expect(providers).toHaveLength(2);
    expect(screen.getAllByTestId('chat-boot-overlay')).toHaveLength(2);
    expect(screen.queryByTestId('chat-page')).not.toBeInTheDocument();
    expect(frames.length).toBeGreaterThan(0);

    act(() => flushQueuedFrame(0));
    expect(screen.queryByTestId('chat-page')).not.toBeInTheDocument();
    act(() => flushQueuedFrame(16));
    await waitFor(() => {
      expect(screen.getAllByTestId('chat-page')).toHaveLength(1);
    });
    expect(
      providers.find((provider) => provider.dataset.tabId === 'restore-active')
        ?.querySelector('[data-testid="chat-page"]'),
    ).not.toBeNull();

    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', ctrlKey: true });
    expect(screen.getAllByTestId('chat-page')).toHaveLength(1);
    expect(screen.getByTestId('tabbar-active')).toHaveTextContent('Inactive history');
    act(() => flushQueuedFrame(32));
    act(() => flushQueuedFrame(48));
    await waitFor(() => {
      expect(screen.getAllByTestId('chat-page')).toHaveLength(2);
    });
  });

  it('keeps current work unchanged when an earlier deletion owns the Session transition', async () => {
    const sessionId = '66666666-7777-4888-8999-000000000000';
    let resolveOwnerCheck!: (value: boolean) => void;
    mocks.querySessionHasPersistentOwners.mockReturnValueOnce(new Promise((resolve) => {
      resolveOwnerCheck = resolve;
    }));
    mocks.deleteTargetSessionId = sessionId;
    mocks.lastExitWasClean = false;
    mocks.durableTabs = {
      version: 1,
      tabs: [{
        view: 'chat',
        id: 'refused-delete-restored-tab',
        agentDir: mocks.project.path,
        sessionId,
        title: 'Still restorable',
      }],
      activeTabId: 'refused-delete-restored-tab',
    };
    render(<App />);

    const restoreButton = await screen.findByTestId('restore-session');
    fireEvent.click(screen.getByTestId('app-delete-session'));
    await waitFor(() => {
      expect(mocks.querySessionHasPersistentOwners).toHaveBeenCalledWith(sessionId);
    });

    fireEvent.click(restoreButton);
    await waitFor(() => {
      expect(screen.getByTestId('tabbar-active')).toHaveTextContent('New Tab');
    });
    expect(mocks.canRestoreSession).not.toHaveBeenCalled();

    await act(async () => {
      resolveOwnerCheck(true);
    });
    await waitFor(() => {
      expect(mocks.deleteResults).toEqual([{
        deleted: false,
        reason: 'in-use',
      }]);
    });
    const currentTabs = mocks.tabbarProps.at(-1)?.tabs as Array<{ id: string }>;
    expect(currentTabs).toHaveLength(1);
    expect(currentTabs).not.toContainEqual(expect.objectContaining({
      id: 'refused-delete-restored-tab',
    }));
  });

  it('materializes every restored Tab without requiring a Tab selection', async () => {
    const firstSessionId = '11111111-2222-4333-8444-555555555551';
    const secondSessionId = '11111111-2222-4333-8444-555555555552';
    mocks.lastExitWasClean = false;
    mocks.durableTabs = {
      version: 1,
      tabs: [
        {
          view: 'chat',
        id: 'restored-first',
          agentDir: mocks.project.path,
          sessionId: firstSessionId,
          title: 'First restored history',
        },
        {
          view: 'chat',
        id: 'restored-second',
          agentDir: mocks.project.path,
          sessionId: secondSessionId,
          title: 'Second restored history',
        },
      ],
      activeTabId: 'restored-second',
    };
    mocks.ensureSessionSidecar.mockResolvedValue({ port: 31417, isNew: false });
    render(<App />);

    fireEvent.click(await screen.findByTestId('restore-session'));

    await waitFor(() => {
      expect(mocks.ensureSessionSidecar).toHaveBeenCalledTimes(2);
      expect(mocks.reconcileSessionTabActivation).toHaveBeenCalledTimes(2);
    });
    expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
      firstSessionId,
      mocks.project.path,
      'tab',
      'restored-first',
    );
    expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
      secondSessionId,
      mocks.project.path,
      'tab',
      'restored-second',
    );
    expect(new Set(mocks.tabProviderProps.map((props) => props.sessionId))).toEqual(
      new Set([firstSessionId, secondSessionId]),
    );
    expect(screen.getAllByTestId('tab-provider')).toHaveLength(2);
    expect(await screen.findAllByTestId('chat-page')).toHaveLength(1);
    expect(screen.getByTestId('tabbar-active')).toHaveTextContent('Second restored history');
    expect(mocks.setAppActiveCorrelation).toHaveBeenCalledWith({
      tabId: 'restored-second',
      sessionId: secondSessionId,
      tabs: [
        { id: 'restored-first', sessionId: firstSessionId },
        { id: 'restored-second', sessionId: secondSessionId },
      ],
    });
    const restoredTabs = mocks.tabbarProps.at(-1)?.tabs as Array<{
      id: string;
      sidecarConfigDisposition?: string;
    }>;
    expect(restoredTabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'restored-first', sidecarConfigDisposition: 'adopt' }),
      expect.objectContaining({ id: 'restored-second', sidecarConfigDisposition: 'adopt' }),
    ]));
  });

  it('keeps a restored Tab when a predecessor terminal read spans the whole opening', async () => {
    const sessionId = '22222222-3333-4444-8555-666666666666';
    let resolveFirstGeneration!: (generation: number | null) => void;
    mocks.tauriEnvironment = true;
    mocks.lastExitWasClean = false;
    mocks.durableTabs = {
      version: 1,
      tabs: [{
        view: 'chat',
        id: 'restored-during-terminal-read',
        agentDir: mocks.project.path,
        sessionId,
        title: 'Restored during terminal read',
      }],
      activeTabId: 'restored-during-terminal-read',
    };
    mocks.ensureSessionSidecar.mockResolvedValue({ port: 31417, isNew: false });
    mocks.hasSessionSidecar.mockResolvedValue(false);
    mocks.getSessionGeneration
      .mockImplementationOnce(() => new Promise<number | null>((resolve) => {
        resolveFirstGeneration = resolve;
      }))
      .mockResolvedValue(2);

    render(<App />);

    const restoreButton = await screen.findByTestId('restore-session');
    await waitFor(() => {
      expect(mocks.listeners.has('session:sidecar-terminal')).toBe(true);
    });
    const terminalHandler = mocks.listeners.get('session:sidecar-terminal');
    expect(terminalHandler).toBeDefined();
    const terminalResult = Promise.resolve(terminalHandler!({
      payload: { sessionId, generation: 1 },
    }));
    await waitFor(() => expect(mocks.getSessionGeneration).toHaveBeenCalledTimes(1));

    fireEvent.click(restoreButton);
    await waitFor(() => {
      const restored = (mocks.tabbarProps.at(-1)?.tabs as Array<{
        id: string;
        sidecarConfigDisposition?: string;
      }>).find((tab) => tab.id === 'restored-during-terminal-read');
      expect(restored?.sidecarConfigDisposition).toBe('adopt');
    });

    await act(async () => {
      resolveFirstGeneration(null);
      await terminalResult;
    });

    expect(mocks.getSessionGeneration).toHaveBeenCalledTimes(2);
    expect(mocks.tabbarProps.at(-1)?.tabs).toContainEqual(expect.objectContaining({
      id: 'restored-during-terminal-read',
      sessionId,
      sidecarConfigDisposition: 'adopt',
    }));
  });

  it('loads every restored history but projects inactive Chat only after selection', async () => {
    const firstSessionId = '33333333-2222-4333-8444-555555555551';
    const secondSessionId = '33333333-2222-4333-8444-555555555552';
    mocks.useRealTabProvider = true;
    mocks.lastExitWasClean = false;
    mocks.durableTabs = {
      version: 1,
      tabs: [
        {
          view: 'chat',
        id: 'history-first',
          agentDir: mocks.project.path,
          sessionId: firstSessionId,
          title: 'First history',
        },
        {
          view: 'chat',
        id: 'history-second',
          agentDir: mocks.project.path,
          sessionId: secondSessionId,
          title: 'Second history',
        },
      ],
      activeTabId: 'history-second',
    };
    mocks.ensureSessionSidecar.mockResolvedValue({ port: 31417, isNew: false });
    mocks.sessionSidecarFetch.mockImplementation(async (
      sessionId: string,
      _owner: { type: 'tab'; id: string },
      path: string,
    ) => {
      if (!path.startsWith('/sessions/')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      const content = sessionId === firstSessionId
        ? 'First persisted restore message'
        : 'Second persisted restore message';
      return new Response(JSON.stringify({
        success: true,
        session: {
          id: sessionId,
          agentDir: mocks.project.path,
          title: sessionId === firstSessionId ? 'First history' : 'Second history',
          createdAt: '2026-08-01T00:00:00.000Z',
          lastActiveAt: '2026-08-01T00:00:01.000Z',
          runtime: 'builtin',
          messages: [{
            id: `${sessionId}-assistant`,
            role: 'assistant',
            content,
            timestamp: '2026-08-01T00:00:01.000Z',
          }],
          snapshotRevision: 1,
          liveSessionState: 'idle',
          liveStreamingMessage: null,
          hasMoreBefore: false,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    render(<App />);
    fireEvent.click(await screen.findByTestId('restore-session'));

    expect(await screen.findByText('Second persisted restore message')).toBeInTheDocument();
    expect(screen.queryByText('First persisted restore message')).not.toBeInTheDocument();
    expect(mocks.sessionSidecarFetch).toHaveBeenCalledWith(
      firstSessionId,
      { type: 'tab', id: 'history-first' },
      expect.stringMatching(new RegExp(`^/sessions/${firstSessionId}\\?`)),
      expect.any(Object),
    );
    expect(mocks.sessionSidecarFetch).toHaveBeenCalledWith(
      secondSessionId,
      { type: 'tab', id: 'history-second' },
      expect.stringMatching(new RegExp(`^/sessions/${secondSessionId}\\?`)),
      expect.any(Object),
    );

    act(() => latestTabbarProps().onSelectTab('history-first'));
    expect(await screen.findByText('First persisted restore message')).toBeInTheDocument();
    expect(screen.getByText('Second persisted restore message')).toBeInTheDocument();
  });

  it('isolates one restored owner failure and preserves successful/current Tabs', async () => {
    const failedSessionId = '22222222-2222-4333-8444-555555555551';
    const successfulSessionId = '22222222-2222-4333-8444-555555555552';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.lastExitWasClean = false;
    mocks.durableTabs = {
      version: 1,
      tabs: [
        {
          view: 'chat',
        id: 'restore-fails',
          agentDir: mocks.project.path,
          sessionId: failedSessionId,
          title: 'Fails',
        },
        {
          view: 'chat',
        id: 'restore-succeeds',
          agentDir: mocks.project.path,
          sessionId: successfulSessionId,
          title: 'Succeeds',
        },
      ],
      activeTabId: 'restore-fails',
    };
    mocks.ensureSessionSidecar.mockResolvedValue({ port: 31417, isNew: false });
    mocks.reconcileSessionTabActivation.mockImplementation(async (sessionId: string) => (
      sessionId !== failedSessionId
    ));
    render(<App />);
    await act(async () => latestSidebarProps().onOpenSettings());
    await waitFor(() => {
      const latest = mocks.tabbarProps.at(-1);
      const active = (latest?.tabs as Array<{ id: string; view?: string }>).find(
        (tab) => tab.id === latest?.activeTabId,
      );
      expect(active?.view).toBe('settings');
    });

    fireEvent.click(await screen.findByTestId('restore-session'));

    await waitFor(() => {
      const latest = mocks.tabbarProps.at(-1);
      const tabs = latest?.tabs as Array<{
        id: string;
        view?: string;
        sidecarConfigDisposition?: string;
      }>;
      expect(tabs.some((tab) => tab.id === 'restore-fails')).toBe(false);
      expect(tabs.some((tab) => tab.id === 'restore-succeeds')).toBe(true);
      expect(tabs.find((tab) => tab.id === 'restore-succeeds')?.sidecarConfigDisposition).toBe('adopt');
      expect(tabs.some((tab) => tab.view === 'settings')).toBe(true);
      expect(tabs.find((tab) => tab.id === latest?.activeTabId)?.view).toBe('settings');
    });
    expect(mocks.releaseTabSession).toHaveBeenCalledWith(failedSessionId, 'restore-fails');
    expect(mocks.reconcileSessionTabActivation).toHaveBeenCalledWith(
      successfulSessionId,
      'restore-succeeds',
    );
    errorSpy.mockRestore();
  });

  it('does not yank focus back when a slow sidebar Session finishes after the user switches tabs', async () => {
    let resolveEnsure!: (result: { port: number; isNew: boolean }) => void;
    mocks.ensureSessionSidecar.mockReturnValueOnce(new Promise((resolve) => {
      resolveEnsure = resolve;
    }));
    const session = {
      id: 'background-ready-session',
      agentDir: mocks.project.path,
      title: 'Background ready history',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    };
    render(<App />);

    let openPromise!: Promise<boolean>;
    act(() => {
      openPromise = latestSidebarProps().onOpenSession(session, mocks.project);
    });
    await waitFor(() => expect(screen.getByTestId('tabbar-active')).toHaveTextContent('Background ready history'));

    await act(async () => latestSidebarProps().onOpenSettings());
    await waitFor(() => {
      const latest = mocks.tabbarProps.at(-1);
      const active = (latest?.tabs as Array<{ id: string; view?: string }>).find(
        (tab) => tab.id === latest?.activeTabId,
      );
      expect(active?.view).toBe('settings');
    });

    await act(async () => {
      resolveEnsure({ port: 31417, isNew: false });
      await openPromise;
    });

    const latest = mocks.tabbarProps.at(-1);
    const active = (latest?.tabs as Array<{ id: string; view?: string }>).find(
      (tab) => tab.id === latest?.activeTabId,
    );
    expect(active?.view).toBe('settings');
  });

  it('preserves Task ownership after optimistic activation of a cron-owned Session', async () => {
    mocks.ensureSessionSidecar.mockResolvedValue({ port: 31417, isNew: false });
    const session = {
      id: 'cron-owned-session',
      agentDir: mocks.project.path,
      title: 'Cron-owned history',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    };
    render(<App />);

    let opened = false;
    await act(async () => {
      opened = await latestSidebarProps().onOpenSession(session, mocks.project);
    });

    const sessionTab = (mocks.tabbarProps.at(-1)?.tabs as Array<{ id: string; sessionId?: string }>).find(
      (tab) => tab.sessionId === session.id,
    );
    expect(opened).toBe(true);
    expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
      session.id,
      mocks.project.path,
      'tab',
      sessionTab?.id,
    );
    expect(sessionTab).toBeTruthy();
    expect(mocks.reconcileSessionTabActivation).toHaveBeenCalledWith(
      session.id,
      sessionTab?.id,
    );
    expect(mocks.activateSession).not.toHaveBeenCalled();
    expect(mocks.cancelBackgroundCompletion).not.toHaveBeenCalled();
  });

  it('restores the previous active tab when an optimistic sidebar Session open fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let rejectEnsure!: (error: Error) => void;
    mocks.ensureSessionSidecar.mockReturnValueOnce(new Promise((_, reject) => {
      rejectEnsure = reject;
    }));
    const session = {
      id: 'failed-sidebar-session',
      agentDir: mocks.project.path,
      title: 'Failed sidebar history',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastActiveAt: '2026-07-20T00:00:00.000Z',
    };
    render(<App />);

    let openPromise!: Promise<boolean>;
    act(() => {
      openPromise = latestSidebarProps().onOpenSession(session, mocks.project);
    });
    await waitFor(() => expect(screen.getByTestId('tabbar-active')).toHaveTextContent('Failed sidebar history'));

    let opened = true;
    await act(async () => {
      rejectEnsure(new Error('ensure failed'));
      opened = await openPromise;
    });

    expect(opened).toBe(false);
    expect(screen.getByTestId('tabbar-active')).toHaveTextContent('New Tab');
    expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(1);
    errorSpy.mockRestore();
  });

  it('opens a sidebar workspace as a fresh Chat tab without replacing the functional tab', async () => {
    render(<App />);
    act(() => latestSidebarProps().onOpenCapabilities());
    await waitFor(() => expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(2));

    let opened = false;
    await act(async () => {
      opened = await latestSidebarProps().onOpenWorkspace(mocks.project);
    });

    expect(opened).toBe(true);
    await waitFor(() => {
      expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(3);
      expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
        expect.any(String),
        mocks.project.path,
        'tab',
        expect.stringMatching(/^tab-/),
      );
      expect(mocks.chatProps.length).toBeGreaterThan(0);
    });
    expect(mocks.track).toHaveBeenCalledWith('workspace_open', expect.objectContaining({
      surface: 'global_sidebar',
      entry_intent: 'open_workspace',
    }));
  });

  it.each(['onOpenSettings', 'onOpenCapabilities', 'onOpenTaskCenter', 'onOpenSpace'] as const)(
    'shows one capacity toast for %s without changing the active tab', async (action) => {
      render(<App />);
      for (let index = 1; index < 12; index += 1) {
        act(() => latestTabbarProps().onNewTab());
      }
      const before = latestTabbarProps();
      await act(async () => latestSidebarProps()[action]());
      expect(mocks.toast.info).toHaveBeenCalledExactlyOnceWith('已达到窗口上限，请关闭一些窗口哦');
      expect(latestTabbarProps().tabs).toEqual(before.tabs);
      expect(latestTabbarProps().activeTabId).toBe(before.activeTabId);
    },
  );

  it('focuses existing settings at capacity without a toast', async () => {
    render(<App />);
    await act(async () => latestSidebarProps().onOpenSettings());
    const settings = latestTabbarProps().tabs.find(tab => tab.view === 'settings')!;
    for (let index = 2; index < 12; index += 1) {
      act(() => latestTabbarProps().onNewTab());
    }
    await act(async () => latestSidebarProps().onOpenSettings());
    expect(latestTabbarProps().activeTabId).toBe(settings.id);
    expect(mocks.toast.info).not.toHaveBeenCalled();
  });

  it('reports capacity when a new-tab action or ordinary support launch is denied', async () => {
    render(<App />);
    for (let index = 1; index < 12; index += 1) {
      act(() => latestTabbarProps().onNewTab());
    }
    act(() => latestTabbarProps().onNewTab());
    expect(mocks.toast.info).toHaveBeenCalledExactlyOnceWith('已达到窗口上限，请关闭一些窗口哦');
    mocks.toast.info.mockClear();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, {
        detail: { description: 'Help', images: [] },
      }));
    });
    expect(mocks.toast.info).toHaveBeenCalledExactlyOnceWith('已达到窗口上限，请关闭一些窗口哦');
    expect(mocks.ensureSessionSidecar).not.toHaveBeenCalled();
  });

  it('stops helper launch if another action takes the last slot during preparation', async () => {
    let resolveWorkspace!: () => void;
    const original = vi.mocked(ensureSelfAwarenessWorkspace).getMockImplementation()!;
    vi.mocked(ensureSelfAwarenessWorkspace).mockImplementationOnce(async (...args) => {
      await new Promise<void>(resolve => { resolveWorkspace = resolve; });
      return original(...args);
    });
    render(<App />);
    for (let index = 1; index < 11; index += 1) {
      act(() => latestTabbarProps().onNewTab());
    }
    act(() => {
      window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, {
        detail: { description: 'Help', images: [] },
      }));
    });
    act(() => latestTabbarProps().onNewTab());
    const before = latestTabbarProps();
    await act(async () => resolveWorkspace());
    expect(mocks.toast.info).toHaveBeenCalledExactlyOnceWith('已达到窗口上限，请关闭一些窗口哦');
    expect(latestTabbarProps().tabs).toEqual(before.tabs);
    expect(latestTabbarProps().activeTabId).toBe(before.activeTabId);
    expect(mocks.ensureSessionSidecar).not.toHaveBeenCalled();
  });

  it.each([false, true])('stops discussion launch on late capacity denial (managed provider: %s)', async (managed) => {
    mocks.tauriEnvironment = true;
    if (managed) mocks.resolveBuiltinSelection.mockReturnValue({ provider: managedCodexProvider(), model: 'gpt-5.5' });
    let resolvePreparation!: (value: unknown) => void;
    tauriCoreMocks.invoke.mockImplementation(async command => {
      if (command === 'cmd_task_prepare_discussion') {
        return new Promise(resolve => { resolvePreparation = resolve; });
      }
      return undefined;
    });
    render(<App />);
    for (let index = 1; index < 11; index += 1) {
      act(() => latestTabbarProps().onNewTab());
    }
    act(() => {
      window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_AI_DISCUSSION, {
        detail: { content: 'Discuss this', workspaceId: mocks.project.id, tags: [] },
      }));
    });
    await waitFor(() => expect(resolvePreparation).toBeDefined());
    act(() => latestTabbarProps().onNewTab());
    const before = latestTabbarProps();
    await act(async () => resolvePreparation({ candidatesDir: '/tmp/discussion/candidates' }));
    expect(mocks.toast.info).toHaveBeenCalledExactlyOnceWith('已达到窗口上限，请关闭一些窗口哦');
    expect(latestTabbarProps().tabs).toEqual(before.tabs);
    expect(mocks.ensureSessionSidecar).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it.each([false, true])('reports a restore denied entirely by capacity (missing record: %s)', async (missingRecord) => {
    mocks.lastExitWasClean = false;
    if (missingRecord) mocks.recordGet.mockResolvedValue(null);
    mocks.durableTabs = {
      version: 1,
      tabs: missingRecord
        ? [{ view: 'record', id: 'restore-capacity', recordId: 'missing-record', title: 'Record' }]
        : [{ view: 'chat', id: 'restore-capacity', agentDir: mocks.project.path,
          sessionId: '11111111-2222-4333-8444-555555555551', title: 'History' }],
      activeTabId: 'restore-capacity',
    };
    render(<App />);
    const restoreButton = await screen.findByTestId('restore-session');
    for (let index = 1; index < 12; index += 1) {
      act(() => latestTabbarProps().onNewTab());
    }
    await act(async () => fireEvent.click(restoreButton));
    expect(mocks.toast.info).toHaveBeenCalledExactlyOnceWith('已达到窗口上限，请关闭一些窗口哦');
    expect(latestTabbarProps().tabs).toHaveLength(12);
    expect(mocks.ensureSessionSidecar).not.toHaveBeenCalled();
  });

  it('keeps Settings and Capabilities as one tab each', async () => {
    render(<App />);

    act(() => latestSidebarProps().onOpenCapabilities());
    await waitFor(() => expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(2));
    act(() => latestSidebarProps().onOpenCapabilities());
    await waitFor(() => expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(2));

    await act(async () => latestSidebarProps().onOpenSettings());
    await waitFor(() => expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(3));
    await act(async () => latestSidebarProps().onOpenSettings());

    expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(3);
  });

  it('opens the official tool market from Capabilities and reuses its Space tab with a fresh intent', async () => {
    render(<App />);
    act(() => latestSidebarProps().onOpenCapabilities());
    const button = await screen.findByRole('button', { name: 'open tool market' });
    await act(async () => fireEvent.click(button));
    await screen.findByTestId('space-page');
    const first = mocks.spaceProps.at(-1)?.pendingRoute;
    expect(first).toEqual({ generation: 1, route: { version: 1, name: 'space.tools', params: { spaceId: 'official' } } });
    const firstTab = latestTabbarProps().tabs.find((tab) => tab.view === 'space');
    act(() => latestSidebarProps().onOpenCapabilities());
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'open tool market' })));
    expect(latestTabbarProps().tabs.filter((tab) => tab.view === 'space')).toEqual([expect.objectContaining({ id: firstTab?.id })]);
    expect(mocks.spaceProps.at(-1)?.pendingRoute).toEqual({ generation: 2, route: { version: 1, name: 'space.tools', params: { spaceId: 'official' } } });
  });

  it('routes chat link intents into one Space tab for home, list and detail', async () => {
    render(<App />);
    const routes = [
      { version: 1, name: 'space.home', params: {} },
      { version: 1, name: 'space.issues', params: { spaceId: 'official' } },
      { version: 1, name: 'space.issue', params: { spaceId: 'myagents', issueId: 'iss_123' } },
    ];
    let spaceTabId: string | undefined;
    for (const [index, route] of routes.entries()) {
      act(() => window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_APP_ROUTE, { detail: route })));
      await screen.findByTestId('space-page');
      const tabs = latestTabbarProps().tabs.filter(tab => tab.view === 'space');
      expect(tabs).toHaveLength(1);
      if (!spaceTabId) spaceTabId = tabs[0].id;
      expect(tabs[0].id).toBe(spaceTabId);
      expect(mocks.spaceProps.at(-1)?.pendingRoute).toEqual({ generation: index + 1, route });
    }
  });

  it('keeps chat Space links behind the explicit developer gate', async () => {
    mocks.spaceDevGate = false;
    render(<App />);
    act(() => window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_APP_ROUTE, { detail: { version: 1, name: 'space.home', params: {} } })));
    expect(latestTabbarProps().tabs.some(tab => tab.view === 'space')).toBe(false);
    expect(mocks.toast.info).toHaveBeenCalledWith('协作空间已被开发者关闭');
  });

  it('keeps the capability banner callback behind the developer Space gate', async () => {
    mocks.spaceDevGate = false;
    render(<App />);
    act(() => latestSidebarProps().onOpenCapabilities());
    const button = await screen.findByRole('button', { name: 'open tool market' });
    await act(async () => fireEvent.click(button));
    expect(latestTabbarProps().tabs.some((tab) => tab.view === 'space')).toBe(false);
  });

  it('keeps Task Center and default-enabled Collaboration Space as one tab each', async () => {
    render(<App />);

    act(() => latestSidebarProps().onOpenTaskCenter());
    await waitFor(() => expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(2));
    act(() => latestSidebarProps().onOpenTaskCenter());
    await waitFor(() => expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(2));

    act(() => latestSidebarProps().onOpenSpace());
    await waitFor(() => expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(3));
    act(() => latestSidebarProps().onOpenSpace());

    expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(3);
    expect(latestSidebarProps().teamSpaceAvailable).toBe(true);
    expect(latestTabbarProps().tabs).toContainEqual(
      expect.objectContaining({ view: 'space', title: 'Space 协作空间' }),
    );
  });

  it.each([false, true])('waits for config before opening Space, then honors persisted gate %s', async (enabled) => {
    mocks.configLoading = true;
    const view = render(<App />);
    expect(latestSidebarProps().teamSpaceAvailable).toBe(false);
    act(() => latestSidebarProps().onOpenSpace());
    expect(latestTabbarProps().tabs.some((tab) => tab.view === 'space')).toBe(false);
    expect(mocks.toast.info).toHaveBeenCalledWith('正在读取协作空间状态');

    mocks.spaceDevGate = enabled;
    mocks.configLoading = false;
    view.rerender(<App />);
    expect(latestSidebarProps().teamSpaceAvailable).toBe(enabled);
    act(() => latestSidebarProps().onOpenSpace());
    expect(latestTabbarProps().tabs.some((tab) => tab.view === 'space')).toBe(enabled);
  });

  it.each(['developer', 'build'] as const)('hides Collaboration Space when disabled by %s', async (gate) => {
    mocks.spaceDevGate = gate === 'developer' ? false : undefined;
    mocks.spaceBuildAvailable = gate !== 'build';
    render(<App />);
    expect(latestSidebarProps().teamSpaceAvailable).toBe(false);
    act(() => latestSidebarProps().onOpenSpace());
    expect(latestTabbarProps().tabs.some((tab) => tab.view === 'space')).toBe(false);
  });

  it('reuses Task Center for the active recording stop surface when the tab strip is full', async () => {
    render(<App />);
    act(() => latestSidebarProps().onOpenTaskCenter());
    await waitFor(() => expect(latestTabbarProps().tabs.some((tab) => tab.view === 'taskcenter')).toBe(true));
    for (let index = latestTabbarProps().tabs.length; index < 12; index += 1) {
      act(() => latestTabbarProps().onNewTab());
    }
    expect(latestTabbarProps().tabs).toHaveLength(12);
    const taskCenter = latestTabbarProps().tabs.find((tab) => tab.view === 'taskcenter')!;
    act(() => latestTabbarProps().onSelectTab(taskCenter.id));
    await waitFor(() => expect(mocks.taskCenterProps.length).toBeGreaterThan(0));

    await act(async () => {
      await latestTaskCenterProps().onStartRecording({ microphone: true, system: true });
    });

    expect(latestTabbarProps().tabs).toHaveLength(12);
    expect(latestTabbarProps().tabs.some((tab) => tab.view === 'taskcenter')).toBe(false);
    expect(latestTabbarProps().tabs).toContainEqual(
      expect.objectContaining({ view: 'record', recordId: 'active-record' }),
    );
  });

  it('routes capability deep links and item targets into the singleton Capabilities tab', async () => {
    render(<App />);
    const skillTarget = { kind: 'skill' as const, folderName: 'github', scope: 'user' as const };

    act(() => {
      window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
        detail: {
          section: 'plugins',
          mcpServerId: 'mcp-one',
          officialToolId: 'image-understanding',
          selectItem: skillTarget,
        },
      }));
    });

    await waitFor(() => expect(latestSettingsProps()).toEqual(expect.objectContaining({
      mode: 'capabilities',
      initialSection: 'plugins',
      initialMcpId: 'mcp-one',
      initialOfficialToolId: 'image-understanding',
      initialSelect: skillTarget,
    })));
    const firstNonce = latestSettingsProps().navigationNonce as number;

    act(() => {
      window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
        detail: { section: 'mcp', mcpServerId: 'mcp-two' },
      }));
    });

    await waitFor(() => expect(latestSettingsProps()).toEqual(expect.objectContaining({
      mode: 'capabilities',
      initialSection: 'mcp',
      initialMcpId: 'mcp-two',
      navigationNonce: firstNonce + 1,
    })));
    expect(mocks.tabbarProps.at(-1)?.tabs).toHaveLength(2);
  });

  it('keeps streaming-local Chat renders outside the global sidebar owner', async () => {
    render(<App />);
    await act(async () => {
      await latestSidebarProps().onOpenWorkspace(mocks.project);
    });
    await waitFor(() => expect(screen.getByTestId('chat-page')).toHaveTextContent('0'));
    const sidebarRenderCount = mocks.sidebarProps.length;

    act(() => {
      fireEvent.click(screen.getByTestId('chat-page'));
      fireEvent.click(screen.getByTestId('chat-page'));
      fireEvent.click(screen.getByTestId('chat-page'));
    });

    expect(screen.getByTestId('chat-page')).toHaveTextContent('3');
    expect(mocks.sidebarProps).toHaveLength(sidebarRenderCount);
  });

  it('keeps external-runtime empty launches on the pending-session path', async () => {
    mocks.agent.runtime = 'codex';
    mocks.resolveBuiltinSelection.mockReturnValue({
      provider: managedCodexProvider(),
      model: 'gpt-5.5',
    });

    render(<App />);

    await act(async () => {
      latestLauncherProps().onLaunchProject(mocks.project);
    });

    await waitFor(() => expect(mocks.ensureSessionSidecar).toHaveBeenCalled());
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
      expect.stringMatching(/^pending-tab-/),
      mocks.project.path,
      'tab',
      expect.stringMatching(/^tab-/),
    );
  });

  it('starts Task discussion with the workspace external Runtime without requiring a builtin provider', async () => {
    mocks.tauriEnvironment = true;
    mocks.agent.runtime = 'codex';
    mocks.resolveBuiltinSelection.mockReturnValue(undefined);
    tauriCoreMocks.invoke.mockImplementation(async (command) => {
      if (command === 'cmd_task_prepare_discussion') {
        return {
          discussionId: 'discussion-external',
          discussionDir: '/tmp/task-discussions/discussion-external',
          candidatesDir: '/tmp/task-discussions/discussion-external/candidates',
        };
      }
      return undefined;
    });

    const recordBody = '    indented Record body\nkeep trailing spaces  \n';
    render(<App />);
    act(() => {
      window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_AI_DISCUSSION, {
        detail: {
            content: recordBody,
          workspaceId: mocks.project.id,
          tags: [],
        },
      }));
    });

    await waitFor(() => expect(mocks.ensureSessionSidecar).toHaveBeenCalled());
    expect(mocks.resolveBuiltinSelection).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
      expect.stringMatching(/^pending-tab-/),
      mocks.project.path,
      'tab',
      expect.stringMatching(/^tab-/),
    );
    expect(mocks.toast.error).not.toHaveBeenCalledWith(
      expect.stringContaining('provider'),
    );
    const discussionChat = [...mocks.chatProps]
      .reverse()
      .find((props) => Boolean(props.initialMessage)) as
      | { initialMessage?: { text?: string } }
      | undefined;
    expect(discussionChat?.initialMessage?.text?.endsWith(recordBody)).toBe(
      true,
    );
  });

  it('ensures the canonical audio document before opening a Record discussion', async () => {
    mocks.tauriEnvironment = true;
    mocks.agent.runtime = 'codex';
    mocks.resolveBuiltinSelection.mockReturnValue(undefined);
    tauriCoreMocks.invoke.mockImplementation(async (command) => {
      if (command === 'cmd_record_discussion_context') {
        return {
          documentPath:
            '/Users/me/.myagents/records/2026-08/record-audio/content.md',
          audioSources: [
            {
              track: 'microphone',
              path: '/Users/me/.myagents/records/2026-08/record-audio/audio/microphone.opus',
            },
            {
              track: 'system',
              path: '/Users/me/.myagents/records/2026-08/record-audio/audio/system.opus',
            },
          ],
        };
      }
      if (command === 'cmd_task_prepare_discussion') {
        return {
          discussionId: 'discussion-audio',
          discussionDir: '/tmp/task-discussions/discussion-audio',
          candidatesDir: '/tmp/task-discussions/discussion-audio/candidates',
        };
      }
      return undefined;
    });

    render(<App />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent(CUSTOM_EVENTS.OPEN_AI_DISCUSSION, {
          detail: {
            sourceRecordId: 'record-audio',
            sourceRecordKind: 'audio',
            workspaceId: mocks.project.id,
          },
        }),
      );
    });

    await waitFor(() => expect(mocks.ensureSessionSidecar).toHaveBeenCalled());
    const commands = tauriCoreMocks.invoke.mock.calls.map(
      ([command]) => command,
    );
    expect(commands.indexOf('cmd_record_discussion_context')).toBeLessThan(
      commands.indexOf('cmd_task_prepare_discussion'),
    );
    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith(
      'cmd_task_prepare_discussion',
      expect.not.objectContaining({ sourceRecordTags: expect.anything() }),
    );
    const discussionChat = [...mocks.chatProps]
      .reverse()
      .find((props) => Boolean(props.initialMessage)) as
      | { initialMessage?: import("./types/tab").InitialMessage }
      | undefined;
    const initial = discussionChat?.initialMessage;
    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('cmd_task_save_discussion_input', {
      discussionId: expect.stringMatching(/^discussion-/),
      input: { text: initial?.text, clientRequestId: initial?.clientRequestId,
        primaryContext: initial?.primaryContext, requiredSystemSkill: TASK_ALIGNMENT_SKILL_REQUIREMENT },
    });
    expect(commands.indexOf('cmd_task_save_discussion_input')).toBeGreaterThan(commands.indexOf('cmd_task_prepare_discussion'));

    const prompt = composeQueryReminder({ visibleText: initial?.text ?? '', primaryContext: initial?.primaryContext });
    expect(prompt).toContain(
      'sourceRecordDocumentPath: /Users/me/.myagents/records/2026-08/record-audio/content.md',
    );
    expect(prompt).toContain(
      '- microphone: /Users/me/.myagents/records/2026-08/record-audio/audio/microphone.opus',
    );
    expect(prompt).toContain(
      '- system: /Users/me/.myagents/records/2026-08/record-audio/audio/system.opus',
    );
    expect(prompt).toContain(
      '请完整读取 sourceRecordDocumentPath 指向的录音文稿',
    );
    expect(prompt).not.toContain('discussionId:');
    expect(prompt).not.toContain('discussionDir:');
    expect(prompt).not.toContain('sourceRecordTags:');
    expect(discussionChat?.initialMessage?.requiredSystemSkill).toBeTruthy();
  });

  it('does not create discussion state when the canonical audio document is unavailable', async () => {
    mocks.tauriEnvironment = true;
    tauriCoreMocks.invoke.mockImplementation(async (command) => {
      if (command === 'cmd_record_discussion_context') {
        throw new Error('RECORD_DISCUSSION_DOCUMENT_NOT_READY');
      }
      return undefined;
    });

    render(<App />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent(CUSTOM_EVENTS.OPEN_AI_DISCUSSION, {
          detail: {
            sourceRecordId: 'record-audio',
            sourceRecordKind: 'audio',
            workspaceId: mocks.project.id,
          },
        }),
      );
    });

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    expect(tauriCoreMocks.invoke).not.toHaveBeenCalledWith(
      'cmd_task_prepare_discussion',
      expect.anything(),
    );
    expect(mocks.ensureSessionSidecar).not.toHaveBeenCalled();
  });

  it('commits the helper tab before launching so the active tab is renderable', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      render(<App />);

      await act(async () => {
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, {
          detail: {
            description: 'help',
            providerId: mocks.provider.id,
            model: 'mimo-v2.5-pro',
            appVersion: 'test',
            images: [],
          },
        }));
      });

      await waitFor(() => expect(mocks.ensureSessionSidecar).toHaveBeenCalled());

      const launchStart = logSpy.mock.calls
        .map(call => String(call[0]))
        .find(message => message.includes('[App][launch] START'));

      expect(launchStart).toContain('view=launcher');
      expect(launchStart).not.toContain('view=undefined');
      expect(mocks.setAppActiveTabId).toHaveBeenCalledWith(
        expect.stringMatching(/^tab-/),
        expect.arrayContaining([expect.stringMatching(/^tab-/)]),
      );
      expect(mocks.setAppActiveCorrelation).toHaveBeenCalledWith(expect.objectContaining({
        tabId: expect.stringMatching(/^tab-/),
      }));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('launches Space Tool installation without the support prompt wrapper', async () => {
    const prompt = [
      '## 工具安装请求',
      '',
      '**工具**：FFmpeg',
      '',
      '```',
      'brew install ffmpeg',
      '```',
    ].join('\n');
    render(<App />);

    await act(async () => {
      window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, {
        detail: {
          scenario: 'space_tool_install',
          description: prompt,
          images: [],
        },
      }));
    });

    await waitFor(() => expect(mocks.ensureSessionSidecar).toHaveBeenCalled());
    const helperChat = [...mocks.chatProps].reverse().find((props) =>
      Boolean(props.initialMessage),
    ) as { initialMessage?: { text?: string } } | undefined;
    expect(helperChat?.initialMessage?.text).toBe(prompt);
    expect(helperChat?.initialMessage?.text).not.toContain('用户反馈');
    await waitFor(() => {
      expect(mocks.track).toHaveBeenCalledWith(
        'space_tool_mutation',
        expect.objectContaining({
          space_surface: 'tools',
          operation: 'helper_launch',
          tool_kind: 'custom_install_prompt',
          result: 'success',
        }),
      );
    });
    expect(latestTabbarProps().tabs).toContainEqual(
      expect.objectContaining({ title: '安装工具' }),
    );
  });

  it('reports Space Tool helper launch failure when the tab limit is reached', async () => {
    render(<App />);
    for (let index = 0; index < 30; index += 1) {
      act(() => latestTabbarProps().onNewTab());
    }
    mocks.track.mockClear();
    mocks.toast.error.mockClear();

    act(() => {
      window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, {
        detail: {
          scenario: 'space_tool_install',
          description: 'Install safely',
          images: [],
        },
      }));
    });

    await waitFor(() => expect(mocks.track).toHaveBeenCalledWith(
      'space_tool_mutation',
      expect.objectContaining({
        operation: 'helper_launch',
        result: 'failure',
      }),
    ));
    expect(mocks.toast.info).toHaveBeenCalledWith(
      '已达到窗口上限，请关闭一些窗口哦',
    );
  });

  it('reports Space Tool helper launch failure when its workspace is unavailable', async () => {
    mocks.selfAwarenessProject = null;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<App />);
      act(() => {
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, {
          detail: {
            scenario: 'space_tool_install',
            description: 'Install safely',
            images: [],
          },
        }));
      });

      await waitFor(() => expect(mocks.track).toHaveBeenCalledWith(
        'space_tool_mutation',
        expect.objectContaining({
          operation: 'helper_launch',
          result: 'failure',
        }),
      ));
      expect(mocks.toast.error).toHaveBeenCalledWith(
        '无法启动工具安装小助手，请重试。',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('reports Space Tool helper launch failure when Session startup rejects', async () => {
    mocks.ensureSessionSidecar.mockRejectedValueOnce(new Error('startup failed'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<App />);
      act(() => {
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, {
          detail: {
            scenario: 'space_tool_install',
            description: 'Install safely',
            images: [],
          },
        }));
      });

      await waitFor(() => expect(mocks.track).toHaveBeenCalledWith(
        'space_tool_mutation',
        expect.objectContaining({
          operation: 'helper_launch',
          result: 'failure',
        }),
      ));
      expect(mocks.toast.error).toHaveBeenCalledWith(
        '无法启动工具安装小助手，请重试。',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('serializes fork owner acquisition with deletion of the forked Session', async () => {
    render(<App />);
    await act(async () => {
      window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, {
        detail: {
          description: 'help',
          providerId: mocks.provider.id,
          model: 'mimo-v2.5-pro',
          appVersion: 'test',
          images: [],
        },
      }));
    });
    await waitFor(() => {
      expect(mocks.chatProps.some((props) => typeof props.onForkSession === 'function')).toBe(true);
    });

    let resolveForkEnsure!: (result: { port: number; isNew: boolean }) => void;
    mocks.ensureSessionSidecar.mockReturnValueOnce(new Promise((resolve) => {
      resolveForkEnsure = resolve;
    }));
    mocks.deleteTargetSessionId = 'fork-delete-race';
    const chatProps = [...mocks.chatProps]
      .reverse()
      .find((props) => typeof props.onForkSession === 'function') as {
        onForkSession: (sessionId: string, agentDir: string, title: string) => Promise<boolean>;
      };

    let forkPromise!: Promise<boolean>;
    act(() => {
      forkPromise = chatProps.onForkSession(
        mocks.deleteTargetSessionId!,
        mocks.project.path,
        'Fork race',
      );
    });
    await waitFor(() => {
      expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
        mocks.deleteTargetSessionId,
        mocks.project.path,
        'tab',
        expect.stringMatching(/^tab-/),
      );
    });

    fireEvent.click(screen.getByTestId('app-delete-session'));
    await waitFor(() => {
      expect(mocks.deleteResults).toEqual([{
        deleted: false,
        reason: 'transition-in-progress',
      }]);
    });
    expect(mocks.deleteSession).not.toHaveBeenCalled();

    let opened = false;
    await act(async () => {
      resolveForkEnsure({ port: 31417, isNew: true });
      opened = await forkPromise;
    });
    expect(opened).toBe(true);
  });

  it('serializes pending-to-real identity adoption with deletion of the target Session', async () => {
    render(<App />);
    await act(async () => {
      await latestLauncherProps().onLaunchProject(mocks.project);
    });
    const providerProps = [...mocks.tabProviderProps]
      .reverse()
      .find((props) => typeof props.onSessionIdChange === 'function') as {
        sessionId: string;
        onSessionIdChange: (
          newSessionId: string,
          options?: { sidecarAlreadyMigrated?: boolean },
        ) => Promise<boolean>;
      };
    expect(providerProps.sessionId).toMatch(/^pending-/);

    let resolveUpgrade!: (upgraded: boolean) => void;
    mocks.upgradeSessionId.mockReturnValueOnce(new Promise((resolve) => {
      resolveUpgrade = resolve;
    }));
    mocks.deleteTargetSessionId = 'real-session-delete-race';
    let adoptionPromise!: Promise<boolean>;
    act(() => {
      adoptionPromise = providerProps.onSessionIdChange(mocks.deleteTargetSessionId!);
    });
    await waitFor(() => {
      expect(mocks.upgradeSessionId).toHaveBeenCalledWith(
        providerProps.sessionId,
        mocks.deleteTargetSessionId,
        expect.stringMatching(/^tab-/),
      );
    });

    fireEvent.click(screen.getByTestId('app-delete-session'));
    await waitFor(() => {
      expect(mocks.deleteResults).toEqual([{
        deleted: false,
        reason: 'transition-in-progress',
      }]);
    });
    expect(mocks.deleteSession).not.toHaveBeenCalled();

    let adopted = false;
    await act(async () => {
      resolveUpgrade(true);
      adopted = await adoptionPromise;
    });
    expect(adopted).toBe(true);
  });

  it('does not repeat a Tab-only Rust rekey after proof-bearing surface migration', async () => {
    render(<App />);
    await act(async () => {
      await latestLauncherProps().onLaunchProject(mocks.project);
    });
    const providerProps = [...mocks.tabProviderProps]
      .reverse()
      .find((props) => typeof props.onSessionIdChange === 'function') as {
        onSessionIdChange: (
          newSessionId: string,
          options?: { sidecarAlreadyMigrated?: boolean },
        ) => Promise<boolean>;
      };

    await expect(providerProps.onSessionIdChange('session-a')).resolves.toBe(true);
    mocks.upgradeSessionId.mockClear();

    await expect(providerProps.onSessionIdChange(
      'session-b',
      { sidecarAlreadyMigrated: true },
    )).resolves.toBe(true);

    expect(mocks.upgradeSessionId).not.toHaveBeenCalled();
    const currentTabs = mocks.tabbarProps.at(-1)?.tabs as Array<{
      sessionId?: string | null;
    }>;
    expect(currentTabs).toContainEqual(expect.objectContaining({ sessionId: 'session-b' }));
  });

  it('releases the migrated Tab owner when the initiating Tab closed before adoption', async () => {
    render(<App />);
    await act(async () => {
      await latestLauncherProps().onLaunchProject(mocks.project);
    });
    const providerProps = [...mocks.tabProviderProps]
      .reverse()
      .find((props) => typeof props.onSessionIdChange === 'function') as {
        tabId: string;
        onSessionIdChange: (
          newSessionId: string,
          options?: { sidecarAlreadyMigrated?: boolean },
        ) => Promise<boolean>;
      };
    await expect(providerProps.onSessionIdChange('session-a')).resolves.toBe(true);

    await act(async () => {
      await (mocks.tabbarProps.at(-1)?.onCloseTab as (tabId: string) => Promise<void>)(
        providerProps.tabId,
      );
    });
    mocks.releaseTabSession.mockClear();

    await expect(providerProps.onSessionIdChange(
      'session-b',
      { sidecarAlreadyMigrated: true },
    )).resolves.toBe(false);

    expect(mocks.releaseTabSession).toHaveBeenCalledWith('session-b', providerProps.tabId);
  });

  it('serializes identity adoption per Tab and advances from the committed predecessor', async () => {
    render(<App />);
    await act(async () => {
      await latestLauncherProps().onLaunchProject(mocks.project);
    });
    const providerProps = [...mocks.tabProviderProps]
      .reverse()
      .find((props) => typeof props.onSessionIdChange === 'function') as {
        sessionId: string;
        onSessionIdChange: (newSessionId: string) => Promise<boolean>;
      };
    let resolveFirst!: (upgraded: boolean) => void;
    mocks.upgradeSessionId.mockReturnValueOnce(new Promise((resolve) => {
      resolveFirst = resolve;
    }));

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = providerProps.onSessionIdChange('real-session-b');
      second = providerProps.onSessionIdChange('real-session-c');
    });
    await waitFor(() => expect(mocks.upgradeSessionId).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveFirst(true);
      await first;
    });
    await waitFor(() => expect(mocks.upgradeSessionId).toHaveBeenCalledTimes(2));
    expect(mocks.upgradeSessionId).toHaveBeenNthCalledWith(
      1,
      providerProps.sessionId,
      'real-session-b',
      expect.stringMatching(/^tab-/),
    );
    expect(mocks.upgradeSessionId).toHaveBeenNthCalledWith(
      2,
      'real-session-b',
      'real-session-c',
      expect.stringMatching(/^tab-/),
    );
    await expect(second).resolves.toBe(true);
  });

  it('lets an earlier deletion terminate a pending creator before it can adopt that identity', async () => {
    render(<App />);
    await act(async () => {
      await latestLauncherProps().onLaunchProject(mocks.project);
    });
    const providerProps = [...mocks.tabProviderProps]
      .reverse()
      .find((props) => typeof props.onSessionIdChange === 'function') as {
        sessionId: string;
        onSessionIdChange: (newSessionId: string) => Promise<boolean>;
      };
    expect(providerProps.sessionId).toMatch(/^pending-/);

    let resolveOwnerCheck!: (hasOwners: boolean) => void;
    mocks.querySessionHasPersistentOwners.mockReturnValueOnce(new Promise((resolve) => {
      resolveOwnerCheck = resolve;
    }));
    mocks.deleteTargetSessionId = 'delete-first-real-session';
    fireEvent.click(screen.getByTestId('app-delete-session'));
    await waitFor(() => {
      expect(mocks.querySessionHasPersistentOwners).toHaveBeenCalledWith(
        mocks.deleteTargetSessionId,
      );
    });

    let adopted = true;
    await act(async () => {
      adopted = await providerProps.onSessionIdChange(mocks.deleteTargetSessionId!);
    });
    expect(adopted).toBe(false);
    expect(mocks.upgradeSessionId).not.toHaveBeenCalled();
    expect(mocks.releaseTabSession).toHaveBeenCalledWith(
      providerProps.sessionId,
      expect.stringMatching(/^tab-/),
    );

    await act(async () => {
      resolveOwnerCheck(false);
    });
    await waitFor(() => {
      expect(mocks.deleteResults).toEqual([{ deleted: true }]);
    });
    const currentTabs = mocks.tabbarProps.at(-1)?.tabs as Array<{
      view?: string;
      sessionId?: string | null;
    }>;
    expect(currentTabs).toContainEqual(expect.objectContaining({
      view: 'launcher',
    }));
    expect(currentTabs.find((tab) => tab.view === 'launcher')).not.toHaveProperty(
      'sessionId',
    );
  });

  it('keeps a refused deletion from reviving the pending creator it already defeated', async () => {
    render(<App />);
    await act(async () => {
      await latestLauncherProps().onLaunchProject(mocks.project);
    });
    const providerProps = [...mocks.tabProviderProps]
      .reverse()
      .find((props) => typeof props.onSessionIdChange === 'function') as {
        sessionId: string;
        onSessionIdChange: (
          newSessionId: string,
          options?: { sidecarAlreadyMigrated?: boolean },
        ) => Promise<boolean>;
      };

    let resolveOwnerCheck!: (hasOwners: boolean) => void;
    mocks.querySessionHasPersistentOwners.mockReturnValueOnce(new Promise((resolve) => {
      resolveOwnerCheck = resolve;
    }));
    mocks.deleteTargetSessionId = 'delete-first-owned-session';
    fireEvent.click(screen.getByTestId('app-delete-session'));
    await waitFor(() => {
      expect(mocks.querySessionHasPersistentOwners).toHaveBeenCalledWith(
        mocks.deleteTargetSessionId,
      );
    });

    await expect(providerProps.onSessionIdChange(
      mocks.deleteTargetSessionId!,
      { sidecarAlreadyMigrated: true },
    )).resolves.toBe(false);
    await act(async () => {
      resolveOwnerCheck(true);
    });
    await waitFor(() => {
      expect(mocks.deleteResults).toEqual([{ deleted: false, reason: 'in-use' }]);
    });
    expect(mocks.upgradeSessionId).not.toHaveBeenCalled();
    expect(mocks.releaseTabSession).toHaveBeenCalledWith(
      mocks.deleteTargetSessionId,
      expect.stringMatching(/^tab-/),
    );
    const currentTabs = mocks.tabbarProps.at(-1)?.tabs as Array<{
      view?: string;
      sessionId?: string | null;
    }>;
    expect(currentTabs).toContainEqual(expect.objectContaining({
      view: 'launcher',
    }));
    expect(currentTabs.find((tab) => tab.view === 'launcher')).not.toHaveProperty(
      'sessionId',
    );
  });

  it('releases the fork tab owner when owner reconciliation fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      render(<App />);

      await act(async () => {
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, {
          detail: {
            description: 'help',
            providerId: mocks.provider.id,
            model: 'mimo-v2.5-pro',
            appVersion: 'test',
            images: [],
          },
        }));
      });

      await waitFor(() => {
        expect(mocks.chatProps.some((props) => typeof props.onForkSession === 'function')).toBe(true);
      });

      mocks.reconcileSessionTabActivation.mockResolvedValueOnce(false);
      const chatProps = [...mocks.chatProps]
        .reverse()
        .find((props) => typeof props.onForkSession === 'function') as {
          onForkSession: (sessionId: string, agentDir: string, title: string) => Promise<boolean>;
        };

      let opened = true;
      await act(async () => {
        opened = await chatProps.onForkSession('fork-session', mocks.project.path, 'Fork');
      });

      expect(opened).toBe(false);
      expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
        'fork-session',
        mocks.project.path,
        'tab',
        expect.stringMatching(/^tab-/),
      );
      expect(mocks.releaseTabSession).toHaveBeenCalledWith(
        'fork-session',
        expect.stringMatching(/^tab-/),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
it('keeps discussion input at its source when durable saving fails', async () => {
  mocks.tauriEnvironment = true;
  let rejectSave!: (error: Error) => void;
  tauriCoreMocks.invoke.mockImplementation(async command => {
    if (command === 'cmd_task_prepare_discussion') return { candidatesDir: '/data/discussion/candidates' };
    if (command === 'cmd_task_save_discussion_input') return new Promise((_resolve, reject) => { rejectSave = reject; });
    return undefined;
  });
  render(<App />);
  const before = latestTabbarProps().tabs;
  act(() => window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_AI_DISCUSSION, { detail: { content: 'original requirement', workspaceId: mocks.project.id } })));
  await waitFor(() => expect(rejectSave).toBeDefined());
  expect(latestTabbarProps().tabs).toEqual(before);
  expect(mocks.ensureSessionSidecar).not.toHaveBeenCalled();
  await act(async () => rejectSave(new Error('disk full')));
  expect(latestTabbarProps().tabs).toEqual(before);
  expect(mocks.toast.error).toHaveBeenCalledWith('disk full');
});

  it('restores an unadmitted discussion even if Session validation or Sidecar startup fails, without auto-replay', async () => {
    mocks.tauriEnvironment = true;
    mocks.lastExitWasClean = false;
    mocks.canRestoreSession.mockResolvedValue(false);
    mocks.durableTabs = { version: 1, activeTabId: 'discussion-recovery', tabs: [{ view: 'chat', id: 'discussion-recovery', agentDir: mocks.project.path, sessionId: 'pending-discussion-recovery', title: 'Discussion', discussionId: 'discussion-saved' }] };
    tauriCoreMocks.invoke.mockImplementation(async command => command === 'cmd_task_read_discussion_input' ? { text: 'original', primaryContext: { kind: 'task-discussion', input: { workspacePath: mocks.project.path } } } : undefined);
    render(<App />);
    fireEvent.click(await screen.findByTestId('restore-session'));
    await waitFor(() => expect(mocks.chatProps.some(props => !!props.startupError)).toBe(true));
    expect(mocks.ensureSessionSidecar).not.toHaveBeenCalled();
    await waitFor(() => expect(latestTabbarProps().tabs).toContainEqual(expect.objectContaining({ id: 'discussion-recovery', discussionId: 'discussion-saved' })));
    const restored = latestTabbarProps().tabs.find(tab => tab.id === 'discussion-recovery');
    expect(restored).not.toHaveProperty('initialMessage');
    expect(tauriCoreMocks.invoke).not.toHaveBeenCalledWith('cmd_task_save_discussion_input', expect.anything());
  });

  it('retains the smart-create form and its text when durable discussion input saving is rejected', async () => {
    mocks.tauriEnvironment = true;
    tauriCoreMocks.invoke.mockImplementation(async command => {
      if (command === 'cmd_task_prepare_discussion') return { candidatesDir: '/data/discussion/candidates' };
      if (command === 'cmd_task_save_discussion_input') throw new Error('disk full');
      return undefined;
    });
    render(<App />);
    act(() => window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_TASK_CREATE, { detail: { initialMode: 'smart', source: 'sidebar', defaultWorkspacePath: mocks.project.path } })));
    const input = await screen.findByPlaceholderText('请输入您希望创建或推进任务的大致目标与需求。接下来会与 AI 多轮讨论完成需求澄清；如需创建 Task，AI 会在你确认最终文档和参数后完成创建。');
    fireEvent.change(input, { target: { value: 'Keep my complete requirement' } });
    fireEvent.click(screen.getByRole('button', { name: '与 AI 讨论' }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('disk full'));
    expect(input).toHaveValue('Keep my complete requirement');
    expect(input).toBeInTheDocument();
    expect(mocks.ensureSessionSidecar).not.toHaveBeenCalled();
  });

  it('keeps managed discussion recovery before birth failure and retries birth without sending the saved body', async () => {
    mocks.tauriEnvironment = true;
    mocks.resolveBuiltinSelection.mockReturnValue({ provider: managedCodexProvider(), model: 'gpt-5.5' });
    mocks.createSession.mockRejectedValueOnce(new Error('birth failed'));
    tauriCoreMocks.invoke.mockImplementation(async command => command === 'cmd_task_prepare_discussion' ? { candidatesDir: '/data/discussion/candidates' } : undefined);
    render(<App />);
    act(() => window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_AI_DISCUSSION, { detail: { content: 'original managed input', workspaceId: mocks.project.id } })));
    await waitFor(() => expect(mocks.chatProps.some(props => !!props.startupError)).toBe(true));
    const failed = mocks.chatProps.at(-1)!;
    expect(failed.discussionId).toMatch(/^discussion-/);
    expect(failed.initialMessage).toMatchObject({ text: 'original managed input', requiredSystemSkill: TASK_ALIGNMENT_SKILL_REQUIREMENT });
    expect(mocks.ensureSessionSidecar).not.toHaveBeenCalled();
    await act(async () => { await (failed.onRetryStartup as () => Promise<void>)(); });
    expect(mocks.createSession).toHaveBeenCalledTimes(2);
    expect(mocks.chatProps.at(-1)?.initialMessage).toBeUndefined();
    expect(mocks.chatProps.at(-1)?.discussionId).toBe(failed.discussionId);
    expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith('prepared-managed-session', mocks.project.path, 'tab', expect.any(String));
  });

  it('exposes the saved recovery and startup failure even while the first input is unconsumed', async () => {
    mocks.tauriEnvironment = true;
    mocks.ensureSessionSidecar.mockRejectedValueOnce(new Error('startup failed'));
    tauriCoreMocks.invoke.mockImplementation(async command => command === 'cmd_task_prepare_discussion' ? { candidatesDir: '/data/discussion/candidates' } : undefined);
    render(<App />);
    act(() => window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_AI_DISCUSSION, { detail: { content: 'original input', workspaceId: mocks.project.id } })));
    await waitFor(() => expect(mocks.chatProps.some(props => !!props.startupError && !!props.discussionId && !!props.initialMessage)).toBe(true));
  });

  it('uses normal Session validation when the archived discussion input is temporarily unreadable', async () => {
    mocks.tauriEnvironment = true;
    mocks.lastExitWasClean = false;
    mocks.durableTabs = { version: 1, activeTabId: 'read-failure', tabs: [{ view: 'chat', id: 'read-failure', agentDir: mocks.project.path, sessionId: 'saved-session', title: 'Discussion', discussionId: 'saved-discussion' }] };
    tauriCoreMocks.invoke.mockImplementation(async command => { if (command === 'cmd_task_read_discussion_input') throw new Error('temporarily unreadable'); return undefined; });
    render(<App />);
    fireEvent.click(await screen.findByTestId('restore-session'));
    await waitFor(() => expect(mocks.canRestoreSession).toHaveBeenCalledWith('saved-session', mocks.project.path));
    await waitFor(() => expect(latestTabbarProps().tabs).toContainEqual(expect.objectContaining({ id: 'read-failure', discussionId: 'saved-discussion' })));
  });

  it.each([false, true])('distinguishes ordinary birth from explicit pending-discussion reset (reset: %s)', async newConversation => {
    mocks.tauriEnvironment = true;
    tauriCoreMocks.invoke.mockImplementation(async command => command === 'cmd_task_prepare_discussion' ? { candidatesDir: '/data/discussion/candidates' } : undefined);
    render(<App />);
    act(() => window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_AI_DISCUSSION, { detail: { content: 'original input', workspaceId: mocks.project.id } })));
    await waitFor(() => expect(mocks.ensureSessionSidecar).toHaveBeenCalled());
    const provider = mocks.tabProviderProps.at(-1)!;
    const original = mocks.chatProps.at(-1)!;
    await act(async () => { await (provider.onSessionIdChange as (id: string, options?: { newConversation: boolean }) => Promise<boolean>)('new-real-session', newConversation ? { newConversation } : undefined); });
    expect(mocks.chatProps.at(-1)?.discussionId).toBe(newConversation ? undefined : original.discussionId);
    expect(!!mocks.chatProps.at(-1)?.initialMessage).toBe(!newConversation);
  });

  it('keeps startup retry available when a prepared managed discussion fails again', async () => {
    mocks.tauriEnvironment = true;
    mocks.resolveBuiltinSelection.mockReturnValue({ provider: managedCodexProvider(), model: 'gpt-5.5' });
    mocks.ensureSessionSidecar.mockRejectedValueOnce(new Error('startup failed')).mockRejectedValueOnce(new Error('startup failed again'));
    tauriCoreMocks.invoke.mockImplementation(async command => command === 'cmd_task_prepare_discussion' ? { candidatesDir: '/data/discussion/candidates' } : undefined);
    render(<App />);
    act(() => window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_AI_DISCUSSION, { detail: { content: 'original input', workspaceId: mocks.project.id } })));
    await waitFor(() => expect(mocks.chatProps.some(props => !!props.startupError)).toBe(true));
    const failed = mocks.chatProps.at(-1)!;
    await act(async () => { await (failed.onRetryStartup as () => Promise<void>)(); });
    expect(mocks.chatProps.at(-1)?.startupError).toBeTruthy();
    expect(mocks.chatProps.at(-1)?.discussionId).toBe(failed.discussionId);
    expect(mocks.chatProps.at(-1)?.initialMessage).toBeUndefined();
  });

});
