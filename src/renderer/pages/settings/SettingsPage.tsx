import {
  Check,
  ChevronDown,
  Copy,
  Download,
  FolderOpen,
  ImageIcon,
  KeyRound,
  Link,
  Loader2,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Square,
  Trash2,
  Unlink,
  X,
  AlertCircle,
  Globe,
  ExternalLink as ExternalLinkIcon,
  Settings2,
} from 'lucide-react';
import { ExternalLink } from '@/components/ExternalLink';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listenWithCleanup } from '@/utils/tauriListen';
import TokenDanceProvider from '@/components/tokendance/TokenDanceProvider';
import { TOKENDANCE_PROVIDER_ID } from '../../../shared/tokendance';
import { homeDir, join } from '@tauri-apps/api/path';

import { track } from '@/analytics';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { useTtsPreview, type TtsPreviewSettings } from './hooks/useTtsPreview';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { apiFetch, apiGetJson, apiPostJson } from '@/api/apiFetch';
import { useToast } from '@/components/Toast';
import CustomSelect from '@/components/CustomSelect';
import { UnifiedLogsPanel } from '@/components/UnifiedLogsPanel';
import GlobalPluginsPanel from '@/components/GlobalPluginsPanel';
import CronTaskDebugPanel from '@/components/dev/CronTaskDebugPanel';
import { BotPlatformRegistry } from '@/components/ImSettings';
import ProxyScopeDialog from '@/components/ProxyScopeDialog';
import WorkspaceConfigPanel from '@/components/WorkspaceConfigPanel';
import ModelManagementPanel from '@/components/ModelManagementPanel';
import GrokSubscriptionProvider from '@/components/GrokSubscriptionProvider';
import SubscriptionProviderCardContent from '@/components/SubscriptionProviderCardContent';
import { discoverGrokModels } from '@/config/services/grokSubscriptionService';
import UsageStatsPanel from '@/components/UsageStatsPanel';
import {
  getEffectiveModelAliases,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  XAI_SUBSCRIPTION_PROVIDER_ID,
  normalizeDisabledProviderIds,
  normalizeProviderOrder,
  splitProviderModelInput,
  type AppConfig,
  type ModelAliases,
  type Provider,
  type McpServerDefinition,
  type McpServerType,
  type McpEnableError,
  isVerifyExpired,
  SUBSCRIPTION_PROVIDER_ID,
  PROXY_DEFAULTS,
  isValidProxyHost,
  getPresetMcpServer,
  DEFAULT_CLAUDE_TRANSCRIPT_CLEANUP_PERIOD_DAYS,
  normalizeClaudeTranscriptCleanupPeriodDays,
  normalizeChatQueueResponseMode,
  getManagedCodexProviderReadiness,
  isManagedCodexProviderGateEnabled,
  type ManagedCodexRuntimeInstallState,
  type ChatQueueResponseMode,
  type ProxyProtocol,
  type SpaceEnvironment,
} from '@/config/types';
import {
  getAllMcpServers,
  getEnabledMcpServerIds,
  applyMcpServerAvailabilityToggle,
  toggleMcpServerEnabled,
  addCustomMcpServer,
  deleteCustomMcpServer,
  saveMcpServerArgs,
  getMcpServerArgs,
  getMcpServerEnv,
  atomicModifyConfig,
  isImageUnderstandingSelectionAvailable,
  isProviderAvailable,
  rebuildAndPersistAvailableProviders,
  shouldInvalidateProviderAfterVerification,
} from '@/config/configService';
import { useConfig } from '@/hooks/useConfig';
import { useSpaceBuildCapability } from '@/hooks/useSpaceBuildCapability';
import { SpaceEnvironmentSwitch } from './components/SpaceEnvironmentSwitch';
import { actions as spaceActions } from '@/pages/space/spaceStore';
import { useHelperAgentModelDefaults } from '@/hooks/useHelperAgentModelDefaults';
import { useAutostart } from '@/hooks/useAutostart';
import { getBuildVersions } from '@/utils/debug';
import { copyPlainText } from '@/utils/clipboard';
import {
  isDeveloperSectionUnlocked,
  unlockDeveloperSection,
  UNLOCK_CONFIG,
} from '@/utils/developerMode';
import { REACT_LOG_EVENT } from '@/utils/frontendLogger';
import { dispatchHelperRequest } from '@/utils/dispatchHelperRequest';
import { isTauriEnvironment } from '@/utils/browserMock';
import { getPlatform } from '@/analytics/device';
import { shortenPathForDisplay } from '@/utils/pathDetection';
import type { LogEntry } from '@/types/log';
import BugReportOverlay from '@/components/BugReportOverlay';
import SettingsHelperInbox from '@/components/SettingsHelperInbox';
import ShortcutRecorder from '@/components/ShortcutRecorder';
import { VISIBLE_APP_SHORTCUTS } from '@/utils/appShortcuts';
import { shouldDebounceAutoVerify } from '@/utils/apiKeyAutoVerify';
import { shouldUseCachedValidSubscriptionVerify } from '@/utils/subscriptionVerifyPolicy';
import type { SubscriptionVerifyResult } from '@/types/subscription';
import { DEFAULT_SUMMON_ACCELERATOR } from '../../../shared/config-types';
import {
  IMAGE_UNDERSTANDING_TOOL_ID,
  OFFICIAL_TOOLS,
  SPEECH_RECOGNITION_TOOL_ID,
  normalizeOfficialToolIds,
  type ImageUnderstandingModelOption,
  type OfficialToolDefinition,
} from '../../../shared/official-tools';
import type { SpeechModelPackStatus } from '../../../shared/types/record';
import {
  speechModelPackInstall,
  speechModelPackRemove,
  speechModelPackStatus as readSpeechModelPackStatus,
} from '@/api/recording';
import { workspacePathsEqual } from '../../../shared/workspacePath';
import { normalizeProxyScope } from '../../../shared/proxyScope';
import { describeProxyScopeSummary } from './proxyScopePresentation';
import { formatSubscriptionVerifyError } from '../../../shared/subscription';
import type { UiLanguage } from '../../../shared/i18n';
import type { ChannelType } from '../../../shared/types/agent';
import { reconcilePersistedAgentWorkspaceIdentities } from '@/config/services/agentConfigService';
import { getBotWorkspaceCandidates } from '@/components/ImSettings/botWorkspaceSelection';
import ProviderEnableOrderDialog from '@/components/ProviderEnableOrderDialog';
import FloatingBallPetSettings from '@/components/FloatingBallPetSettings';
import {
  describeNativeFloatingBallError,
  setNativeFloatingBallEnabled,
  runFloatingBallToggleTransaction,
} from '@/floating-ball/nativeFloatingBall';
import {
  MYAGENTS_GITHUB_URL,
  MYAGENTS_RELEASES_URL,
  MYAGENTS_SOURCE_CODE_URL,
  PLAYWRIGHT_DEVICE_PRESETS,
} from './settingsSections';
import {
  applyVisionToolSettings,
  planVisionToolToggle,
} from './visionToolSettingsPolicy';
import {
  EMPTY_CUSTOM_FORM,
  parsePositiveInt,
  type CustomProviderForm,
  type ProviderEditForm,
} from './providerForms';
import {
  getManagedCodexRuntimePresentation,
  getManagedCodexUpdateRefreshAction,
  type ManagedCodexRuntimeBusyAction,
} from './managedCodexRuntimePresentation';
import { AppearanceModeControl } from './components/AppearanceModeControl';
import { ThemePresetSelect } from './components/ThemePresetSelect';
import { useResolvedTheme } from '@/theme';
import {
  MANAGED_BROWSER_MCP_ID,
  hasUserEditableMcpSettings,
  isBrowserResourceReady,
  selectLatestBrowserResourceStatus,
  shouldAutoMaintainBrowserResource,
  splitStandardPlaywrightProfileArgs,
  standardPlaywrightProfileArgs,
  type BrowserResourceStatus,
  type StandardPlaywrightProfileMode,
} from '../../../shared/browserTools';
import type {
  NetworkProbeResult,
  ProviderVerifyError,
  ProxyProbeState,
  SettingsProps,
  SubscriptionStatus,
} from './types';
import { useSettingsNavigation } from './hooks/useSettingsNavigation';
import { SettingsSidebar } from './components/SettingsSidebar';
import { SkillsAgentsSection } from './sections/SkillsAgentsSection';
import { ToolboxSection } from './sections/ToolboxSection';
import codexModelSelectorOnboarding from '@/assets/onboarding/codex-model-selector.png';

type ManagedCodexLoginStatus =
  | 'idle'
  | 'starting'
  | 'waiting'
  | 'succeeded'
  | 'cancelled'
  | 'error';
type SubscriptionRefreshResult =
  | { success: true }
  | { success: false; error: string };

interface ManagedCodexLoginAttemptState {
  status: ManagedCodexLoginStatus;
  loginUrl?: string | null;
  startedAt?: string | null;
  error?: string | null;
}

const EMPTY_MANAGED_CODEX_LOGIN_STATE: ManagedCodexLoginAttemptState = {
  status: 'idle',
  loginUrl: null,
  startedAt: null,
  error: null,
};

function visionModelOptionValue(providerId: string, model: string): string {
  return JSON.stringify([providerId, model]);
}

function parseVisionModelOptionValue(
  value: string,
): { providerId: string; model: string } | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [providerId, model] = parsed;
    if (typeof providerId !== 'string' || typeof model !== 'string')
      return null;
    if (!providerId.trim() || !model.trim()) return null;
    return { providerId, model };
  } catch {
    return null;
  }
}

function normalizeManagedCodexLoginState(
  raw: unknown,
): ManagedCodexLoginAttemptState {
  if (!raw || typeof raw !== 'object') return EMPTY_MANAGED_CODEX_LOGIN_STATE;
  const value = raw as Record<string, unknown>;
  const status = typeof value.status === 'string' ? value.status : 'idle';
  return {
    status: ['starting', 'waiting', 'succeeded', 'cancelled', 'error'].includes(
      status,
    )
      ? (status as ManagedCodexLoginStatus)
      : 'idle',
    loginUrl: typeof value.loginUrl === 'string' ? value.loginUrl : null,
    startedAt: typeof value.startedAt === 'string' ? value.startedAt : null,
    error: typeof value.error === 'string' ? value.error : null,
  };
}

type SubscriptionLoginStatus =
  | 'idle'
  | 'starting'
  | 'waiting'
  | 'succeeded'
  | 'cancelled'
  | 'error';

interface SubscriptionLoginAttemptState {
  status: SubscriptionLoginStatus;
  loginUrl?: string | null;
  manualUrl?: string | null;
  automaticUrl?: string | null;
  startedAt?: string | null;
  error?: string | null;
}

const EMPTY_SUBSCRIPTION_LOGIN_STATE: SubscriptionLoginAttemptState = {
  status: 'idle',
  loginUrl: null,
  manualUrl: null,
  automaticUrl: null,
  startedAt: null,
  error: null,
};

function normalizeSubscriptionLoginState(
  raw: unknown,
): SubscriptionLoginAttemptState {
  if (!raw || typeof raw !== 'object') return EMPTY_SUBSCRIPTION_LOGIN_STATE;
  const value = raw as Record<string, unknown>;
  const status = typeof value.status === 'string' ? value.status : 'idle';
  return {
    status: ['starting', 'waiting', 'succeeded', 'cancelled', 'error'].includes(
      status,
    )
      ? (status as SubscriptionLoginStatus)
      : 'idle',
    loginUrl: typeof value.loginUrl === 'string' ? value.loginUrl : null,
    manualUrl: typeof value.manualUrl === 'string' ? value.manualUrl : null,
    automaticUrl:
      typeof value.automaticUrl === 'string' ? value.automaticUrl : null,
    startedAt: typeof value.startedAt === 'string' ? value.startedAt : null,
    error: typeof value.error === 'string' ? value.error : null,
  };
}

function isSubscriptionLoginActiveStatus(
  status: SubscriptionLoginStatus,
): boolean {
  return status === 'starting' || status === 'waiting';
}

export default function Settings({
  mode = 'settings',
  initialSection,
  navigationNonce,
  initialMcpId,
  initialOfficialToolId,
  initialSelect,
  onSectionChange,
  isActive,
  updateReady: propUpdateReady,
  updateVersion: propUpdateVersion,
  updateChecking,
  updateDownloading,
  updateInstalling,
  updatePreparing,
  onCheckForUpdate,
  onRestartAndUpdate,
}: SettingsProps) {
  const {
    apiKeys,
    saveApiKey,
    deleteApiKey: _deleteApiKeyService,
    providerVerifyStatus,
    saveProviderVerifyStatus,
    config,
    updateConfig,
    patchProxySettings,
    providers,
    projects,
    addProject,
    updateProject,
    addCustomProvider,
    updateCustomProvider,
    deleteCustomProvider: deleteCustomProviderService,
    refreshProviders,
    savePresetCustomModels,
    removePresetCustomModel: _removePresetCustomModel,
    savePrimaryModel,
    saveProviderModelAliases,
    refreshConfig,
    managedCodexRuntimeUpdateInFlight,
    requestManagedCodexRuntimeUpdate,
  } = useConfig();
  const spaceBuildCapability = useSpaceBuildCapability(config.spaceEnvironment);
  const toast = useToast();
  const resolvedTheme = useResolvedTheme();
  const { t: tSettings } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');
  // Stabilize toast reference to avoid unnecessary effect re-runs
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const tSettingsRef = useRef(tSettings);
  tSettingsRef.current = tSettings;

  // Autostart hook for managing launch on startup
  const {
    isEnabled: autostartEnabled,
    isLoading: autostartLoading,
    setAutostart,
  } = useAutostart(mode === 'settings');
  const claudeTranscriptCleanupPeriodDays = useMemo(
    () =>
      normalizeClaudeTranscriptCleanupPeriodDays(
        config.claudeTranscriptCleanupPeriodDays,
      ),
    [config.claudeTranscriptCleanupPeriodDays],
  );
  const languageOptions = useMemo(
    () => [
      { value: 'system', label: tCommon('language.system') },
      { value: 'zh-CN', label: tCommon('language.zhCN') },
      { value: 'en-US', label: tCommon('language.enUS') },
    ],
    [tCommon],
  );
  const availableSpaceEnvironments = useMemo(
    () => new Set(spaceBuildCapability.environments ?? ['production']),
    [spaceBuildCapability.environments],
  );
  const activeSpaceEnvironment: SpaceEnvironment =
    spaceBuildCapability.activeEnvironment === 'dev' &&
    availableSpaceEnvironments.has('dev')
      ? 'dev'
      : 'production';
  const updateSpaceEnvironment = useCallback(
    (environment: SpaceEnvironment) => {
      if (!availableSpaceEnvironments.has(environment)) return;
      void (async () => {
        await updateConfig({ spaceEnvironment: environment });
        await spaceActions.ensureBootstrapped({ force: true, silent: true });
      })().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        toast.error(
          tSettings('about.developer.spaceEnvironmentSaveFailed', { message }),
        );
      });
    },
    [availableSpaceEnvironments, tSettings, toast, updateConfig],
  );
  const [
    claudeTranscriptCleanupDaysDraft,
    setClaudeTranscriptCleanupDaysDraft,
  ] = useState(String(DEFAULT_CLAUDE_TRANSCRIPT_CLEANUP_PERIOD_DAYS));
  const [floatingBallGateBusy, setFloatingBallGateBusy] = useState(false);
  const [managedCodexBusy, setManagedCodexBusy] =
    useState<ManagedCodexRuntimeBusyAction>(null);
  const managedCodexBusyRef = useRef<typeof managedCodexBusy>(null);
  managedCodexBusyRef.current = managedCodexBusy;
  const [managedCodexDetailsOpen, setManagedCodexDetailsOpen] = useState(false);
  const [managedCodexLoginDialogOpen, setManagedCodexLoginDialogOpen] =
    useState(false);
  const [managedCodexLoginState, setManagedCodexLoginState] =
    useState<ManagedCodexLoginAttemptState>(EMPTY_MANAGED_CODEX_LOGIN_STATE);
  useEffect(() => {
    setClaudeTranscriptCleanupDaysDraft(
      String(claudeTranscriptCleanupPeriodDays),
    );
  }, [claudeTranscriptCleanupPeriodDays]);
  const commitClaudeTranscriptCleanupDays = useCallback(() => {
    const raw = claudeTranscriptCleanupDaysDraft.trim();
    const parsed =
      raw === '' ? DEFAULT_CLAUDE_TRANSCRIPT_CLEANUP_PERIOD_DAYS : Number(raw);
    const next = normalizeClaudeTranscriptCleanupPeriodDays(parsed);
    setClaudeTranscriptCleanupDaysDraft(String(next));
    if (next !== claudeTranscriptCleanupPeriodDays) {
      void updateConfig({ claudeTranscriptCleanupPeriodDays: next });
    }
  }, [
    claudeTranscriptCleanupDaysDraft,
    claudeTranscriptCleanupPeriodDays,
    updateConfig,
  ]);

  const toggleFloatingBallGate = useCallback(async () => {
    if (floatingBallGateBusy) return;
    const next = config.floatingBallDevGate === false;
    setFloatingBallGateBusy(true);
    try {
      if (!next) {
        await runFloatingBallToggleTransaction({
          enabled: false,
          nativeStateBeforeChange: config.floatingBallEnabled === true,
          persistDesiredState: enabled => updateConfig({
            floatingBallDevGate: enabled,
            floatingBallEnabled: enabled,
          }),
          applyNativeState: setNativeFloatingBallEnabled,
        });
      } else {
        await updateConfig({ floatingBallDevGate: true });
      }
      track('floating_ball_toggle', { gate: true, enabled: next });
      toast.success(
        next
          ? tSettings('about.desktopPetEnabled')
          : tSettings('about.desktopPetDisabled'),
      );
    } catch (err) {
      toast.error(
        tSettings('about.desktopPetToggleFailed', {
          action: tSettings(
            next ? 'about.enableAction' : 'about.disableAction',
          ),
          message: describeNativeFloatingBallError(err),
        }),
      );
    } finally {
      setFloatingBallGateBusy(false);
    }
  }, [
    config.floatingBallDevGate,
    config.floatingBallEnabled,
    floatingBallGateBusy,
    tSettings,
    toast,
    updateConfig,
  ]);

  const {
    activeSection,
    setActiveSection,
    navigateToProxySettings,
    notifySectionChange,
  } = useSettingsNavigation({
    initialSection:
      mode === 'capabilities' ? (initialSection ?? 'skills') : initialSection,
    navigationNonce,
    floatingBallDevGate: config.floatingBallDevGate,
    onSectionChange,
  });
  useEffect(() => {
    if (mode !== 'capabilities') return;
    if (
      activeSection === 'skills' ||
      activeSection === 'sub-agents' ||
      activeSection === 'plugins' ||
      activeSection === 'mcp'
    )
      return;
    setActiveSection('skills');
  }, [activeSection, mode, setActiveSection]);
  // Agent overlay state for viewing agent config from Settings card list
  const [overlayAgent, setOverlayAgent] = useState<{
    workspacePath: string;
    initialAddChannelPlatform?: ChannelType;
  } | null>(null);

  // Global summon shortcut (PRD 0.2.16) — load from Rust on mount, mutate
  // via cmd_set_global_summon_shortcut which validates + registers + saves.
  // Local mirror so toggle/recorder UI is snappy without round-tripping
  // useConfig (which writes the whole AppConfig). Falls back to defaults
  // silently in browser dev where invoke returns no useful value.
  const [summonEnabled, setSummonEnabled] = useState(true);
  const [summonAccelerator, setSummonAccelerator] = useState(
    DEFAULT_SUMMON_ACCELERATOR,
  );
  const isMac = useMemo(
    () => navigator.platform.toLowerCase().includes('mac'),
    [],
  );
  useEffect(() => {
    if (mode !== 'settings') return;
    if (!isTauriEnvironment()) return;
    invoke<{ enabled: boolean; accelerator: string }>(
      'cmd_get_global_summon_shortcut',
    )
      .then((cfg) => {
        setSummonEnabled(cfg.enabled);
        setSummonAccelerator(cfg.accelerator || DEFAULT_SUMMON_ACCELERATOR);
      })
      .catch((e) => {
        console.warn('[Settings] load global summon shortcut failed:', e);
      });
  }, [mode]);
  const applySummonShortcut = useCallback(
    async (next: { enabled: boolean; accelerator: string }) => {
      if (!isTauriEnvironment()) return;
      const prevEnabled = summonEnabled;
      const prevAccelerator = summonAccelerator;
      // Optimistic UI — pre-apply, revert on Err.
      setSummonEnabled(next.enabled);
      setSummonAccelerator(next.accelerator);
      try {
        await invoke('cmd_set_global_summon_shortcut', {
          enabled: next.enabled,
          accelerator: next.accelerator,
        });
        toastRef.current.success(
          tSettingsRef.current(
            next.enabled
              ? 'shortcuts.toasts.enabled'
              : 'shortcuts.toasts.disabled',
          ),
        );
      } catch (e) {
        setSummonEnabled(prevEnabled);
        setSummonAccelerator(prevAccelerator);
        const msg = e instanceof Error ? e.message : String(e);
        toastRef.current.error(
          tSettingsRef.current('shortcuts.toasts.saveFailed', { message: msg }),
        );
      }
    },
    [summonEnabled, summonAccelerator],
  );

  // Download progress — listen directly for Tauri events to avoid re-render blast radius
  // through the MemoizedTabContent tree (only Settings needs this value)
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  useEffect(() => {
    if (mode !== 'settings') return;
    if (!isTauriEnvironment()) return;
    const ac = new AbortController();
    void listenWithCleanup<{ percent: number | null }>(
      'updater:download-progress',
      (event) => {
        setDownloadProgress(event.payload.percent);
      },
      ac.signal,
    );
    return () => ac.abort();
  }, [mode]);
  // Reset progress when download completes (updateReady becomes true)
  useEffect(() => {
    if (propUpdateReady) setDownloadProgress(null);
  }, [propUpdateReady]);

  const handleAddBotToWorkspace = useCallback(
    async (
      platform: ChannelType,
      selectedProject: import('@/config/types').Project,
    ) => {
      try {
        const identity = await reconcilePersistedAgentWorkspaceIdentities();
        const project = getBotWorkspaceCandidates(
          identity.projects,
          config.defaultWorkspacePath,
        ).find((candidate) => candidate.id === selectedProject.id);
        if (!project)
          throw new Error(
            `Project '${selectedProject.id}' is no longer available.`,
          );
        const projection = identity.agentProjections.find(
          (item) => item.projectId === project.id,
        );
        if (!projection)
          throw new Error(
            `Agent identity is unavailable for Project '${project.id}'.`,
          );
        await refreshConfig();
        setOverlayAgent({
          workspacePath: project.path,
          initialAddChannelPlatform: platform,
        });
      } catch (error) {
        console.error(
          '[Settings] Failed to prepare workspace for Channel setup:',
          error,
        );
        toastRef.current.error(
          tSettingsRef.current('agentSettings.botRegistry.openWorkspaceFailed'),
        );
      }
    },
    [config.defaultWorkspacePath, refreshConfig],
  );

  const handleInitialAddChannelPlatformConsumed = useCallback(() => {
    setOverlayAgent((current) =>
      current ? { workspacePath: current.workspacePath } : current,
    );
  }, []);

  // #230: The proxy host/port fields previously called updateConfig() on every
  // keystroke. Each call writes config.json AND — via ConfigProvider's
  // process-wide propagation effect — fires
  // cmd_propagate_proxy(), which POSTs /api/proxy/set to every active sidecar.
  // Typing "6666" therefore triggered 4 disk writes + 4 N-sidecar hot-reload
  // storms. Fix: edit into local draft state and commit to config only on blur
  // or Enter, so propagation happens once per intentional change. Protocol
  // (CustomSelect) and the enable toggle stay immediate — they are single
  // discrete actions, not high-frequency typing.
  const [proxyHostDraft, setProxyHostDraft] = useState<string>(
    () => config.proxySettings?.host || PROXY_DEFAULTS.host,
  );
  const [proxyPortDraft, setProxyPortDraft] = useState<string>(() =>
    String(config.proxySettings?.port || PROXY_DEFAULTS.port),
  );
  const [proxyProbeState, setProxyProbeState] = useState<ProxyProbeState>({
    status: 'idle',
  });
  const [showProxyScopeDialog, setShowProxyScopeDialog] = useState(false);
  const proxyProbeGenerationRef = useRef(0);
  // Re-sync drafts when the committed proxy values change from elsewhere
  // (initial load, commit normalisation, external edit). No-op while the user
  // types, since we don't commit until blur/Enter so config doesn't change.
  useEffect(() => {
    setProxyHostDraft(config.proxySettings?.host || PROXY_DEFAULTS.host);
  }, [config.proxySettings?.host]);
  useEffect(() => {
    setProxyPortDraft(
      String(config.proxySettings?.port || PROXY_DEFAULTS.port),
    );
  }, [config.proxySettings?.port]);

  const commitProxyHost = useCallback(() => {
    const host = proxyHostDraft.trim();
    const current = config.proxySettings?.host || PROXY_DEFAULTS.host;
    if (host === '') {
      setProxyHostDraft(PROXY_DEFAULTS.host);
      if (current !== PROXY_DEFAULTS.host) {
        patchProxySettings({ host: PROXY_DEFAULTS.host });
      }
      return;
    }
    if (isValidProxyHost(host)) {
      if (host !== current) {
        patchProxySettings({ host });
      }
    } else {
      // Invalid host → discard the draft, snap back to the committed value.
      setProxyHostDraft(current);
    }
  }, [proxyHostDraft, config.proxySettings?.host, patchProxySettings]);

  const commitProxyPort = useCallback(() => {
    const current = config.proxySettings?.port || PROXY_DEFAULTS.port;
    const port = parseInt(proxyPortDraft, 10);
    if (!isNaN(port) && port >= 1 && port <= 65535) {
      if (port !== current) {
        patchProxySettings({ port });
      }
      // Normalise the draft (e.g. strip leading zeros) to its committed form.
      setProxyPortDraft(String(port));
    } else {
      // Empty or out-of-range → snap back to the committed value.
      setProxyPortDraft(String(current));
    }
  }, [proxyPortDraft, config.proxySettings?.port, patchProxySettings]);

  useEffect(() => {
    if (mode !== 'settings') return;
    if (!config.proxySettings?.enabled) {
      proxyProbeGenerationRef.current += 1;
      setProxyProbeState({ status: 'idle' });
      return;
    }

    const protocol = config.proxySettings.protocol || PROXY_DEFAULTS.protocol;
    const host = config.proxySettings.host || PROXY_DEFAULTS.host;
    const port = config.proxySettings.port || PROXY_DEFAULTS.port;
    const generation = proxyProbeGenerationRef.current + 1;
    proxyProbeGenerationRef.current = generation;

    setProxyProbeState({ status: 'checking' });
    const timer = window.setTimeout(() => {
      invoke<NetworkProbeResult>('cmd_probe_proxy', { protocol, host, port })
        .then((result) => {
          if (proxyProbeGenerationRef.current !== generation) return;
          if (result.ok) {
            setProxyProbeState({
              status: 'ok',
              message: result.message,
              detail: result.httpStatus
                ? `${result.url} HTTP ${result.httpStatus}`
                : result.url,
            });
          } else {
            setProxyProbeState({
              status: 'error',
              message: result.message,
              detail: result.detail,
              stage: result.stage,
              kind: result.kind,
            });
          }
        })
        .catch((error) => {
          if (proxyProbeGenerationRef.current !== generation) return;
          setProxyProbeState({
            status: 'error',
            message: tSettings('proxy.probeFailed'),
            detail: error instanceof Error ? error.message : String(error),
          });
        });
    }, 250);

    return () => window.clearTimeout(timer);
  }, [
    config.proxySettings?.enabled,
    config.proxySettings?.protocol,
    config.proxySettings?.host,
    config.proxySettings?.port,
    mode,
    tSettings,
  ]);

  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customForm, setCustomForm] =
    useState<CustomProviderForm>(EMPTY_CUSTOM_FORM);
  const [showProviderOrderDialog, setShowProviderOrderDialog] = useState(false);
  const [providerOrderDraft, setProviderOrderDraft] = useState<string[]>([]);
  const [disabledProviderDraft, setDisabledProviderDraft] = useState<string[]>(
    [],
  );
  const customModelInputRef = useRef<HTMLInputElement>(null);
  const addCustomModelFromInput = () => {
    const modelIds = splitProviderModelInput(
      customModelInputRef.current?.value ?? '',
    );
    if (modelIds.length === 0) return;
    setCustomForm((p) => {
      const existing = new Set(p.models);
      const added = modelIds.filter((id) => {
        if (existing.has(id)) return false;
        existing.add(id);
        return true;
      });
      if (added.length === 0) return p;
      return { ...p, models: [...p.models, ...added] };
    });
    if (customModelInputRef.current) customModelInputRef.current.value = '';
  };
  // Provider edit/manage panel state
  const [editingProvider, setEditingProvider] =
    useState<ProviderEditForm | null>(null);
  // 删除确认弹窗状态
  const [deleteConfirmProvider, setDeleteConfirmProvider] =
    useState<Provider | null>(null);
  // 模型管理面板状态 — 存 ID 而非 Provider 对象，从 providers 派生最新引用
  const [managingProviderId, setManagingProviderId] = useState<string | null>(
    null,
  );
  const managingProvider = useMemo(
    () =>
      managingProviderId
        ? (providers.find((p) => p.id === managingProviderId) ?? null)
        : null,
    [managingProviderId, providers],
  );
  // UI-only loading state (not persisted)
  const [verifyLoading, setVerifyLoading] = useState<Record<string, boolean>>(
    {},
  );
  const [verifyError, setVerifyError] = useState<
    Record<string, ProviderVerifyError>
  >({});
  const [errorDetailOpenId, setErrorDetailOpenId] = useState<string | null>(
    null,
  );

  // Dev-only: Logs panel
  const [showLogs, setShowLogs] = useState(false);
  const [sseLogs, setSseLogs] = useState<LogEntry[]>([]);

  // App version from Tauri
  const [appVersion, setAppVersion] = useState<string>('');
  const sourceRevision = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(
    appVersion,
  )
    ? `v${appVersion}`
    : 'main';
  const sourceLicenseUrl = `${MYAGENTS_GITHUB_URL}/blob/${sourceRevision}/LICENSE`;
  const sourceNoticesUrl = `${MYAGENTS_GITHUB_URL}/blob/${sourceRevision}/THIRD_PARTY_NOTICES.md`;
  useEffect(() => {
    if (mode !== 'settings') return;
    if (!isTauriEnvironment()) {
      setAppVersion('dev');
      return;
    }
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion('unknown'));
  }, [mode]);

  // QR code URL for user community section
  // Tauri: Downloads on first launch and caches locally, CDN in browser
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [qrCodeLoading, setQrCodeLoading] = useState(false);
  const [logExporting, setLogExporting] = useState(false);
  const [showBugReport, setShowBugReport] = useState(false);
  const helperAgentDefaults = useHelperAgentModelDefaults();

  // Load QR code when entering about section
  useEffect(() => {
    if (activeSection !== 'about') return;

    let cancelled = false;
    setQrCodeLoading(true);

    if (isTauriEnvironment()) {
      // Tauri mode: Call backend API to download & cache QR code
      // The API downloads from CDN on first call, then serves from cache
      apiGetJson<{ success: boolean; dataUrl?: string }>('/api/assets/qr-code')
        .then((result) => {
          if (cancelled) return;
          if (result.success && result.dataUrl) {
            setQrCodeDataUrl(result.dataUrl);
          }
        })
        .catch((error) => {
          if (cancelled) return;
          console.error('[Settings] Failed to load QR code:', error);
          // Silently fail - QR code section will remain hidden
        })
        .finally(() => {
          if (!cancelled) setQrCodeLoading(false);
        });
    } else {
      // Browser mode: Direct CDN URL
      setQrCodeDataUrl(
        'https://download.myagents.io/assets/feedback_qr_code.png',
      );
      setQrCodeLoading(false);
    }

    return () => {
      cancelled = true;
      setQrCodeDataUrl(null); // 统一清理，避免内存泄漏
      setQrCodeLoading(false);
    };
  }, [activeSection]);

  // Collect React and Rust logs for Settings page (since we don't have TabProvider)
  // Limit to 3000 logs to prevent memory issues (matches UnifiedLogsPanel MAX_DISPLAY_LOGS)
  const MAX_LOGS = 3000;
  useEffect(() => {
    if (mode !== 'settings') return;
    const handleReactLog = (event: Event) => {
      const customEvent = event as CustomEvent<LogEntry>;
      setSseLogs((prev) => {
        const next = [...prev, customEvent.detail];
        return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
      });
    };
    window.addEventListener(REACT_LOG_EVENT, handleReactLog);
    return () => {
      window.removeEventListener(REACT_LOG_EVENT, handleReactLog);
    };
  }, [mode]);

  // Listen for Rust logs (Tauri only)
  useEffect(() => {
    if (mode !== 'settings') return;
    if (!isTauriEnvironment()) return;
    const ac = new AbortController();
    void listenWithCleanup<LogEntry>(
      'log:rust',
      (event) => {
        setSseLogs((prev) => {
          const next = [...prev, event.payload];
          return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
        });
      },
      ac.signal,
    );
    return () => ac.abort();
  }, [mode]);

  const clearLogs = useCallback(() => {
    setSseLogs([]);
  }, []);

  // Developer section unlock state
  const [devSectionVisible, setDevSectionVisible] = useState(
    isDeveloperSectionUnlocked,
  );
  const [showCronDebugPanel, setShowCronDebugPanel] = useState(false);
  const logoTapCountRef = useRef(0);
  const logoTapTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Handle logo tap to unlock developer section
  const handleLogoTap = useCallback(() => {
    if (devSectionVisible) return; // Already unlocked

    logoTapCountRef.current += 1;

    // Clear existing timer and start new one
    if (logoTapTimerRef.current) {
      clearTimeout(logoTapTimerRef.current);
    }

    // Check if unlock threshold reached
    if (logoTapCountRef.current >= UNLOCK_CONFIG.requiredTaps) {
      unlockDeveloperSection();
      setDevSectionVisible(true);
      logoTapCountRef.current = 0;
      return;
    }

    // Reset counter after time window expires
    logoTapTimerRef.current = setTimeout(() => {
      logoTapCountRef.current = 0;
    }, UNLOCK_CONFIG.timeWindowMs);
  }, [devSectionVisible]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (logoTapTimerRef.current) {
        clearTimeout(logoTapTimerRef.current);
      }
    };
  }, []);

  // Anthropic subscription status
  const [subscriptionStatus, setSubscriptionStatus] =
    useState<SubscriptionStatus | null>(null);
  const [subscriptionVerifying, setSubscriptionVerifying] = useState(false);
  const [subscriptionLoginDialogOpen, setSubscriptionLoginDialogOpen] =
    useState(false);
  const [subscriptionLoginState, setSubscriptionLoginState] =
    useState<SubscriptionLoginAttemptState>(EMPTY_SUBSCRIPTION_LOGIN_STATE);
  const [subscriptionLoginBusy, setSubscriptionLoginBusy] = useState(false);
  const [subscriptionLoginCode, setSubscriptionLoginCode] = useState('');
  const [subscriptionLoginSubmitting, setSubscriptionLoginSubmitting] =
    useState(false);
  const subscriptionLoginSuccessHandledRef = useRef(false);
  const refreshSubscriptionStatusAfterLoginRef = useRef<
    (() => Promise<SubscriptionRefreshResult>) | null
  >(null);
  const cancelSubscriptionLoginAttempt = useCallback(
    async (startedAt?: string | null) => {
      try {
        const state = normalizeSubscriptionLoginState(
          await apiPostJson('/api/subscription/login/cancel', { startedAt }),
        );
        setSubscriptionLoginState((prev) =>
          startedAt && prev.startedAt !== startedAt ? prev : state,
        );
      } catch (error) {
        console.warn('[Settings] Subscription login cancel failed:', error);
      }
    },
    [],
  );
  const closeSubscriptionLoginDialog = useCallback(() => {
    const shouldVerifyAfterClose =
      subscriptionLoginState.status === 'succeeded' ||
      subscriptionLoginSuccessHandledRef.current;
    setSubscriptionLoginDialogOpen(false);
    setSubscriptionLoginCode('');
    if (isSubscriptionLoginActiveStatus(subscriptionLoginState.status)) {
      void cancelSubscriptionLoginAttempt(
        subscriptionLoginState.startedAt ?? null,
      );
    } else if (shouldVerifyAfterClose) {
      void refreshSubscriptionStatusAfterLoginRef.current?.();
    }
  }, [
    cancelSubscriptionLoginAttempt,
    subscriptionLoginState.startedAt,
    subscriptionLoginState.status,
  ]);

  // Ref for verify timeout cleanup
  const verifyTimeoutRef = useRef<Record<string, NodeJS.Timeout>>({});
  // Per-provider generation counter to prevent stale verify results from overwriting newer ones
  const verifyGenRef = useRef<Record<string, number>>({});

  // MCP state
  const [mcpServers, setMcpServersState] = useState<McpServerDefinition[]>([]);
  const [mcpEnabledIds, setMcpEnabledIds] = useState<string[]>([]);
  const [mcpEnabling, setMcpEnabling] = useState<Record<string, boolean>>({}); // Loading state for enable toggle
  const [browserResourceStatus, setBrowserResourceStatus] =
    useState<BrowserResourceStatus | null>(null);
  const browserResourceOperationRef = useRef(false);
  const [speechModelPackStatus, setSpeechModelPackStatus] =
    useState<SpeechModelPackStatus | null>(null);
  const speechModelPackOperationRef = useRef(false);
  const [showMcpForm, setShowMcpForm] = useState(false);
  const [editingMcpId, setEditingMcpId] = useState<string | null>(null);
  // Dialog state for runtime not found
  const [runtimeDialog, setRuntimeDialog] = useState<{
    show: boolean;
    runtimeName?: string;
    downloadUrl?: string;
    command?: string;
  }>({ show: false });

  const acceptBrowserResourceStatus = useCallback(
    (incoming: BrowserResourceStatus) => {
      setBrowserResourceStatus((current) =>
        selectLatestBrowserResourceStatus(current, incoming),
      );
    },
    [],
  );

  const refreshBrowserResourceStatus = useCallback(async () => {
    if (!isTauriEnvironment()) return;
    try {
      acceptBrowserResourceStatus(
        await invoke<BrowserResourceStatus>('cmd_browser_resource_status'),
      );
    } catch (error) {
      console.warn('[Settings] Failed to read Browser resource status:', error);
    }
  }, [acceptBrowserResourceStatus]);

  useEffect(() => {
    if (mode !== 'capabilities' || !isTauriEnvironment()) return;
    const abortController = new AbortController();
    void listenWithCleanup<BrowserResourceStatus>(
      'browser-resource-status',
      (event) => {
        acceptBrowserResourceStatus(event.payload);
      },
      abortController.signal,
    );
    void refreshBrowserResourceStatus();
    return () => abortController.abort();
  }, [acceptBrowserResourceStatus, mode, refreshBrowserResourceStatus]);

  const runBrowserResourceInstall = useCallback(async () => {
    if (!isTauriEnvironment() || browserResourceOperationRef.current) return;
    browserResourceOperationRef.current = true;
    try {
      const command = shouldAutoMaintainBrowserResource(browserResourceStatus)
        ? 'cmd_browser_resource_maintain'
        : 'cmd_browser_resource_install';
      acceptBrowserResourceStatus(await invoke<BrowserResourceStatus>(command));
    } catch (error) {
      console.warn('[Settings] Browser resource operation failed:', error);
      toast.error(tSettings('toolbox.browserResource.operationFailed'));
      await refreshBrowserResourceStatus();
    } finally {
      browserResourceOperationRef.current = false;
    }
  }, [
    acceptBrowserResourceStatus,
    browserResourceStatus,
    refreshBrowserResourceStatus,
    tSettings,
    toast,
  ]);

  const refreshSpeechModelPackStatus = useCallback(async () => {
    if (!isTauriEnvironment()) return;
    try {
      setSpeechModelPackStatus(await readSpeechModelPackStatus());
    } catch (error) {
      console.warn(
        '[Settings] Failed to read speech model pack status:',
        error,
      );
    }
  }, []);

  useEffect(() => {
    if (mode !== 'capabilities' || !isTauriEnvironment()) return;
    void refreshSpeechModelPackStatus();
  }, [mode, refreshSpeechModelPackStatus]);

  useEffect(() => {
    if (
      !speechModelPackStatus ||
      ![
        'checking',
        'downloading',
        'verifying',
        'installing',
        'removing',
      ].includes(speechModelPackStatus.status)
    )
      return;
    const interval = window.setInterval(() => {
      void refreshSpeechModelPackStatus();
    }, 500);
    return () => window.clearInterval(interval);
  }, [refreshSpeechModelPackStatus, speechModelPackStatus]);

  const runSpeechModelPackInstall = useCallback(async () => {
    if (!isTauriEnvironment() || speechModelPackOperationRef.current) return;
    speechModelPackOperationRef.current = true;
    setSpeechModelPackStatus((current) =>
      current
        ? { ...current, status: 'checking', lastErrorCode: undefined }
        : current,
    );
    try {
      setSpeechModelPackStatus(await speechModelPackInstall());
    } catch (error) {
      console.warn('[Settings] Speech model pack install failed:', error);
      toast.error(tSettings('toolbox.speechResource.operationFailed'));
      await refreshSpeechModelPackStatus();
    } finally {
      speechModelPackOperationRef.current = false;
    }
  }, [refreshSpeechModelPackStatus, tSettings, toast]);

  const runSpeechModelPackRemove = useCallback(async () => {
    if (!isTauriEnvironment() || speechModelPackOperationRef.current) return;
    speechModelPackOperationRef.current = true;
    setSpeechModelPackStatus((current) =>
      current
        ? { ...current, status: 'removing', lastErrorCode: undefined }
        : current,
    );
    try {
      setSpeechModelPackStatus(await speechModelPackRemove());
    } catch (error) {
      console.warn('[Settings] Speech model pack removal failed:', error);
      toast.error(tSettings('toolbox.speechResource.removeFailed'));
      await refreshSpeechModelPackStatus();
    } finally {
      speechModelPackOperationRef.current = false;
    }
  }, [refreshSpeechModelPackStatus, tSettings, toast]);

  // Whether any provider is available (for "AI 小助理安装" button)
  const showAiInstallButton = useMemo(
    () =>
      providers.some(
        (p) =>
          p.models.length > 0 &&
          isProviderAvailable(p, apiKeys, providerVerifyStatus),
      ),
    [providers, apiKeys, providerVerifyStatus],
  );

  const handleAiInstallRuntime = useCallback(() => {
    const { runtimeName, command, downloadUrl } = runtimeDialog;
    setRuntimeDialog({ show: false });

    const platform = getPlatform();
    const osName = platform.startsWith('darwin')
      ? 'macOS'
      : platform.startsWith('windows')
        ? 'Windows'
        : platform.startsWith('linux')
          ? 'Linux'
          : platform;

    const prompt = [
      `## 依赖安装请求`,
      ``,
      `用户尝试启用一个 MCP 服务，但系统缺少必要的运行环境。`,
      ``,
      `- **缺少的运行环境**: ${runtimeName || command || '未知'}`,
      `- **缺少的命令**: \`${command || '未知'}\``,
      ...(downloadUrl ? [`- **官方下载地址**: ${downloadUrl}`] : []),
      `- **操作系统**: ${osName}`,
      ``,
      `请帮助用户安装 \`${command}\`，安装完成后告知用户回到设置页面重新启用 MCP 服务。`,
    ].join('\n');

    // Don't pass providerId/model — the LAUNCH_BUG_REPORT handler will fall
    // through to the helper Agent's persisted (providerId, model), matching
    // the user's intent that "summon helper" always opens with the helper
    // Agent's workspace settings, not whatever provider this dialog could
    // find first.
    dispatchHelperRequest({
      description: prompt,
      appVersion,
      assistantEntry: 'settings',
    });
  }, [runtimeDialog, appVersion]);

  // Track which MCP servers need configuration (missing required fields)
  const [mcpNeedsConfig, setMcpNeedsConfig] = useState<Record<string, boolean>>(
    {},
  );

  // Official MyAgents CLI tools shown in the same Toolbox list as MCP.
  const [officialToolEnabling, setOfficialToolEnabling] = useState<
    Record<string, boolean>
  >({});
  const [visionToolSettingsOpen, setVisionToolSettingsOpen] = useState(false);
  const [visionToolEnableAfterSave, setVisionToolEnableAfterSave] =
    useState(false);
  const [visionToolSaving, setVisionToolSaving] = useState(false);
  const [visionToolDraftValue, setVisionToolDraftValue] = useState('');
  const [visionModelCandidates, setVisionModelCandidates] = useState<
    ImageUnderstandingModelOption[]
  >([]);
  const [visionModelsLoading, setVisionModelsLoading] = useState(false);
  const [visionModelsLoadFailed, setVisionModelsLoadFailed] = useState(false);

  const resetVisionToolSettings = useCallback(() => {
    setVisionToolSettingsOpen(false);
    setVisionToolEnableAfterSave(false);
  }, []);

  const closeVisionToolSettings = useCallback(() => {
    if (visionToolSaving) return;
    resetVisionToolSettings();
  }, [resetVisionToolSettings, visionToolSaving]);

  const officialEnabledIds = useMemo(
    () => normalizeOfficialToolIds(config.enabledOfficialToolIds ?? []),
    [config.enabledOfficialToolIds],
  );

  const loadVisionModelCandidates = useCallback(async () => {
    setVisionModelsLoading(true);
    setVisionModelsLoadFailed(false);
    try {
      const result = await apiPostJson<{
        success: boolean;
        data?: { models?: ImageUnderstandingModelOption[] };
      }>('/api/admin/vision/models', {});
      if (!result.success || !Array.isArray(result.data?.models)) {
        throw new Error('Invalid image-understanding model response');
      }
      setVisionModelCandidates(result.data.models);
    } catch (error) {
      console.error(
        '[Settings] Failed to load image-understanding models:',
        error,
      );
      setVisionModelCandidates([]);
      setVisionModelsLoadFailed(true);
    } finally {
      setVisionModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadVisionModelCandidates();
  }, [loadVisionModelCandidates, providers, apiKeys, providerVerifyStatus]);

  const visionModelOptions = useMemo(
    () =>
      visionModelCandidates.map((candidate) => ({
        value: visionModelOptionValue(candidate.providerId, candidate.model),
        label: `${candidate.providerName} / ${candidate.modelName || candidate.model}${
          candidate.capabilityConfidence === 'inferred'
            ? ` · ${tSettings('toolbox.dialogs.vision.inferredBadge')}`
            : candidate.capabilityConfidence === 'unknown'
              ? ` · ${tSettings('toolbox.dialogs.vision.confirmBadge')}`
              : ''
        }`,
      })),
    [tSettings, visionModelCandidates],
  );

  const savedVisionModelValue = useMemo(() => {
    const saved = config.officialToolSettings?.imageUnderstanding;
    return saved?.providerId && saved.model
      ? visionModelOptionValue(saved.providerId, saved.model)
      : '';
  }, [config.officialToolSettings?.imageUnderstanding]);
  const savedVisionModelStillValid = isImageUnderstandingSelectionAvailable(
    providers,
    apiKeys,
    providerVerifyStatus,
    config.officialToolSettings,
  );
  const visionToolNeedsConfig = !savedVisionModelStillValid;
  const selectedVisionModelCandidate = useMemo(() => {
    const parsed = parseVisionModelOptionValue(visionToolDraftValue);
    return parsed
      ? visionModelCandidates.find(
          (candidate) =>
            candidate.providerId === parsed.providerId &&
            candidate.model === parsed.model,
        )
      : undefined;
  }, [visionModelCandidates, visionToolDraftValue]);

  // Builtin MCP settings dialog state
  const [builtinMcpSettings, setBuiltinMcpSettings] = useState<{
    server: McpServerDefinition;
    extraArgs: string[];
    newArg: string;
    env: Record<string, string>;
    newEnvKey: string;
    newEnvValue: string;
  } | null>(null);

  // Gemini Image MCP custom settings dialog
  const [geminiImageSettings, setGeminiImageSettings] = useState<{
    apiKey: string;
    baseUrl: string;
    model: string;
    aspectRatio: string;
    imageSize: string;
    thinkingLevel: string;
    searchGrounding: boolean;
    maxContextTurns: number;
  } | null>(null);

  // Edge TTS slider styling (custom range input with accent-colored thumb)
  const ttsSliderClass =
    'w-full h-1.5 rounded-full appearance-none cursor-pointer bg-[var(--line)] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--accent)] [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:hover:scale-110';

  // Edge TTS MCP custom settings dialog
  const [edgeTtsSettings, setEdgeTtsSettings] = useState<TtsPreviewSettings | null>(null);
  const [ttsPreviewText, setTtsPreviewText] = useState(
    '你好，这是一段语音合成测试。Hello, this is a text-to-speech test.',
  );
  const {
    loading: ttsPreviewLoading,
    playing: ttsPreviewPlaying,
    toggle: toggleTtsPreview,
    stop: stopTtsPreview,
  } = useTtsPreview(edgeTtsSettings);

  // OAuth polling cleanup refs (P0-7: prevent interval leak on unmount)
  const oauthPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const oauthPollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  useEffect(() => {
    return () => {
      if (oauthPollIntervalRef.current)
        clearInterval(oauthPollIntervalRef.current);
      if (oauthPollTimeoutRef.current)
        clearTimeout(oauthPollTimeoutRef.current);
    };
  }, []);

  // Playwright MCP custom settings dialog
  const [playwrightSettings, setPlaywrightSettings] = useState<{
    mode: StandardPlaywrightProfileMode;
    headless: boolean;
    browser: string;
    device: string;
    customDevice: string;
    userDataDir: string;
    extraArgs: string[];
    newArg: string;
  } | null>(null);

  const [mcpFormMode, setMcpFormMode] = useState<'form' | 'json'>('form');
  const [mcpJsonInput, setMcpJsonInput] = useState('');
  const [mcpJsonError, setMcpJsonError] = useState<{
    key: string;
    params?: Record<string, number | string>;
  } | null>(null);

  // OAuth state for MCP servers
  const [mcpOAuthStatus, setMcpOAuthStatus] = useState<
    Record<
      string,
      'disconnected' | 'connecting' | 'connected' | 'expired' | 'error'
    >
  >({});
  const [mcpOAuthConnecting, setMcpOAuthConnecting] = useState<string | null>(
    null,
  );
  const [mcpOAuthProbe, setMcpOAuthProbe] = useState<
    Record<
      string,
      {
        required: boolean;
        supportsDynamicRegistration?: boolean;
        scopes?: string[];
      }
    >
  >({});

  const [mcpForm, setMcpForm] = useState<{
    id: string;
    name: string;
    type: McpServerType;
    command: string;
    args: string[];
    newArg: string;
    url: string;
    env: Record<string, string>;
    newEnvKey: string;
    newEnvValue: string;
    headers: Record<string, string>;
    newHeaderKey: string;
    newHeaderValue: string;
    // OAuth fields (manual mode fallback)
    oauthClientId: string;
    oauthClientSecret: string;
    oauthScopes: string;
    oauthCallbackPort: string;
    oauthAuthUrl: string;
    oauthTokenUrl: string;
  }>({
    id: '',
    name: '',
    type: 'stdio',
    command: '',
    args: [],
    newArg: '',
    url: '',
    env: {},
    newEnvKey: '',
    newEnvValue: '',
    headers: {},
    newHeaderKey: '',
    newHeaderValue: '',
    oauthClientId: '',
    oauthClientSecret: '',
    oauthScopes: '',
    oauthCallbackPort: '',
    oauthAuthUrl: '',
    oauthTokenUrl: '',
  });
  const [mcpHeadersExpanded, setMcpHeadersExpanded] = useState(false);
  const [mcpOAuthExpanded, setMcpOAuthExpanded] = useState(false);

  // Cmd+W dismissal for all inline Settings overlays (z-50 / z-[60]).
  // Checks from highest z-index down; first truthy state gets closed.
  useCloseLayer(() => {
    // z-[60]: delete confirmation (highest)
    if (deleteConfirmProvider) {
      setDeleteConfirmProvider(null);
      return true;
    }
    // z-50: all other inline overlays
    if (subscriptionLoginDialogOpen) {
      closeSubscriptionLoginDialog();
      return true;
    }
    if (managedCodexLoginDialogOpen) {
      setManagedCodexLoginDialogOpen(false);
      return true;
    }
    if (managedCodexDetailsOpen) {
      setManagedCodexDetailsOpen(false);
      return true;
    }
    if (runtimeDialog.show) {
      setRuntimeDialog((prev) => ({ ...prev, show: false }));
      return true;
    }
    if (editingProvider) {
      setEditingProvider(null);
      return true;
    }
    if (showProviderOrderDialog) {
      setShowProviderOrderDialog(false);
      return true;
    }
    if (showProxyScopeDialog) {
      setShowProxyScopeDialog(false);
      return true;
    }
    if (showCustomForm) {
      setShowCustomForm(false);
      return true;
    }
    if (showMcpForm) {
      setShowMcpForm(false);
      setEditingMcpId(null);
      return true;
    }
    if (visionToolSettingsOpen) {
      closeVisionToolSettings();
      return true;
    }
    if (builtinMcpSettings) {
      setBuiltinMcpSettings(null);
      return true;
    }
    if (geminiImageSettings) {
      setGeminiImageSettings(null);
      return true;
    }
    if (playwrightSettings) {
      setPlaywrightSettings(null);
      return true;
    }
    if (edgeTtsSettings) {
      setEdgeTtsSettings(null);
      return true;
    }
    return false;
  }, 50);

  // Check which MCP servers need configuration (missing required fields)
  const checkMcpConfigStatus = async (servers: McpServerDefinition[]) => {
    const needs: Record<string, boolean> = {};
    for (const server of servers) {
      if (server.requiresConfig && server.requiresConfig.length > 0) {
        const savedEnv = await getMcpServerEnv(server.id);
        const missing = server.requiresConfig.some(
          (key) => !savedEnv?.[key]?.trim(),
        );
        if (missing) needs[server.id] = true;
      }
    }
    setMcpNeedsConfig(needs);
  };

  // Load MCP config on mount
  useEffect(() => {
    if (mode !== 'capabilities') return;
    const loadMcp = async () => {
      try {
        const servers = await getAllMcpServers();
        const enabledIds = await getEnabledMcpServerIds();
        setMcpServersState(servers);
        setMcpEnabledIds(enabledIds);
        await checkMcpConfigStatus(servers);
      } catch (err) {
        console.error('[Settings] Failed to load MCP config:', err);
      }
    };
    loadMcp();
  }, [mode]);

  // Refresh MCP local state when tab becomes active (inactive → active transition).
  // Config/projects/providers/apiKeys are shared via ConfigProvider and auto-sync.
  // MCP servers are local state, so we reload them from disk on tab activation.
  const prevIsActiveRef = useRef(isActive);
  useEffect(() => {
    if (mode !== 'capabilities') return;
    const wasInactive = !prevIsActiveRef.current;
    prevIsActiveRef.current = isActive;
    if (!wasInactive || !isActive) return;

    void (async () => {
      try {
        const servers = await getAllMcpServers();
        const enabledIds = await getEnabledMcpServerIds();
        setMcpServersState(servers);
        setMcpEnabledIds(enabledIds);
        await checkMcpConfigStatus(servers);
      } catch (err) {
        console.warn(
          '[Settings] Failed to reload MCP servers on activation:',
          err,
        );
      }
    })();
  }, [isActive, mode]);

  // Toggle MCP server enabled status
  // For preset MCP (npx): warmup bun cache
  // For custom MCP: check if command exists
  const handleMcpToggle = async (
    server: McpServerDefinition,
    enabled: boolean,
  ) => {
    if (!enabled) {
      // Just disable
      await toggleMcpServerEnabled(server.id, false, false);
      setMcpEnabledIds((prev) =>
        applyMcpServerAvailabilityToggle(prev, server.id, false, false),
      );
      toast.success(tSettings('toolbox.toasts.mcpDisabled'));
      return;
    }

    if (
      server.id === MANAGED_BROWSER_MCP_ID &&
      !isBrowserResourceReady(browserResourceStatus)
    ) {
      toast.error(tSettings('toolbox.browserResource.installFirst'));
      return;
    }

    // Validate required config before enabling (e.g., API keys)
    if (server.requiresConfig && server.requiresConfig.length > 0) {
      const savedEnv = await getMcpServerEnv(server.id);
      const missingKeys = server.requiresConfig.filter(
        (key) => !savedEnv?.[key]?.trim(),
      );
      if (missingKeys.length > 0) {
        toast.error(
          tSettings('toolbox.toasts.configureServerFirst', {
            name: server.name,
          }),
        );
        // Auto-open settings dialog for convenience
        handleEditBuiltinMcp(server);
        return;
      }
    }

    // Set loading state
    setMcpEnabling((prev) => ({ ...prev, [server.id]: true }));

    try {
      // Call enable API to validate/warmup
      const result = await apiPostJson<{
        success: boolean;
        error?: McpEnableError;
      }>('/api/mcp/enable', { server });

      if (result.success) {
        // Enable the MCP
        const browserReady = isBrowserResourceReady(browserResourceStatus);
        await toggleMcpServerEnabled(server.id, true, browserReady);
        setMcpEnabledIds((prev) =>
          applyMcpServerAvailabilityToggle(prev, server.id, true, browserReady),
        );

        toast.success(tSettings('toolbox.toasts.mcpEnabled'));
      } else if (result.error) {
        // Handle different error types
        if (
          result.error.type === 'command_not_found' &&
          result.error.downloadUrl
        ) {
          // Show dialog for runtime not found
          setRuntimeDialog({
            show: true,
            runtimeName: result.error.runtimeName,
            downloadUrl: result.error.downloadUrl,
            command: result.error.command,
          });
        } else {
          // Show toast for other errors
          toast.error(
            result.error.message || tSettings('toolbox.toasts.mcpEnableFailed'),
          );
        }
      }
    } catch (err) {
      const errorMsg =
        err instanceof Error
          ? err.message
          : tSettings('toolbox.toasts.mcpEnableFailed');
      toast.error(errorMsg);
    } finally {
      setMcpEnabling((prev) => ({ ...prev, [server.id]: false }));
    }
  };

  const openOfficialToolSettings = useCallback(
    (tool: OfficialToolDefinition, enableAfterSave = false) => {
      if (tool.id === SPEECH_RECOGNITION_TOOL_ID) {
        window.requestAnimationFrame(() => {
          document
            .getElementById(`official-tool-${tool.id}`)
            ?.scrollIntoView({ block: 'center' });
        });
        return;
      }
      if (tool.id !== IMAGE_UNDERSTANDING_TOOL_ID) return;
      const initial = savedVisionModelStillValid
        ? savedVisionModelValue
        : (visionModelOptions[0]?.value ?? '');
      setVisionToolEnableAfterSave(enableAfterSave);
      setVisionToolDraftValue(initial);
      setVisionToolSettingsOpen(true);
      void loadVisionModelCandidates();
    },
    [
      loadVisionModelCandidates,
      savedVisionModelStillValid,
      savedVisionModelValue,
      visionModelOptions,
    ],
  );

  useEffect(() => {
    if (
      visionToolSettingsOpen &&
      !visionToolDraftValue &&
      visionModelOptions[0]
    ) {
      setVisionToolDraftValue(visionModelOptions[0].value);
    }
  }, [visionModelOptions, visionToolDraftValue, visionToolSettingsOpen]);

  const handleOfficialToolToggle = useCallback(
    async (tool: OfficialToolDefinition, enabled: boolean) => {
      if (
        tool.id === IMAGE_UNDERSTANDING_TOOL_ID &&
        planVisionToolToggle(enabled, visionToolNeedsConfig) ===
          'configure-before-enable'
      ) {
        openOfficialToolSettings(tool, true);
        return;
      }

      setOfficialToolEnabling((prev) => ({ ...prev, [tool.id]: true }));
      try {
        await atomicModifyConfig((current) => {
          const existing = normalizeOfficialToolIds(
            current.enabledOfficialToolIds ?? [],
          );
          const next = enabled
            ? normalizeOfficialToolIds([...existing, tool.id])
            : existing.filter((id) => id !== tool.id);
          return { ...current, enabledOfficialToolIds: next };
        });
        await refreshConfig();
        toast.success(
          enabled
            ? tSettings('toolbox.toasts.officialToolEnabled')
            : tSettings('toolbox.toasts.officialToolDisabled'),
        );
      } catch (err) {
        console.error('[Settings] Failed to toggle official tool:', err);
        toast.error(tSettings('toolbox.toasts.officialToolToggleFailed'));
      } finally {
        setOfficialToolEnabling((prev) => ({ ...prev, [tool.id]: false }));
      }
    },
    [
      openOfficialToolSettings,
      refreshConfig,
      tSettings,
      toast,
      visionToolNeedsConfig,
    ],
  );

  const saveVisionToolSettings = useCallback(async () => {
    if (visionToolSaving) return;
    const parsed = parseVisionModelOptionValue(visionToolDraftValue);
    if (!parsed) {
      toast.error(tSettings('toolbox.toasts.visionModelRequired'));
      return;
    }
    setVisionToolSaving(true);
    try {
      await atomicModifyConfig((current) =>
        applyVisionToolSettings(
          current,
          parsed,
          visionToolEnableAfterSave,
        ),
      );
      await refreshConfig();
      resetVisionToolSettings();
      toast.success(tSettings('toolbox.toasts.visionModelSaved'));
    } catch (err) {
      console.error('[Settings] Failed to save vision tool settings:', err);
      toast.error(tSettings('toolbox.toasts.saveFailed'));
    } finally {
      setVisionToolSaving(false);
    }
  }, [
    refreshConfig,
    resetVisionToolSettings,
    tSettings,
    toast,
    visionToolDraftValue,
    visionToolEnableAfterSave,
    visionToolSaving,
  ]);

  const resetMcpForm = () => {
    setEditingMcpId(null);
    setMcpFormMode('form');
    setMcpJsonInput('');
    setMcpJsonError(null);
    setMcpForm({
      id: '',
      name: '',
      type: 'stdio',
      command: '',
      args: [],
      newArg: '',
      url: '',
      env: {},
      newEnvKey: '',
      newEnvValue: '',
      headers: {},
      newHeaderKey: '',
      newHeaderValue: '',
      oauthClientId: '',
      oauthClientSecret: '',
      oauthScopes: '',
      oauthCallbackPort: '',
      oauthAuthUrl: '',
      oauthTokenUrl: '',
    });
    setMcpHeadersExpanded(false);
    setMcpOAuthExpanded(false);
  };

  // Edit builtin MCP server settings (extra args + env)
  const handleEditBuiltinMcp = async (server: McpServerDefinition) => {
    if (!hasUserEditableMcpSettings(server.id)) return;

    // Edge TTS: open custom config dialog
    if (server.id === 'edge-tts') {
      const savedEnv = await getMcpServerEnv(server.id);
      const parseRate = (s?: string) =>
        parseInt((s || '0%').replace('%', ''), 10) || 0;
      const parsePitch = (s?: string) =>
        parseInt((s || '+0Hz').replace('Hz', '').replace('+', ''), 10) || 0;
      setEdgeTtsSettings({
        defaultVoice:
          savedEnv?.EDGE_TTS_DEFAULT_VOICE || 'zh-CN-XiaoxiaoNeural',
        defaultRate: parseRate(savedEnv?.EDGE_TTS_DEFAULT_RATE),
        defaultVolume: parseRate(savedEnv?.EDGE_TTS_DEFAULT_VOLUME),
        defaultPitch: parsePitch(savedEnv?.EDGE_TTS_DEFAULT_PITCH),
        defaultOutputFormat:
          savedEnv?.EDGE_TTS_DEFAULT_FORMAT ||
          'audio-24khz-48kbitrate-mono-mp3',
      });
      stopTtsPreview();
      return;
    }

    // Gemini Image: open custom config dialog
    if (server.id === 'gemini-image') {
      const savedEnv = await getMcpServerEnv(server.id);
      setGeminiImageSettings({
        apiKey: savedEnv?.GEMINI_API_KEY || '',
        baseUrl: savedEnv?.GEMINI_BASE_URL || '',
        model: savedEnv?.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image',
        aspectRatio: savedEnv?.GEMINI_DEFAULT_ASPECT_RATIO || 'auto',
        imageSize: savedEnv?.GEMINI_DEFAULT_IMAGE_SIZE || 'auto',
        thinkingLevel: savedEnv?.GEMINI_THINKING_LEVEL || 'auto',
        searchGrounding: savedEnv?.GEMINI_SEARCH_GROUNDING === 'true',
        maxContextTurns: parseInt(savedEnv?.MAX_CONTEXT_TURNS || '20', 10),
      });
      return;
    }

    // Playwright: open custom config dialog
    if (server.id === 'playwright') {
      const savedArgs = await getMcpServerArgs(server.id);
      const profile = splitStandardPlaywrightProfileArgs(savedArgs);
      let headless = false;
      let browser = '';
      let device = '';
      let customDevice = '';
      const extraArgs: string[] = [];

      for (const arg of profile.remainingArgs) {
        if (arg === '--headless') {
          headless = true;
        } else if (arg.startsWith('--browser=')) {
          browser = arg.slice('--browser='.length);
        } else if (arg.startsWith('--device=')) {
          const value = arg.slice('--device='.length);
          if (PLAYWRIGHT_DEVICE_PRESETS.includes(value)) {
            device = value;
          } else {
            device = '__custom__';
            customDevice = value;
          }
        } else {
          extraArgs.push(arg);
        }
      }

      setPlaywrightSettings({
        mode: profile.mode,
        headless,
        browser,
        device,
        customDevice,
        userDataDir: profile.userDataDir,
        extraArgs,
        newArg: '',
      });
      return;
    }

    const savedArgs = await getMcpServerArgs(server.id);
    const savedEnv = await getMcpServerEnv(server.id);

    const extraArgs = savedArgs ?? [];

    // Pre-populate required config fields so they show in the dialog
    const env: Record<string, string> = { ...savedEnv };
    for (const key of server.requiresConfig ?? []) {
      if (!(key in env)) env[key] = '';
    }

    setBuiltinMcpSettings({
      server,
      extraArgs,
      newArg: '',
      env,
      newEnvKey: '',
      newEnvValue: '',
    });
  };

  const handleSaveBuiltinMcp = async () => {
    if (!builtinMcpSettings) return;
    const { server, extraArgs, env } = builtinMcpSettings;
    try {
      await atomicModifyConfig((config) => ({
        ...config,
        mcpServerArgs: {
          ...(config.mcpServerArgs ?? {}),
          [server.id]: extraArgs,
        },
        mcpServerEnv: { ...(config.mcpServerEnv ?? {}), [server.id]: env },
      }));
      const servers = await getAllMcpServers();
      setMcpServersState(servers);
      setBuiltinMcpSettings(null);
      toast.success(tSettings('toolbox.toasts.saveSuccess'));
    } catch {
      toast.error(tSettings('toolbox.toasts.saveFailed'));
    }
  };

  const handleSaveGeminiImage = async () => {
    if (!geminiImageSettings) return;
    try {
      const env: Record<string, string> = {
        GEMINI_API_KEY: geminiImageSettings.apiKey,
        GEMINI_BASE_URL: geminiImageSettings.baseUrl,
        GEMINI_IMAGE_MODEL: geminiImageSettings.model,
        GEMINI_DEFAULT_ASPECT_RATIO: geminiImageSettings.aspectRatio,
        GEMINI_DEFAULT_IMAGE_SIZE: geminiImageSettings.imageSize,
        GEMINI_THINKING_LEVEL: geminiImageSettings.thinkingLevel,
        GEMINI_SEARCH_GROUNDING: geminiImageSettings.searchGrounding
          ? 'true'
          : 'false',
        MAX_CONTEXT_TURNS: String(geminiImageSettings.maxContextTurns),
      };
      await atomicModifyConfig((config) => ({
        ...config,
        mcpServerEnv: { ...(config.mcpServerEnv ?? {}), 'gemini-image': env },
      }));
      const servers = await getAllMcpServers();
      setMcpServersState(servers);
      await checkMcpConfigStatus(servers);
      setGeminiImageSettings(null);
      toast.success(tSettings('toolbox.toasts.geminiImageSaved'));
    } catch {
      toast.error(tSettings('toolbox.toasts.saveFailed'));
    }
  };

  const appendPlaywrightAdvancedInput = () => {
    setPlaywrightSettings((prev) => {
      if (!prev) return null;
      const arg = prev.newArg.trim();
      if (!arg) return prev;
      return {
        ...prev,
        extraArgs: [...prev.extraArgs, arg],
        newArg: '',
      };
    });
  };

  const handleSavePlaywright = async () => {
    if (!playwrightSettings) return;
    try {
      const args: string[] = [];
      if (playwrightSettings.mode === 'persistent') {
        let userDataDir = playwrightSettings.userDataDir.trim();
        if (userDataDir.startsWith('~/') || userDataDir === '~') {
          const home = await homeDir();
          userDataDir =
            userDataDir === '~' ? home : await join(home, userDataDir.slice(2));
        }
        args.push(
          ...standardPlaywrightProfileArgs(
            playwrightSettings.mode,
            userDataDir,
          ),
        );
      } else {
        args.push(
          ...standardPlaywrightProfileArgs(playwrightSettings.mode, ''),
        );
      }
      if (playwrightSettings.headless) args.push('--headless');
      if (playwrightSettings.browser)
        args.push(`--browser=${playwrightSettings.browser}`);
      const device =
        playwrightSettings.device === '__custom__'
          ? playwrightSettings.customDevice.trim()
          : playwrightSettings.device;
      if (device) args.push(`--device=${device}`);
      args.push(...playwrightSettings.extraArgs);

      await saveMcpServerArgs('playwright', args);
      const servers = await getAllMcpServers();
      setMcpServersState(servers);
      setPlaywrightSettings(null);
      toast.success(tSettings('toolbox.toasts.playwrightSaved'));
    } catch {
      toast.error(tSettings('toolbox.toasts.saveFailed'));
    }
  };

  const fmtTtsRate = (v: number) => (v >= 0 ? `+${v}%` : `${v}%`);
  const fmtTtsPitch = (v: number) => (v >= 0 ? `+${v}Hz` : `${v}Hz`);

  const handleSaveEdgeTts = async () => {
    if (!edgeTtsSettings) return;
    try {
      const env: Record<string, string> = {
        EDGE_TTS_DEFAULT_VOICE: edgeTtsSettings.defaultVoice,
        EDGE_TTS_DEFAULT_RATE: fmtTtsRate(edgeTtsSettings.defaultRate),
        EDGE_TTS_DEFAULT_VOLUME: fmtTtsRate(edgeTtsSettings.defaultVolume),
        EDGE_TTS_DEFAULT_PITCH: fmtTtsPitch(edgeTtsSettings.defaultPitch),
        EDGE_TTS_DEFAULT_FORMAT: edgeTtsSettings.defaultOutputFormat,
      };
      await atomicModifyConfig((config) => ({
        ...config,
        mcpServerEnv: { ...(config.mcpServerEnv ?? {}), 'edge-tts': env },
      }));
      const servers = await getAllMcpServers();
      setMcpServersState(servers);
      await checkMcpConfigStatus(servers);
      setEdgeTtsSettings(null);
      toast.success(tSettings('toolbox.toasts.edgeTtsSaved'));
    } catch {
      toast.error(tSettings('toolbox.toasts.saveFailed'));
    }
  };

  const handlePreviewTts = () => toggleTtsPreview(ttsPreviewText);

  // OAuth: probe MCP server for OAuth requirements (returns probe result for chaining)
  const handleMcpOAuthProbe = async (
    serverId: string,
    mcpUrl: string,
  ): Promise<{ supportsDynamicRegistration?: boolean } | null> => {
    if (!mcpUrl) return null;
    try {
      const result = await apiPostJson<{
        success: boolean;
        required?: boolean;
        supportsDynamicRegistration?: boolean;
        scopes?: string[];
      }>('/api/mcp/oauth/discover', {
        serverId,
        mcpUrl,
      });
      if (result.success && result.required) {
        setMcpOAuthProbe((prev) => ({
          ...prev,
          [serverId]: {
            required: true,
            supportsDynamicRegistration: result.supportsDynamicRegistration,
            scopes: result.scopes,
          },
        }));
        return {
          supportsDynamicRegistration: result.supportsDynamicRegistration,
        };
      }
      setMcpOAuthProbe((prev) => ({
        ...prev,
        [serverId]: { required: false },
      }));
      return null;
    } catch {
      return null;
    }
  };

  // OAuth: start OAuth flow (auto mode = no clientId, manual mode = with clientId)
  const handleMcpOAuthConnect = async (
    serverId: string,
    serverUrl: string,
    manual?: boolean,
  ) => {
    if (manual && !mcpForm.oauthClientId) {
      toast.error(tSettingsRef.current('toolbox.toasts.oauthClientIdRequired'));
      return;
    }
    setMcpOAuthConnecting(serverId);
    try {
      const payload: Record<string, unknown> = {
        serverId,
        serverUrl: serverUrl || mcpForm.url,
      };
      // Manual mode: include user-provided credentials
      if (manual && mcpForm.oauthClientId) {
        payload.clientId = mcpForm.oauthClientId;
        payload.clientSecret = mcpForm.oauthClientSecret || undefined;
        payload.scopes = mcpForm.oauthScopes
          ? mcpForm.oauthScopes.split(/[\s,]+/).filter(Boolean)
          : undefined;
        payload.callbackPort = mcpForm.oauthCallbackPort
          ? parseInt(mcpForm.oauthCallbackPort, 10)
          : undefined;
        payload.authorizationUrl = mcpForm.oauthAuthUrl || undefined;
        payload.tokenUrl = mcpForm.oauthTokenUrl || undefined;
      }

      const result = await apiPostJson<{
        success: boolean;
        authUrl?: string;
        error?: string;
      }>('/api/mcp/oauth/start', payload);
      if (result.success && result.authUrl) {
        const { openExternal } = await import('@/utils/openExternal');
        await openExternal(result.authUrl);
        toast.success(tSettingsRef.current('toolbox.toasts.oauthOpened'));
        setMcpOAuthStatus((prev) => ({ ...prev, [serverId]: 'connecting' }));
        // Clean up any previous poll
        if (oauthPollIntervalRef.current)
          clearInterval(oauthPollIntervalRef.current);
        if (oauthPollTimeoutRef.current)
          clearTimeout(oauthPollTimeoutRef.current);
        // Poll for token status (refs ensure cleanup on unmount)
        const pollInterval = setInterval(async () => {
          try {
            const status = await apiGetJson<{
              success: boolean;
              status: string;
            }>(`/api/mcp/oauth/status/${encodeURIComponent(serverId)}`);
            if (status.success && status.status === 'connected') {
              clearInterval(pollInterval);
              oauthPollIntervalRef.current = null;
              setMcpOAuthStatus((prev) => ({
                ...prev,
                [serverId]: 'connected',
              }));
              setMcpOAuthConnecting(null);
              toast.success(
                tSettingsRef.current('toolbox.toasts.oauthSuccess'),
              );
            } else if (status.success && status.status === 'disconnected') {
              setMcpOAuthConnecting((prev) => {
                if (prev === serverId) {
                  clearInterval(pollInterval);
                  oauthPollIntervalRef.current = null;
                  setMcpOAuthStatus((p) => ({
                    ...p,
                    [serverId]: 'disconnected',
                  }));
                  return null;
                }
                return prev;
              });
            }
          } catch {
            /* ignore poll errors */
          }
        }, 2000);
        oauthPollIntervalRef.current = pollInterval;
        oauthPollTimeoutRef.current = setTimeout(
          () => {
            clearInterval(pollInterval);
            oauthPollIntervalRef.current = null;
            oauthPollTimeoutRef.current = null;
            setMcpOAuthConnecting(null);
          },
          5 * 60 * 1000,
        );
      } else {
        toast.error(
          result.error ||
            tSettingsRef.current('toolbox.toasts.oauthStartFailed'),
        );
        setMcpOAuthConnecting(null);
      }
    } catch (err) {
      toast.error(
        tSettingsRef.current('toolbox.toasts.oauthError', {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      setMcpOAuthConnecting(null);
    }
  };

  // OAuth: disconnect (revoke token)
  const handleMcpOAuthDisconnect = async (serverId: string) => {
    try {
      const response = await apiFetch('/api/mcp/oauth/token', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      setMcpOAuthStatus((prev) => ({ ...prev, [serverId]: 'disconnected' }));
      toast.success(tSettingsRef.current('toolbox.toasts.oauthDisconnected'));
    } catch {
      toast.error(tSettingsRef.current('toolbox.toasts.oauthDisconnectFailed'));
    }
  };

  // Edit custom MCP server - populate form and open modal
  const handleEditMcp = (server: McpServerDefinition) => {
    setMcpForm({
      id: server.id,
      name: server.name,
      type: server.type || 'stdio',
      command: server.command || '',
      args: server.args || [],
      newArg: '',
      url: server.url || '',
      env: server.env ? { ...server.env } : {},
      newEnvKey: '',
      newEnvValue: '',
      headers: server.headers ? { ...server.headers } : {},
      newHeaderKey: '',
      newHeaderValue: '',
      oauthClientId: '',
      oauthClientSecret: '',
      oauthScopes: '',
      oauthCallbackPort: '',
      oauthAuthUrl: '',
      oauthTokenUrl: '',
    });
    // Auto-expand sections if they have existing data
    const hasHeaders = server.headers && Object.keys(server.headers).length > 0;
    setMcpHeadersExpanded(!!hasHeaders);
    setMcpOAuthExpanded(false);
    // Fetch OAuth status for this server
    if (server.type === 'sse' || server.type === 'http') {
      apiGetJson<{ success: boolean; status: string }>(
        `/api/mcp/oauth/status/${encodeURIComponent(server.id)}`,
      )
        .then((res) => {
          if (res.success) {
            setMcpOAuthStatus((prev) => ({
              ...prev,
              [server.id]: res.status as
                | 'connected'
                | 'disconnected'
                | 'expired',
            }));
            // Auto-expand OAuth section if connected/expired
            if (res.status === 'connected' || res.status === 'expired') {
              setMcpOAuthExpanded(true);
            }
          }
        })
        .catch(() => {
          /* ignore */
        });
    }
    setEditingMcpId(server.id);
    setShowMcpForm(true);
  };

  // Auto-open MCP config dialog when initialMcpId is provided (from Chat tool popup)
  useEffect(() => {
    if (!initialMcpId || mcpServers.length === 0) return;
    const server = mcpServers.find((s) => s.id === initialMcpId);
    if (server) {
      if (server.isBuiltin) {
        void handleEditBuiltinMcp(server);
      } else {
        handleEditMcp(server);
      }
    }
    // Clear parent state so the same ID can be dispatched again
    notifySectionChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only triggers on initialMcpId change
  }, [initialMcpId, mcpServers]);

  useEffect(() => {
    if (!initialOfficialToolId) return;
    const tool = OFFICIAL_TOOLS.find(
      (item) => item.id === initialOfficialToolId,
    );
    if (tool) openOfficialToolSettings(tool);
    notifySectionChange();
  }, [initialOfficialToolId, openOfficialToolSettings, notifySectionChange]);

  // Add custom MCP server - auto-install after adding
  const handleAddMcp = async () => {
    // Validate based on transport type
    if (!mcpForm.id || !mcpForm.name) return;
    if (mcpForm.type === 'stdio' && !mcpForm.command) return;
    if ((mcpForm.type === 'http' || mcpForm.type === 'sse') && !mcpForm.url)
      return;

    const newServer: McpServerDefinition = {
      id: mcpForm.id,
      name: mcpForm.name,
      type: mcpForm.type,
      isBuiltin: false,
      // stdio fields
      ...(mcpForm.type === 'stdio' && {
        command: mcpForm.command,
        args: mcpForm.args.length > 0 ? mcpForm.args : undefined,
        env: Object.keys(mcpForm.env).length > 0 ? mcpForm.env : undefined,
      }),
      // http/sse fields
      ...((mcpForm.type === 'http' || mcpForm.type === 'sse') && {
        url: mcpForm.url,
        headers:
          Object.keys(mcpForm.headers).length > 0 ? mcpForm.headers : undefined,
      }),
    };
    try {
      await addCustomMcpServer(newServer);
      if (editingMcpId) {
        setMcpServersState((prev) =>
          prev.map((s) => (s.id === editingMcpId ? newServer : s)),
        );
      } else {
        setMcpServersState((prev) => [...prev, newServer]);
      }
      resetMcpForm();
      setShowMcpForm(false);

      // Track mcp_add event
      if (!editingMcpId) track('mcp_add', { type: mcpForm.type });

      toast.success(
        tSettingsRef.current(
          editingMcpId
            ? 'toolbox.toasts.mcpServerSaved'
            : 'toolbox.toasts.mcpServerAdded',
        ),
      );

      // Auto-probe OAuth for HTTP/SSE servers after adding/saving
      if ((mcpForm.type === 'http' || mcpForm.type === 'sse') && mcpForm.url) {
        const savedId = newServer.id;
        const savedUrl = mcpForm.url;
        // Run in background — don't block form close
        handleMcpOAuthProbe(savedId, savedUrl)
          .then((probe) => {
            if (!probe) return; // Server doesn't require OAuth
            if (probe.supportsDynamicRegistration !== false) {
              // Auto-mode supported — start OAuth flow automatically
              handleMcpOAuthConnect(savedId, savedUrl);
            } else {
              // Manual config needed — inform user
              toast.info(
                tSettingsRef.current('toolbox.toasts.mcpOAuthRequired'),
              );
            }
          })
          .catch(() => {
            /* probe failed — server may not need OAuth */
          });
      }
    } catch {
      toast.error(
        tSettingsRef.current(
          editingMcpId
            ? 'toolbox.toasts.mcpSaveFailed'
            : 'toolbox.toasts.mcpAddFailed',
        ),
      );
    }
  };

  // Add MCP servers from JSON (batch import)
  const handleAddMcpFromJson = async () => {
    setMcpJsonError(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(mcpJsonInput);
    } catch {
      setMcpJsonError({ key: 'toolbox.dialogs.customMcp.jsonInvalid' });
      return;
    }

    // Support { mcpServers: { ... } } or direct { serverName: { ... } }
    const serversObj = (parsed.mcpServers ?? parsed) as Record<string, unknown>;

    const entries = Object.entries(serversObj).filter(
      ([, v]) => v && typeof v === 'object' && !Array.isArray(v),
    );
    if (entries.length === 0) {
      setMcpJsonError({ key: 'toolbox.dialogs.customMcp.jsonNoValidServers' });
      return;
    }

    const added: string[] = [];
    const skipped: string[] = [];
    const existingIds = new Set(mcpServers.map((s) => s.id));

    for (const [name, rawConfig] of entries) {
      const config = rawConfig as Record<string, unknown>;
      const id = name.toLowerCase().replace(/\s+/g, '-');

      if (existingIds.has(id)) {
        skipped.push(id);
        continue;
      }

      const hasCommand = typeof config.command === 'string';
      const hasUrl = typeof config.url === 'string';
      let type: McpServerType = 'stdio';
      if (!hasCommand && hasUrl) {
        type =
          config.transportType === 'sse' || config.type === 'sse'
            ? 'sse'
            : 'http';
      }

      const newServer: McpServerDefinition = {
        id,
        name,
        type,
        isBuiltin: false,
        ...(type === 'stdio' && {
          command: config.command as string,
          args: Array.isArray(config.args)
            ? (config.args as string[])
            : undefined,
          env:
            config.env && typeof config.env === 'object'
              ? (config.env as Record<string, string>)
              : undefined,
        }),
        ...((type === 'http' || type === 'sse') && {
          url: config.url as string,
          headers:
            config.headers && typeof config.headers === 'object'
              ? (config.headers as Record<string, string>)
              : undefined,
        }),
      };

      try {
        await addCustomMcpServer(newServer);
        added.push(id);
        existingIds.add(id);
      } catch {
        // Single failure doesn't block the rest
      }
    }

    if (added.length > 0) {
      const servers = await getAllMcpServers();
      setMcpServersState(servers);
      track('mcp_add', { type: 'json_import', count: added.length });
    }

    if (added.length > 0 && skipped.length === 0) {
      toast.success(
        tSettingsRef.current('toolbox.toasts.mcpJsonAdded', {
          count: added.length,
        }),
      );
      resetMcpForm();
      setShowMcpForm(false);
    } else if (added.length > 0 && skipped.length > 0) {
      toast.success(
        tSettingsRef.current('toolbox.toasts.mcpJsonAddedSkipped', {
          added: added.length,
          skipped: skipped.length,
          names: skipped.join(', '),
        }),
      );
      resetMcpForm();
      setShowMcpForm(false);
    } else if (skipped.length > 0) {
      setMcpJsonError({
        key: 'toolbox.dialogs.customMcp.jsonAllExist',
        params: { names: skipped.join(', ') },
      });
    }
  };

  // Delete custom MCP server
  const handleDeleteMcp = async (serverId: string) => {
    try {
      await deleteCustomMcpServer(serverId);
      await refreshConfig();
      setMcpServersState((prev) => prev.filter((s) => s.id !== serverId));
      setMcpEnabledIds((prev) => prev.filter((id) => id !== serverId));

      // Track mcp_remove event
      track('mcp_remove');

      toast.success(tSettingsRef.current('toolbox.toasts.deleteSuccess'));
    } catch {
      toast.error(tSettingsRef.current('toolbox.toasts.deleteFailed'));
    }
  };

  // Use refs to avoid useEffect dependency issues (P1 fix)
  const providerVerifyStatusRef = useRef(providerVerifyStatus);
  providerVerifyStatusRef.current = providerVerifyStatus;
  const saveProviderVerifyStatusRef = useRef(saveProviderVerifyStatus);
  saveProviderVerifyStatusRef.current = saveProviderVerifyStatus;

  // Check subscription status on mount (with retry for sidecar startup)
  // Uses cached verification result if valid and not expired (30 days)
  useEffect(() => {
    if (mode !== 'settings') return;
    let isMounted = true;
    let retryCount = 0;
    const maxRetries = 3;
    const retryDelay = 1500; // 1.5s between retries

    const verifySubscriptionCredentials = async (
      status: SubscriptionStatus,
      forceVerify = false,
    ) => {
      // Issue #203: `info` may be empty when the user just ran `claude auth login`
      // (Keychain has the token but ~/.claude.json::oauthAccount hasn't been seeded
      // yet). Gate solely on `available`; missing email falls back to undefined and
      // bypasses the cache (which keys by email).
      if (!status.available) {
        return;
      }

      const currentEmail = status.info?.email;
      const cached = providerVerifyStatusRef.current[SUBSCRIPTION_PROVIDER_ID];

      if (
        !forceVerify &&
        shouldUseCachedValidSubscriptionVerify(status, cached)
      ) {
        console.log(
          '[Settings] Using cached subscription verification (valid)',
        );
        if (isMounted) {
          setSubscriptionStatus((prev: SubscriptionStatus | null) =>
            prev
              ? {
                  ...prev,
                  verifyStatus: 'valid',
                  verifyError: undefined,
                }
              : prev,
          );
        }
        return;
      }

      if (!forceVerify && cached?.verifiedAt) {
        if (isVerifyExpired(cached.verifiedAt)) {
          console.log(
            '[Settings] Subscription verification expired, re-verifying...',
          );
        } else if (cached.accountEmail !== currentEmail) {
          console.log(
            '[Settings] Subscription account changed, re-verifying...',
          );
        } else if (cached.status === 'invalid') {
          console.log(
            '[Settings] Previous transient subscription verification failed, retrying...',
          );
        }
      }

      // Set loading state
      if (isMounted) {
        setSubscriptionStatus((prev: SubscriptionStatus | null) =>
          prev ? { ...prev, verifyStatus: 'loading' } : prev,
        );
      }

      try {
        const result = await apiPostJson<SubscriptionVerifyResult>(
          '/api/subscription/verify',
          {},
        );
        const newStatus = result.success ? 'valid' : 'invalid';

        if (result.success) {
          await saveProviderVerifyStatusRef.current(
            SUBSCRIPTION_PROVIDER_ID,
            'valid',
            currentEmail,
          );
        }

        if (isMounted) {
          setSubscriptionStatus((prev: SubscriptionStatus | null) =>
            prev
              ? {
                  ...prev,
                  verifyStatus: newStatus,
                  verifyError: result.success
                    ? undefined
                    : formatSubscriptionVerifyError(
                        result,
                        tSettingsRef.current('providers.verify.failed'),
                      ),
                }
              : prev,
          );
        }
      } catch (err) {
        console.error('[Settings] Subscription verify failed:', err);
        // Failed subscription verifies are intentionally not cached; the next view or retry
        // should ask the SDK again because local OAuth state may have changed out of band.

        if (isMounted) {
          setSubscriptionStatus((prev: SubscriptionStatus | null) =>
            prev
              ? {
                  ...prev,
                  verifyStatus: 'invalid',
                  verifyError:
                    err instanceof Error
                      ? err.message
                      : tSettingsRef.current('providers.verify.failed'),
                }
              : prev,
          );
        }
      }
    };

    const checkSubscription = () => {
      apiGetJson<SubscriptionStatus>('/api/subscription/status')
        .then((status) => {
          if (!isMounted) return;
          setSubscriptionStatus({ ...status, verifyStatus: 'idle' });
          // Issue #203: trigger verify whenever credentials are present, even
          // if account metadata (`info`) hasn't been seeded yet.
          if (status.available) {
            verifySubscriptionCredentials(status);
          }
        })
        .catch((err) => {
          if (!isMounted) return;
          // Retry if sidecar not ready
          if (retryCount < maxRetries && err.message?.includes('sidecar')) {
            retryCount++;
            console.log(
              `[Settings] Subscription check retry ${retryCount}/${maxRetries}...`,
            );
            setTimeout(checkSubscription, retryDelay);
          } else {
            console.error('[Settings] Failed to check subscription:', err);
            setSubscriptionStatus({ available: false });
          }
        });
    };

    // Initial delay to let sidecar start
    const timer = setTimeout(checkSubscription, 500);
    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, [mode]); // Only the Settings Tab owns provider verification; refs handle latest values

  // Force re-verify subscription (called from UI button)
  const handleReVerifySubscription = useCallback(async () => {
    if (!subscriptionStatus?.available) {
      return;
    }

    const currentEmail = subscriptionStatus.info?.email;
    setSubscriptionVerifying(true);
    setSubscriptionStatus((prev) =>
      prev
        ? { ...prev, verifyStatus: 'loading', verifyError: undefined }
        : prev,
    );

    try {
      console.log('[Settings] Force re-verifying subscription...');
      const result = await apiPostJson<SubscriptionVerifyResult>(
        '/api/subscription/verify',
        {},
      );
      const newStatus = result.success ? 'valid' : 'invalid';

      if (result.success) {
        await saveProviderVerifyStatus(
          SUBSCRIPTION_PROVIDER_ID,
          'valid',
          currentEmail,
        );
        toast.success(tSettings('providers.verify.success'));
      } else {
        toast.error(
          formatSubscriptionVerifyError(
            result,
            tSettings('providers.verify.failed'),
          ),
        );
      }

      setSubscriptionStatus((prev) =>
        prev
          ? {
              ...prev,
              verifyStatus: newStatus,
              verifyError: result.success
                ? undefined
                : formatSubscriptionVerifyError(
                    result,
                    tSettings('providers.verify.failed'),
                  ),
            }
          : prev,
      );
    } catch (err) {
      console.error('[Settings] Subscription re-verify failed:', err);
      // Failed subscription verifies are intentionally not cached; retry should ask the SDK again.

      setSubscriptionStatus((prev) =>
        prev
          ? {
              ...prev,
              verifyStatus: 'invalid',
              verifyError:
                err instanceof Error
                  ? err.message
                  : tSettings('providers.verify.failed'),
            }
          : prev,
      );
      toast.error(tSettings('providers.verify.failed'));
    } finally {
      setSubscriptionVerifying(false);
    }
  }, [subscriptionStatus, saveProviderVerifyStatus, tSettings, toast]);

  const refreshSubscriptionStatusAfterLogin =
    useCallback(async (): Promise<SubscriptionRefreshResult> => {
      try {
        const status = await apiGetJson<SubscriptionStatus>(
          '/api/subscription/status',
        );
        setSubscriptionStatus({ ...status, verifyStatus: 'idle' });
        if (!status.available) {
          const error = tSettings('providers.verify.failed');
          setSubscriptionStatus({
            ...status,
            verifyStatus: 'invalid',
            verifyError: error,
          });
          return { success: false, error };
        }

        const currentEmail = status.info?.email;
        setSubscriptionVerifying(true);
        setSubscriptionStatus((prev) =>
          prev
            ? { ...prev, verifyStatus: 'loading', verifyError: undefined }
            : prev,
        );
        const result = await apiPostJson<SubscriptionVerifyResult>(
          '/api/subscription/verify',
          {},
        );
        const nextStatus = result.success ? 'valid' : 'invalid';
        if (result.success) {
          await saveProviderVerifyStatus(
            SUBSCRIPTION_PROVIDER_ID,
            'valid',
            currentEmail,
          );
        }
        const errorMsg = result.success
          ? undefined
          : formatSubscriptionVerifyError(
              result,
              tSettings('providers.verify.failed'),
            );
        setSubscriptionStatus((prev) =>
          prev
            ? {
                ...prev,
                verifyStatus: nextStatus,
                verifyError: errorMsg,
              }
            : prev,
        );
        return result.success
          ? { success: true }
          : {
              success: false,
              error: errorMsg ?? tSettings('providers.verify.failed'),
            };
      } catch (error) {
        console.warn(
          '[Settings] Failed to refresh subscription after login:',
          error,
        );
        const errorMsg =
          error instanceof Error
            ? error.message
            : tSettings('providers.verify.failed');
        setSubscriptionStatus((prev) =>
          prev
            ? {
                ...prev,
                verifyStatus: 'invalid',
                verifyError: errorMsg,
              }
            : prev,
        );
        return { success: false, error: errorMsg };
      } finally {
        setSubscriptionVerifying(false);
      }
    }, [saveProviderVerifyStatus, tSettings]);
  refreshSubscriptionStatusAfterLoginRef.current =
    refreshSubscriptionStatusAfterLogin;

  const handleSubscriptionLoginSucceeded = useCallback(async () => {
    if (subscriptionLoginSuccessHandledRef.current) return;
    subscriptionLoginSuccessHandledRef.current = true;
    setSubscriptionLoginState((prev) => ({
      ...prev,
      status: 'succeeded',
      error: null,
    }));
    toast.success(tSettings('providers.codexToast.claudeLoginSucceeded'));
  }, [tSettings, toast]);

  // Verify API key for a provider
  const verifyProvider = useCallback(
    async (provider: Provider, apiKey: string) => {
      if (!apiKey || !provider.config.baseUrl) {
        console.warn('[verifyProvider] Missing apiKey or baseUrl');
        return;
      }

      // Bump generation counter — any in-flight verify for this provider becomes stale.
      // Note: handleSaveApiKey ALSO bumps this counter on every keystroke (#306) so a verify
      // already in flight against an older key value will see current != gen and bail before
      // surfacing a toast. Both writers just want "older work becomes stale" — order doesn't matter.
      const gen = (verifyGenRef.current[provider.id] ?? 0) + 1;
      verifyGenRef.current[provider.id] = gen;

      console.log('[verifyProvider] ========================');
      console.log(
        '[verifyProvider] Provider:',
        provider.id,
        provider.name,
        `(gen=${gen})`,
      );
      console.log('[verifyProvider] baseUrl:', provider.config.baseUrl);
      console.log('[verifyProvider] model:', provider.primaryModel);
      console.log('[verifyProvider] apiKey:', apiKey.slice(0, 10) + '...');

      setVerifyLoading((prev) => ({ ...prev, [provider.id]: true }));
      setVerifyError((prev) => {
        const next = { ...prev };
        delete next[provider.id];
        return next;
      });

      try {
        const networkResult = await invoke<NetworkProbeResult>(
          'cmd_probe_provider_network',
          {
            url: provider.config.baseUrl,
            providerId: provider.id,
          },
        );

        // Stale check: if a newer verify was triggered while we were waiting, discard this result
        if (verifyGenRef.current[provider.id] !== gen) {
          console.log(
            `[verifyProvider] Discarding stale network result (gen=${gen}, current=${verifyGenRef.current[provider.id]})`,
          );
          return;
        }

        if (!networkResult.ok) {
          await saveProviderVerifyStatus(provider.id, 'invalid');
          const detailParts = [
            `stage=${networkResult.stage}`,
            `kind=${networkResult.kind}`,
            networkResult.detail,
          ].filter(Boolean);
          setVerifyError((prev) => ({
            ...prev,
            [provider.id]: {
              error: tSettings('providers.verify.networkError', {
                name: provider.name,
              }),
              detail:
                detailParts.length > 0 ? detailParts.join('; ') : undefined,
              action: 'proxy-settings',
            },
          }));
          toastRef.current.error(
            tSettings('providers.verify.networkToast', { name: provider.name }),
          );
          return;
        }

        const result = await apiPostJson<{
          success: boolean;
          error?: string;
          detail?: string;
          retryable?: boolean;
        }>('/api/provider/verify', {
          providerId: provider.id,
          baseUrl: provider.config.baseUrl,
          apiKey,
          model: provider.primaryModel,
          authType: provider.authType,
          apiProtocol: provider.apiProtocol,
          maxOutputTokens: provider.maxOutputTokens,
          maxOutputTokensParamName: provider.maxOutputTokensParamName,
          upstreamFormat: provider.upstreamFormat,
        });

        // Stale check: if a newer verify was triggered while we were waiting, discard this result
        if (verifyGenRef.current[provider.id] !== gen) {
          console.log(
            `[verifyProvider] Discarding stale result (gen=${gen}, current=${verifyGenRef.current[provider.id]})`,
          );
          return;
        }

        console.log(
          '[verifyProvider] Result:',
          JSON.stringify(result, null, 2),
        );
        console.log('[verifyProvider] ========================');

        if (result.success) {
          await saveProviderVerifyStatus(provider.id, 'valid');
        } else {
          if (shouldInvalidateProviderAfterVerification(result)) {
            await saveProviderVerifyStatus(provider.id, 'invalid');
          }
          const errorMsg = result.error || tSettings('providers.verify.failed');
          setVerifyError((prev) => ({
            ...prev,
            [provider.id]: { error: errorMsg, detail: result.detail },
          }));
          toastRef.current.error(`${provider.name}: ${errorMsg}`);
        }
      } catch (err) {
        // Stale check on error path too
        if (verifyGenRef.current[provider.id] !== gen) return;

        console.error('[verifyProvider] Exception:', err);
        await saveProviderVerifyStatus(provider.id, 'invalid');
        const errorMsg =
          err instanceof Error
            ? err.message
            : tSettings('providers.verify.failed');
        setVerifyError((prev) => ({
          ...prev,
          [provider.id]: { error: errorMsg },
        }));
        toastRef.current.error(`${provider.name}: ${errorMsg}`);
      } finally {
        // Only clear loading if this is still the latest generation
        if (verifyGenRef.current[provider.id] === gen) {
          setVerifyLoading((prev) => ({ ...prev, [provider.id]: false }));
        }
      }
    },
    [saveProviderVerifyStatus, tSettings],
  );

  // Auto-verify when API key changes (with debounce)
  const handleSaveApiKey = useCallback(
    async (provider: Provider, key: string) => {
      // Snapshot BEFORE the await — saveApiKey eventually swaps apiKeysRef.current
      // via ConfigProvider's state update. Reading afterwards races that swap.
      const prevKey = apiKeysRef.current[provider.id] ?? '';
      await saveApiKey(provider.id, key);

      // Clear previous timeout for this provider
      if (verifyTimeoutRef.current[provider.id]) {
        clearTimeout(verifyTimeoutRef.current[provider.id]);
      }

      // Clear stale error and popover immediately on any key change
      setVerifyError((prev) => {
        const next = { ...prev };
        delete next[provider.id];
        return next;
      });
      if (errorDetailOpenId === provider.id) setErrorDetailOpenId(null);

      // Bump the generation counter so any in-flight verify (still running
      // from a prior keystroke / paste) becomes stale and won't fire a toast
      // against the now-changed key. #306: users backspacing an expired key
      // were getting stacked "invalid" toasts as previous verify cycles
      // landed against intermediate prefixes.
      verifyGenRef.current[provider.id] =
        (verifyGenRef.current[provider.id] ?? 0) + 1;

      if (!shouldDebounceAutoVerify(prevKey, key)) {
        // User is shortening (backspace / cut) or the field is empty.
        // Skip auto-verify entirely — the user can paste / type forward to
        // trigger one. Avoids the #306 keystroke-per-verify cascade.
        return;
      }

      // Debounce verification for the grow-the-key case
      verifyTimeoutRef.current[provider.id] = setTimeout(() => {
        verifyProvider(provider, key);
      }, 500);
    },
    [saveApiKey, verifyProvider, errorDetailOpenId],
  );

  // Cleanup timeouts on unmount
  useEffect(() => {
    const timeouts = verifyTimeoutRef.current;
    return () => {
      Object.values(timeouts).forEach(clearTimeout);
    };
  }, []);

  const handleAddCustomProvider = async (): Promise<Provider | null> => {
    if (!customForm.name || !customForm.baseUrl) {
      return null;
    }
    if (customForm.models.length === 0) {
      toast.error(tSettings('providers.toast.addAtLeastOneModel'));
      return null;
    }
    const newProvider: Provider = {
      id: `custom-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      name: customForm.name,
      vendor: 'Custom', // 内部保留但不在 UI 显示
      cloudProvider: customForm.cloudProvider || '自定义',
      type: 'api',
      primaryModel: customForm.models[0] ?? '',
      isBuiltin: false,
      authType: customForm.authType,
      apiProtocol: customForm.apiProtocol === 'openai' ? 'openai' : undefined,
      ...(customForm.apiProtocol === 'openai' && customForm.maxOutputTokens
        ? { maxOutputTokens: parsePositiveInt(customForm.maxOutputTokens) }
        : {}),
      ...(customForm.apiProtocol === 'openai' &&
      customForm.maxOutputTokensParamName !== 'max_tokens'
        ? { maxOutputTokensParamName: customForm.maxOutputTokensParamName }
        : {}),
      ...(customForm.apiProtocol === 'openai' &&
      customForm.upstreamFormat !== 'chat_completions'
        ? { upstreamFormat: customForm.upstreamFormat }
        : {}),
      config: {
        baseUrl: customForm.baseUrl,
      },
      models: customForm.models.map((m) => ({
        model: m,
        modelName: m,
        modelSeries: 'custom',
      })),
    };

    try {
      // Save API key FIRST so that addCustomProvider's rebuildAndPersistAvailableProviders()
      // already sees the key and includes this provider in the available list.
      // This fixes the bug where entering API key during creation always failed verification:
      // the old flow saved the provider first (rebuild without key) then saved the key
      // (rebuild with key), but the debounced verification could fire between the two rebuilds.
      if (customForm.apiKey) {
        await saveApiKey(newProvider.id, customForm.apiKey);
      }
      // Persist provider to disk and refresh providers list
      await addCustomProvider(newProvider);
      // Set as default only when no valid default exists (avoid overriding user's existing choice)
      const currentDefault = config.defaultProviderId;
      const defaultStillExists =
        currentDefault && providers.some((p) => p.id === currentDefault);
      if (!defaultStillExists) {
        await updateConfig({ defaultProviderId: newProvider.id });
      }
      // Trigger verification directly (no debounce — unlike handleSaveApiKey which
      // debounces for keystroke input, creation is a one-shot operation)
      if (customForm.apiKey) {
        verifyProvider(newProvider, customForm.apiKey);
      }
      toast.success(tSettings('providers.toast.providerAdded'));
    } catch (error) {
      console.error('[Settings] Failed to add custom provider:', error);
      toast.error(tSettings('providers.toast.providerAddFailed'));
      return null;
    }

    setCustomForm(EMPTY_CUSTOM_FORM);
    setShowCustomForm(false);
    return newProvider;
  };

  // 确认删除自定义供应商
  const confirmDeleteCustomProvider = async () => {
    if (!deleteConfirmProvider) return;
    const providerId = deleteConfirmProvider.id;

    try {
      // 检查是否有项目正在使用该供应商，如果有则切换到其他供应商
      const affectedProjects = projects.filter(
        (p) => p.providerId === providerId,
      );
      if (affectedProjects.length > 0) {
        // 找到第一个可用的其他供应商
        const alternativeProvider = providers.find((p) => p.id !== providerId);
        if (alternativeProvider) {
          // 更新所有受影响的项目
          for (const project of affectedProjects) {
            await updateProject({
              ...project,
              providerId: alternativeProvider.id,
            });
          }
          console.log(
            `[Settings] Switched ${affectedProjects.length} project(s) to ${alternativeProvider.name}`,
          );
        }
      }

      // Delete from disk, remove API key, and refresh providers list
      await deleteCustomProviderService(providerId);
      toast.success(tSettings('providers.toast.providerDeleted'));
    } catch (error) {
      console.error('[Settings] Failed to delete custom provider:', error);
      toast.error(tSettings('providers.toast.providerDeleteFailed'));
    }
    setDeleteConfirmProvider(null);
    setEditingProvider(null);
  };

  // Open provider management panel
  const openProviderManage = (provider: Provider) => {
    if (provider.id === CODEX_SUBSCRIPTION_PROVIDER_ID) return;
    // For preset providers, we allow adding custom models
    // For custom providers, we can edit all fields
    const effectiveAliases = getEffectiveModelAliases(
      provider,
      config.providerModelAliases,
    );
    setEditingProvider({
      provider,
      customModels: [], // TODO: Load from persisted custom models if any
      removedModels: [], // 标记要删除的已保存模型
      newModelInput: '',
      editModelAliases: effectiveAliases
        ? { ...effectiveAliases }
        : { fable: '', sonnet: '', opus: '', haiku: '' },
      showAdvanced: false,
      // 为自定义供应商初始化编辑字段
      ...(provider.isBuiltin
        ? {}
        : {
            editName: provider.name,
            editCloudProvider: provider.cloudProvider,
            editApiProtocol: provider.apiProtocol ?? 'anthropic',
            editBaseUrl: provider.config.baseUrl || '',
            editAuthType:
              provider.authType === 'api_key' ? 'api_key' : 'auth_token',
            editMaxOutputTokens: provider.maxOutputTokens
              ? String(provider.maxOutputTokens)
              : '',
            editMaxOutputTokensParamName:
              provider.maxOutputTokensParamName ?? 'max_tokens',
            editUpstreamFormat: provider.upstreamFormat ?? 'chat_completions',
          }),
    });
  };

  // Save provider edits
  const saveProviderEdits = async () => {
    if (!editingProvider) return;
    const {
      provider,
      customModels,
      removedModels,
      editName,
      editCloudProvider,
      editApiProtocol,
      editBaseUrl,
      editAuthType,
      editModelAliases,
    } = editingProvider;

    // Save model aliases for preset providers (custom providers store aliases on the Provider object itself)
    if (
      provider.isBuiltin &&
      editModelAliases &&
      provider.id !== 'anthropic-sub' &&
      provider.id !== 'anthropic-api'
    ) {
      try {
        await saveProviderModelAliases(provider.id, editModelAliases);
      } catch (error) {
        console.error('[Settings] Failed to save model aliases:', error);
      }
    }

    if (provider.isBuiltin) {
      // For preset providers: save user-added custom models
      // 1. Get existing user-added models (from config.presetCustomModels)
      const existingCustomModels =
        config.presetCustomModels?.[provider.id] ?? [];
      // 2. Filter out removed models
      const remainingCustomModels = existingCustomModels.filter(
        (m) => !removedModels.includes(m.model),
      );
      // 3. Add newly added models
      const newCustomModels = customModels.map((m) => ({
        model: m,
        modelName: m,
        modelSeries: 'custom' as const,
      }));
      const finalCustomModels = [...remainingCustomModels, ...newCustomModels];
      // 4. Save
      try {
        await savePresetCustomModels(provider.id, finalCustomModels);
        if (customModels.length > 0 || removedModels.length > 0) {
          toast.success(tSettings('providers.toast.modelConfigUpdated'));
        }
      } catch (error) {
        console.error('[Settings] Failed to save preset custom models:', error);
        toast.error(tSettings('providers.toast.saveFailed'));
        return;
      }
    } else {
      // 验证必填字段
      if (!editName?.trim() || !editBaseUrl?.trim()) {
        toast.error(tSettings('providers.toast.nameAndBaseUrlRequired'));
        return;
      }
      // 验证 Base URL 格式
      const trimmedUrl = editBaseUrl.trim();
      if (
        !trimmedUrl.startsWith('http://') &&
        !trimmedUrl.startsWith('https://')
      ) {
        toast.error(tSettings('providers.toast.baseUrlProtocolRequired'));
        return;
      }
      // Filter out removed models from existing list, then add new custom models
      const remainingModels = provider.models.filter(
        (m) => !removedModels.includes(m.model),
      );
      // Validate: at least one model must remain
      if (remainingModels.length === 0 && customModels.length === 0) {
        toast.error(tSettings('providers.toast.atLeastOneModelRequired'));
        return;
      }
      const finalModels = [
        ...remainingModels,
        ...customModels.map((m) => ({
          model: m,
          modelName: m,
          modelSeries: 'custom' as const,
        })),
      ];
      // 若 primaryModel 已被删除，改用第一个可用模型
      const validPrimary = finalModels.some(
        (m) => m.model === provider.primaryModel,
      )
        ? provider.primaryModel
        : finalModels[0].model;
      // For custom providers, update the provider and persist to disk
      const updatedProvider: Provider = {
        ...provider,
        name: editName.trim(),
        cloudProvider: editCloudProvider?.trim() || '自定义',
        primaryModel: validPrimary,
        authType: editAuthType ?? provider.authType ?? 'auth_token',
        apiProtocol: editApiProtocol === 'openai' ? 'openai' : undefined,
        maxOutputTokens:
          editApiProtocol === 'openai' && editingProvider?.editMaxOutputTokens
            ? parsePositiveInt(editingProvider.editMaxOutputTokens)
            : undefined,
        maxOutputTokensParamName:
          editApiProtocol === 'openai' &&
          editingProvider?.editMaxOutputTokensParamName &&
          editingProvider.editMaxOutputTokensParamName !== 'max_tokens'
            ? editingProvider.editMaxOutputTokensParamName
            : undefined,
        upstreamFormat:
          editApiProtocol === 'openai' &&
          editingProvider?.editUpstreamFormat !== 'chat_completions'
            ? editingProvider?.editUpstreamFormat
            : undefined,
        modelAliases: editModelAliases
          ? (Object.fromEntries(
              Object.entries(editModelAliases).filter(([, v]) => v),
            ) as ModelAliases)
          : undefined,
        config: {
          ...provider.config,
          baseUrl: editBaseUrl.trim(),
        },
        models: finalModels,
      };
      try {
        await updateCustomProvider(updatedProvider);
        toast.success(tSettings('providers.toast.providerUpdated'));
      } catch (error) {
        console.error('[Settings] Failed to update custom provider:', error);
        toast.error(tSettings('providers.toast.providerUpdateFailed'));
      }
    }
    setEditingProvider(null);
  };

  // providers from useConfig includes both preset and custom providers
  const allProviders = providers;
  const managedCodexProviderGateEnabled =
    isManagedCodexProviderGateEnabled(config);
  const managedCodexReadiness = useMemo(
    () => getManagedCodexProviderReadiness(config),
    [config],
  );
  const visibleProviders = useMemo(
    () => providers.filter((provider) => provider.enabled !== false),
    [providers],
  );
  const proxyScopeProviderIds = useMemo(
    () => allProviders.map((provider) => provider.id),
    [allProviders],
  );
  const proxyScope = useMemo(
    () =>
      normalizeProxyScope(config.proxySettings?.scope, proxyScopeProviderIds),
    [config.proxySettings?.scope, proxyScopeProviderIds],
  );
  const proxyScopeSelectedProviders = useMemo(
    () =>
      proxyScope.mode === 'custom'
        ? allProviders.filter((provider) =>
            proxyScope.providerIds?.includes(provider.id),
          )
        : allProviders,
    [allProviders, proxyScope],
  );
  const proxyScopeSummary = useMemo(() => {
    const descriptor = describeProxyScopeSummary({
      enabled: config.proxySettings?.enabled === true,
      scope: proxyScope,
      selectedProviderNames: proxyScopeSelectedProviders.map(
        (provider) => provider.name,
      ),
    });
    const providerSummaryKey = descriptor.values?.providerSummaryKey;
    const providerSummary =
      typeof providerSummaryKey === 'string'
        ? tSettings(providerSummaryKey, descriptor.values)
        : undefined;
    return tSettings(descriptor.key, {
      ...descriptor.values,
      ...(providerSummary ? { providerSummary } : {}),
    });
  }, [
    config.proxySettings?.enabled,
    proxyScope,
    proxyScopeSelectedProviders,
    tSettings,
  ]);
  const proxyScopeDialogInitialGeneralRequests =
    proxyScope.mode === 'all' || proxyScope.generalRequests === true;
  const proxyScopeDialogInitialIds = useMemo(
    () =>
      proxyScope.mode === 'custom'
        ? (proxyScope.providerIds ?? [])
        : proxyScopeProviderIds,
    [proxyScope, proxyScopeProviderIds],
  );
  const saveProxyScope = useCallback(
    (selection: { generalRequests: boolean; providerIds: string[] }) => {
      const allowed = new Set(proxyScopeProviderIds);
      const cleaned = Array.from(
        new Set(
          selection.providerIds
            .map((id) => id.trim())
            .filter((id) => id && allowed.has(id)),
        ),
      );
      if (
        selection.generalRequests &&
        cleaned.length === proxyScopeProviderIds.length
      ) {
        patchProxySettings({ scope: { mode: 'all' } });
      } else {
        patchProxySettings({
          scope: {
            mode: 'custom',
            generalRequests: selection.generalRequests,
            providerIds: cleaned,
          },
        });
      }
      setShowProxyScopeDialog(false);
    },
    [patchProxySettings, proxyScopeProviderIds],
  );

  useEffect(() => {
    const rawScope = config.proxySettings?.scope;
    if (
      !rawScope ||
      rawScope.mode !== 'custom' ||
      proxyScopeProviderIds.length === 0
    )
      return;

    const normalized = normalizeProxyScope(rawScope, proxyScopeProviderIds);
    const rawIds = Array.isArray(rawScope.providerIds)
      ? rawScope.providerIds.map((id) => id.trim()).filter(Boolean)
      : [];
    const normalizedIds =
      normalized.mode === 'custom' ? (normalized.providerIds ?? []) : [];
    const hasRawGeneralRequests = Object.prototype.hasOwnProperty.call(
      rawScope,
      'generalRequests',
    );
    const normalizedGeneralRequests =
      normalized.mode === 'custom' ? normalized.generalRequests === true : true;
    const changed =
      normalized.mode !== rawScope.mode ||
      rawIds.length !== normalizedIds.length ||
      rawIds.some((id, index) => id !== normalizedIds[index]) ||
      (hasRawGeneralRequests &&
        rawScope.generalRequests !== normalizedGeneralRequests);

    if (changed) {
      void patchProxySettings({ scope: normalized });
    }
  }, [config.proxySettings?.scope, patchProxySettings, proxyScopeProviderIds]);

  const openProviderOrderDialog = useCallback(() => {
    setProviderOrderDraft(allProviders.map((provider) => provider.id));
    setDisabledProviderDraft(
      allProviders
        .filter((provider) => provider.enabled === false)
        .map((provider) => provider.id),
    );
    setShowProviderOrderDialog(true);
  }, [allProviders]);

  const refreshManagedCodexStatus = useCallback(async () => {
    if (!isTauriEnvironment()) return;
    if (managedCodexBusyRef.current === 'download') {
      await refreshConfig();
      return;
    }
    setManagedCodexBusy('status');
    try {
      await invoke('cmd_managed_codex_status');
      await refreshConfig();
    } catch (error) {
      console.warn('[Settings] Managed Codex status failed:', error);
    } finally {
      setManagedCodexBusy((prev) => (prev === 'status' ? null : prev));
    }
  }, [refreshConfig]);

  useEffect(() => {
    if (activeSection !== 'providers') return;
    if (!managedCodexProviderGateEnabled) return;
    void refreshManagedCodexStatus();
  }, [
    activeSection,
    managedCodexProviderGateEnabled,
    refreshManagedCodexStatus,
  ]);

  useEffect(() => {
    if (activeSection !== 'providers') return;
    if (!managedCodexProviderGateEnabled) return;
    const isDownloading =
      managedCodexBusy === 'download' ||
      config.managedCodexRuntimeInstall?.status === 'downloading';
    if (!isDownloading) return;
    const interval = window.setInterval(() => {
      void refreshConfig();
    }, 500);
    return () => window.clearInterval(interval);
  }, [
    activeSection,
    managedCodexProviderGateEnabled,
    config.managedCodexRuntimeInstall?.status,
    managedCodexBusy,
    refreshConfig,
  ]);

  const runManagedCodexDownload = useCallback(
    async (announceUpdate = false) => {
      if (!isTauriEnvironment()) {
        toast.error(tSettings('providers.codexToast.unsupportedManagement'));
        return;
      }
      if (managedCodexRuntimeUpdateInFlight) {
        if (announceUpdate) {
          toast.info(tSettings('providers.codexToast.runtimeUpdating'));
        }
        return;
      }
      const currentBusy = managedCodexBusyRef.current;
      if (currentBusy && currentBusy !== 'status') return;
      managedCodexBusyRef.current = 'download';
      setManagedCodexBusy('download');
      if (announceUpdate) {
        toast.info(tSettings('providers.codexToast.runtimeUpdating'));
      }
      try {
        await requestManagedCodexRuntimeUpdate();
        toast.success(tSettings('providers.codexToast.runtimeReady'));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast.error(
          tSettings('providers.codexToast.downloadFailed', { message }),
        );
      } finally {
        if (managedCodexBusyRef.current === 'download') {
          managedCodexBusyRef.current = null;
        }
        setManagedCodexBusy((prev) => (prev === 'download' ? null : prev));
      }
    },
    [
      managedCodexRuntimeUpdateInFlight,
      requestManagedCodexRuntimeUpdate,
      tSettings,
      toast,
    ],
  );

  const logoutManagedCodex = useCallback(async () => {
    if (!isTauriEnvironment()) {
      toast.error(tSettings('providers.codexToast.unsupportedManagement'));
      return;
    }
    if (
      managedCodexRuntimeUpdateInFlight ||
      managedCodexBusyRef.current !== null
    )
      return;
    managedCodexBusyRef.current = 'logout';
    setManagedCodexBusy('logout');
    try {
      await invoke('cmd_managed_codex_logout');
      await refreshConfig();
      toast.success(tSettings('providers.codexToast.loggedOut'));
    } catch (error) {
      await refreshConfig().catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      toast.error(tSettings('providers.codexToast.logoutFailed', { message }));
    } finally {
      if (managedCodexBusyRef.current === 'logout') {
        managedCodexBusyRef.current = null;
      }
      setManagedCodexBusy((prev) => (prev === 'logout' ? null : prev));
    }
  }, [managedCodexRuntimeUpdateInFlight, refreshConfig, tSettings, toast]);

  const checkManagedCodexUpdate = useCallback(async () => {
    if (!isTauriEnvironment()) {
      toast.error(tSettings('providers.codexToast.unsupportedManagement'));
      return;
    }
    if (
      managedCodexRuntimeUpdateInFlight ||
      managedCodexBusyRef.current === 'download'
    ) {
      toast.info(tSettings('providers.codexToast.runtimeUpdating'));
      return;
    }
    if (managedCodexBusyRef.current !== null) return;

    managedCodexBusyRef.current = 'status';
    setManagedCodexBusy('status');
    try {
      const status = await invoke<{
        runtimeInstall: ManagedCodexRuntimeInstallState;
      }>('cmd_managed_codex_check_update');
      await refreshConfig();
      const refreshAction = getManagedCodexUpdateRefreshAction(
        status.runtimeInstall,
      );
      if (refreshAction === 'no-update') {
        toast.info(tSettings('providers.codexToast.noRuntimeUpdate'));
        return;
      }
      if (refreshAction === 'already-updating') {
        toast.info(tSettings('providers.codexToast.runtimeUpdating'));
        return;
      }
      await runManagedCodexDownload(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(
        tSettings('providers.codexToast.updateCheckFailed', { message }),
      );
    } finally {
      if (managedCodexBusyRef.current === 'status') {
        managedCodexBusyRef.current = null;
      }
      setManagedCodexBusy((prev) => (prev === 'status' ? null : prev));
    }
  }, [
    managedCodexRuntimeUpdateInFlight,
    refreshConfig,
    runManagedCodexDownload,
    tSettings,
    toast,
  ]);

  const startManagedCodexLogin = useCallback(async () => {
    if (!isTauriEnvironment()) {
      toast.error(tSettings('providers.codexToast.unsupportedLogin'));
      return;
    }
    if (
      managedCodexRuntimeUpdateInFlight ||
      managedCodexBusyRef.current !== null
    )
      return;
    managedCodexBusyRef.current = 'login';
    setManagedCodexLoginDialogOpen(true);
    setManagedCodexBusy('login');
    try {
      const state = normalizeManagedCodexLoginState(
        await invoke('cmd_managed_codex_login_start'),
      );
      setManagedCodexLoginState(state);
      await refreshConfig();
      if (state.status === 'succeeded') {
        toast.success(tSettings('providers.codexToast.loginSucceeded'));
      }
    } catch (error) {
      await refreshConfig().catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      setManagedCodexLoginState({
        status: 'error',
        loginUrl: null,
        startedAt: null,
        error: message,
      });
      toast.error(tSettings('providers.codexToast.loginFailed', { message }));
    } finally {
      if (managedCodexBusyRef.current === 'login') {
        managedCodexBusyRef.current = null;
      }
      setManagedCodexBusy((prev) => (prev === 'login' ? null : prev));
    }
  }, [managedCodexRuntimeUpdateInFlight, refreshConfig, tSettings, toast]);

  const refreshManagedCodexLoginState = useCallback(async () => {
    if (!isTauriEnvironment()) return;
    try {
      const state = normalizeManagedCodexLoginState(
        await invoke('cmd_managed_codex_login_status'),
      );
      setManagedCodexLoginState(state);
      if (
        state.status === 'succeeded' ||
        state.status === 'cancelled' ||
        state.status === 'error'
      ) {
        await refreshConfig();
      }
    } catch (error) {
      console.warn('[Settings] Managed Codex login status failed:', error);
    }
  }, [refreshConfig]);

  useEffect(() => {
    if (!managedCodexLoginDialogOpen) return;
    if (!['starting', 'waiting'].includes(managedCodexLoginState.status))
      return;
    const interval = window.setInterval(() => {
      void refreshManagedCodexLoginState();
    }, 1000);
    return () => window.clearInterval(interval);
  }, [
    managedCodexLoginDialogOpen,
    managedCodexLoginState.status,
    refreshManagedCodexLoginState,
  ]);

  const copyManagedCodexLoginUrl = useCallback(async () => {
    const url = managedCodexLoginState.loginUrl;
    if (!url) return;
    try {
      await copyPlainText(url);
      toast.success(tSettings('providers.codexToast.urlCopied'));
    } catch (error) {
      console.warn('[Settings] Failed to copy Managed Codex login URL:', error);
      toast.error(tSettings('providers.codexToast.urlCopyFailed'));
    }
  }, [managedCodexLoginState.loginUrl, tSettings, toast]);

  const startSubscriptionLogin = useCallback(async () => {
    if (subscriptionLoginBusy) return;
    subscriptionLoginSuccessHandledRef.current = false;
    setSubscriptionLoginDialogOpen(true);
    setSubscriptionLoginCode('');
    setSubscriptionLoginBusy(true);
    setSubscriptionLoginState({
      ...EMPTY_SUBSCRIPTION_LOGIN_STATE,
      status: 'starting',
    });
    try {
      const state = normalizeSubscriptionLoginState(
        await apiPostJson('/api/subscription/login/start', {}),
      );
      setSubscriptionLoginState(state);
      const urlToOpen = state.automaticUrl ?? state.loginUrl ?? state.manualUrl;
      if (urlToOpen) {
        const { openExternal } = await import('@/utils/openExternal');
        await openExternal(urlToOpen);
      }
      if (state.status === 'succeeded') {
        await handleSubscriptionLoginSucceeded();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSubscriptionLoginState({
        status: 'error',
        loginUrl: null,
        manualUrl: null,
        automaticUrl: null,
        startedAt: null,
        error: message,
      });
      toast.error(
        tSettings('providers.codexToast.claudeLoginFailed', { message }),
      );
    } finally {
      setSubscriptionLoginBusy(false);
    }
  }, [
    handleSubscriptionLoginSucceeded,
    subscriptionLoginBusy,
    tSettings,
    toast,
  ]);

  const submitSubscriptionLoginCode = useCallback(async () => {
    const code = subscriptionLoginCode.trim();
    if (!code || subscriptionLoginSubmitting) return;
    setSubscriptionLoginSubmitting(true);
    try {
      const state = normalizeSubscriptionLoginState(
        await apiPostJson('/api/subscription/login/submit', {
          codeOrUrl: code,
        }),
      );
      setSubscriptionLoginState(state);
      if (!state.error) {
        setSubscriptionLoginCode('');
      }
      if (state.status === 'succeeded') {
        await handleSubscriptionLoginSucceeded();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSubscriptionLoginState((prev) => ({
        ...prev,
        error: message,
      }));
      toast.error(
        tSettings('providers.codexToast.claudeLoginFailed', { message }),
      );
    } finally {
      setSubscriptionLoginSubmitting(false);
    }
  }, [
    handleSubscriptionLoginSucceeded,
    subscriptionLoginCode,
    subscriptionLoginSubmitting,
    tSettings,
    toast,
  ]);

  const refreshSubscriptionLoginState = useCallback(async () => {
    try {
      const state = normalizeSubscriptionLoginState(
        await apiGetJson('/api/subscription/login/status'),
      );
      setSubscriptionLoginState(state);
      if (state.status === 'succeeded') {
        await handleSubscriptionLoginSucceeded();
      }
    } catch (error) {
      console.warn('[Settings] Subscription login status failed:', error);
    }
  }, [handleSubscriptionLoginSucceeded]);

  useEffect(() => {
    if (!subscriptionLoginDialogOpen) return;
    if (!['starting', 'waiting'].includes(subscriptionLoginState.status))
      return;
    const interval = window.setInterval(() => {
      void refreshSubscriptionLoginState();
    }, 1000);
    return () => window.clearInterval(interval);
  }, [
    refreshSubscriptionLoginState,
    subscriptionLoginDialogOpen,
    subscriptionLoginState.status,
  ]);

  const copySubscriptionLoginUrl = useCallback(async () => {
    const url =
      subscriptionLoginState.automaticUrl ??
      subscriptionLoginState.loginUrl ??
      subscriptionLoginState.manualUrl;
    if (!url) return;
    try {
      await copyPlainText(url);
      toast.success(tSettings('providers.codexToast.urlCopied'));
    } catch (error) {
      console.warn('[Settings] Failed to copy subscription login URL:', error);
      toast.error(tSettings('providers.codexToast.urlCopyFailed'));
    }
  }, [
    subscriptionLoginState.automaticUrl,
    subscriptionLoginState.loginUrl,
    subscriptionLoginState.manualUrl,
    tSettings,
    toast,
  ]);

  const saveProviderOrderSettings = useCallback(async () => {
    const providerIds = allProviders.map((provider) => provider.id);
    const nextOrder = normalizeProviderOrder(providerIds, providerOrderDraft);
    const nextDisabled = normalizeDisabledProviderIds(
      providerIds,
      disabledProviderDraft,
    );
    const updates: Partial<AppConfig> = {
      providerOrder: nextOrder,
      disabledProviderIds: nextDisabled.length > 0 ? nextDisabled : undefined,
    };
    if (
      config.defaultProviderId &&
      nextDisabled.includes(config.defaultProviderId)
    ) {
      updates.defaultProviderId = undefined;
    }

    try {
      await updateConfig(updates);
      await rebuildAndPersistAvailableProviders();
      setShowProviderOrderDialog(false);
      toast.success(tSettings('providers.toast.providerOrderSaved'));
    } catch (error) {
      console.error(
        '[Settings] Failed to save provider order settings:',
        error,
      );
      toast.error(tSettings('providers.toast.providerOrderSaveFailed'));
    }
  }, [
    allProviders,
    config.defaultProviderId,
    disabledProviderDraft,
    providerOrderDraft,
    tSettings,
    toast,
    updateConfig,
  ]);

  // Refs for API Key expiry check (P2 fix - avoid stale closures)
  const allProvidersRef = useRef(allProviders);
  allProvidersRef.current = allProviders;
  const apiKeysRef = useRef(apiKeys);
  apiKeysRef.current = apiKeys;
  const verifyProviderRef = useRef(verifyProvider);
  verifyProviderRef.current = verifyProvider;

  // Check for expired API Key verifications on mount (30-day expiry)
  useEffect(() => {
    if (mode !== 'settings') return;
    // Delay to let component stabilize
    const timer = setTimeout(() => {
      allProvidersRef.current.forEach((provider: Provider) => {
        if (provider.enabled === false) return;
        // Skip subscription type (handled separately)
        if (provider.type === 'subscription') return;

        const apiKey = apiKeysRef.current[provider.id];
        const cached = providerVerifyStatusRef.current[provider.id];

        // Only check if has API key and has cached verification
        if (apiKey && cached?.verifiedAt) {
          if (isVerifyExpired(cached.verifiedAt)) {
            console.log(
              `[Settings] Provider ${provider.id} verification expired, re-verifying...`,
            );
            verifyProviderRef.current(provider, apiKey);
          }
        }
      });
    }, 1000); // 1s delay to avoid race conditions

    return () => clearTimeout(timer);
  }, [mode]); // Only the Settings Tab owns provider verification; refs handle latest values

  // Error detail popover ref (state is declared near verifyError)
  const errorDetailPopoverRef = useRef<HTMLDivElement>(null);

  // Close error detail popover on outside click or when the error is cleared
  useEffect(() => {
    if (!errorDetailOpenId) return;
    // If the error for the open popover has been cleared, close the popover
    if (!verifyError[errorDetailOpenId]) {
      setErrorDetailOpenId(null);
      return;
    }
    const handleClick = (e: MouseEvent) => {
      if (
        errorDetailPopoverRef.current &&
        !errorDetailPopoverRef.current.contains(e.target as Node)
      ) {
        setErrorDetailOpenId(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [errorDetailOpenId, verifyError]);

  const renderSubscriptionProviderContent = () => {
    const isLoginActive =
      subscriptionLoginBusy ||
      subscriptionLoginState.status === 'starting' ||
      subscriptionLoginState.status === 'waiting';
    const isLoggedIn =
      subscriptionStatus?.available &&
      subscriptionStatus.verifyStatus === 'valid';
    const isVerifyInvalid = subscriptionStatus?.verifyStatus === 'invalid';
    const needsLogin = !subscriptionStatus?.available || isVerifyInvalid;
    const accountLabel =
      subscriptionStatus?.info?.email ??
      tSettings('providers.subscription.localCredential');
    const statusText = isLoginActive
      ? tSettings('providers.subscription.loginInProgress')
      : isVerifyInvalid
        ? tSettings('providers.subscription.verifyFailed')
        : subscriptionStatus?.available
          ? accountLabel
          : tSettings('providers.subscription.notLoggedIn');

    return (
      <SubscriptionProviderCardContent
        description={tSettings('providers.subscription.description')}
        status={
          <>
            {isLoggedIn ? (
              <>
                <span className="truncate font-mono text-xs text-[var(--ink-muted)]">
                  {accountLabel}
                </span>
                <span className="shrink-0 rounded bg-[var(--success-bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--success)]">
                  {tSettings('providers.verified')}
                </span>
              </>
            ) : (
              <>
                <span className="truncate text-xs text-[var(--ink-muted)]">
                  {statusText}
                </span>
                {isLoginActive && (
                  <span className="shrink-0 rounded bg-[var(--info-bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--info)]">
                    {tSettings('providers.loggingIn')}
                  </span>
                )}
                {subscriptionStatus?.verifyStatus === 'loading' &&
                  !isLoginActive && (
                    <span className="flex shrink-0 items-center gap-1 rounded bg-[var(--info-bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--info)]">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {tSettings('providers.verifying')}
                    </span>
                  )}
                {isVerifyInvalid && (
                  <span className="shrink-0 rounded bg-[var(--error-bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--error)]">
                    {tSettings('providers.verifyFailed')}
                  </span>
                )}
              </>
            )}
          </>
        }
        actions={
          <>
            {subscriptionStatus?.available && (
              <button
                type="button"
                onClick={handleReVerifySubscription}
                disabled={subscriptionVerifying || isLoginActive}
                className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-50"
                title={tSettings('providers.reverify')}
              >
                <RefreshCw
                  className={`h-4 w-4 ${subscriptionVerifying ? 'animate-spin' : ''}`}
                />
              </button>
            )}
            {needsLogin && (
              <button
                type="button"
                disabled={isLoginActive || subscriptionVerifying}
                onClick={() => void startSubscriptionLogin()}
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-60"
              >
                {isLoginActive ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Link className="h-3.5 w-3.5" />
                )}
                {tSettings('providers.login')}
              </button>
            )}
          </>
        }
        error={
          <>
            {isVerifyInvalid && subscriptionStatus?.verifyError && (
              <p className="break-words text-xs text-[var(--error)]">
                {subscriptionStatus.verifyError}
              </p>
            )}
            {subscriptionLoginState.status === 'error' &&
              subscriptionLoginState.error && (
                <p className="break-words text-xs text-[var(--error)]">
                  {subscriptionLoginState.error}
                </p>
              )}
          </>
        }
      />
    );
  };

  const renderManagedCodexProviderCard = (provider: Provider) => {
    const install = config.managedCodexRuntimeInstall;
    const auth = config.managedCodexAuth;
    const installStatus = install?.status;
    const { runtimeUsable, isUpdatingRuntime, showDownloadRow } =
      getManagedCodexRuntimePresentation(
        install,
        managedCodexBusy,
        managedCodexRuntimeUpdateInFlight,
      );
    const authStatus = auth?.status;
    const isDownloadingRuntime =
      managedCodexRuntimeUpdateInFlight ||
      managedCodexBusy === 'download' ||
      installStatus === 'downloading' ||
      managedCodexReadiness.reason === 'runtime-downloading';
    const isCommandBusy = managedCodexBusy !== null;
    const busy =
      managedCodexRuntimeUpdateInFlight ||
      isCommandBusy ||
      isDownloadingRuntime;
    const hasVersionDrift = Boolean(
      install?.installedVersion &&
        install.installedVersion !== managedCodexReadiness.requiredVersion,
    );
    const needsLogin =
      managedCodexReadiness.reason === 'auth-missing' ||
      managedCodexReadiness.reason === 'auth-invalid' ||
      managedCodexReadiness.reason === 'auth-error' ||
      managedCodexReadiness.reason === 'auth-logging-in';
    const rawProgress = install?.progressPercent;
    const progressPercent =
      typeof rawProgress === 'number' && Number.isFinite(rawProgress)
        ? Math.max(0, Math.min(100, Math.round(rawProgress)))
        : null;
    const downloadButtonLabel = isDownloadingRuntime
      ? progressPercent == null
        ? tSettings('providers.managedCodex.downloading')
        : `${progressPercent}%`
      : installStatus === 'update-required' ||
          installStatus === 'error' ||
          hasVersionDrift
        ? tSettings('providers.managedCodex.update')
        : tSettings('providers.managedCodex.download');
    const runtimeRowLabel = tSettings('providers.managedCodex.downloadRuntime');
    const modelLine = provider.models
      .map((model) => model.modelName || model.model)
      .join(', ');
    const loginInProgress =
      managedCodexBusy === 'login' || authStatus === 'logging-in';
    const isLoggedIn = authStatus === 'valid';
    const accountLabel =
      auth?.accountEmail ?? tSettings('providers.managedCodex.account');
    const statusText = loginInProgress
      ? tSettings('providers.managedCodex.loginInProgress')
      : authStatus === 'error' || authStatus === 'invalid'
        ? tSettings('providers.managedCodex.verifyFailed')
        : tSettings('providers.managedCodex.notLoggedIn');
    const runtimeError =
      install?.error &&
      (installStatus === 'error' ||
        managedCodexReadiness.reason === 'runtime-error' ||
        managedCodexReadiness.reason === 'runtime-update-required')
        ? install.error
        : null;

    return (
      <div
        key={provider.id}
        className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5"
      >
        <div className="mb-4 flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="truncate text-lg font-semibold text-[var(--ink)]">
                {tSettings('providers.cardTitles.chatgptSubscription')}
              </h3>
              <span className="shrink-0 rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
                {tSettings('providers.official')}
              </span>
              {isUpdatingRuntime && (
                <span className="shrink-0 text-xs font-medium text-[var(--success)]">
                  {tSettings('providers.managedCodex.updating')}
                </span>
              )}
            </div>
            <p className="mt-1 truncate text-xs text-[var(--ink-muted)]">
              {modelLine}
            </p>
          </div>
          {!showDownloadRow && (
            <button
              type="button"
              onClick={() => setManagedCodexDetailsOpen(true)}
              className="shrink-0 rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
              title={tSettings('providers.managedCodex.settingsTitle')}
            >
              <Settings2 className="h-4 w-4" />
            </button>
          )}
        </div>

        {showDownloadRow && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <Download className="h-4 w-4 shrink-0 text-[var(--accent)]" />
                <span className="truncate text-sm font-semibold text-[var(--ink)]">
                  {runtimeRowLabel}
                </span>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void runManagedCodexDownload()}
                className="flex min-w-16 items-center justify-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
              >
                {isDownloadingRuntime && progressPercent == null && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                {downloadButtonLabel}
              </button>
            </div>
            {runtimeError && (
              <p className="text-xs text-[var(--error)]">{runtimeError}</p>
            )}
          </div>
        )}
        {runtimeUsable && (
          <div className="space-y-3">
            <p className="text-sm text-[var(--ink-muted)]">
              {tSettings('providers.managedCodex.description')}
            </p>
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                {isLoggedIn ? (
                  <>
                    <span className="truncate font-mono text-xs text-[var(--ink-muted)]">
                      {accountLabel}
                    </span>
                    <span className="shrink-0 rounded bg-[var(--success-bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--success)]">
                      {tSettings('providers.verified')}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="truncate text-xs text-[var(--ink-muted)]">
                      {statusText}
                    </span>
                    {loginInProgress && (
                      <span className="shrink-0 rounded bg-[var(--info-bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--info)]">
                        {tSettings('providers.loggingIn')}
                      </span>
                    )}
                    {(authStatus === 'error' || authStatus === 'invalid') && (
                      <span className="shrink-0 rounded bg-[var(--error-bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--error)]">
                        {tSettings('providers.verifyFailed')}
                      </span>
                    )}
                  </>
                )}
              </div>
              {needsLogin && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void startManagedCodexLogin()}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-60"
                >
                  {loginInProgress ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Link className="h-3.5 w-3.5" />
                  )}
                  {tSettings('providers.login')}
                </button>
              )}
            </div>
            {installStatus === 'error' && install?.installedVersion && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-[var(--error)]">
                  {tSettings('providers.managedCodex.updateFailedWithCurrent', {
                    current: install.installedVersion,
                  })}
                </p>
                {runtimeError && (
                  <p className="break-words text-xs text-[var(--error)]">
                    {runtimeError}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderManagedCodexDetailsDialog = () => {
    if (!managedCodexDetailsOpen) return null;
    const install = config.managedCodexRuntimeInstall;
    const auth = config.managedCodexAuth;
    const runtimeVersion =
      install?.installedVersion ?? managedCodexReadiness.requiredVersion;
    const { runtimeUsable, isUpdatingRuntime } =
      getManagedCodexRuntimePresentation(
        install,
        managedCodexBusy,
        managedCodexRuntimeUpdateInFlight,
      );
    const authStatus = auth?.status;
    const isLoggedIn = authStatus === 'valid';
    const loginInProgress =
      managedCodexBusy === 'login' || authStatus === 'logging-in';
    const accountLabel =
      auth?.accountEmail ?? tSettings('providers.managedCodex.account');
    const authBadgeClass = isLoggedIn
      ? 'bg-[var(--success-bg)] text-[var(--success)]'
      : authStatus === 'error' || authStatus === 'invalid'
        ? 'bg-[var(--error-bg)] text-[var(--error)]'
        : loginInProgress
          ? 'bg-[var(--info-bg)] text-[var(--info)]'
          : 'bg-[var(--paper-inset)] text-[var(--ink-muted)]';
    const authBadgeLabel = isLoggedIn
      ? tSettings('providers.managedCodex.loggedIn')
      : loginInProgress
        ? tSettings('providers.loggingIn')
        : authStatus === 'error'
          ? tSettings('providers.managedCodex.errorBadge')
          : tSettings('providers.managedCodex.notLoggedInBadge');
    const authError =
      auth?.error &&
      (managedCodexReadiness.reason === 'auth-error' ||
        managedCodexReadiness.reason === 'auth-invalid')
        ? auth.error
        : null;

    return (
      <OverlayBackdrop
        onClose={() => setManagedCodexDetailsOpen(false)}
        className="z-50 overflow-y-auto py-8"
      >
        <div className="mx-4 flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-xl">
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--line-subtle)] px-6 py-5">
            <div className="min-w-0">
              <h3 className="text-lg font-semibold text-[var(--ink)]">
                {tSettings('providers.managedCodex.settingsTitle')}
              </h3>
              <p className="mt-1 text-sm text-[var(--ink-muted)]">
                {tSettings('providers.managedCodex.settingsDescription')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setManagedCodexDetailsOpen(false)}
              className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
            <section>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--ink)]">
                    {tSettings('providers.managedCodex.runtime')}
                  </p>
                  <div className="mt-1 flex items-center gap-2">
                    <p className="text-sm font-semibold text-[var(--ink)]">
                      v{runtimeVersion}
                    </p>
                    {isUpdatingRuntime && (
                      <span className="shrink-0 text-xs font-medium text-[var(--success)]">
                        {tSettings('providers.managedCodex.updating')}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 truncate text-xs text-[var(--ink-muted)]">
                    {install?.platform ??
                      tSettings('providers.managedCodex.currentPlatform')}
                  </p>
                  {runtimeUsable &&
                    install?.status === 'error' &&
                    install.installedVersion && (
                      <p className="mt-2 text-xs font-medium text-[var(--error)]">
                        {tSettings(
                          'providers.managedCodex.updateFailedWithCurrent',
                          {
                            current: install.installedVersion,
                          },
                        )}
                      </p>
                    )}
                </div>
                <button
                  type="button"
                  disabled={managedCodexBusy !== null}
                  onClick={() => void checkManagedCodexUpdate()}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)] disabled:cursor-wait disabled:opacity-60"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${managedCodexBusy === 'status' ? 'animate-spin' : ''}`}
                  />
                  {tSettings('providers.managedCodex.refresh')}
                </button>
              </div>
            </section>

            <section className="border-t border-[var(--line-subtle)] pt-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-[var(--ink)]">
                      {tSettings('providers.managedCodex.loginStatus')}
                    </p>
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-medium ${authBadgeClass}`}
                    >
                      {authBadgeLabel}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-sm text-[var(--ink-muted)]">
                    {isLoggedIn
                      ? accountLabel
                      : tSettings('providers.managedCodex.account')}
                  </p>
                </div>
                {isLoggedIn ? (
                  <button
                    type="button"
                    disabled={
                      managedCodexRuntimeUpdateInFlight ||
                      managedCodexBusy !== null
                    }
                    onClick={() => void logoutManagedCodex()}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)] disabled:cursor-wait disabled:opacity-60"
                  >
                    {managedCodexBusy === 'logout' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Unlink className="h-3.5 w-3.5" />
                    )}
                    {tSettings('providers.managedCodex.logout')}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={
                      managedCodexRuntimeUpdateInFlight ||
                      managedCodexBusy !== null
                    }
                    onClick={() => void startManagedCodexLogin()}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-60"
                  >
                    {managedCodexBusy === 'login' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Link className="h-3.5 w-3.5" />
                    )}
                    {tSettings('providers.login')}
                  </button>
                )}
              </div>
              {authError && (
                <p className="mt-3 break-words text-xs text-[var(--error)]">
                  {authError}
                </p>
              )}
            </section>
          </div>
        </div>
      </OverlayBackdrop>
    );
  };

  const renderManagedCodexLoginDialog = () => {
    if (!managedCodexLoginDialogOpen) return null;
    const state = managedCodexLoginState;
    const isActiveLogin =
      state.status === 'starting' || state.status === 'waiting';
    const isLoginSucceeded = state.status === 'succeeded';
    const statusLabel =
      state.status === 'succeeded'
        ? tSettings('providers.loginDialog.statusDone')
        : state.status === 'cancelled'
          ? tSettings('providers.loginDialog.statusCancelled')
          : state.status === 'error'
            ? tSettings('providers.loginDialog.statusError')
            : tSettings('providers.loginDialog.statusWaiting');
    const statusClass =
      state.status === 'succeeded'
        ? 'bg-[var(--success-bg)] text-[var(--success)]'
        : state.status === 'cancelled' || state.status === 'error'
          ? 'bg-[var(--error-bg)] text-[var(--error)]'
          : 'bg-[var(--info-bg)] text-[var(--info)]';

    return (
      <OverlayBackdrop
        onClose={() => setManagedCodexLoginDialogOpen(false)}
        className="z-50 overflow-y-auto px-4 py-8"
      >
        <div className="w-full max-w-xl rounded-2xl bg-[var(--paper-elevated)] shadow-xl">
          <div className="flex items-start justify-between gap-4 border-b border-[var(--line-subtle)] px-6 py-5">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-semibold text-[var(--ink)]">
                  {tSettings('providers.loginDialog.codexTitle')}
                </h3>
                <span
                  className={`rounded px-1.5 py-0.5 text-xs font-medium ${statusClass}`}
                >
                  {statusLabel}
                </span>
              </div>
              <p className="mt-1 text-sm text-[var(--ink-muted)]">
                {tSettings('providers.loginDialog.codexDescription')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setManagedCodexLoginDialogOpen(false)}
              className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-5 px-6 py-5">
            <section hidden={isLoginSucceeded}>
              <div className="flex items-center gap-2">
                {isActiveLogin ? (
                  <Loader2 className="h-4 w-4 animate-spin text-[var(--info)]" />
                ) : state.status === 'succeeded' ? (
                  <Check className="h-4 w-4 text-[var(--success)]" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-[var(--error)]" />
                )}
                <p className="text-sm font-medium text-[var(--ink)]">
                  {tSettings('providers.loginDialog.autoOpenBrowser')}
                </p>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-[var(--ink-muted)]">
                {tSettings('providers.loginDialog.codexAutoOpenDescription')}
              </p>
              <div className="mt-3 flex min-w-0 items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2">
                <p className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--ink-muted)]">
                  {state.loginUrl ??
                    tSettings('providers.loginDialog.waitingCodexUrl')}
                </p>
                <button
                  type="button"
                  disabled={!state.loginUrl}
                  onClick={() => void copyManagedCodexLoginUrl()}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Copy className="h-3.5 w-3.5" />
                  {tSettings('providers.loginDialog.copy')}
                </button>
              </div>
            </section>

            <section
              hidden={isLoginSucceeded}
              className="border-t border-[var(--line-subtle)] pt-5"
            >
              <p className="text-sm font-medium text-[var(--ink)]">
                {tSettings('providers.loginDialog.remoteTitle')}
              </p>
              <p className="mt-2 text-sm leading-relaxed text-[var(--ink-muted)]">
                {tSettings('providers.loginDialog.codexRemoteDescription')}
                <code className="mx-1 rounded bg-[var(--paper-inset)] px-1.5 py-0.5 font-mono text-xs text-[var(--ink)]">
                  codex login --device-auth
                </code>
              </p>
            </section>

            {isLoginSucceeded && (
              <section>
                <div className="flex items-start gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--success-bg)]">
                    <Check className="h-4 w-4 text-[var(--success)]" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[var(--ink)]">
                      {tSettings('providers.loginDialog.codexReadyTitle')}
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-[var(--ink-muted)]">
                      {tSettings('providers.loginDialog.codexReadyDescription')}
                    </p>
                  </div>
                </div>
                <img
                  src={codexModelSelectorOnboarding}
                  alt={tSettings('providers.loginDialog.codexModelSelectorAlt')}
                  className="mx-auto mt-5 block h-auto w-full max-w-xs rounded-xl border border-[var(--line-subtle)]"
                />
              </section>
            )}
            {(state.status === 'cancelled' || state.status === 'error') && (
              <p className="break-words rounded-lg bg-[var(--error-bg)] px-3 py-2 text-sm text-[var(--error)]">
                {state.error ?? tSettings('providers.loginDialog.notCompleted')}
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-[var(--line-subtle)] px-6 py-4">
            <button
              type="button"
              onClick={() => setManagedCodexLoginDialogOpen(false)}
              className={
                isLoginSucceeded
                  ? 'rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]'
                  : 'rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]'
              }
            >
              {isLoginSucceeded
                ? tSettings('providers.loginDialog.done')
                : tSettings('providers.loginDialog.close')}
            </button>
            {(state.status === 'cancelled' || state.status === 'error') && (
              <button
                type="button"
                disabled={managedCodexBusy === 'login'}
                onClick={() => void startManagedCodexLogin()}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-60"
              >
                {managedCodexBusy === 'login' && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                {tSettings('providers.loginDialog.retryLogin')}
              </button>
            )}
          </div>
        </div>
      </OverlayBackdrop>
    );
  };

  const renderSubscriptionLoginDialog = () => {
    if (!subscriptionLoginDialogOpen) return null;
    const state = subscriptionLoginState;
    const isActiveLogin =
      state.status === 'starting' || state.status === 'waiting';
    const displayUrl = state.automaticUrl ?? state.loginUrl ?? state.manualUrl;
    const statusLabel =
      state.status === 'succeeded'
        ? tSettings('providers.loginDialog.statusDone')
        : state.status === 'cancelled'
          ? tSettings('providers.loginDialog.statusCancelled')
          : state.status === 'error'
            ? tSettings('providers.loginDialog.statusError')
            : tSettings('providers.loginDialog.statusWaiting');
    const statusClass =
      state.status === 'succeeded'
        ? 'bg-[var(--success-bg)] text-[var(--success)]'
        : state.status === 'cancelled' || state.status === 'error'
          ? 'bg-[var(--error-bg)] text-[var(--error)]'
          : 'bg-[var(--info-bg)] text-[var(--info)]';

    return (
      <OverlayBackdrop
        onClose={closeSubscriptionLoginDialog}
        className="z-50 overflow-y-auto px-4 py-8"
      >
        <div className="w-full max-w-xl rounded-2xl bg-[var(--paper-elevated)] shadow-xl">
          <div className="flex items-start justify-between gap-4 border-b border-[var(--line-subtle)] px-6 py-5">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-semibold text-[var(--ink)]">
                  {tSettings('providers.loginDialog.claudeTitle')}
                </h3>
                <span
                  className={`rounded px-1.5 py-0.5 text-xs font-medium ${statusClass}`}
                >
                  {statusLabel}
                </span>
              </div>
              <p className="mt-1 text-sm text-[var(--ink-muted)]">
                {tSettings('providers.loginDialog.claudeDescription')}
              </p>
            </div>
            <button
              type="button"
              onClick={closeSubscriptionLoginDialog}
              className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-5 px-6 py-5">
            <section>
              <div className="flex items-center gap-2">
                {isActiveLogin ? (
                  <Loader2 className="h-4 w-4 animate-spin text-[var(--info)]" />
                ) : state.status === 'succeeded' ? (
                  <Check className="h-4 w-4 text-[var(--success)]" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-[var(--error)]" />
                )}
                <p className="text-sm font-medium text-[var(--ink)]">
                  {tSettings('providers.loginDialog.autoOpenBrowser')}
                </p>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-[var(--ink-muted)]">
                {tSettings('providers.loginDialog.claudeAutoOpenDescription')}
              </p>
              <div className="mt-3 flex min-w-0 items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2">
                <p className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--ink-muted)]">
                  {displayUrl ??
                    tSettings('providers.loginDialog.waitingClaudeUrl')}
                </p>
                <button
                  type="button"
                  disabled={!displayUrl}
                  onClick={() => void copySubscriptionLoginUrl()}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Copy className="h-3.5 w-3.5" />
                  {tSettings('providers.loginDialog.copy')}
                </button>
              </div>
            </section>

            {isActiveLogin && (
              <section className="border-t border-[var(--line-subtle)] pt-5">
                <div className="flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-[var(--ink-muted)]" />
                  <p className="text-sm font-medium text-[var(--ink)]">
                    {tSettings('providers.loginDialog.manualCodeTitle')}
                  </p>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-[var(--ink-muted)]">
                  {tSettings('providers.loginDialog.manualCodeDescription')}
                </p>
                <form
                  className="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitSubscriptionLoginCode();
                  }}
                >
                  <input
                    value={subscriptionLoginCode}
                    onChange={(event) =>
                      setSubscriptionLoginCode(event.target.value)
                    }
                    placeholder={tSettings(
                      'providers.loginDialog.manualCodePlaceholder',
                    )}
                    className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 font-mono text-sm text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)]"
                  />
                  <button
                    type="submit"
                    disabled={
                      !subscriptionLoginCode.trim() ||
                      subscriptionLoginSubmitting
                    }
                    className="flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {subscriptionLoginSubmitting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <KeyRound className="h-3.5 w-3.5" />
                    )}
                    {subscriptionLoginSubmitting
                      ? tSettings('providers.loginDialog.submittingCode')
                      : tSettings('providers.loginDialog.submitCode')}
                  </button>
                </form>
                {state.error && (
                  <p className="mt-2 break-words rounded-lg bg-[var(--error-bg)] px-3 py-2 text-sm text-[var(--error)]">
                    {state.error}
                  </p>
                )}
              </section>
            )}

            <section className="border-t border-[var(--line-subtle)] pt-5">
              <p className="text-sm font-medium text-[var(--ink)]">
                {tSettings('providers.loginDialog.remoteTitle')}
              </p>
              <p className="mt-2 text-sm leading-relaxed text-[var(--ink-muted)]">
                {tSettings('providers.loginDialog.claudeRemoteDescription')}
                <code className="mx-1 rounded bg-[var(--paper-inset)] px-1.5 py-0.5 font-mono text-xs text-[var(--ink)]">
                  claude auth login
                </code>
              </p>
            </section>

            {state.status === 'succeeded' && (
              <p className="rounded-lg bg-[var(--success-bg)] px-3 py-2 text-sm text-[var(--success)]">
                {tSettings('providers.loginDialog.completed')}
              </p>
            )}
            {(state.status === 'cancelled' || state.status === 'error') && (
              <p className="break-words rounded-lg bg-[var(--error-bg)] px-3 py-2 text-sm text-[var(--error)]">
                {state.error ?? tSettings('providers.loginDialog.notCompleted')}
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-[var(--line-subtle)] px-6 py-4">
            <button
              type="button"
              onClick={closeSubscriptionLoginDialog}
              className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]"
            >
              {tSettings('providers.loginDialog.close')}
            </button>
            {(state.status === 'cancelled' || state.status === 'error') && (
              <button
                type="button"
                disabled={subscriptionLoginBusy}
                onClick={() => void startSubscriptionLogin()}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-60"
              >
                {subscriptionLoginBusy && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                {tSettings('providers.loginDialog.retryLogin')}
              </button>
            )}
          </div>
        </div>
      </OverlayBackdrop>
    );
  };

  // Render verification status indicator (icon row)
  const renderVerifyStatus = (provider: Provider) => {
    const isLoading = verifyLoading[provider.id];
    const cached = providerVerifyStatus[provider.id];
    const verifyStatus = cached?.status; // 'valid' | 'invalid' | undefined
    const hasKey = !!apiKeys[provider.id];

    if (!hasKey) {
      return null;
    }

    return (
      <div className="flex items-center gap-1">
        {isLoading && (
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--info-bg)]">
            <Loader2 className="h-4 w-4 animate-spin text-[var(--info)]" />
          </div>
        )}
        {!isLoading && verifyStatus === 'valid' && (
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--success-bg)]">
            <Check className="h-4 w-4 text-[var(--success)]" />
          </div>
        )}
        {!isLoading && verifyStatus === 'invalid' && (
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--error-bg)]">
            <AlertCircle className="h-4 w-4 text-[var(--error)]" />
          </div>
        )}
        {!isLoading && !verifyStatus && (
          <div
            className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--warning-bg)]"
            title={tSettings('providers.verifyPending')}
          >
            <AlertCircle className="h-4 w-4 text-[var(--warning)]" />
          </div>
        )}
        {/* Refresh button for re-verification - hide if already valid */}
        {verifyStatus !== 'valid' && (
          <button
            type="button"
            onClick={() => verifyProvider(provider, apiKeys[provider.id])}
            disabled={isLoading}
            className="flex h-10 w-10 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
            title={tSettings('providers.reverify')}
          >
            <RefreshCw
              className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`}
            />
          </button>
        )}
      </div>
    );
  };

  // Render inline error line below the API key input row
  const renderVerifyError = (provider: Provider) => {
    const errObj = verifyError[provider.id];
    if (!errObj) return null;

    return (
      <div className="flex items-start gap-1.5 pt-1.5 text-xs text-[var(--error)]">
        <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
        <span className="min-w-0 break-words">
          {errObj.error}
          {errObj.action === 'proxy-settings' && (
            <>
              <button
                type="button"
                onClick={navigateToProxySettings}
                className="mx-1 font-medium text-[var(--accent)] underline decoration-dotted underline-offset-2 transition-colors hover:text-[var(--accent-warm-hover)]"
              >
                {tSettings('providers.verify.configureProxy')}
              </button>
              <span>。</span>
            </>
          )}
        </span>
        {errObj.detail && errObj.detail !== errObj.error && (
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() =>
                setErrorDetailOpenId(
                  errorDetailOpenId === provider.id ? null : provider.id,
                )
              }
              className="whitespace-nowrap text-[var(--ink-muted)] underline decoration-dotted transition-colors hover:text-[var(--ink)]"
            >
              {tSettings('providers.verify.details')}
            </button>
            {errorDetailOpenId === provider.id && (
              <div
                ref={errorDetailPopoverRef}
                className="absolute right-0 top-6 z-50 w-80 max-w-[90vw] rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-3 shadow-lg"
              >
                <p className="mb-1 text-xs font-medium uppercase tracking-wider text-[var(--ink-muted)]">
                  {tSettings('providers.verify.errorDetails')}
                </p>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-[var(--ink-secondary)]">
                  {errObj.detail}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="settings-root flex h-full bg-[var(--paper)]">
      {/* Logs Panel */}
      {mode === 'settings' && (
        <UnifiedLogsPanel
          sseLogs={sseLogs}
          isVisible={showLogs}
          onClose={() => setShowLogs(false)}
          onClearAll={clearLogs}
        />
      )}

      {mode === 'settings' && (
        <SettingsSidebar
          activeSection={activeSection}
          setActiveSection={setActiveSection}
          showDevTools={config.showDevTools}
          floatingBallDevGate={config.floatingBallDevGate}
          onShowLogs={() => setShowLogs(true)}
        />
      )}

      {/* Right content area — h-full ensures height is explicit for WebKit scroll */}
      <div className="h-full flex-1 overflow-y-auto overscroll-contain">
        {mode === 'capabilities' && (
          <>
            <header
              className="mx-auto max-w-4xl px-8 pt-7"
              data-capabilities-page-header
            >
              <h1 className="text-xl font-semibold text-[var(--ink)]">
                {tSettings('capabilities.title')}
              </h1>
              <p className="mt-1 text-sm text-[var(--ink-muted)]">
                {tSettings('capabilities.description')}
              </p>
            </header>
            <div
              className="sticky top-0 z-20 mt-5 border-b border-[var(--line)] bg-[var(--paper)]/95 px-8 backdrop-blur-sm"
              data-capabilities-sticky-tabs
            >
              <nav
                className="mx-auto flex max-w-4xl gap-1"
                role="tablist"
                aria-label={tSettings('capabilities.navigation')}
              >
                {(
                  [
                    ['skills', 'capabilities.skills'],
                    ['plugins', 'capabilities.plugins'],
                    ['mcp', 'capabilities.tools'],
                  ] as const
                ).map(([section, labelKey]) => {
                  const selected =
                    section === 'skills'
                      ? activeSection === 'skills' ||
                        activeSection === 'sub-agents'
                      : activeSection === section;
                  return (
                    <button
                      key={section}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      onClick={() => setActiveSection(section)}
                      className={`relative px-4 pb-3 pt-2 text-sm font-medium transition-colors ${
                        selected
                          ? 'text-[var(--ink)] after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-[var(--accent)]'
                          : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                      }`}
                    >
                      {tSettings(labelKey)}
                    </button>
                  );
                })}
              </nav>
            </div>
          </>
        )}
        {/* Skills + Sub-Agents section uses wider layout.
         *  initialSelect is passed unfiltered — each panel's viewStateForSelect
         *  is the single source of truth for which kinds it accepts. */}
        {(activeSection === 'skills' || activeSection === 'sub-agents') && (
          <SkillsAgentsSection initialSelect={initialSelect} />
        )}

        {/* Plugins section (PRD 0.2.17) — independent tab. Plugins are
         * version-pinned packages of skills/agents/MCP/hooks; the SDK
         * does the actual component loading once we hand it the path
         * via Options.plugins. */}
        {activeSection === 'plugins' && (
          <div className="mx-auto max-w-4xl px-8 py-8">
            <GlobalPluginsPanel />
          </div>
        )}

        {/* Bot Platform Registry (formerly Agent / IM Bot) */}
        {activeSection === 'agent' && (
          <div className="mx-auto max-w-4xl px-8 py-8">
            <BotPlatformRegistry
              projects={projects}
              defaultWorkspacePath={config.defaultWorkspacePath}
              onAddToWorkspace={handleAddBotToWorkspace}
            />
          </div>
        )}

        {/* Usage Stats section */}
        {activeSection === 'usage-stats' && (
          <div className="mx-auto max-w-4xl px-8 py-8">
            <UsageStatsPanel />
          </div>
        )}

        {activeSection === 'desktop-pet' &&
          config.floatingBallDevGate !== false && <FloatingBallPetSettings />}

        {/* Providers section uses wider layout */}
        {activeSection === 'providers' && (
          <div className="mx-auto max-w-4xl px-8 py-8">
            {showAiInstallButton && (
              <SettingsHelperInbox
                providers={providers}
                apiKeys={apiKeys}
                providerVerifyStatus={providerVerifyStatus}
                appVersion={appVersion}
                initialProviderId={helperAgentDefaults.initialProviderId}
                initialModel={helperAgentDefaults.initialModel}
                onModelChange={helperAgentDefaults.onModelChange}
              />
            )}
            <div className="mb-8 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-[var(--ink)]">
                {tSettings('providers.title')}
              </h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={openProviderOrderDialog}
                  className="flex items-center gap-1.5 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  {tSettings('providers.enableAndSort')}
                </button>
                <button
                  onClick={() => setShowCustomForm(true)}
                  className="flex items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {tSettings('providers.addProvider')}
                </button>
              </div>
            </div>

            <p className="mb-6 text-sm text-[var(--ink-muted)]">
              {tSettings('providers.description')}
            </p>

            {/* Provider list */}
            <div className="grid grid-cols-2 gap-4">
              {visibleProviders.map((provider) =>
                provider.id === CODEX_SUBSCRIPTION_PROVIDER_ID ? (
                  renderManagedCodexProviderCard(provider)
                ) : provider.id === TOKENDANCE_PROVIDER_ID ? (
                  <TokenDanceProvider key={provider.id} provider={provider} isActive={isActive} />
                ) : (
                  <div
                    key={provider.id}
                    className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5"
                  >
                    {/* Provider header */}
                    <div className="mb-4 flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="truncate text-lg font-semibold text-[var(--ink)]">
                            {provider.id === 'anthropic-sub'
                              ? tSettings('providers.cardTitles.claudeSubscription')
                              : provider.id === 'anthropic-api'
                                ? tSettings('providers.cardTitles.claudeApi')
                                : provider.name}
                          </h3>
                          <span className="shrink-0 rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
                            {provider.cloudProvider}
                          </span>
                          {provider.apiProtocol === 'openai' && (
                            <span className="shrink-0 rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
                              {tSettings('providers.openaiProtocol')}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 truncate text-xs text-[var(--ink-muted)]">
                          {provider.models.length > 0
                            ? provider.models
                                .map((m) => m.modelName || m.model)
                                .join(', ')
                            : tSettings('providers.noModels')}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {provider.websiteUrl && (
                          <ExternalLink
                            href={provider.websiteUrl}
                            className="rounded-lg px-1.5 py-1.5 text-xs text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                          >
                            {tSettings('providers.website')}
                          </ExternalLink>
                        )}
                        <button
                          onClick={() => openProviderManage(provider)}
                          className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                          title={tSettings('providers.manage')}
                        >
                          <Settings2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>

                    {/* API Key input */}
                    {provider.type === 'api' && (
                      <div>
                        <div className="flex items-center gap-2">
                          <div className="relative flex-1">
                            <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-muted)]" />
                            <input
                              type="password"
                              placeholder={tSettings(
                                'providers.apiKeyPlaceholder',
                              )}
                              value={apiKeys[provider.id] || ''}
                              onChange={(e) =>
                                handleSaveApiKey(provider, e.target.value)
                              }
                              className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] py-2.5 pl-10 pr-4 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)] transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                            />
                          </div>
                          {renderVerifyStatus(provider)}
                        </div>
                        {renderVerifyError(provider)}
                      </div>
                    )}

                    {/* Subscription type - show status */}
                    {provider.type === 'subscription' &&
                      (provider.id === XAI_SUBSCRIPTION_PROVIDER_ID ? (
                        <GrokSubscriptionProvider
                          onAuthChanged={async () => {
                            await refreshConfig();
                            await refreshProviders();
                          }}
                        />
                      ) : (
                        renderSubscriptionProviderContent()
                      ))}
                  </div>
                ),
              )}
              {visibleProviders.length === 0 && (
                <div className="col-span-2 rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-elevated)] p-8 text-center">
                  <p className="text-sm font-medium text-[var(--ink)]">
                    {tSettings('providers.noEnabledTitle')}
                  </p>
                  <p className="mt-1 text-xs text-[var(--ink-muted)]">
                    {tSettings('providers.noEnabledDescription')}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 工具箱 section（原 MCP tab 原位改造，PRD 0.2.36：section id 保持 'mcp' 深链接零迁移）。
                    纵向两分区：MCP（现状内容）+ CLI 工具（注册表）。视觉以
                    specs/playgrounds/toolbox_settings_tab.html 定稿版为准。 */}
        {activeSection === 'mcp' && (
          <ToolboxSection
            cliToolRegistryEnabled={config.cliToolRegistryEnabled}
            mcpServers={mcpServers}
            mcpEnabledIds={mcpEnabledIds}
            mcpEnabling={mcpEnabling}
            mcpNeedsConfig={mcpNeedsConfig}
            officialTools={OFFICIAL_TOOLS}
            officialEnabledIds={officialEnabledIds}
            officialToolEnabling={officialToolEnabling}
            officialToolNeedsConfig={{
              [IMAGE_UNDERSTANDING_TOOL_ID]: visionToolNeedsConfig,
            }}
            browserResourceStatus={browserResourceStatus}
            speechModelPackStatus={speechModelPackStatus}
            onAddMcp={() => {
              resetMcpForm();
              setShowMcpForm(true);
            }}
            onEditMcp={handleEditMcp}
            onEditBuiltinMcp={handleEditBuiltinMcp}
            onToggleMcp={handleMcpToggle}
            onEditOfficialTool={openOfficialToolSettings}
            onToggleOfficialTool={handleOfficialToolToggle}
            onInstallBrowserResource={() => {
              void runBrowserResourceInstall();
            }}
            onInstallSpeechModelPack={() => {
              void runSpeechModelPackInstall();
            }}
            onRemoveSpeechModelPack={() => {
              void runSpeechModelPackRemove();
            }}
          />
        )}

        {/* Other sections use narrower layout */}
        <div
          className={`mx-auto max-w-xl px-8 py-8 ${['skills', 'agents', 'plugins', 'providers', 'mcp', 'desktop-pet'].includes(activeSection) ? 'hidden' : ''}`}
        >
          {activeSection === 'shortcuts' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold text-[var(--ink)]">
                  {tSettings('shortcuts.title')}
                </h2>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                  {tSettings('shortcuts.description')}
                </p>
              </div>

              {/* 消息发送 — applies to every "AI conversation" composer:
                                主对话框 / AI 小助理 / 问题反馈 (shared via utils/chatSendKey). */}
              <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                <h3 className="text-base font-medium text-[var(--ink)]">
                  {tSettings('shortcuts.messageSend.title')}
                </h3>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                  {tSettings('shortcuts.messageSend.description')}
                </p>
                <div className="mt-4 flex items-center justify-between">
                  <div className="flex-1 pr-4">
                    <p className="text-sm font-medium text-[var(--ink)]">
                      {tSettings('shortcuts.messageSend.shortcutTitle')}
                    </p>
                    <p className="text-xs text-[var(--ink-muted)]">
                      {(config.chatSendShortcut ?? 'enter') === 'modEnter'
                        ? tSettings('shortcuts.messageSend.modEnterSummary', {
                            mod: isMac ? '⌘' : 'Ctrl',
                          })
                        : tSettings('shortcuts.messageSend.enterSummary')}
                    </p>
                  </div>
                  <div className="flex gap-0.5 rounded-full bg-[var(--paper-inset)] p-0.5">
                    {(
                      [
                        { value: 'enter', label: 'Enter' },
                        {
                          value: 'modEnter',
                          label: `${isMac ? '⌘' : 'Ctrl'} + Enter`,
                        },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() =>
                          void updateConfig({ chatSendShortcut: opt.value })
                        }
                        className={`rounded-full px-3 py-1 text-xs font-medium transition-all ${
                          (config.chatSendShortcut ?? 'enter') === opt.value
                            ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-sm'
                            : 'text-[var(--ink-muted)] hover:text-[var(--ink-secondary)]'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Global Summon Shortcut (PRD 0.2.16) — relocated here from
                                通用设置 in 0.2.29 so all keyboard shortcuts live together. */}
              <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                <h3 className="text-base font-medium text-[var(--ink)]">
                  {tSettings('shortcuts.summon.title')}
                </h3>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                  {tSettings('shortcuts.summon.description')}
                </p>

                {/* Enable toggle */}
                <div className="mt-4 flex items-center justify-between">
                  <div className="flex-1 pr-4">
                    <p className="text-sm font-medium text-[var(--ink)]">
                      {tSettings('shortcuts.summon.enableTitle')}
                    </p>
                    <p className="text-xs text-[var(--ink-muted)]">
                      {isTauriEnvironment()
                        ? tSettings('shortcuts.summon.enableDescription')
                        : tSettings('shortcuts.desktopOnly')}
                    </p>
                  </div>
                  <button
                    onClick={() =>
                      void applySummonShortcut({
                        enabled: !summonEnabled,
                        accelerator: summonAccelerator,
                      })
                    }
                    disabled={!isTauriEnvironment()}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                      !isTauriEnvironment()
                        ? 'opacity-50 cursor-not-allowed'
                        : 'cursor-pointer'
                    } ${
                      summonEnabled
                        ? 'bg-[var(--accent)]'
                        : 'bg-[var(--line-strong)]'
                    }`}
                  >
                    <span
                      className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                        summonEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Shortcut recorder + reset */}
                <div className="mt-4 flex items-center justify-between">
                  <div className="flex-1 pr-4">
                    <p className="text-sm font-medium text-[var(--ink)]">
                      {tSettings('shortcuts.summon.currentTitle')}
                    </p>
                    <p className="text-xs text-[var(--ink-muted)]">
                      {tSettings('shortcuts.summon.currentDescription')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <ShortcutRecorder
                      value={summonAccelerator}
                      onChange={(accel) =>
                        void applySummonShortcut({
                          enabled: summonEnabled,
                          accelerator: accel,
                        })
                      }
                      disabled={!isTauriEnvironment() || !summonEnabled}
                    />
                    <button
                      type="button"
                      onClick={() =>
                        void applySummonShortcut({
                          enabled: summonEnabled,
                          accelerator: DEFAULT_SUMMON_ACCELERATOR,
                        })
                      }
                      disabled={
                        !isTauriEnvironment() ||
                        !summonEnabled ||
                        summonAccelerator === DEFAULT_SUMMON_ACCELERATOR
                      }
                      className={`text-xs text-[var(--ink-muted)] hover:text-[var(--ink)] transition-colors ${
                        !isTauriEnvironment() ||
                        !summonEnabled ||
                        summonAccelerator === DEFAULT_SUMMON_ACCELERATOR
                          ? 'opacity-40 cursor-not-allowed'
                          : 'cursor-pointer'
                      }`}
                      title={tSettings('shortcuts.summon.resetTitle')}
                    >
                      {tSettings('shortcuts.summon.resetDefault')}
                    </button>
                  </div>
                </div>
              </div>

              {/* 应用快捷键 reference — read-only, sourced from the same
                                APP_SHORTCUTS table App.tsx dispatches from (no drift). */}
              <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                <h3 className="text-base font-medium text-[var(--ink)]">
                  {tSettings('shortcuts.app.title')}
                </h3>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                  {tSettings('shortcuts.app.description')}
                </p>
                <div className="mt-4 space-y-2.5">
                  {VISIBLE_APP_SHORTCUTS.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center justify-between gap-4"
                    >
                      <p className="text-sm text-[var(--ink-secondary)]">
                        {tSettings(`shortcuts.app.items.${s.id}`)}
                      </p>
                      <kbd className="shrink-0 rounded-md border border-[var(--line)] bg-[var(--paper-inset)] px-2 py-0.5 font-mono text-xs text-[var(--ink-muted)]">
                        {s.keys?.(isMac)}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeSection === 'general' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold text-[var(--ink)]">
                  {tSettings('general.title')}
                </h2>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                  {tSettings('general.description')}
                </p>
              </div>

              <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                <h3 className="text-base font-medium text-[var(--ink)]">
                  {tSettings('general.appearanceTitle')}
                </h3>

                <div className="mt-4 flex items-center justify-between gap-4">
                  <div className="flex-1 pr-4">
                    <p className="text-sm font-medium text-[var(--ink)]">
                      {tSettings('general.languageTitle')}
                    </p>
                    <p className="text-xs text-[var(--ink-muted)]">
                      {tSettings('general.languageDescription')}
                    </p>
                  </div>
                  <CustomSelect
                    value={config.uiLanguage ?? 'system'}
                    options={languageOptions}
                    onChange={async (value) => {
                      await updateConfig({ uiLanguage: value as UiLanguage });
                      toast.success(tSettings('general.languageChanged'));
                    }}
                    triggerIcon={<Globe className="h-3.5 w-3.5" />}
                    className="w-[220px]"
                  />
                </div>

                <AppearanceModeControl
                  value={config.appearanceMode}
                  onChange={(mode) => {
                    void updateConfig({ appearanceMode: mode });
                  }}
                />

                <div className="mt-4 flex items-center justify-between gap-4 border-t border-[var(--line)] pt-4">
                  <div className="min-w-0 flex-1 pr-4">
                    <p className="text-sm font-medium text-[var(--ink)]">
                      {tSettings('general.themeTitle')}
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                      {tSettings('general.themeDescription')}
                    </p>
                  </div>
                  <ThemePresetSelect
                    value={resolvedTheme.themeId}
                    onPersistTheme={(themeId) =>
                      updateConfig({
                        themeId,
                        themeSelectionExplicit: true,
                      })
                    }
                    onPersistError={(error) => {
                      const message =
                        error instanceof Error ? error.message : String(error);
                      toast.error(
                        tSettings('general.themeSaveFailed', { message }),
                      );
                    }}
                  />
                </div>
              </div>

              {/* Startup Settings */}
              <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                <h3 className="text-base font-medium text-[var(--ink)]">
                  {tSettings('general.startupTitle')}
                </h3>

                {/* Auto Start */}
                <div className="mt-4 flex items-center justify-between">
                  <div className="flex-1 pr-4">
                    <p className="text-sm font-medium text-[var(--ink)]">
                      {tSettings('general.autostartTitle')}
                    </p>
                    <p className="text-xs text-[var(--ink-muted)]">
                      {tSettings('general.autostartDescription')}
                    </p>
                  </div>
                  <button
                    onClick={async () => {
                      const success = await setAutostart(!autostartEnabled);
                      if (success) {
                        toast.success(
                          autostartEnabled
                            ? tSettings('general.autostartDisabled')
                            : tSettings('general.autostartEnabled'),
                        );
                      } else {
                        toast.error(tSettings('general.saveFailedRetry'));
                      }
                    }}
                    disabled={autostartLoading}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                      autostartLoading
                        ? 'opacity-50 cursor-not-allowed'
                        : 'cursor-pointer'
                    } ${
                      autostartEnabled
                        ? 'bg-[var(--accent)]'
                        : 'bg-[var(--line-strong)]'
                    }`}
                  >
                    <span
                      className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                        autostartEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Minimize to Tray */}
                <div className="mt-4 flex items-center justify-between">
                  <div className="flex-1 pr-4">
                    <p className="text-sm font-medium text-[var(--ink)]">
                      {tSettings('general.minimizeToTrayTitle')}
                    </p>
                    <p className="text-xs text-[var(--ink-muted)]">
                      {tSettings('general.minimizeToTrayDescription')}
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      updateConfig({ minimizeToTray: !config.minimizeToTray });
                      toast.success(
                        config.minimizeToTray
                          ? tSettings('general.minimizeToTrayDisabled')
                          : tSettings('general.minimizeToTrayEnabled'),
                      );
                    }}
                    className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                      config.minimizeToTray
                        ? 'bg-[var(--accent)]'
                        : 'bg-[var(--line-strong)]'
                    }`}
                  >
                    <span
                      className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                        config.minimizeToTray
                          ? 'translate-x-5'
                          : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* 始终阻止电脑睡眠 (PRD 0.2.35).
                                    副标题文案锁定 (D5):必须诚实告诉用户合盖照睡 + 更耗电,
                                    用户原话「在外面 AI 始终响应」直觉对应"合盖塞包"但 mac
                                    合盖即睡是固件强制,不说=误导。
                                    ConfigProvider.updateConfig 特化分支会路由到
                                    cmd_set_force_wake_lock,本组件保持和 minimizeToTray 同构。 */}
                <div className="mt-4 flex items-center justify-between">
                  <div className="flex-1 pr-4">
                    <p className="text-sm font-medium text-[var(--ink)]">
                      {tSettings('general.forceWakeTitle')}
                    </p>
                    <p className="text-xs text-[var(--ink-muted)]">
                      {tSettings('general.forceWakeDescription')}
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      const next = !config.forceWakeLock;
                      updateConfig({ forceWakeLock: next });
                      toast.success(
                        next
                          ? tSettings('general.forceWakeEnabled')
                          : tSettings('general.forceWakeDisabled'),
                      );
                    }}
                    className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                      config.forceWakeLock
                        ? 'bg-[var(--accent)]'
                        : 'bg-[var(--line-strong)]'
                    }`}
                  >
                    <span
                      className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                        config.forceWakeLock ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Default Workspace */}
                <div className="mt-4 flex items-center justify-between">
                  <div className="flex-1 pr-4">
                    <p className="text-sm font-medium text-[var(--ink)]">
                      {tSettings('general.defaultWorkspaceTitle')}
                    </p>
                    <p className="text-xs text-[var(--ink-muted)]">
                      {tSettings('general.defaultWorkspaceDescription')}
                    </p>
                  </div>
                  <CustomSelect
                    value={config.defaultWorkspacePath ?? ''}
                    options={[
                      {
                        value: '',
                        label: tSettings('general.defaultWorkspaceNone'),
                      },
                      ...projects.map((p) => ({
                        value: p.path,
                        label: shortenPathForDisplay(p.path),
                        icon: <FolderOpen className="h-3.5 w-3.5" />,
                      })),
                    ]}
                    onChange={async (val) => {
                      if (val === '') {
                        await updateConfig({ defaultWorkspacePath: undefined });
                      } else {
                        await updateConfig({ defaultWorkspacePath: val });
                        toast.success(
                          tSettings('general.defaultWorkspaceSaved'),
                        );
                      }
                    }}
                    placeholder={tSettings('general.defaultWorkspaceNone')}
                    triggerIcon={<FolderOpen className="h-3.5 w-3.5" />}
                    className="w-[240px]"
                    footerAction={{
                      label: tSettings('general.defaultWorkspaceBrowse'),
                      icon: <Plus className="h-3.5 w-3.5" />,
                      onClick: async () => {
                        try {
                          const { open } = await import(
                            '@tauri-apps/plugin-dialog'
                          );
                          const selected = await open({
                            directory: true,
                            multiple: false,
                            title: tSettings(
                              'general.defaultWorkspacePickTitle',
                            ),
                          });
                          if (selected && typeof selected === 'string') {
                            if (
                              !projects.find((p) =>
                                workspacePathsEqual(p.path, selected),
                              )
                            ) {
                              await addProject(selected);
                            }
                            await updateConfig({
                              defaultWorkspacePath: selected,
                            });
                            toast.success(
                              tSettings('general.defaultWorkspaceSaved'),
                            );
                          }
                        } catch (err) {
                          console.error(
                            '[Settings] Browse folder failed:',
                            err,
                          );
                        }
                      },
                    }}
                  />
                </div>
              </div>

              {/* Chat Queue Response Mode */}
              <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                <h3 className="text-base font-medium text-[var(--ink)]">
                  {tSettings('general.queueTitle')}
                </h3>
                <div className="mt-4 flex items-center justify-between gap-4">
                  <div className="flex-1">
                    <p className="text-sm font-medium text-[var(--ink)]">
                      {tSettings('general.queueModeTitle')}
                    </p>
                    <p className="text-xs text-[var(--ink-muted)]">
                      {normalizeChatQueueResponseMode(
                        config.chatQueueResponseMode,
                      ) === 'turn'
                        ? tSettings('general.queueTurnDescription')
                        : tSettings('general.queueRealtimeDescription')}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-0.5 rounded-full bg-[var(--paper-inset)] p-0.5">
                    {(
                      [
                        {
                          value: 'realtime',
                          label: tSettings('general.queueRealtime'),
                        },
                        {
                          value: 'turn',
                          label: tSettings('general.queueTurn'),
                        },
                      ] as const satisfies ReadonlyArray<{
                        value: ChatQueueResponseMode;
                        label: string;
                      }>
                    ).map((opt) => {
                      const active =
                        normalizeChatQueueResponseMode(
                          config.chatQueueResponseMode,
                        ) === opt.value;
                      return (
                        <button
                          key={opt.value}
                          onClick={() =>
                            void updateConfig({
                              chatQueueResponseMode: opt.value,
                            })
                          }
                          className={`rounded-full px-3 py-1 text-xs font-medium transition-all ${
                            active
                              ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-sm'
                              : 'text-[var(--ink-muted)] hover:text-[var(--ink-secondary)]'
                          }`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Notification Settings */}
              <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                <h3 className="text-base font-medium text-[var(--ink)]">
                  {tSettings('general.notificationTitle')}
                </h3>

                {/* Task Notifications */}
                <div className="mt-4 flex items-center justify-between">
                  <div className="flex-1 pr-4">
                    <p className="text-sm font-medium text-[var(--ink)]">
                      {tSettings('general.notificationEnableTitle')}
                    </p>
                    <p className="text-xs text-[var(--ink-muted)]">
                      {tSettings('general.notificationEnableDescription')}
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      const enabling = !config.osNotifications;
                      updateConfig({ osNotifications: enabling });
                      if (enabling && isTauriEnvironment()) {
                        void invoke(
                          'cmd_request_notification_permission',
                        ).catch((error: unknown) => {
                          console.warn(
                            '[Notification] Permission request failed:',
                            error,
                          );
                        });
                      }
                      toast.success(
                        config.osNotifications
                          ? tSettings('general.notificationDisabled')
                          : tSettings('general.notificationEnabled'),
                      );
                    }}
                    className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                      config.osNotifications
                        ? 'bg-[var(--accent)]'
                        : 'bg-[var(--line-strong)]'
                    }`}
                  >
                    <span
                      className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                        config.osNotifications
                          ? 'translate-x-5'
                          : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Notification Sound — only meaningful when master notification toggle is on,
                                     so hide it entirely when osNotifications is off (avoids the
                                     "I toggled this and nothing happens" UX trap). */}
                {config.osNotifications && (
                  <>
                    <div className="mt-4 flex items-center justify-between">
                      <div className="flex-1 pr-4">
                        <p className="text-sm font-medium text-[var(--ink)]">
                          {tSettings('general.notificationSoundTitle')}
                        </p>
                        <p className="text-xs text-[var(--ink-muted)]">
                          {tSettings('general.notificationSoundDescription')}
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          updateConfig({
                            notificationSound: !config.notificationSound,
                          });
                          toast.success(
                            config.notificationSound
                              ? tSettings('general.notificationSoundDisabled')
                              : tSettings('general.notificationSoundEnabled'),
                          );
                        }}
                        className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                          config.notificationSound
                            ? 'bg-[var(--accent)]'
                            : 'bg-[var(--line-strong)]'
                        }`}
                      >
                        <span
                          className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                            config.notificationSound
                              ? 'translate-x-5'
                              : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </div>

                    <div className="mt-4 flex items-center justify-between">
                      <div className="flex-1 pr-4">
                        <p className="text-sm font-medium text-[var(--ink)]">
                          {tSettings('general.notificationBadgeTitle')}
                        </p>
                        <p className="text-xs text-[var(--ink-muted)]">
                          {tSettings('general.notificationBadgeDescription')}
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          const enabled = config.notificationBadge ?? false;
                          updateConfig({ notificationBadge: !enabled });
                          toast.success(
                            enabled
                              ? tSettings('general.notificationBadgeDisabled')
                              : tSettings('general.notificationBadgeEnabled'),
                          );
                        }}
                        className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                          (config.notificationBadge ?? false)
                            ? 'bg-[var(--accent)]'
                            : 'bg-[var(--line-strong)]'
                        }`}
                      >
                        <span
                          className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                            (config.notificationBadge ?? false)
                              ? 'translate-x-5'
                              : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {activeSection === 'proxy' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold text-[var(--ink)]">
                  {tSettings('proxy.title')}
                </h2>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                  {tSettings('proxy.description')}
                </p>
              </div>

              {/* Network Proxy Settings */}
              <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                {/* Enable toggle */}
                <div className="flex items-center justify-between">
                  <div className="flex-1 pr-4">
                    <p className="text-sm font-medium text-[var(--ink)]">
                      {tSettings('proxy.enableTitle')}
                    </p>
                    <p className="text-xs text-[var(--ink-muted)]">
                      {tSettings('proxy.enableDescription')}
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      // patchProxySettings merges against disk-latest config, so
                      // toggling enabled preserves protocol/host/port (and seeds
                      // them from defaults on first enable). #230.
                      patchProxySettings({
                        enabled: !config.proxySettings?.enabled,
                      });
                    }}
                    className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                      config.proxySettings?.enabled
                        ? 'bg-[var(--accent)]'
                        : 'bg-[var(--line-strong)]'
                    }`}
                  >
                    <span
                      className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                        config.proxySettings?.enabled
                          ? 'translate-x-5'
                          : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                <div className="mt-4 border-t border-[var(--line)] pt-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-[var(--ink)]">
                        {tSettings('proxy.scopeTitle')}
                      </p>
                      <p
                        className="mt-1 truncate text-xs text-[var(--ink-muted)]"
                        title={proxyScopeSummary}
                      >
                        {proxyScopeSummary}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <div className="inline-flex overflow-hidden rounded-lg border border-[var(--line)]">
                        <button
                          type="button"
                          disabled={!config.proxySettings?.enabled}
                          onClick={() =>
                            patchProxySettings({ scope: { mode: 'all' } })
                          }
                          className={`px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                            proxyScope.mode === 'all'
                              ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                              : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
                          }`}
                        >
                          {tSettings('proxy.scopeAll')}
                        </button>
                        <button
                          type="button"
                          disabled={!config.proxySettings?.enabled}
                          onClick={() => setShowProxyScopeDialog(true)}
                          className={`border-l border-[var(--line)] px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                            proxyScope.mode === 'custom'
                              ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                              : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
                          }`}
                        >
                          {tSettings('proxy.scopeCustom')}
                        </button>
                      </div>
                      <button
                        type="button"
                        disabled={!config.proxySettings?.enabled}
                        onClick={() => setShowProxyScopeDialog(true)}
                        className="rounded-lg border border-[var(--line)] p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label={tSettings('proxy.scopeDialogTitle')}
                      >
                        <SlidersHorizontal size={16} />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Proxy settings form (shown when enabled) */}
                {config.proxySettings?.enabled && (
                  <div className="mt-4 space-y-3 border-t border-[var(--line)] pt-4">
                    {/* Protocol */}
                    <div className="flex items-center gap-3">
                      <label className="w-16 text-xs text-[var(--ink-muted)]">
                        {tSettings('proxy.protocol')}
                      </label>
                      <CustomSelect
                        value={
                          config.proxySettings?.protocol ||
                          PROXY_DEFAULTS.protocol
                        }
                        options={[
                          { value: 'http', label: 'HTTP' },
                          { value: 'https', label: 'HTTPS' },
                          { value: 'socks5', label: 'SOCKS5' },
                        ]}
                        onChange={(val) => {
                          patchProxySettings({
                            protocol: val as ProxyProtocol,
                          });
                        }}
                        className="flex-1"
                      />
                    </div>

                    {/* Host */}
                    <div className="flex items-center gap-3">
                      <label className="w-16 text-xs text-[var(--ink-muted)]">
                        {tSettings('proxy.server')}
                      </label>
                      <input
                        type="text"
                        value={proxyHostDraft}
                        onChange={(e) => setProxyHostDraft(e.target.value)}
                        onBlur={commitProxyHost}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur();
                        }}
                        placeholder={PROXY_DEFAULTS.host}
                        className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-xs text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:border-[var(--focus-border)] focus:outline-none"
                      />
                    </div>

                    {/* Port */}
                    <div className="flex items-center gap-3">
                      <label className="w-16 text-xs text-[var(--ink-muted)]">
                        {tSettings('proxy.port')}
                      </label>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={proxyPortDraft}
                        onChange={(e) => {
                          // Digit-only: drop everything else so it behaves
                          // like a number field without the native spinner.
                          setProxyPortDraft(
                            e.target.value.replace(/[^0-9]/g, ''),
                          );
                        }}
                        onBlur={commitProxyPort}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur();
                        }}
                        placeholder={String(PROXY_DEFAULTS.port)}
                        className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-xs text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:border-[var(--focus-border)] focus:outline-none"
                      />
                    </div>

                    {/* Preview */}
                    <div className="mt-2 rounded-lg bg-[var(--paper-inset)] px-3 py-2">
                      <span className="text-xs text-[var(--ink-muted)]">
                        {tSettings('proxy.address')}
                      </span>
                      <code className="text-xs font-mono text-[var(--ink)]">
                        {config.proxySettings?.protocol ||
                          PROXY_DEFAULTS.protocol}
                        ://{proxyHostDraft || PROXY_DEFAULTS.host}:
                        {proxyPortDraft || PROXY_DEFAULTS.port}
                      </code>
                    </div>

                    {proxyProbeState.status !== 'idle' && (
                      <div
                        className={`flex items-start gap-1.5 rounded-lg px-3 py-2 text-xs ${
                          proxyProbeState.status === 'error'
                            ? 'bg-[var(--error-bg)] text-[var(--error)]'
                            : proxyProbeState.status === 'ok'
                              ? 'bg-[var(--success-bg)] text-[var(--success)]'
                              : 'bg-[var(--info-bg)] text-[var(--info)]'
                        }`}
                        title={
                          'detail' in proxyProbeState
                            ? proxyProbeState.detail
                            : undefined
                        }
                      >
                        {proxyProbeState.status === 'checking' ? (
                          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
                        ) : proxyProbeState.status === 'ok' ? (
                          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        ) : (
                          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        )}
                        <span className="min-w-0 break-words">
                          {proxyProbeState.status === 'checking'
                            ? tSettings('proxy.checking')
                            : proxyProbeState.message}
                        </span>
                      </div>
                    )}

                    <p className="text-xs text-[var(--ink-faint)]">
                      {tSettings('proxy.appliedHint')}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeSection === 'general' && (
            <div className="mt-6 space-y-6">
              {/* Log Export */}
              <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-base font-medium text-[var(--ink)]">
                      {tSettings('general.logsTitle')}
                    </h3>
                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                      {tSettings('general.logsDescription')}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      setLogExporting(true);
                      try {
                        const result = await apiGetJson<{
                          success: boolean;
                          path?: string;
                          error?: string;
                        }>('/api/logs/export');
                        if (result.success && result.path) {
                          toast.success(
                            tSettings('general.logsExported', {
                              path: result.path,
                            }),
                          );
                        } else {
                          toast.error(
                            result.error ||
                              tSettings('general.logsExportFailed'),
                          );
                        }
                      } catch {
                        toast.error(tSettings('general.logsExportFailedRetry'));
                      } finally {
                        setLogExporting(false);
                      }
                    }}
                    disabled={logExporting}
                    className="flex items-center gap-1.5 rounded-lg bg-[var(--paper-inset)] px-3 py-1.5 text-xs text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-elevated)] disabled:opacity-50"
                  >
                    {logExporting ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {tSettings('general.logsExporting')}
                      </>
                    ) : (
                      <>
                        <Download className="h-3.5 w-3.5" />
                        {tSettings('general.logsExport')}
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'about' && (
            <div className="space-y-6">
              {/* Brand Header */}
              <div className="rounded-2xl border border-[var(--line)] bg-gradient-to-br from-[var(--paper-inset)] to-[var(--paper)] p-8">
                <div className="flex flex-col items-center text-center">
                  <h1
                    className="theme-product-wordmark theme-launcher-hero-title cursor-default select-none"
                    onClick={handleLogoTap}
                  >
                    MyAgents
                  </h1>
                  <div className="mt-1 flex items-center gap-2">
                    <p className="text-sm font-medium text-[var(--ink-muted)]">
                      Version {appVersion || '...'}
                    </p>
                    {!propUpdateReady && !updateDownloading && (
                      <button
                        type="button"
                        onClick={async () => {
                          if (!onCheckForUpdate) {
                            toast.error(tSettings('about.desktopOnly'));
                            return;
                          }
                          const result = await onCheckForUpdate();
                          if (result === 'up-to-date') {
                            toast.info(tSettings('about.upToDate'));
                          } else if (result === 'downloading') {
                            toast.info(tSettings('about.foundDownloading'));
                          } else if (result === 'error') {
                            toast.error(tSettings('about.checkFailed'));
                          }
                        }}
                        disabled={updateChecking}
                        className="rounded-lg bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-elevated)] disabled:opacity-50"
                      >
                        {updateChecking ? (
                          <span className="flex items-center gap-1">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            {tSettings('about.checking')}
                          </span>
                        ) : (
                          tSettings('about.checkUpdates')
                        )}
                      </button>
                    )}
                    <ExternalLink
                      href={MYAGENTS_RELEASES_URL}
                      className="rounded-lg bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-elevated)]"
                    >
                      {tSettings('about.releaseNotes')}
                    </ExternalLink>
                  </div>
                  <p className="mt-3 text-base text-[var(--ink-secondary)]">
                    {tSettings('about.slogan')}
                  </p>
                  {updateDownloading && propUpdateVersion && (
                    <div className="mt-3 space-y-2">
                      <div className="flex items-center gap-2 text-sm text-[var(--ink-secondary)]">
                        <Loader2 className="h-4 w-4 animate-spin text-[var(--accent)]" />
                        <span>
                          {tSettings('about.downloadingVersion', {
                            version: propUpdateVersion,
                            progress:
                              downloadProgress != null
                                ? `... ${downloadProgress}%`
                                : '...',
                          })}
                        </span>
                      </div>
                      {downloadProgress != null && (
                        <div className="h-1.5 w-48 overflow-hidden rounded-full bg-[var(--paper-inset)]">
                          <div
                            className="h-full rounded-full bg-[var(--accent)] transition-all duration-300"
                            style={{ width: `${downloadProgress}%` }}
                          />
                        </div>
                      )}
                    </div>
                  )}
                  {/* Hidden during silent replacement (updatePreparing) for the
                                        same reason CustomTitleBar hides its button: pending bytes
                                        are mid-replacement, click would hit inconsistent state. */}
                  {propUpdateReady && propUpdateVersion && !updatePreparing && (
                    <div className="mt-3 flex items-center gap-2">
                      <span className="text-sm text-[var(--success)]">
                        {tSettings('about.updateReady', {
                          version: propUpdateVersion,
                        })}
                      </span>
                      <button
                        type="button"
                        onClick={
                          updateInstalling ? undefined : onRestartAndUpdate
                        }
                        disabled={updateInstalling}
                        className="rounded-lg bg-[var(--success)] px-3 py-1.5 text-xs font-medium text-[var(--on-success)] transition-colors hover:opacity-90 disabled:opacity-80 disabled:cursor-wait"
                      >
                        {updateInstalling
                          ? tSettings('about.installing')
                          : tSettings('about.restartInstall')}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Product Description — Developer Letter */}
              <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] px-7 py-6">
                <p className="text-xs font-medium uppercase tracking-widest text-[var(--ink-muted)]/50">
                  {tSettings('about.developerLabel')}
                </p>
                <div className="mt-4 space-y-5 text-sm leading-[1.9] text-[var(--ink-secondary)]">
                  <p>{tSettings('about.developerParagraph1')}</p>
                  <p>{tSettings('about.developerParagraph2')}</p>
                  <p>{tSettings('about.developerParagraph3')}</p>
                  <p className="text-center text-base font-medium italic tracking-wide text-[var(--ink)]">
                    {tSettings('about.developerQuote')}
                  </p>
                </div>
              </div>

              {/* 实验室 */}
              <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                <h3 className="text-base font-medium text-[var(--ink)]">
                  {tSettings('about.labTitle')}
                </h3>

                <div className="mt-4 flex items-center justify-between">
                  <div className="flex-1 pr-4">
                    <p className="text-sm font-medium text-[var(--ink)]">
                      {tSettings('about.teamSpaceTitle')}
                    </p>
                    <p className="text-xs text-[var(--ink-muted)]">
                      {tSettings('about.teamSpaceDescription')}
                    </p>
                    {(spaceBuildCapability.isLoading ||
                      !spaceBuildCapability.available) && (
                      <p className="mt-1 text-xs text-[var(--ink-subtle)]">
                        {spaceBuildCapability.isLoading
                          ? tSettings('about.teamSpaceLoading')
                          : tSettings(
                              spaceBuildCapability.reason
                                ? 'about.teamSpaceUnavailableWithReason'
                                : 'about.teamSpaceUnavailable',
                              { reason: spaceBuildCapability.reason },
                            )}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        spaceBuildCapability.isLoading ||
                        !spaceBuildCapability.available
                      )
                        return;
                      updateConfig({
                        teamSpaceEnabled: config.teamSpaceEnabled !== true,
                      });
                    }}
                    disabled={
                      spaceBuildCapability.isLoading ||
                      !spaceBuildCapability.available
                    }
                    aria-pressed={
                      config.teamSpaceEnabled === true &&
                      spaceBuildCapability.available
                    }
                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                      config.teamSpaceEnabled === true &&
                      spaceBuildCapability.available
                        ? 'bg-[var(--accent)]'
                        : 'bg-[var(--line-strong)]'
                    }`}
                  >
                    <span
                      className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                        config.teamSpaceEnabled === true &&
                        spaceBuildCapability.available
                          ? 'translate-x-5'
                          : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                <div className="mt-4 flex items-center justify-between border-t border-[var(--line)] pt-4">
                  <div className="flex-1 pr-4">
                    <p className="text-sm font-medium text-[var(--ink)]">
                      {tSettings('about.runtimeTitle')}
                    </p>
                    <p className="text-xs text-[var(--ink-muted)]">
                      {tSettings('about.runtimeDescription')}
                    </p>
                  </div>
                  <button
                    onClick={() =>
                      updateConfig({
                        multiAgentRuntime: !config.multiAgentRuntime,
                      })
                    }
                    className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                      config.multiAgentRuntime
                        ? 'bg-[var(--accent)]'
                        : 'bg-[var(--line-strong)]'
                    }`}
                  >
                    <span
                      className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                        config.multiAgentRuntime
                          ? 'translate-x-5'
                          : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                <div className="mt-4 flex items-center justify-between border-t border-[var(--line)] pt-4">
                  <div className="flex-1 pr-4">
                    <p className="text-sm font-medium text-[var(--ink)]">
                      {tSettings('about.cliRegistryTitle')}
                    </p>
                    <p className="text-xs text-[var(--ink-muted)]">
                      {tSettings('about.cliRegistryDescription')}
                    </p>
                  </div>
                  <button
                    onClick={() =>
                      updateConfig({
                        cliToolRegistryEnabled:
                          config.cliToolRegistryEnabled !== true,
                      })
                    }
                    className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                      config.cliToolRegistryEnabled === true
                        ? 'bg-[var(--accent)]'
                        : 'bg-[var(--line-strong)]'
                    }`}
                  >
                    <span
                      className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                        config.cliToolRegistryEnabled === true
                          ? 'translate-x-5'
                          : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </div>

              {/* AI Feedback */}
              <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-base font-medium text-[var(--ink)]">
                      {tSettings('about.helperTitle')}
                    </h3>
                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                      {tSettings('about.helperDescription')}
                    </p>
                  </div>
                  <button
                    onClick={() => setShowBugReport(true)}
                    className="rounded-lg bg-[var(--paper-inset)] px-3 py-1.5 text-xs font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-elevated)]"
                  >
                    {tSettings('about.feedback')}
                  </button>
                </div>
              </div>

              {/* User Community QR Code - Show loading state, then image when ready */}
              {(qrCodeLoading || qrCodeDataUrl) && (
                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                  <div className="flex flex-col items-center text-center">
                    <p className="text-sm font-medium text-[var(--ink)]">
                      {tSettings('about.communityTitle')}
                    </p>
                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                      {tSettings('about.communityDescription')}
                    </p>
                    {qrCodeLoading ? (
                      <div className="mt-4 h-36 w-36 flex items-center justify-center">
                        <Loader2 className="h-8 w-8 animate-spin text-[var(--ink-muted)]" />
                      </div>
                    ) : (
                      <img
                        src={qrCodeDataUrl!}
                        alt={tSettings('about.communityQrAlt')}
                        className="mt-4 h-36 w-36 rounded-lg"
                      />
                    )}
                  </div>
                </div>
              )}

              {/* Contact & Links */}
              <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wider text-[var(--ink-muted)]">
                      Developer
                    </p>
                    <p className="mt-1 text-[var(--ink)]">Ethan L</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wider text-[var(--ink-muted)]">
                      Website
                    </p>
                    <ExternalLink
                      href="https://myagents.io"
                      className="mt-1 block text-[var(--accent)] hover:underline"
                    >
                      myagents.io
                    </ExternalLink>
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wider text-[var(--ink-muted)]">
                      Contact
                    </p>
                    <ExternalLink
                      href="mailto:myagents.io@gmail.com"
                      className="mt-1 block text-[var(--accent)] hover:underline"
                    >
                      myagents.io@gmail.com
                    </ExternalLink>
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wider text-[var(--ink-muted)]">
                      GitHub
                    </p>
                    <ExternalLink
                      href={MYAGENTS_GITHUB_URL}
                      className="mt-1 block text-[var(--accent)] hover:underline"
                    >
                      github.com/hAcKlyc/MyAgents
                    </ExternalLink>
                  </div>
                </div>
              </div>

              {/* Open-source and commercial licensing */}
              <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                <h3 className="text-base font-medium text-[var(--ink)]">
                  {tSettings('about.licensingTitle')}
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-[var(--ink-muted)]">
                  {tSettings('about.licensingDescription')}
                </p>
                <div className="mt-4 flex flex-wrap gap-2 text-sm">
                  <ExternalLink
                    href={sourceLicenseUrl}
                    className="rounded-lg bg-[var(--paper-inset)] px-3 py-1.5 text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)]"
                  >
                    {tSettings('about.communityLicense')}
                  </ExternalLink>
                  <ExternalLink
                    href={MYAGENTS_SOURCE_CODE_URL}
                    className="rounded-lg bg-[var(--paper-inset)] px-3 py-1.5 text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)]"
                  >
                    {tSettings('about.sourceCode')}
                  </ExternalLink>
                  <ExternalLink
                    href={sourceNoticesUrl}
                    className="rounded-lg bg-[var(--paper-inset)] px-3 py-1.5 text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)]"
                  >
                    {tSettings('about.thirdPartyNotices')}
                  </ExternalLink>
                  <ExternalLink
                    href="mailto:myagents.io@gmail.com"
                    className="rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                  >
                    {tSettings('about.commercialLicensing')}
                  </ExternalLink>
                </div>
              </div>

              {/* Copyright */}
              <p className="text-center text-xs text-[var(--ink-muted)]">
                {tSettings('about.licensingCopyright')}
              </p>

              {/* Developer Section - Hidden by default, unlocked by tapping logo 5 times */}
              {devSectionVisible && (
                <div>
                  <h2 className="mb-4 text-base font-medium text-[var(--ink-muted)]">
                    {tSettings('about.developerSection')}
                  </h2>
                  <div className="space-y-4">
                    {/* Developer Mode Toggle */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="text-sm font-medium text-[var(--ink)]">
                            {tSettings('about.developer.devModeTitle')}
                          </h3>
                          <p className="mt-1 text-xs text-[var(--ink-muted)]">
                            {tSettings('about.developer.devModeDescription')}
                          </p>
                        </div>
                        <button
                          onClick={() =>
                            updateConfig({ showDevTools: !config.showDevTools })
                          }
                          className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                            config.showDevTools
                              ? 'bg-[var(--accent)]'
                              : 'bg-[var(--line-strong)]'
                          }`}
                        >
                          <span
                            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                              config.showDevTools
                                ? 'translate-x-5'
                                : 'translate-x-0'
                            }`}
                          />
                        </button>
                      </div>
                    </div>

                    {/* Legacy Chat History Entry */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                      <div className="flex items-center justify-between">
                        <div className="flex-1 pr-4">
                          <h3 className="text-sm font-medium text-[var(--ink)]">
                            {tSettings('about.developer.chatHistoryEntryTitle')}
                          </h3>
                          <p className="mt-1 text-xs text-[var(--ink-muted)]">
                            {tSettings(
                              'about.developer.chatHistoryEntryDescription',
                            )}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            updateConfig({
                              showChatHistoryEntry:
                                config.showChatHistoryEntry !== true,
                            })
                          }
                          aria-label={tSettings(
                            'about.developer.chatHistoryEntryTitle',
                          )}
                          aria-pressed={config.showChatHistoryEntry === true}
                          className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                            config.showChatHistoryEntry === true
                              ? 'bg-[var(--accent)]'
                              : 'bg-[var(--line-strong)]'
                          }`}
                        >
                          <span
                            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                              config.showChatHistoryEntry === true
                                ? 'translate-x-5'
                                : 'translate-x-0'
                            }`}
                          />
                        </button>
                      </div>
                    </div>

                    {/* Desktop Pet Gate */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                      <div className="flex items-center justify-between">
                        <div className="flex-1 pr-4">
                          <h3 className="text-sm font-medium text-[var(--ink)]">
                            {tSettings('about.desktopPetTitle')}
                          </h3>
                          <p className="mt-1 text-xs text-[var(--ink-muted)]">
                            {tSettings('about.desktopPetDescription')}
                          </p>
                        </div>
                        <button
                          onClick={() => void toggleFloatingBallGate()}
                          disabled={floatingBallGateBusy}
                          aria-pressed={config.floatingBallDevGate !== false}
                          className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors disabled:cursor-wait disabled:opacity-70 ${
                            config.floatingBallDevGate !== false
                              ? 'bg-[var(--accent)]'
                              : 'bg-[var(--line-strong)]'
                          }`}
                        >
                          <span
                            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                              config.floatingBallDevGate !== false
                                ? 'translate-x-5'
                                : 'translate-x-0'
                            }`}
                          />
                        </button>
                      </div>
                    </div>

                    {/* Managed Codex Provider Gate */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                      <div className="flex items-center justify-between">
                        <div className="flex-1 pr-4">
                          <h3 className="text-sm font-medium text-[var(--ink)]">
                            {tSettings('about.developer.codexProviderTitle')}
                          </h3>
                          <p className="mt-1 text-xs text-[var(--ink-muted)]">
                            {tSettings(
                              'about.developer.codexProviderDescription',
                            )}
                          </p>
                        </div>
                        <button
                          onClick={() => {
                            const nextEnabled =
                              !managedCodexProviderGateEnabled;
                            console.info(
                              `[managed-codex] developer gate toggle requested runtime=codex runtimeSource=managed-provider enabled=${nextEnabled}`,
                            );
                            updateConfig({
                              managedCodexProviderDevGate: nextEnabled,
                            });
                          }}
                          aria-pressed={managedCodexProviderGateEnabled}
                          className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                            managedCodexProviderGateEnabled
                              ? 'bg-[var(--accent)]'
                              : 'bg-[var(--line-strong)]'
                          }`}
                        >
                          <span
                            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                              managedCodexProviderGateEnabled
                                ? 'translate-x-5'
                                : 'translate-x-0'
                            }`}
                          />
                        </button>
                      </div>
                    </div>

                    {spaceBuildCapability.available &&
                      availableSpaceEnvironments.has('dev') && (
                        <SpaceEnvironmentSwitch
                          activeEnvironment={activeSpaceEnvironment}
                          origin={spaceBuildCapability.baseUrl ?? ''}
                          onChange={updateSpaceEnvironment}
                        />
                      )}

                    {/* Split View Toggle */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="text-sm font-medium text-[var(--ink)]">
                            {tSettings('about.developer.splitViewTitle')}
                          </h3>
                          <p className="mt-1 text-xs text-[var(--ink-muted)]">
                            {tSettings('about.developer.splitViewDescription')}
                          </p>
                        </div>
                        <button
                          onClick={() =>
                            updateConfig({
                              experimentalSplitView: !(
                                config.experimentalSplitView ?? true
                              ),
                            })
                          }
                          className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                            (config.experimentalSplitView ?? true)
                              ? 'bg-[var(--accent)]'
                              : 'bg-[var(--line-strong)]'
                          }`}
                        >
                          <span
                            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                              (config.experimentalSplitView ?? true)
                                ? 'translate-x-5'
                                : 'translate-x-0'
                            }`}
                          />
                        </button>
                      </div>
                    </div>

                    {/* #264 — Background-agent permission policy */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                      <div className="flex items-center justify-between">
                        <div className="flex-1 pr-4">
                          <h3 className="text-sm font-medium text-[var(--ink)]">
                            {tSettings(
                              'about.developer.backgroundAgentPermissionTitle',
                            )}
                          </h3>
                          <p className="mt-1 text-xs text-[var(--ink-muted)]">
                            {tSettings(
                              'about.developer.backgroundAgentPermissionPrefix',
                            )}{' '}
                            <span className="font-mono">run_in_background</span>{' '}
                            {tSettings(
                              'about.developer.backgroundAgentPermissionSuffix',
                            )}
                          </p>
                        </div>
                        <CustomSelect
                          value={
                            config.backgroundAgentPermissionMode ?? 'inherit'
                          }
                          options={[
                            {
                              value: 'inherit',
                              label: tSettings(
                                'about.developer.backgroundAgentPermissionInherit',
                              ),
                            },
                            {
                              value: 'fullAgency',
                              label: tSettings(
                                'about.developer.backgroundAgentPermissionFullAgency',
                              ),
                            },
                          ]}
                          onChange={(val) => {
                            updateConfig({
                              backgroundAgentPermissionMode: val as
                                | 'inherit'
                                | 'fullAgency',
                            });
                          }}
                          className="w-32 shrink-0"
                        />
                      </div>
                    </div>

                    {/* LiteLLM Model Data Refresh Toggle */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="text-sm font-medium text-[var(--ink)]">
                            {tSettings('about.developer.liteLlmRefreshTitle')}
                          </h3>
                          <p className="mt-1 text-xs text-[var(--ink-muted)]">
                            {tSettings(
                              'about.developer.liteLlmRefreshDescription',
                            )}
                          </p>
                        </div>
                        <button
                          onClick={() =>
                            updateConfig({
                              liteLLMModelDataRefresh: !(
                                config.liteLLMModelDataRefresh ?? true
                              ),
                            })
                          }
                          className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                            (config.liteLLMModelDataRefresh ?? true)
                              ? 'bg-[var(--accent)]'
                              : 'bg-[var(--line-strong)]'
                          }`}
                        >
                          <span
                            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                              (config.liteLLMModelDataRefresh ?? true)
                                ? 'translate-x-5'
                                : 'translate-x-0'
                            }`}
                          />
                        </button>
                      </div>
                    </div>

                    {/* Eager Fork Toggle (PRD 0.2.27) */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="text-sm font-medium text-[var(--ink)]">
                            {tSettings('about.developer.eagerForkTitle')}
                          </h3>
                          <p className="mt-1 text-xs text-[var(--ink-muted)]">
                            {tSettings('about.developer.eagerForkDescription')}
                          </p>
                        </div>
                        <button
                          onClick={() =>
                            updateConfig({
                              eagerFork: !(config.eagerFork ?? true),
                            })
                          }
                          className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                            (config.eagerFork ?? true)
                              ? 'bg-[var(--accent)]'
                              : 'bg-[var(--line-strong)]'
                          }`}
                        >
                          <span
                            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                              (config.eagerFork ?? true)
                                ? 'translate-x-5'
                                : 'translate-x-0'
                            }`}
                          />
                        </button>
                      </div>
                    </div>

                    {/* Claude transcript retention */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <h3 className="text-sm font-medium text-[var(--ink)]">
                            {tSettings(
                              'about.developer.claudeTranscriptRetentionTitle',
                            )}
                          </h3>
                          <p className="mt-1 text-xs text-[var(--ink-muted)]">
                            {tSettings(
                              'about.developer.claudeTranscriptRetentionDescription',
                            )}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <input
                            type="text"
                            inputMode="numeric"
                            value={claudeTranscriptCleanupDaysDraft}
                            onChange={(e) =>
                              setClaudeTranscriptCleanupDaysDraft(
                                e.target.value.replace(/[^0-9]/g, ''),
                              )
                            }
                            onBlur={commitClaudeTranscriptCleanupDays}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') e.currentTarget.blur();
                            }}
                            aria-label={tSettings(
                              'about.developer.claudeTranscriptRetentionTitle',
                            )}
                            className="w-24 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-right text-xs text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:border-[var(--focus-border)] focus:outline-none"
                            placeholder={String(
                              DEFAULT_CLAUDE_TRANSCRIPT_CLEANUP_PERIOD_DAYS,
                            )}
                          />
                          <span className="text-xs text-[var(--ink-muted)]">
                            {tSettings('about.developer.daysUnit')}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Build Versions */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                      <h3 className="mb-3 text-sm font-medium text-[var(--ink)]">
                        {tSettings('about.developer.buildInfoTitle')}
                      </h3>
                      <div className="space-y-2 text-xs">
                        {(() => {
                          const versions = getBuildVersions();
                          return (
                            <>
                              <div className="flex justify-between">
                                <span className="text-[var(--ink-muted)]">
                                  Claude Agent SDK
                                </span>
                                <span className="font-mono text-[var(--ink)]">
                                  {versions.claudeAgentSdk}
                                </span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-[var(--ink-muted)]">
                                  Node.js Runtime
                                </span>
                                <span className="font-mono text-[var(--ink)]">
                                  {versions.node}
                                </span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-[var(--ink-muted)]">
                                  Tauri
                                </span>
                                <span className="font-mono text-[var(--ink)]">
                                  {versions.tauri}
                                </span>
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    </div>

                    {/* Cron Task Debug Panel */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="text-sm font-medium text-[var(--ink)]">
                            {tSettings('about.developer.cronTaskTitle')}
                          </h3>
                          <p className="mt-1 text-xs text-[var(--ink-muted)]">
                            {tSettings('about.developer.cronTaskDescription')}
                          </p>
                        </div>
                        <button
                          onClick={() => setShowCronDebugPanel(true)}
                          className="rounded-lg bg-[var(--paper-inset)] px-3 py-1.5 text-xs font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-elevated)]"
                        >
                          {tSettings('about.developer.openPanel')}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Cron Task Debug Panel Modal */}
              <CronTaskDebugPanel
                isOpen={showCronDebugPanel}
                onClose={() => setShowCronDebugPanel(false)}
              />
            </div>
          )}
        </div>
      </div>

      {/* Official image understanding tool settings */}
      {visionToolSettingsOpen && (
        <OverlayBackdrop
          onClose={closeVisionToolSettings}
          className="z-50"
        >
          <div className="mx-4 flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-xl">
            <div className="flex items-center justify-between border-b border-[var(--line)] px-6 py-4">
              <div className="min-w-0 flex-1">
                <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--ink)]">
                  <ImageIcon className="h-4 w-4 text-[var(--accent-warm)]" />
                  {tSettings('toolbox.dialogs.vision.title')}
                </h2>
                <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                  {tSettings('toolbox.dialogs.vision.description')}
                </p>
              </div>
              <button
                onClick={closeVisionToolSettings}
                disabled={visionToolSaving}
                className="shrink-0 rounded-lg p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4 overflow-y-auto p-6">
              <div>
                <label className="mb-2 block text-sm font-medium text-[var(--ink)]">
                  {tSettings('toolbox.dialogs.vision.model')}
                </label>
                <CustomSelect
                  value={visionToolDraftValue}
                  options={visionModelOptions}
                  onChange={setVisionToolDraftValue}
                  placeholder={
                    visionModelOptions.length > 0
                      ? tSettings('toolbox.dialogs.vision.selectModel')
                      : tSettings('toolbox.dialogs.vision.noImageModels')
                  }
                  size="md"
                />
                {visionModelsLoading && (
                  <p className="mt-2 text-xs text-[var(--ink-muted)]">
                    {tSettings('toolbox.dialogs.vision.loadingModels')}
                  </p>
                )}
                {!visionModelsLoading && visionModelsLoadFailed && (
                  <p className="mt-2 text-xs text-[var(--warning)]">
                    {tSettings('toolbox.dialogs.vision.loadModelsFailed')}
                  </p>
                )}
                {!visionModelsLoading &&
                  !visionModelsLoadFailed &&
                  visionModelOptions.length === 0 && (
                    <p className="mt-2 text-xs text-[var(--warning)]">
                      {tSettings('toolbox.dialogs.vision.noImageModelsWarning')}
                    </p>
                  )}
                {selectedVisionModelCandidate?.capabilityConfidence ===
                  'unknown' && (
                  <p className="mt-2 text-xs text-[var(--warning)]">
                    {tSettings('toolbox.dialogs.vision.confirmUnknownWarning')}
                  </p>
                )}
                {selectedVisionModelCandidate?.capabilityConfidence ===
                  'inferred' && (
                  <p className="mt-2 text-xs text-[var(--ink-muted)]">
                    {tSettings('toolbox.dialogs.vision.inferredHint')}
                  </p>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-[var(--line)] px-6 py-4">
              <button
                onClick={closeVisionToolSettings}
                disabled={visionToolSaving}
                className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {tSettings('toolbox.common.cancel')}
              </button>
              <button
                onClick={() => void saveVisionToolSettings()}
                disabled={
                  visionToolSaving ||
                  !parseVisionModelOptionValue(visionToolDraftValue)
                }
                className="rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {tSettings('toolbox.common.save')}
              </button>
            </div>
          </div>
        </OverlayBackdrop>
      )}

      {/* Builtin MCP Settings Modal */}
      {builtinMcpSettings && (
        <OverlayBackdrop className="z-50">
          <div className="mx-4 w-full max-w-lg rounded-2xl bg-[var(--paper-elevated)] shadow-xl max-h-[85vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--line)]">
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-semibold text-[var(--ink)]">
                  {tSettings('toolbox.dialogs.builtinMcp.title', {
                    name: builtinMcpSettings.server.name,
                  })}
                </h2>
                {builtinMcpSettings.server.description && (
                  <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                    {builtinMcpSettings.server.description}
                  </p>
                )}
              </div>
              <button
                onClick={() => setBuiltinMcpSettings(null)}
                className="shrink-0 rounded-lg p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
              {/* Preset command/URL (read-only) */}
              <div>
                <label className="block text-sm font-medium text-[var(--ink)] mb-1">
                  {builtinMcpSettings.server.type === 'stdio'
                    ? tSettings('toolbox.dialogs.builtinMcp.presetCommand')
                    : tSettings('toolbox.dialogs.builtinMcp.serviceUrl')}
                </label>
                <div className="rounded-lg bg-[var(--paper-inset)] px-3 py-2 font-mono text-xs text-[var(--ink-muted)]">
                  {builtinMcpSettings.server.type === 'stdio'
                    ? `${builtinMcpSettings.server.command} ${(getPresetMcpServer(builtinMcpSettings.server.id)?.args ?? []).join(' ')}`
                    : (builtinMcpSettings.server.url?.replace(
                        /\{\{\w+\}\}/g,
                        '***',
                      ) ?? '')}
                </div>
              </div>

              {/* Extra Args (stdio only) */}
              {builtinMcpSettings.server.type === 'stdio' && (
                <div>
                  <label className="block text-sm font-medium text-[var(--ink)] mb-1">
                    {tSettings('toolbox.dialogs.builtinMcp.extraArgs')}
                  </label>
                  <p className="text-xs text-[var(--ink-muted)] mb-2">
                    {tSettings('toolbox.dialogs.builtinMcp.extraArgsHint')}
                  </p>
                  <div className="space-y-2">
                    {builtinMcpSettings.extraArgs.map((arg, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <span className="flex-1 rounded-lg bg-[var(--paper-inset)] px-3 py-1.5 font-mono text-xs text-[var(--ink)] break-all">
                          {arg}
                        </span>
                        <button
                          onClick={() =>
                            setBuiltinMcpSettings((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    extraArgs: prev.extraArgs.filter(
                                      (_, i) => i !== idx,
                                    ),
                                  }
                                : null,
                            )
                          }
                          className="shrink-0 rounded p-1 text-[var(--error)] hover:bg-[var(--error-bg)]"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={builtinMcpSettings.newArg}
                        onChange={(e) =>
                          setBuiltinMcpSettings((prev) =>
                            prev ? { ...prev, newArg: e.target.value } : null,
                          )
                        }
                        onKeyDown={(e) => {
                          if (
                            e.key === 'Enter' &&
                            builtinMcpSettings.newArg.trim()
                          ) {
                            setBuiltinMcpSettings((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    extraArgs: [
                                      ...prev.extraArgs,
                                      prev.newArg.trim(),
                                    ],
                                    newArg: '',
                                  }
                                : null,
                            );
                          }
                        }}
                        placeholder={tSettings(
                          'toolbox.dialogs.builtinMcp.argPlaceholder',
                        )}
                        className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)]"
                      />
                      <button
                        onClick={() => {
                          if (builtinMcpSettings.newArg.trim()) {
                            setBuiltinMcpSettings((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    extraArgs: [
                                      ...prev.extraArgs,
                                      prev.newArg.trim(),
                                    ],
                                    newArg: '',
                                  }
                                : null,
                            );
                          }
                        }}
                        disabled={!builtinMcpSettings.newArg.trim()}
                        className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--on-accent)] disabled:opacity-40"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Config hint + website link */}
              {(builtinMcpSettings.server.configHint ||
                builtinMcpSettings.server.websiteUrl) && (
                <div className="flex items-center gap-2 rounded-lg bg-[var(--accent-bg)] px-3 py-2 text-xs text-[var(--ink-secondary)]">
                  <Globe className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                  <span>{builtinMcpSettings.server.configHint}</span>
                  {builtinMcpSettings.server.websiteUrl && (
                    <ExternalLink
                      href={builtinMcpSettings.server.websiteUrl}
                      className="ml-auto shrink-0 font-medium text-[var(--accent)] hover:underline"
                    >
                      {tSettings('toolbox.dialogs.builtinMcp.register')}
                    </ExternalLink>
                  )}
                </div>
              )}

              {/* Environment Variables */}
              <div>
                <label className="block text-sm font-medium text-[var(--ink)] mb-1">
                  {tSettings('toolbox.dialogs.builtinMcp.environmentVariables')}
                </label>
                <div className="space-y-2">
                  {Object.entries(builtinMcpSettings.env).map(
                    ([key, value]) => (
                      <div key={key} className="flex items-center gap-2">
                        <span className="shrink-0 rounded bg-[var(--paper-inset)] px-2 py-1 font-mono text-xs text-[var(--ink)]">
                          {key}
                        </span>
                        <input
                          type="text"
                          value={value}
                          onChange={(e) =>
                            setBuiltinMcpSettings((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    env: { ...prev.env, [key]: e.target.value },
                                  }
                                : null,
                            )
                          }
                          className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1 font-mono text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                        />
                        <button
                          onClick={() =>
                            setBuiltinMcpSettings((prev) => {
                              if (!prev) return null;
                              const newEnv = { ...prev.env };
                              delete newEnv[key];
                              return { ...prev, env: newEnv };
                            })
                          }
                          className="shrink-0 rounded p-1 text-[var(--error)] hover:bg-[var(--error-bg)]"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ),
                  )}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={builtinMcpSettings.newEnvKey}
                      onChange={(e) =>
                        setBuiltinMcpSettings((prev) =>
                          prev ? { ...prev, newEnvKey: e.target.value } : null,
                        )
                      }
                      placeholder={tSettings(
                        'toolbox.common.envKeyPlaceholder',
                      )}
                      className="w-1/3 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 font-mono text-sm text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)]"
                    />
                    <input
                      type="text"
                      value={builtinMcpSettings.newEnvValue}
                      onChange={(e) =>
                        setBuiltinMcpSettings((prev) =>
                          prev
                            ? { ...prev, newEnvValue: e.target.value }
                            : null,
                        )
                      }
                      placeholder={tSettings('toolbox.common.valuePlaceholder')}
                      className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 font-mono text-sm text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)]"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          const key = builtinMcpSettings.newEnvKey.trim();
                          if (key && !(key in builtinMcpSettings.env)) {
                            setBuiltinMcpSettings((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    env: {
                                      ...prev.env,
                                      [key]: prev.newEnvValue,
                                    },
                                    newEnvKey: '',
                                    newEnvValue: '',
                                  }
                                : null,
                            );
                          }
                        }
                      }}
                    />
                    <button
                      onClick={() => {
                        const key = builtinMcpSettings.newEnvKey.trim();
                        if (key && !(key in builtinMcpSettings.env)) {
                          setBuiltinMcpSettings((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  env: { ...prev.env, [key]: prev.newEnvValue },
                                  newEnvKey: '',
                                  newEnvValue: '',
                                }
                              : null,
                          );
                        }
                      }}
                      disabled={
                        !builtinMcpSettings.newEnvKey.trim() ||
                        builtinMcpSettings.newEnvKey.trim() in
                          builtinMcpSettings.env
                      }
                      className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--on-accent)] disabled:opacity-40"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-3 border-t border-[var(--line)] px-6 py-4">
              <button
                onClick={() => setBuiltinMcpSettings(null)}
                className="rounded-lg px-4 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
              >
                {tSettings('toolbox.common.cancel')}
              </button>
              <button
                onClick={handleSaveBuiltinMcp}
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--on-accent)] hover:bg-[var(--accent)]/90"
              >
                {tSettings('toolbox.common.save')}
              </button>
            </div>
          </div>
        </OverlayBackdrop>
      )}

      {/* Gemini Image Settings Modal */}
      {geminiImageSettings && (
        <OverlayBackdrop className="z-50">
          <div className="mx-4 w-full max-w-lg rounded-2xl bg-[var(--paper-elevated)] shadow-xl max-h-[85vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--line)]">
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-semibold text-[var(--ink)]">
                  {tSettings('toolbox.dialogs.geminiImage.title')}
                </h2>
                {getPresetMcpServer('gemini-image')?.description && (
                  <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                    {getPresetMcpServer('gemini-image')?.description}
                  </p>
                )}
              </div>
              <button
                onClick={() => setGeminiImageSettings(null)}
                className="shrink-0 rounded-lg p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
              {/* API Key */}
              <div>
                <label className="block text-sm font-medium text-[var(--ink)] mb-1">
                  API Key *
                </label>
                <input
                  type="password"
                  value={geminiImageSettings.apiKey}
                  onChange={(e) =>
                    setGeminiImageSettings((prev) =>
                      prev ? { ...prev, apiKey: e.target.value } : null,
                    )
                  }
                  placeholder="AIzaSy..."
                  className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)] font-mono"
                />
                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                  {tSettings('toolbox.dialogs.geminiImage.apiKeyHintPrefix')}
                  <a
                    href="https://aistudio.google.com/apikey"
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--accent)] hover:underline"
                  >
                    aistudio.google.com
                  </a>
                  {tSettings('toolbox.dialogs.geminiImage.apiKeyHintSuffix')}
                </p>
              </div>

              {/* Base URL */}
              <div>
                <label className="block text-sm font-medium text-[var(--ink)] mb-1">
                  API Base URL
                </label>
                <input
                  type="text"
                  value={geminiImageSettings.baseUrl}
                  onChange={(e) =>
                    setGeminiImageSettings((prev) =>
                      prev ? { ...prev, baseUrl: e.target.value } : null,
                    )
                  }
                  placeholder={tSettings(
                    'toolbox.dialogs.geminiImage.baseUrlPlaceholder',
                  )}
                  className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)] font-mono"
                />
                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                  {tSettings('toolbox.dialogs.geminiImage.baseUrlHint')}
                </p>
              </div>

              {/* Model */}
              <div>
                <label className="block text-sm font-medium text-[var(--ink)] mb-2">
                  {tSettings('toolbox.dialogs.geminiImage.model')}
                </label>
                <div className="flex flex-wrap gap-2">
                  {[
                    {
                      id: 'gemini-2.5-flash-image',
                      label: 'Nano Banana',
                      desc: tSettings(
                        'toolbox.dialogs.geminiImage.modelDescStable',
                      ),
                    },
                    {
                      id: 'gemini-3-pro-image-preview',
                      label: 'Nano Banana Pro',
                      desc: tSettings(
                        'toolbox.dialogs.geminiImage.modelDescBestQuality',
                      ),
                    },
                    {
                      id: 'gemini-3.1-flash-image-preview',
                      label: 'Nano Banana 2',
                      desc: tSettings(
                        'toolbox.dialogs.geminiImage.modelDescBalanced',
                      ),
                    },
                  ].map((m) => (
                    <button
                      key={m.id}
                      onClick={() =>
                        setGeminiImageSettings((prev) =>
                          prev ? { ...prev, model: m.id } : null,
                        )
                      }
                      className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                        geminiImageSettings.model === m.id
                          ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                          : 'border-[var(--line)] text-[var(--ink-muted)] hover:border-[var(--ink-muted)]'
                      }`}
                    >
                      <div className="font-medium">{m.label}</div>
                      <div className="text-xs opacity-70">{m.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Aspect Ratio */}
              <div>
                <label className="block text-sm font-medium text-[var(--ink)] mb-2">
                  {tSettings('toolbox.dialogs.geminiImage.defaultAspectRatio')}
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    'auto',
                    '1:1',
                    '3:4',
                    '4:3',
                    '9:16',
                    '16:9',
                    '2:3',
                    '3:2',
                    '4:5',
                    '5:4',
                    '21:9',
                  ].map((r) => (
                    <button
                      key={r}
                      onClick={() =>
                        setGeminiImageSettings((prev) =>
                          prev ? { ...prev, aspectRatio: r } : null,
                        )
                      }
                      className={`rounded-md px-2.5 py-1 text-xs transition-colors ${r !== 'auto' ? 'font-mono' : ''} ${
                        geminiImageSettings.aspectRatio === r
                          ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                          : 'bg-[var(--paper-inset)] text-[var(--ink-muted)] hover:text-[var(--ink)]'
                      }`}
                    >
                      {r === 'auto' ? tSettings('toolbox.common.auto') : r}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                  {tSettings('toolbox.dialogs.geminiImage.autoAspectHint')}
                </p>
              </div>

              {/* Resolution */}
              <div>
                <label className="block text-sm font-medium text-[var(--ink)] mb-2">
                  {tSettings('toolbox.dialogs.geminiImage.defaultResolution')}
                </label>
                <div className="flex gap-2">
                  {['auto', '1K', '2K', '4K'].map((s) => (
                    <button
                      key={s}
                      onClick={() =>
                        setGeminiImageSettings((prev) =>
                          prev ? { ...prev, imageSize: s } : null,
                        )
                      }
                      className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
                        geminiImageSettings.imageSize === s
                          ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                          : 'bg-[var(--paper-inset)] text-[var(--ink-muted)] hover:text-[var(--ink)]'
                      }`}
                    >
                      {s === 'auto' ? tSettings('toolbox.common.auto') : s}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                  {tSettings('toolbox.dialogs.geminiImage.autoResolutionHint')}
                </p>
              </div>

              {/* Advanced Section Divider */}
              <div className="border-t border-[var(--line)] pt-4">
                <span className="text-sm font-medium text-[var(--ink-muted)]">
                  {tSettings('toolbox.common.advancedSettings')}
                </span>
              </div>

              {/* Thinking Level */}
              <div>
                <label className="block text-sm font-medium text-[var(--ink)] mb-2">
                  {tSettings('toolbox.dialogs.geminiImage.thinkingLevel')}
                </label>
                <div className="flex gap-2">
                  {[
                    {
                      id: 'auto',
                      label: tSettings(
                        'toolbox.dialogs.geminiImage.thinkingAuto',
                      ),
                      desc: tSettings(
                        'toolbox.dialogs.geminiImage.thinkingAutoDesc',
                      ),
                    },
                    {
                      id: 'minimal',
                      label: tSettings(
                        'toolbox.dialogs.geminiImage.thinkingMinimal',
                      ),
                      desc: tSettings(
                        'toolbox.dialogs.geminiImage.thinkingMinimalDesc',
                      ),
                    },
                    {
                      id: 'high',
                      label: tSettings(
                        'toolbox.dialogs.geminiImage.thinkingHigh',
                      ),
                      desc: tSettings(
                        'toolbox.dialogs.geminiImage.thinkingHighDesc',
                      ),
                    },
                  ].map((t) => (
                    <button
                      key={t.id}
                      onClick={() =>
                        setGeminiImageSettings((prev) =>
                          prev ? { ...prev, thinkingLevel: t.id } : null,
                        )
                      }
                      className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                        geminiImageSettings.thinkingLevel === t.id
                          ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                          : 'border-[var(--line)] text-[var(--ink-muted)] hover:border-[var(--ink-muted)]'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Search Grounding */}
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-[var(--ink)]">
                    {tSettings('toolbox.dialogs.geminiImage.searchGrounding')}
                  </div>
                  <div className="text-xs text-[var(--ink-muted)]">
                    {tSettings(
                      'toolbox.dialogs.geminiImage.searchGroundingDescription',
                    )}
                  </div>
                </div>
                <button
                  onClick={() =>
                    setGeminiImageSettings((prev) =>
                      prev
                        ? { ...prev, searchGrounding: !prev.searchGrounding }
                        : null,
                    )
                  }
                  className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                    geminiImageSettings.searchGrounding
                      ? 'bg-[var(--accent)]'
                      : 'bg-[var(--line-strong)]'
                  }`}
                >
                  <span
                    className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                      geminiImageSettings.searchGrounding
                        ? 'translate-x-5'
                        : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* Max Context Turns */}
              <div>
                <label className="block text-sm font-medium text-[var(--ink)] mb-1">
                  {tSettings('toolbox.dialogs.geminiImage.maxContextTurns')}
                </label>
                <input
                  type="number"
                  min={2}
                  max={50}
                  value={geminiImageSettings.maxContextTurns}
                  onChange={(e) =>
                    setGeminiImageSettings((prev) =>
                      prev
                        ? {
                            ...prev,
                            maxContextTurns: parseInt(e.target.value, 10) || 20,
                          }
                        : null,
                    )
                  }
                  className="w-20 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                />
                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                  {tSettings('toolbox.dialogs.geminiImage.maxContextTurnsHint')}
                </p>
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-3 border-t border-[var(--line)] px-6 py-4">
              <button
                onClick={() => setGeminiImageSettings(null)}
                className="rounded-lg px-4 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
              >
                {tSettings('toolbox.common.cancel')}
              </button>
              <button
                onClick={handleSaveGeminiImage}
                disabled={!geminiImageSettings.apiKey.trim()}
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--on-accent)] hover:bg-[var(--accent)]/90 disabled:opacity-40"
              >
                {tSettings('toolbox.common.save')}
              </button>
            </div>
          </div>
        </OverlayBackdrop>
      )}

      {/* Playwright Settings Modal */}
      {playwrightSettings && (
        <OverlayBackdrop className="z-50">
          <div className="mx-4 w-full max-w-lg rounded-2xl bg-[var(--paper-elevated)] shadow-xl max-h-[85vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--line)]">
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-semibold text-[var(--ink)]">
                  {tSettings('toolbox.dialogs.playwright.title')}
                </h2>
                {getPresetMcpServer('playwright')?.description && (
                  <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                    {getPresetMcpServer('playwright')?.description}
                  </p>
                )}
              </div>
              <button
                onClick={() => setPlaywrightSettings(null)}
                className="shrink-0 rounded-lg p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
              {/* Headless Mode */}
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-[var(--ink)]">
                    {tSettings('toolbox.dialogs.playwright.headless')}
                  </div>
                  <div className="text-xs text-[var(--ink-muted)]">
                    {tSettings(
                      'toolbox.dialogs.playwright.headlessDescription',
                    )}
                  </div>
                </div>
                <button
                  onClick={() =>
                    setPlaywrightSettings((prev) =>
                      prev ? { ...prev, headless: !prev.headless } : null,
                    )
                  }
                  className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                    playwrightSettings.headless
                      ? 'bg-[var(--accent)]'
                      : 'bg-[var(--line-strong)]'
                  }`}
                >
                  <span
                    className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                      playwrightSettings.headless
                        ? 'translate-x-5'
                        : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* Browser */}
              <div>
                <label className="block text-sm font-medium text-[var(--ink)] mb-2">
                  {tSettings('toolbox.dialogs.playwright.browser')}
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {(() => {
                    const knownBrowsers = [
                      {
                        id: '',
                        label: tSettings(
                          'toolbox.dialogs.playwright.defaultChromium',
                        ),
                      },
                      { id: 'chrome', label: 'Chrome' },
                      { id: 'firefox', label: 'Firefox' },
                      { id: 'webkit', label: 'WebKit' },
                      { id: 'msedge', label: 'Edge' },
                    ];
                    const isKnown = knownBrowsers.some(
                      (b) => b.id === playwrightSettings.browser,
                    );
                    const items = isKnown
                      ? knownBrowsers
                      : [
                          ...knownBrowsers,
                          {
                            id: playwrightSettings.browser,
                            label: playwrightSettings.browser,
                          },
                        ];
                    return items.map((b) => (
                      <button
                        key={b.id}
                        onClick={() =>
                          setPlaywrightSettings((prev) =>
                            prev ? { ...prev, browser: b.id } : null,
                          )
                        }
                        className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                          playwrightSettings.browser === b.id
                            ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                            : 'bg-[var(--paper-inset)] text-[var(--ink-muted)] hover:text-[var(--ink)]'
                        }`}
                      >
                        {b.label}
                      </button>
                    ));
                  })()}
                </div>
              </div>

              {/* Device Emulation */}
              <div>
                <label className="block text-sm font-medium text-[var(--ink)] mb-2">
                  {tSettings('toolbox.dialogs.playwright.deviceEmulation')}
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    {
                      id: '',
                      label: tSettings(
                        'toolbox.dialogs.playwright.noEmulation',
                      ),
                    },
                    ...PLAYWRIGHT_DEVICE_PRESETS.map((name) => ({
                      id: name,
                      label: name,
                    })),
                    {
                      id: '__custom__',
                      label: tSettings('toolbox.dialogs.playwright.custom'),
                    },
                  ].map((d) => (
                    <button
                      key={d.id}
                      onClick={() =>
                        setPlaywrightSettings((prev) =>
                          prev ? { ...prev, device: d.id } : null,
                        )
                      }
                      className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                        playwrightSettings.device === d.id
                          ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                          : 'bg-[var(--paper-inset)] text-[var(--ink-muted)] hover:text-[var(--ink)]'
                      }`}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
                {playwrightSettings.device === '__custom__' && (
                  <input
                    type="text"
                    value={playwrightSettings.customDevice}
                    onChange={(e) =>
                      setPlaywrightSettings((prev) =>
                        prev ? { ...prev, customDevice: e.target.value } : null,
                      )
                    }
                    placeholder={tSettings(
                      'toolbox.dialogs.playwright.customDevicePlaceholder',
                    )}
                    className="mt-2 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)]"
                  />
                )}
              </div>

              {/* Browser Mode Selector */}
              <div>
                <label className="block text-sm font-medium text-[var(--ink)] mb-2">
                  {tSettings('toolbox.dialogs.playwright.browserMode')}
                </label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    aria-pressed={playwrightSettings.mode === 'isolated'}
                    onClick={() =>
                      setPlaywrightSettings((prev) =>
                        prev ? { ...prev, mode: 'isolated' } : null,
                      )
                    }
                    className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      playwrightSettings.mode === 'isolated'
                        ? 'border-[var(--accent)] bg-[var(--accent)]/5'
                        : 'border-[var(--line)] hover:border-[var(--line-strong)]'
                    }`}
                  >
                    <div
                      className={`text-xs font-medium ${playwrightSettings.mode === 'isolated' ? 'text-[var(--accent)]' : 'text-[var(--ink)]'}`}
                    >
                      {tSettings('toolbox.dialogs.playwright.isolatedMode')}
                    </div>
                    <div className="text-xs text-[var(--ink-muted)] mt-0.5 leading-tight">
                      {tSettings(
                        'toolbox.dialogs.playwright.isolatedModeDescription',
                      )}
                    </div>
                  </button>
                  <button
                    type="button"
                    aria-pressed={playwrightSettings.mode === 'persistent'}
                    onClick={() =>
                      setPlaywrightSettings((prev) =>
                        prev ? { ...prev, mode: 'persistent' } : null,
                      )
                    }
                    className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      playwrightSettings.mode === 'persistent'
                        ? 'border-[var(--accent)] bg-[var(--accent)]/5'
                        : 'border-[var(--line)] hover:border-[var(--line-strong)]'
                    }`}
                  >
                    <div
                      className={`text-xs font-medium ${playwrightSettings.mode === 'persistent' ? 'text-[var(--accent)]' : 'text-[var(--ink)]'}`}
                    >
                      {tSettings('toolbox.dialogs.playwright.persistentMode')}
                    </div>
                    <div className="text-xs text-[var(--ink-muted)] mt-0.5 leading-tight">
                      {tSettings(
                        'toolbox.dialogs.playwright.persistentModeDescription',
                      )}
                    </div>
                  </button>
                </div>
              </div>

              {/* Persistent Mode: user-data-dir + warning */}
              {playwrightSettings.mode === 'persistent' && (
                <div>
                  <label className="block text-sm font-medium text-[var(--ink)] mb-1">
                    {tSettings('toolbox.dialogs.playwright.userDataDir')}
                  </label>
                  <input
                    type="text"
                    value={playwrightSettings.userDataDir}
                    onChange={(e) =>
                      setPlaywrightSettings((prev) =>
                        prev ? { ...prev, userDataDir: e.target.value } : null,
                      )
                    }
                    placeholder="~/.playwright-mcp-profile"
                    className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)] font-mono"
                  />
                  <p className="mt-1.5 text-xs leading-relaxed text-[var(--ink-muted)]">
                    {tSettings('toolbox.dialogs.playwright.userDataDirHint')}
                  </p>
                  <div className="mt-2 rounded-lg bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--warning)]">
                    {tSettings('toolbox.dialogs.playwright.persistentWarning')}
                  </div>
                </div>
              )}

              {/* Advanced Section Divider */}
              <div className="border-t border-[var(--line)] pt-4">
                <span className="text-sm font-medium text-[var(--ink-muted)]">
                  {tSettings('toolbox.common.advancedSettings')}
                </span>
              </div>

              {/* Extra Args */}
              <div>
                <label className="block text-sm font-medium text-[var(--ink)] mb-1">
                  {tSettings('toolbox.dialogs.playwright.extraArgs')}
                </label>
                <p className="text-xs text-[var(--ink-muted)] mb-2">
                  {tSettings('toolbox.dialogs.playwright.extraArgsHint')}
                </p>
                <div className="space-y-2">
                  {playwrightSettings.extraArgs.map((arg, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <span className="flex-1 rounded-lg bg-[var(--paper-inset)] px-3 py-1.5 font-mono text-xs text-[var(--ink)] break-all">
                        {arg}
                      </span>
                      <button
                        onClick={() =>
                          setPlaywrightSettings((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  extraArgs: prev.extraArgs.filter(
                                    (_, i) => i !== idx,
                                  ),
                                }
                              : null,
                          )
                        }
                        className="shrink-0 rounded p-1 text-[var(--error)] hover:bg-[var(--error-bg)]"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={playwrightSettings.newArg}
                      onChange={(e) =>
                        setPlaywrightSettings((prev) =>
                          prev ? { ...prev, newArg: e.target.value } : null,
                        )
                      }
                      onKeyDown={(e) => {
                        if (
                          e.key === 'Enter' &&
                          playwrightSettings.newArg.trim()
                        ) {
                          appendPlaywrightAdvancedInput();
                        }
                      }}
                      placeholder={tSettings(
                        'toolbox.dialogs.playwright.argPlaceholder',
                      )}
                      className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)]"
                    />
                    <button
                      onClick={appendPlaywrightAdvancedInput}
                      disabled={!playwrightSettings.newArg.trim()}
                      className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--on-accent)] disabled:opacity-40"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-3 border-t border-[var(--line)] px-6 py-4">
              <button
                onClick={() => setPlaywrightSettings(null)}
                className="rounded-lg px-4 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
              >
                {tSettings('toolbox.common.cancel')}
              </button>
              <button
                onClick={handleSavePlaywright}
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--on-accent)] hover:bg-[var(--accent)]/90"
              >
                {tSettings('toolbox.common.save')}
              </button>
            </div>
          </div>
        </OverlayBackdrop>
      )}

      {/* Edge TTS Settings Modal */}
      {edgeTtsSettings && (
        <OverlayBackdrop className="z-50">
          <div className="mx-4 w-full max-w-lg rounded-2xl bg-[var(--paper-elevated)] shadow-xl max-h-[85vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--line)]">
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-semibold text-[var(--ink)]">
                  {tSettings('toolbox.dialogs.edgeTts.title')}
                </h2>
                {getPresetMcpServer('edge-tts')?.description && (
                  <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                    {getPresetMcpServer('edge-tts')?.description}
                  </p>
                )}
              </div>
              <button
                onClick={() => setEdgeTtsSettings(null)}
                className="shrink-0 rounded-lg p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
              {/* Free service notice */}
              <div className="rounded-lg bg-[var(--success-bg)] border border-[var(--success)]/20 px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-[var(--success)]">
                  <Check className="h-3.5 w-3.5" />
                  {tSettings('toolbox.dialogs.edgeTts.freeNotice')}
                </div>
              </div>

              {/* Default Voice */}
              <div>
                <label className="block text-sm font-medium text-[var(--ink)] mb-1">
                  {tSettings('toolbox.dialogs.edgeTts.defaultVoice')}
                </label>
                <input
                  type="text"
                  value={edgeTtsSettings.defaultVoice}
                  onChange={(e) =>
                    setEdgeTtsSettings((prev) =>
                      prev ? { ...prev, defaultVoice: e.target.value } : null,
                    )
                  }
                  placeholder="zh-CN-XiaoxiaoNeural"
                  className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)] font-mono"
                />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {[
                    {
                      id: 'zh-CN-XiaoxiaoNeural',
                      label: tSettings('toolbox.dialogs.edgeTts.voiceXiaoxiao'),
                    },
                    {
                      id: 'zh-CN-YunxiNeural',
                      label: tSettings('toolbox.dialogs.edgeTts.voiceYunxi'),
                    },
                    {
                      id: 'zh-CN-XiaomoNeural',
                      label: tSettings('toolbox.dialogs.edgeTts.voiceXiaomo'),
                    },
                    {
                      id: 'zh-CN-YunjianNeural',
                      label: tSettings('toolbox.dialogs.edgeTts.voiceYunjian'),
                    },
                    { id: 'en-US-JennyNeural', label: 'Jenny · English' },
                    { id: 'en-US-GuyNeural', label: 'Guy · English' },
                  ].map((v) => (
                    <button
                      key={v.id}
                      onClick={() =>
                        setEdgeTtsSettings((prev) =>
                          prev ? { ...prev, defaultVoice: v.id } : null,
                        )
                      }
                      className={`rounded-md px-2 py-1 text-xs transition-colors ${
                        edgeTtsSettings.defaultVoice === v.id
                          ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                          : 'bg-[var(--paper-inset)] text-[var(--ink-muted)] hover:text-[var(--ink)]'
                      }`}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Output Format */}
              <div>
                <label className="block text-sm font-medium text-[var(--ink)] mb-2">
                  {tSettings('toolbox.dialogs.edgeTts.outputFormat')}
                </label>
                <div className="flex gap-2">
                  {[
                    {
                      id: 'audio-24khz-48kbitrate-mono-mp3',
                      label: tSettings(
                        'toolbox.dialogs.edgeTts.mp3Recommended',
                      ),
                    },
                    { id: 'webm-24khz-16bit-mono-opus', label: 'WebM' },
                    { id: 'ogg-24khz-16bit-mono-opus', label: 'OGG' },
                  ].map((f) => (
                    <button
                      key={f.id}
                      onClick={() =>
                        setEdgeTtsSettings((prev) =>
                          prev ? { ...prev, defaultOutputFormat: f.id } : null,
                        )
                      }
                      className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
                        edgeTtsSettings.defaultOutputFormat === f.id
                          ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                          : 'bg-[var(--paper-inset)] text-[var(--ink-muted)] hover:text-[var(--ink)]'
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Voice Parameters Divider */}
              <div className="border-t border-[var(--line)] pt-4">
                <span className="text-sm font-medium text-[var(--ink-muted)]">
                  {tSettings('toolbox.dialogs.edgeTts.voiceParameters')}
                </span>
              </div>

              {/* Rate Slider */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm font-medium text-[var(--ink-muted)]">
                    {tSettings('toolbox.dialogs.edgeTts.rate')}
                  </label>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-[var(--ink)]">
                      {edgeTtsSettings.defaultRate >= 0 ? '+' : ''}
                      {edgeTtsSettings.defaultRate}%
                    </span>
                    {edgeTtsSettings.defaultRate !== 0 && (
                      <button
                        onClick={() =>
                          setEdgeTtsSettings((prev) =>
                            prev ? { ...prev, defaultRate: 0 } : null,
                          )
                        }
                        className="text-xs text-[var(--ink-muted)] hover:text-[var(--accent)]"
                      >
                        {tSettings('toolbox.common.reset')}
                      </button>
                    )}
                  </div>
                </div>
                <input
                  type="range"
                  min={-100}
                  max={200}
                  step={10}
                  value={edgeTtsSettings.defaultRate}
                  onChange={(e) =>
                    setEdgeTtsSettings((prev) =>
                      prev
                        ? { ...prev, defaultRate: parseInt(e.target.value, 10) }
                        : null,
                    )
                  }
                  className={ttsSliderClass}
                />
                <div className="flex justify-between text-xs text-[var(--ink-muted)] opacity-50">
                  <span>-100%</span>
                  <span>+200%</span>
                </div>
              </div>

              {/* Volume Slider */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm font-medium text-[var(--ink-muted)]">
                    {tSettings('toolbox.dialogs.edgeTts.volume')}
                  </label>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-[var(--ink)]">
                      {edgeTtsSettings.defaultVolume >= 0 ? '+' : ''}
                      {edgeTtsSettings.defaultVolume}%
                    </span>
                    {edgeTtsSettings.defaultVolume !== 0 && (
                      <button
                        onClick={() =>
                          setEdgeTtsSettings((prev) =>
                            prev ? { ...prev, defaultVolume: 0 } : null,
                          )
                        }
                        className="text-xs text-[var(--ink-muted)] hover:text-[var(--accent)]"
                      >
                        {tSettings('toolbox.common.reset')}
                      </button>
                    )}
                  </div>
                </div>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  step={10}
                  value={edgeTtsSettings.defaultVolume}
                  onChange={(e) =>
                    setEdgeTtsSettings((prev) =>
                      prev
                        ? {
                            ...prev,
                            defaultVolume: parseInt(e.target.value, 10),
                          }
                        : null,
                    )
                  }
                  className={ttsSliderClass}
                />
                <div className="flex justify-between text-xs text-[var(--ink-muted)] opacity-50">
                  <span>-100%</span>
                  <span>+100%</span>
                </div>
              </div>

              {/* Pitch Slider */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm font-medium text-[var(--ink-muted)]">
                    {tSettings('toolbox.dialogs.edgeTts.pitch')}
                  </label>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-[var(--ink)]">
                      {edgeTtsSettings.defaultPitch >= 0 ? '+' : ''}
                      {edgeTtsSettings.defaultPitch}Hz
                    </span>
                    {edgeTtsSettings.defaultPitch !== 0 && (
                      <button
                        onClick={() =>
                          setEdgeTtsSettings((prev) =>
                            prev ? { ...prev, defaultPitch: 0 } : null,
                          )
                        }
                        className="text-xs text-[var(--ink-muted)] hover:text-[var(--accent)]"
                      >
                        {tSettings('toolbox.common.reset')}
                      </button>
                    )}
                  </div>
                </div>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  step={10}
                  value={edgeTtsSettings.defaultPitch}
                  onChange={(e) =>
                    setEdgeTtsSettings((prev) =>
                      prev
                        ? {
                            ...prev,
                            defaultPitch: parseInt(e.target.value, 10),
                          }
                        : null,
                    )
                  }
                  className={ttsSliderClass}
                />
                <div className="flex justify-between text-xs text-[var(--ink-muted)] opacity-50">
                  <span>-100Hz</span>
                  <span>+100Hz</span>
                </div>
              </div>

              {/* Preview Section Divider */}
              <div className="border-t border-[var(--line)] pt-4">
                <span className="text-sm font-medium text-[var(--ink-muted)]">
                  {tSettings('toolbox.dialogs.edgeTts.preview')}
                </span>
              </div>

              {/* Preview */}
              <div>
                <div className="flex gap-2">
                  <textarea
                    value={ttsPreviewText}
                    onChange={(e) => setTtsPreviewText(e.target.value)}
                    rows={2}
                    placeholder={tSettings(
                      'toolbox.dialogs.edgeTts.previewPlaceholder',
                    )}
                    className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)] resize-none"
                  />
                  <button
                    onClick={handlePreviewTts}
                    disabled={ttsPreviewLoading || !ttsPreviewText.trim()}
                    className="shrink-0 h-10 w-10 rounded-full bg-[var(--accent)] text-[var(--on-accent)] flex items-center justify-center hover:bg-[var(--accent)]/90 disabled:opacity-40 transition-colors self-center"
                    title={
                      ttsPreviewPlaying
                        ? tSettings('toolbox.dialogs.edgeTts.stop')
                        : tSettings('toolbox.dialogs.edgeTts.play')
                    }
                  >
                    {ttsPreviewLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : ttsPreviewPlaying ? (
                      <Square className="h-3.5 w-3.5" fill="currentColor" />
                    ) : (
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        className="h-4 w-4 ml-0.5"
                      >
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-3 border-t border-[var(--line)] px-6 py-4">
              <button
                onClick={() => setEdgeTtsSettings(null)}
                className="rounded-lg px-4 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
              >
                {tSettings('toolbox.common.cancel')}
              </button>
              <button
                onClick={handleSaveEdgeTts}
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--on-accent)] hover:bg-[var(--accent)]/90"
              >
                {tSettings('toolbox.common.save')}
              </button>
            </div>
          </div>
        </OverlayBackdrop>
      )}

      {/* Add MCP Modal */}
      {showMcpForm && (
        <OverlayBackdrop className="z-50">
          <div className="mx-4 w-full max-w-lg rounded-2xl bg-[var(--paper-elevated)] shadow-xl max-h-[85vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--line)]">
              <h3 className="text-lg font-semibold text-[var(--ink)]">
                {editingMcpId
                  ? tSettings('toolbox.dialogs.customMcp.editTitle')
                  : tSettings('toolbox.dialogs.customMcp.addTitle')}
              </h3>
              <div className="flex items-center gap-2">
                {!editingMcpId && (
                  <button
                    onClick={() => {
                      setMcpFormMode((m) => (m === 'form' ? 'json' : 'form'));
                      setMcpJsonError(null);
                    }}
                    className="text-sm text-[var(--accent)] hover:underline"
                  >
                    {mcpFormMode === 'form'
                      ? tSettings('toolbox.dialogs.customMcp.switchToJson')
                      : tSettings('toolbox.dialogs.customMcp.switchToForm')}
                  </button>
                )}
                <button
                  onClick={() => {
                    setShowMcpForm(false);
                    resetMcpForm();
                  }}
                  className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)]"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            {/* Content - Scrollable */}
            <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-5">
              {mcpFormMode === 'json' ? (
                <div className="space-y-3">
                  <textarea
                    value={mcpJsonInput}
                    onChange={(e) => {
                      setMcpJsonInput(e.target.value);
                      setMcpJsonError(null);
                    }}
                    placeholder={tSettings(
                      'toolbox.dialogs.customMcp.jsonPlaceholder',
                    )}
                    className="w-full h-64 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 font-mono text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)]/50 focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] resize-none"
                    spellCheck={false}
                  />
                  {mcpJsonError && (
                    <p className="text-sm text-[var(--error)]">
                      {tSettings(mcpJsonError.key, mcpJsonError.params)}
                    </p>
                  )}
                </div>
              ) : (
                <>
                  {/* Transport Type Selector */}
                  <div className="mb-5">
                    <label className="mb-2 block text-sm font-medium text-[var(--ink-muted)]">
                      {tSettings('toolbox.dialogs.customMcp.transport')}
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        {
                          type: 'stdio' as const,
                          icon: '💻',
                          name: 'STDIO',
                          desc: tSettings(
                            'toolbox.dialogs.customMcp.localCommand',
                          ),
                        },
                        {
                          type: 'http' as const,
                          icon: '🌐',
                          name: 'Streamable HTTP',
                          desc: tSettings(
                            'toolbox.dialogs.customMcp.remoteServer',
                          ),
                        },
                        {
                          type: 'sse' as const,
                          icon: '📡',
                          name: 'SSE',
                          desc: 'Server-Sent Events',
                        },
                      ].map((t) => (
                        <button
                          key={t.type}
                          onClick={() =>
                            setMcpForm((p) => ({ ...p, type: t.type }))
                          }
                          className={`flex flex-col items-center rounded-xl border p-3 transition-all ${
                            mcpForm.type === t.type
                              ? 'border-[var(--ink)] bg-[var(--paper-inset)]'
                              : 'border-[var(--line)] hover:border-[var(--ink-muted)]'
                          }`}
                        >
                          <span className="text-xl mb-1">{t.icon}</span>
                          <span
                            className={`text-sm font-medium ${mcpForm.type === t.type ? 'text-[var(--ink)]' : 'text-[var(--ink-muted)]'}`}
                          >
                            {t.name}
                          </span>
                          <span className="text-xs text-[var(--ink-muted)]">
                            {t.desc}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-4">
                    {/* ID - Common */}
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                        <span className="font-mono">ID</span>{' '}
                        <span className="text-[var(--error)]">*</span>
                      </label>
                      <input
                        type="text"
                        value={mcpForm.id}
                        onChange={(e) =>
                          setMcpForm((p) => ({
                            ...p,
                            id: e.target.value
                              .toLowerCase()
                              .replace(/\s/g, '-'),
                          }))
                        }
                        placeholder={tSettings(
                          'toolbox.dialogs.customMcp.idPlaceholder',
                        )}
                        disabled={!!editingMcpId}
                        className={`w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none ${editingMcpId ? 'opacity-50 cursor-not-allowed' : ''}`}
                      />
                      <p className="mt-1 text-xs text-[var(--ink-muted)]">
                        {tSettings('toolbox.dialogs.customMcp.idHint')}
                      </p>
                    </div>

                    {/* Name - Common */}
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                        {tSettings('toolbox.dialogs.customMcp.name')}{' '}
                        <span className="font-mono text-[var(--ink-muted)]">
                          name
                        </span>{' '}
                        <span className="text-[var(--error)]">*</span>
                      </label>
                      <input
                        type="text"
                        value={mcpForm.name}
                        onChange={(e) =>
                          setMcpForm((p) => ({ ...p, name: e.target.value }))
                        }
                        placeholder={tSettings(
                          'toolbox.dialogs.customMcp.namePlaceholder',
                        )}
                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                      />
                    </div>

                    {/* STDIO Fields */}
                    {mcpForm.type === 'stdio' && (
                      <>
                        <div>
                          <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                            {tSettings('toolbox.dialogs.customMcp.command')}{' '}
                            <span className="font-mono text-[var(--ink-muted)]">
                              command
                            </span>{' '}
                            <span className="text-[var(--error)]">*</span>
                          </label>
                          <input
                            type="text"
                            value={mcpForm.command}
                            onChange={(e) =>
                              setMcpForm((p) => ({
                                ...p,
                                command: e.target.value,
                              }))
                            }
                            placeholder={tSettings(
                              'toolbox.dialogs.customMcp.commandPlaceholder',
                            )}
                            className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                          />
                          <p className="mt-1 text-xs text-[var(--ink-muted)]">
                            {tSettings('toolbox.dialogs.customMcp.commandHint')}
                          </p>
                        </div>

                        {/* Args - array input */}
                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-inset)] p-4">
                          <label className="mb-3 block text-sm font-medium text-[var(--ink)]">
                            {tSettings('toolbox.dialogs.customMcp.args')}{' '}
                            <span className="font-mono text-[var(--ink-muted)]">
                              args
                            </span>
                          </label>

                          {/* Existing args */}
                          {mcpForm.args.length > 0 && (
                            <div className="mb-3 flex flex-wrap gap-2">
                              {mcpForm.args.map((arg, index) => (
                                <div
                                  key={index}
                                  className="flex items-center gap-1 rounded-lg bg-[var(--paper-elevated)] px-2.5 py-1.5 text-xs font-mono text-[var(--ink)]"
                                >
                                  <span>{arg}</span>
                                  <button
                                    onClick={() => {
                                      setMcpForm((p) => ({
                                        ...p,
                                        args: p.args.filter(
                                          (_, i) => i !== index,
                                        ),
                                      }));
                                    }}
                                    className="ml-1 text-[var(--ink-muted)] hover:text-[var(--error)]"
                                  >
                                    <X className="h-3 w-3" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Add new arg */}
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={mcpForm.newArg}
                              onChange={(e) =>
                                setMcpForm((p) => ({
                                  ...p,
                                  newArg: e.target.value,
                                }))
                              }
                              placeholder={tSettings(
                                'toolbox.dialogs.customMcp.argPlaceholder',
                              )}
                              className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  if (mcpForm.newArg.trim()) {
                                    setMcpForm((p) => ({
                                      ...p,
                                      args: [...p.args, p.newArg.trim()],
                                      newArg: '',
                                    }));
                                  }
                                }
                              }}
                            />
                            <button
                              onClick={() => {
                                if (mcpForm.newArg.trim()) {
                                  setMcpForm((p) => ({
                                    ...p,
                                    args: [...p.args, p.newArg.trim()],
                                    newArg: '',
                                  }));
                                }
                              }}
                              disabled={!mcpForm.newArg.trim()}
                              className="flex items-center gap-1.5 rounded-lg border border-[var(--ink)] px-3 py-2 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)] disabled:opacity-50"
                            >
                              <Plus className="h-4 w-4" />
                              {tSettings('toolbox.common.add')}
                            </button>
                          </div>
                          <p className="mt-2 text-xs text-[var(--ink-muted)]">
                            {tSettings('toolbox.dialogs.customMcp.argHint')}
                          </p>
                        </div>

                        {/* Environment Variables */}
                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-inset)] p-4">
                          <label className="mb-3 flex items-center gap-2 text-sm font-medium text-[var(--ink)]">
                            <span>🔐</span>{' '}
                            {tSettings('toolbox.dialogs.customMcp.envVars')}{' '}
                            <span className="font-mono text-[var(--ink-muted)]">
                              env
                            </span>
                            {tSettings(
                              'toolbox.dialogs.customMcp.optionalSuffix',
                            )}
                          </label>

                          {/* Existing env vars */}
                          {Object.entries(mcpForm.env).map(([key, value]) => (
                            <div
                              key={key}
                              className="mb-2 flex items-center gap-2"
                            >
                              <span className="min-w-[100px] text-xs font-mono text-[var(--success)]">
                                {key}
                              </span>
                              <input
                                type="text"
                                value={value}
                                onChange={(e) =>
                                  setMcpForm((p) => ({
                                    ...p,
                                    env: { ...p.env, [key]: e.target.value },
                                  }))
                                }
                                placeholder={tSettings(
                                  'toolbox.common.valuePlaceholder',
                                )}
                                className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                              />
                              <button
                                onClick={() => {
                                  const newEnv = { ...mcpForm.env };
                                  delete newEnv[key];
                                  setMcpForm((p) => ({ ...p, env: newEnv }));
                                }}
                                className="rounded-lg p-2 text-[var(--error)] transition-colors hover:bg-[var(--error-bg)]"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          ))}

                          {/* Add new env var (key + value) */}
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={mcpForm.newEnvKey}
                              onChange={(e) =>
                                setMcpForm((p) => ({
                                  ...p,
                                  newEnvKey: e.target.value
                                    .toUpperCase()
                                    .replace(/\s/g, '_'),
                                }))
                              }
                              placeholder={tSettings(
                                'toolbox.common.envKeyPlaceholder',
                              )}
                              className="w-[140px] shrink-0 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                            />
                            <input
                              type="text"
                              value={mcpForm.newEnvValue}
                              onChange={(e) =>
                                setMcpForm((p) => ({
                                  ...p,
                                  newEnvValue: e.target.value,
                                }))
                              }
                              placeholder={tSettings(
                                'toolbox.common.valuePlaceholder',
                              )}
                              className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  const key = mcpForm.newEnvKey.trim();
                                  if (key && !(key in mcpForm.env)) {
                                    setMcpForm((p) => ({
                                      ...p,
                                      env: { ...p.env, [key]: p.newEnvValue },
                                      newEnvKey: '',
                                      newEnvValue: '',
                                    }));
                                  }
                                }
                              }}
                            />
                            <button
                              onClick={() => {
                                const key = mcpForm.newEnvKey.trim();
                                if (key && !(key in mcpForm.env)) {
                                  setMcpForm((p) => ({
                                    ...p,
                                    env: { ...p.env, [key]: p.newEnvValue },
                                    newEnvKey: '',
                                    newEnvValue: '',
                                  }));
                                }
                              }}
                              disabled={
                                !mcpForm.newEnvKey.trim() ||
                                mcpForm.newEnvKey.trim() in mcpForm.env
                              }
                              className="flex items-center gap-1.5 rounded-lg border border-[var(--ink)] px-3 py-2 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)] disabled:opacity-50"
                            >
                              <Plus className="h-4 w-4" />
                              {tSettings('toolbox.common.add')}
                            </button>
                          </div>
                        </div>
                      </>
                    )}

                    {/* HTTP/SSE Fields */}
                    {(mcpForm.type === 'http' || mcpForm.type === 'sse') && (
                      <>
                        <div>
                          <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                            {tSettings('toolbox.dialogs.customMcp.serverUrl')}{' '}
                            <span className="font-mono text-[var(--ink-muted)]">
                              url
                            </span>{' '}
                            <span className="text-[var(--error)]">*</span>
                          </label>
                          <input
                            type="url"
                            value={mcpForm.url}
                            onChange={(e) =>
                              setMcpForm((p) => ({ ...p, url: e.target.value }))
                            }
                            placeholder={
                              mcpForm.type === 'sse'
                                ? tSettings(
                                    'toolbox.dialogs.customMcp.urlPlaceholderSse',
                                  )
                                : tSettings(
                                    'toolbox.dialogs.customMcp.urlPlaceholderHttp',
                                  )
                            }
                            className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                          />
                          <p className="mt-1 text-xs text-[var(--ink-muted)]">
                            {mcpForm.type === 'sse'
                              ? tSettings(
                                  'toolbox.dialogs.customMcp.urlHintSse',
                                )
                              : tSettings(
                                  'toolbox.dialogs.customMcp.urlHintHttp',
                                )}
                          </p>
                        </div>

                        {/* HTTP Headers — collapsible */}
                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-inset)]">
                          <button
                            type="button"
                            onClick={() => setMcpHeadersExpanded((v) => !v)}
                            className="flex w-full items-center justify-between p-4 text-sm font-medium text-[var(--ink)]"
                          >
                            <span className="flex items-center gap-2">
                              <KeyRound className="h-4 w-4" />{' '}
                              {tSettings('toolbox.dialogs.customMcp.headers')}{' '}
                              <span className="font-mono text-[var(--ink-muted)]">
                                headers
                              </span>
                              {Object.keys(mcpForm.headers).length > 0 && (
                                <span className="rounded-full bg-[var(--accent)]/10 px-1.5 py-0.5 text-xs text-[var(--accent)]">
                                  {Object.keys(mcpForm.headers).length}
                                </span>
                              )}
                            </span>
                            <ChevronDown
                              className={`h-4 w-4 text-[var(--ink-muted)] transition-transform ${mcpHeadersExpanded ? '' : '-rotate-90'}`}
                            />
                          </button>
                          {mcpHeadersExpanded && (
                            <div className="border-t border-[var(--line)] px-4 pb-4 pt-3">
                              {/* Existing headers — key:value inline */}
                              {Object.entries(mcpForm.headers).map(
                                ([key, value]) => (
                                  <div
                                    key={key}
                                    className="mb-2 flex items-center gap-2"
                                  >
                                    <input
                                      type="text"
                                      value={key}
                                      readOnly
                                      className="w-[140px] shrink-0 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm font-mono text-[var(--success)] focus:outline-none"
                                    />
                                    <input
                                      type="text"
                                      value={value}
                                      onChange={(e) =>
                                        setMcpForm((p) => ({
                                          ...p,
                                          headers: {
                                            ...p.headers,
                                            [key]: e.target.value,
                                          },
                                        }))
                                      }
                                      placeholder={tSettings(
                                        'toolbox.common.valuePlaceholder',
                                      )}
                                      className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                    />
                                    <button
                                      onClick={() => {
                                        const newHeaders = {
                                          ...mcpForm.headers,
                                        };
                                        delete newHeaders[key];
                                        setMcpForm((p) => ({
                                          ...p,
                                          headers: newHeaders,
                                        }));
                                      }}
                                      className="rounded-lg p-2 text-[var(--error)] transition-colors hover:bg-[var(--error-bg)]"
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </button>
                                  </div>
                                ),
                              )}

                              {/* Add new header — key + value inline */}
                              <div className="flex items-center gap-2">
                                <input
                                  type="text"
                                  value={mcpForm.newHeaderKey}
                                  onChange={(e) =>
                                    setMcpForm((p) => ({
                                      ...p,
                                      newHeaderKey: e.target.value,
                                    }))
                                  }
                                  placeholder={tSettings(
                                    'toolbox.dialogs.customMcp.headerNamePlaceholder',
                                  )}
                                  className="w-[140px] shrink-0 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                />
                                <input
                                  type="text"
                                  value={mcpForm.newHeaderValue}
                                  onChange={(e) =>
                                    setMcpForm((p) => ({
                                      ...p,
                                      newHeaderValue: e.target.value,
                                    }))
                                  }
                                  placeholder={tSettings(
                                    'toolbox.common.valuePlaceholder',
                                  )}
                                  className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      if (mcpForm.newHeaderKey) {
                                        setMcpForm((p) => ({
                                          ...p,
                                          headers: {
                                            ...p.headers,
                                            [p.newHeaderKey]: p.newHeaderValue,
                                          },
                                          newHeaderKey: '',
                                          newHeaderValue: '',
                                        }));
                                      }
                                    }
                                  }}
                                />
                                <button
                                  onClick={() => {
                                    if (mcpForm.newHeaderKey) {
                                      setMcpForm((p) => ({
                                        ...p,
                                        headers: {
                                          ...p.headers,
                                          [p.newHeaderKey]: p.newHeaderValue,
                                        },
                                        newHeaderKey: '',
                                        newHeaderValue: '',
                                      }));
                                    }
                                  }}
                                  disabled={!mcpForm.newHeaderKey}
                                  className="flex items-center gap-1.5 rounded-lg border border-[var(--ink)] px-3 py-2 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)] disabled:opacity-50"
                                >
                                  <Plus className="h-4 w-4" />
                                </button>
                              </div>
                              <p className="mt-2 text-xs text-[var(--ink-muted)]">
                                {tSettings(
                                  'toolbox.dialogs.customMcp.authHeaderHint',
                                )}
                              </p>
                            </div>
                          )}
                        </div>

                        {/* OAuth 2.0 Section — auto-discover + one-click authorize */}
                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-inset)]">
                          <div className="p-4">
                            <div className="flex items-center justify-between">
                              <span className="flex items-center gap-2 text-sm font-medium text-[var(--ink)]">
                                <Link className="h-4 w-4" />{' '}
                                {tSettings(
                                  'toolbox.dialogs.customMcp.oauthTitle',
                                )}
                              </span>
                              <span className="flex items-center gap-2">
                                {mcpOAuthStatus[mcpForm.id] === 'connected' && (
                                  <span className="flex items-center gap-1 rounded-full bg-[var(--success)]/10 px-2 py-0.5 text-xs text-[var(--success)]">
                                    <Check className="h-3 w-3" />{' '}
                                    {tSettings(
                                      'toolbox.dialogs.customMcp.oauthAuthorized',
                                    )}
                                  </span>
                                )}
                                {mcpOAuthStatus[mcpForm.id] === 'expired' && (
                                  <span className="flex items-center gap-1 rounded-full bg-[var(--warning)]/10 px-2 py-0.5 text-xs text-[var(--warning)]">
                                    <AlertCircle className="h-3 w-3" />{' '}
                                    {tSettings(
                                      'toolbox.dialogs.customMcp.oauthExpired',
                                    )}
                                  </span>
                                )}
                              </span>
                            </div>

                            {/* Connected state */}
                            {mcpOAuthStatus[mcpForm.id] === 'connected' && (
                              <div className="mt-3">
                                <button
                                  onClick={() =>
                                    handleMcpOAuthDisconnect(mcpForm.id)
                                  }
                                  className="flex items-center gap-1.5 rounded-lg border border-[var(--error)] px-3 py-2 text-sm font-medium text-[var(--error)] transition-colors hover:bg-[var(--error-bg)]"
                                >
                                  <Unlink className="h-4 w-4" />{' '}
                                  {tSettings(
                                    'toolbox.dialogs.customMcp.revokeAuthorization',
                                  )}
                                </button>
                              </div>
                            )}

                            {/* Expired state */}
                            {mcpOAuthStatus[mcpForm.id] === 'expired' && (
                              <div className="mt-3">
                                <button
                                  onClick={() =>
                                    handleMcpOAuthConnect(
                                      mcpForm.id,
                                      mcpForm.url,
                                    )
                                  }
                                  disabled={mcpOAuthConnecting === mcpForm.id}
                                  className="flex items-center gap-1.5 rounded-lg border border-[var(--warning)] px-3 py-2 text-sm font-medium text-[var(--warning)] transition-colors hover:bg-[var(--warning)]/10 disabled:opacity-50"
                                >
                                  {mcpOAuthConnecting === mcpForm.id ? (
                                    <>
                                      <Loader2 className="h-4 w-4 animate-spin" />{' '}
                                      {tSettings(
                                        'toolbox.dialogs.customMcp.waitingAuthorization',
                                      )}
                                    </>
                                  ) : (
                                    <>
                                      <Link className="h-4 w-4" />{' '}
                                      {tSettings(
                                        'toolbox.dialogs.customMcp.reauthorize',
                                      )}
                                    </>
                                  )}
                                </button>
                              </div>
                            )}

                            {/* Not connected — show authorize flow */}
                            {mcpOAuthStatus[mcpForm.id] !== 'connected' &&
                              mcpOAuthStatus[mcpForm.id] !== 'expired' && (
                                <div className="mt-3 space-y-3">
                                  {/* Auto mode: one-click authorize (when probe detected dynamic registration) */}
                                  {(!mcpOAuthProbe[mcpForm.id] ||
                                    mcpOAuthProbe[mcpForm.id]
                                      ?.supportsDynamicRegistration !==
                                      false) && (
                                    <div className="flex items-center gap-3">
                                      <button
                                        onClick={async () => {
                                          if (!mcpOAuthProbe[mcpForm.id]) {
                                            const probe =
                                              await handleMcpOAuthProbe(
                                                mcpForm.id,
                                                mcpForm.url,
                                              );
                                            if (
                                              probe?.supportsDynamicRegistration ===
                                              false
                                            ) {
                                              // No dynamic registration — expand manual config instead of auto-connect
                                              setMcpOAuthExpanded(true);
                                              return;
                                            }
                                          }
                                          handleMcpOAuthConnect(
                                            mcpForm.id,
                                            mcpForm.url,
                                          );
                                        }}
                                        disabled={
                                          mcpOAuthConnecting === mcpForm.id ||
                                          !mcpForm.url
                                        }
                                        className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--on-accent)] transition-colors hover:opacity-90 disabled:opacity-50"
                                      >
                                        {mcpOAuthConnecting === mcpForm.id ? (
                                          <>
                                            <Loader2 className="h-4 w-4 animate-spin" />{' '}
                                            {tSettings(
                                              'toolbox.dialogs.customMcp.waitingAuthorization',
                                            )}
                                          </>
                                        ) : (
                                          <>
                                            <Link className="h-4 w-4" />{' '}
                                            {tSettings(
                                              'toolbox.dialogs.customMcp.authorizeLogin',
                                            )}
                                          </>
                                        )}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setMcpOAuthExpanded((v) => !v)
                                        }
                                        className="text-xs text-[var(--ink-muted)] hover:text-[var(--ink)] transition-colors"
                                      >
                                        {mcpOAuthExpanded
                                          ? tSettings(
                                              'toolbox.dialogs.customMcp.collapseAdvanced',
                                            )
                                          : tSettings(
                                              'toolbox.dialogs.customMcp.manualConfig',
                                            )}
                                      </button>
                                    </div>
                                  )}

                                  {/* Manual fallback note (when probe says no dynamic registration) */}
                                  {mcpOAuthProbe[mcpForm.id]
                                    ?.supportsDynamicRegistration === false &&
                                    !mcpOAuthExpanded && (
                                      <div>
                                        <p className="mb-2 text-xs text-[var(--ink-muted)]">
                                          {tSettings(
                                            'toolbox.dialogs.customMcp.manualFallbackNote',
                                          )}
                                        </p>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            setMcpOAuthExpanded(true)
                                          }
                                          className="text-xs text-[var(--accent)] hover:underline"
                                        >
                                          {tSettings(
                                            'toolbox.dialogs.customMcp.expandManualConfig',
                                          )}
                                        </button>
                                      </div>
                                    )}

                                  {/* Manual config form (advanced) */}
                                  {mcpOAuthExpanded && (
                                    <div className="border-t border-[var(--line)] pt-3 space-y-2">
                                      <input
                                        type="text"
                                        value={mcpForm.oauthClientId}
                                        onChange={(e) =>
                                          setMcpForm((p) => ({
                                            ...p,
                                            oauthClientId: e.target.value,
                                          }))
                                        }
                                        placeholder={tSettings(
                                          'toolbox.dialogs.customMcp.clientIdPlaceholder',
                                        )}
                                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                      />
                                      <input
                                        type="password"
                                        value={mcpForm.oauthClientSecret}
                                        onChange={(e) =>
                                          setMcpForm((p) => ({
                                            ...p,
                                            oauthClientSecret: e.target.value,
                                          }))
                                        }
                                        placeholder={tSettings(
                                          'toolbox.dialogs.customMcp.clientSecretPlaceholder',
                                        )}
                                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                      />
                                      <div className="grid grid-cols-2 gap-2">
                                        <input
                                          type="text"
                                          value={mcpForm.oauthScopes}
                                          onChange={(e) =>
                                            setMcpForm((p) => ({
                                              ...p,
                                              oauthScopes: e.target.value,
                                            }))
                                          }
                                          placeholder={tSettings(
                                            'toolbox.dialogs.customMcp.scopesPlaceholder',
                                          )}
                                          className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                        />
                                        <input
                                          type="text"
                                          value={mcpForm.oauthCallbackPort}
                                          onChange={(e) =>
                                            setMcpForm((p) => ({
                                              ...p,
                                              oauthCallbackPort:
                                                e.target.value.replace(
                                                  /\D/g,
                                                  '',
                                                ),
                                            }))
                                          }
                                          placeholder={tSettings(
                                            'toolbox.dialogs.customMcp.callbackPortPlaceholder',
                                          )}
                                          className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                        />
                                      </div>
                                      <div className="grid grid-cols-2 gap-2">
                                        <input
                                          type="url"
                                          value={mcpForm.oauthAuthUrl}
                                          onChange={(e) =>
                                            setMcpForm((p) => ({
                                              ...p,
                                              oauthAuthUrl: e.target.value,
                                            }))
                                          }
                                          placeholder={tSettings(
                                            'toolbox.dialogs.customMcp.authUrlPlaceholder',
                                          )}
                                          className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                        />
                                        <input
                                          type="url"
                                          value={mcpForm.oauthTokenUrl}
                                          onChange={(e) =>
                                            setMcpForm((p) => ({
                                              ...p,
                                              oauthTokenUrl: e.target.value,
                                            }))
                                          }
                                          placeholder={tSettings(
                                            'toolbox.dialogs.customMcp.tokenUrlPlaceholder',
                                          )}
                                          className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                        />
                                      </div>
                                      <button
                                        onClick={() =>
                                          handleMcpOAuthConnect(
                                            mcpForm.id,
                                            mcpForm.url,
                                            true,
                                          )
                                        }
                                        disabled={
                                          !mcpForm.oauthClientId ||
                                          mcpOAuthConnecting === mcpForm.id
                                        }
                                        className="flex items-center gap-1.5 rounded-lg border border-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10 disabled:opacity-50"
                                      >
                                        {mcpOAuthConnecting === mcpForm.id ? (
                                          <>
                                            <Loader2 className="h-4 w-4 animate-spin" />{' '}
                                            {tSettings(
                                              'toolbox.dialogs.customMcp.waitingAuthorization',
                                            )}
                                          </>
                                        ) : (
                                          <>
                                            <Link className="h-4 w-4" />{' '}
                                            {tSettings(
                                              'toolbox.dialogs.customMcp.manualConnect',
                                            )}
                                          </>
                                        )}
                                      </button>
                                    </div>
                                  )}
                                </div>
                              )}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Footer */}
            {mcpFormMode === 'json' ? (
              <div className="flex gap-3 px-6 py-4 border-t border-[var(--line)]">
                <button
                  onClick={() => {
                    setShowMcpForm(false);
                    resetMcpForm();
                  }}
                  className="flex-1 rounded-lg border border-[var(--line)] px-4 py-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]"
                >
                  {tSettings('toolbox.common.cancel')}
                </button>
                <button
                  onClick={handleAddMcpFromJson}
                  disabled={!mcpJsonInput.trim()}
                  className="flex-1 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                >
                  {tSettings('toolbox.dialogs.customMcp.import')}
                </button>
              </div>
            ) : (
              <div
                className={`flex items-center px-6 py-4 border-t border-[var(--line)] ${editingMcpId ? 'justify-between' : 'gap-3'}`}
              >
                {editingMcpId && (
                  <button
                    onClick={() => {
                      setShowMcpForm(false);
                      resetMcpForm();
                      handleDeleteMcp(editingMcpId);
                    }}
                    className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-[var(--error)] transition-colors hover:bg-[var(--error-bg)]"
                  >
                    <Trash2 className="h-4 w-4" />
                    {tSettings('toolbox.dialogs.customMcp.delete')}
                  </button>
                )}
                <div
                  className={editingMcpId ? 'flex gap-3' : 'flex gap-3 flex-1'}
                >
                  <button
                    onClick={() => {
                      setShowMcpForm(false);
                      resetMcpForm();
                    }}
                    className={`rounded-lg border border-[var(--line)] px-4 py-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)] ${editingMcpId ? '' : 'flex-1'}`}
                  >
                    {tSettings('toolbox.common.cancel')}
                  </button>
                  <button
                    onClick={handleAddMcp}
                    disabled={
                      !mcpForm.id ||
                      !mcpForm.name ||
                      (mcpForm.type === 'stdio' && !mcpForm.command) ||
                      ((mcpForm.type === 'http' || mcpForm.type === 'sse') &&
                        !mcpForm.url)
                    }
                    className={`rounded-lg bg-[var(--button-primary-bg)] px-4 py-2.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50 ${editingMcpId ? '' : 'flex-1'}`}
                  >
                    {editingMcpId
                      ? tSettings('toolbox.dialogs.customMcp.saveChanges')
                      : tSettings('toolbox.dialogs.customMcp.addServer')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </OverlayBackdrop>
      )}

      {renderManagedCodexDetailsDialog()}
      {renderManagedCodexLoginDialog()}
      {renderSubscriptionLoginDialog()}

      {showProxyScopeDialog && (
        <ProxyScopeDialog
          providers={allProviders}
          initialGeneralRequests={proxyScopeDialogInitialGeneralRequests}
          initialProviderIds={proxyScopeDialogInitialIds}
          onClose={() => setShowProxyScopeDialog(false)}
          onSave={saveProxyScope}
        />
      )}

      {/* Provider Enablement / Ordering Modal */}
      {showProviderOrderDialog && (
        <ProviderEnableOrderDialog
          providers={allProviders}
          providerOrderDraft={providerOrderDraft}
          disabledProviderDraft={disabledProviderDraft}
          onProviderOrderDraftChange={setProviderOrderDraft}
          onDisabledProviderDraftChange={setDisabledProviderDraft}
          onClose={() => setShowProviderOrderDialog(false)}
          onSave={saveProviderOrderSettings}
        />
      )}

      {/* Custom Provider Modal */}
      {showCustomForm && (
        <OverlayBackdrop className="z-50 overflow-y-auto py-8">
          <div className="mx-4 w-full max-w-md flex max-h-[90vh] flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-xl">
            <div className="flex-shrink-0 px-6 pt-6 pb-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-[var(--ink)]">
                  {tSettings('providers.custom.addTitle')}
                </h3>
                <button
                  onClick={() => {
                    setShowCustomForm(false);
                    setCustomForm(EMPTY_CUSTOM_FORM);
                  }}
                  className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)]"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                  {tSettings('providers.custom.providerName')}{' '}
                  <span className="text-[var(--error)]">*</span>
                </label>
                <input
                  type="text"
                  value={customForm.name}
                  onChange={(e) =>
                    setCustomForm((p) => ({ ...p, name: e.target.value }))
                  }
                  placeholder={tSettings(
                    'providers.custom.providerNamePlaceholder',
                  )}
                  className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                  {tSettings('providers.custom.cloudProvider')}
                </label>
                <input
                  type="text"
                  value={customForm.cloudProvider}
                  onChange={(e) =>
                    setCustomForm((p) => ({
                      ...p,
                      cloudProvider: e.target.value,
                    }))
                  }
                  placeholder={tSettings(
                    'providers.custom.cloudProviderPlaceholder',
                  )}
                  className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-0.5 block text-sm font-medium text-[var(--ink)]">
                  {tSettings('providers.custom.apiProtocol')}
                </label>
                {customForm.apiProtocol === 'openai' && (
                  <p className="mb-1.5 text-xs text-[var(--ink-muted)]">
                    {tSettings('providers.custom.bridgeWarning')}
                  </p>
                )}
                <div
                  className={`flex gap-4${customForm.apiProtocol !== 'openai' ? ' mt-1' : ''}`}
                >
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="create-apiProtocol"
                      value="anthropic"
                      checked={customForm.apiProtocol !== 'openai'}
                      onChange={() =>
                        setCustomForm((p) => ({
                          ...p,
                          apiProtocol: 'anthropic',
                          authType: 'auth_token',
                        }))
                      }
                      className="accent-[var(--ink)]"
                    />
                    <span className="text-sm text-[var(--ink)]">
                      {tSettings('providers.custom.anthropicProtocol')}
                    </span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="create-apiProtocol"
                      value="openai"
                      checked={customForm.apiProtocol === 'openai'}
                      onChange={() =>
                        setCustomForm((p) => ({
                          ...p,
                          apiProtocol: 'openai',
                          authType: 'api_key',
                        }))
                      }
                      className="accent-[var(--ink)]"
                    />
                    <span className="text-sm text-[var(--ink)]">
                      {tSettings('providers.custom.openaiProtocol')}
                    </span>
                  </label>
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                  {tSettings('providers.custom.baseUrl')}{' '}
                  <span className="text-[var(--error)]">*</span>
                </label>
                <input
                  type="url"
                  value={customForm.baseUrl}
                  onChange={(e) =>
                    setCustomForm((p) => ({ ...p, baseUrl: e.target.value }))
                  }
                  placeholder={
                    customForm.apiProtocol === 'openai'
                      ? 'https://api.openai.com/v1'
                      : 'https://api.example.com/anthropic'
                  }
                  className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                />
              </div>

              {customForm.apiProtocol === 'openai' && (
                <>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                      {tSettings('providers.custom.upstreamFormat')}
                    </label>
                    <div className="flex gap-4">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="create-upstreamFormat"
                          value="chat_completions"
                          checked={
                            customForm.upstreamFormat === 'chat_completions'
                          }
                          onChange={() =>
                            setCustomForm((p) => ({
                              ...p,
                              upstreamFormat: 'chat_completions',
                              maxOutputTokensParamName:
                                p.maxOutputTokensParamName ===
                                'max_output_tokens'
                                  ? 'max_tokens'
                                  : p.maxOutputTokensParamName,
                            }))
                          }
                          className="accent-[var(--ink)]"
                        />
                        <span className="text-sm text-[var(--ink)]">
                          Chat Completions
                        </span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="create-upstreamFormat"
                          value="responses"
                          checked={customForm.upstreamFormat === 'responses'}
                          onChange={() =>
                            setCustomForm((p) => ({
                              ...p,
                              upstreamFormat: 'responses',
                              maxOutputTokensParamName: 'max_output_tokens',
                            }))
                          }
                          className="accent-[var(--ink)]"
                        />
                        <span className="text-sm text-[var(--ink)]">
                          Responses API
                        </span>
                      </label>
                    </div>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                      {tSettings('providers.custom.maxOutputTokens')}
                    </label>
                    <div className="flex gap-2 items-center">
                      <CustomSelect
                        value={customForm.maxOutputTokensParamName}
                        onChange={(v) =>
                          setCustomForm((p) => ({
                            ...p,
                            maxOutputTokensParamName: v as
                              | 'max_tokens'
                              | 'max_completion_tokens'
                              | 'max_output_tokens',
                          }))
                        }
                        options={
                          customForm.upstreamFormat === 'responses'
                            ? [
                                {
                                  value: 'max_output_tokens',
                                  label: 'max_output_tokens',
                                },
                              ]
                            : [
                                { value: 'max_tokens', label: 'max_tokens' },
                                {
                                  value: 'max_completion_tokens',
                                  label: 'max_completion_tokens',
                                },
                              ]
                        }
                        compact
                        className="shrink-0"
                      />
                      <input
                        type="number"
                        value={customForm.maxOutputTokens}
                        onChange={(e) =>
                          setCustomForm((p) => ({
                            ...p,
                            maxOutputTokens: e.target.value,
                          }))
                        }
                        placeholder={tSettings(
                          'providers.custom.unlimitedPlaceholder',
                        )}
                        className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                      />
                    </div>
                  </div>
                </>
              )}

              {/* Auth Type - only meaningful for Anthropic protocol (controls x-api-key vs Authorization header) */}
              {customForm.apiProtocol !== 'openai' && (
                <div>
                  <label className="mb-0.5 block text-sm font-medium text-[var(--ink)]">
                    {tSettings('providers.custom.authType')}
                  </label>
                  <p className="mb-1.5 text-xs text-[var(--ink-muted)]">
                    {tSettings('providers.custom.authTypeDescription')}
                  </p>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="create-authType"
                        value="auth_token"
                        checked={customForm.authType === 'auth_token'}
                        onChange={() =>
                          setCustomForm((p) => ({
                            ...p,
                            authType: 'auth_token',
                          }))
                        }
                        className="accent-[var(--ink)]"
                      />
                      <span className="text-sm text-[var(--ink)]">
                        AUTH_TOKEN
                      </span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="create-authType"
                        value="api_key"
                        checked={customForm.authType === 'api_key'}
                        onChange={() =>
                          setCustomForm((p) => ({ ...p, authType: 'api_key' }))
                        }
                        className="accent-[var(--ink)]"
                      />
                      <span className="text-sm text-[var(--ink)]">API_KEY</span>
                    </label>
                  </div>
                </div>
              )}

              {/* Models — inline input, no dependency on provider creation */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                  {tSettings('providers.custom.models')}{' '}
                  <span className="text-[var(--error)]">*</span>
                </label>
                {customForm.models.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {customForm.models.map((m) => (
                      <span
                        key={m}
                        className="inline-flex items-center gap-1 rounded-md bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-muted)]"
                      >
                        {m}
                        <button
                          type="button"
                          onClick={() =>
                            setCustomForm((p) => ({
                              ...p,
                              models: p.models.filter((id) => id !== m),
                            }))
                          }
                          className="rounded-sm p-0.5 text-[var(--ink-subtle)] transition-colors hover:text-[var(--ink)]"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    ref={customModelInputRef}
                    type="text"
                    placeholder={tSettings(
                      'providers.custom.modelInputPlaceholder',
                    )}
                    className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors placeholder:text-[var(--ink-muted)] focus:border-[var(--focus-border)] focus:outline-none"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addCustomModelFromInput();
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={addCustomModelFromInput}
                    className="rounded-lg bg-[var(--paper-inset)] px-2.5 py-1.5 text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* API Key moved to provider list page for consistency with edit flow */}
            </div>

            <div className="flex-shrink-0 border-t border-[var(--line)] px-6 py-4">
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setShowCustomForm(false);
                    setCustomForm(EMPTY_CUSTOM_FORM);
                  }}
                  className="flex-1 rounded-lg border border-[var(--line)] px-4 py-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]"
                >
                  {tSettings('providers.custom.cancel')}
                </button>
                <button
                  onClick={handleAddCustomProvider}
                  disabled={
                    !customForm.name ||
                    !customForm.baseUrl ||
                    customForm.models.length === 0
                  }
                  className="flex-1 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                >
                  {tSettings('providers.custom.add')}
                </button>
              </div>
            </div>
          </div>
        </OverlayBackdrop>
      )}

      {/* Provider Management Modal */}
      {editingProvider && (
        <OverlayBackdrop className="z-50 overflow-y-auto py-8">
          <div className="mx-4 w-full max-w-md flex max-h-[90vh] flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-xl">
            <div className="flex-shrink-0 px-6 pt-6 pb-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-[var(--ink)]">
                  {editingProvider.provider.isBuiltin
                    ? tSettings('providers.custom.manageTitle')
                    : tSettings('providers.custom.editTitle')}
                </h3>
                <button
                  onClick={() => setEditingProvider(null)}
                  className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)]"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-6">
              {/* Provider info - editable for custom, read-only for preset */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                  {tSettings('providers.custom.providerName')}
                </label>
                {editingProvider.provider.isBuiltin ? (
                  <div className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 text-sm text-[var(--ink-muted)]">
                    {editingProvider.provider.name}
                  </div>
                ) : (
                  <input
                    type="text"
                    value={editingProvider.editName || ''}
                    onChange={(e) =>
                      setEditingProvider((p) =>
                        p ? { ...p, editName: e.target.value } : null,
                      )
                    }
                    placeholder={tSettings(
                      'providers.custom.providerNameEditPlaceholder',
                    )}
                    className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                  />
                )}
              </div>

              {/* 云服务商标签 - only for custom providers */}
              {!editingProvider.provider.isBuiltin && (
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                    {tSettings('providers.custom.cloudProvider')}
                  </label>
                  <input
                    type="text"
                    value={editingProvider.editCloudProvider || ''}
                    onChange={(e) =>
                      setEditingProvider((p) =>
                        p ? { ...p, editCloudProvider: e.target.value } : null,
                      )
                    }
                    placeholder={tSettings(
                      'providers.custom.cloudProviderEditPlaceholder',
                    )}
                    className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                  />
                </div>
              )}

              {/* API Protocol - only for custom providers */}
              {!editingProvider.provider.isBuiltin && (
                <div>
                  <label className="mb-0.5 block text-sm font-medium text-[var(--ink)]">
                    {tSettings('providers.custom.apiProtocol')}
                  </label>
                  {editingProvider.editApiProtocol === 'openai' && (
                    <p className="mb-1.5 text-xs text-[var(--ink-muted)]">
                      {tSettings('providers.custom.bridgeWarning')}
                    </p>
                  )}
                  <div
                    className={`flex gap-4${editingProvider.editApiProtocol !== 'openai' ? ' mt-1' : ''}`}
                  >
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="edit-apiProtocol"
                        value="anthropic"
                        checked={editingProvider.editApiProtocol !== 'openai'}
                        onChange={() =>
                          setEditingProvider((p) =>
                            p
                              ? {
                                  ...p,
                                  editApiProtocol: 'anthropic',
                                  editAuthType: 'auth_token',
                                }
                              : null,
                          )
                        }
                        className="accent-[var(--ink)]"
                      />
                      <span className="text-sm text-[var(--ink)]">
                        {tSettings('providers.custom.anthropicProtocol')}
                      </span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="edit-apiProtocol"
                        value="openai"
                        checked={editingProvider.editApiProtocol === 'openai'}
                        onChange={() =>
                          setEditingProvider((p) =>
                            p
                              ? {
                                  ...p,
                                  editApiProtocol: 'openai',
                                  editAuthType: 'api_key',
                                }
                              : null,
                          )
                        }
                        className="accent-[var(--ink)]"
                      />
                      <span className="text-sm text-[var(--ink)]">
                        {tSettings('providers.custom.openaiProtocol')}
                      </span>
                    </label>
                  </div>
                </div>
              )}

              {/* Base URL */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                  {tSettings('providers.custom.baseUrl')}
                </label>
                {editingProvider.provider.isBuiltin ? (
                  editingProvider.provider.config.baseUrl && (
                    <div className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 text-sm text-[var(--ink-muted)] font-mono text-xs break-all">
                      {editingProvider.provider.config.baseUrl}
                    </div>
                  )
                ) : (
                  <input
                    type="text"
                    value={editingProvider.editBaseUrl || ''}
                    onChange={(e) =>
                      setEditingProvider((p) =>
                        p ? { ...p, editBaseUrl: e.target.value } : null,
                      )
                    }
                    placeholder={
                      editingProvider.editApiProtocol === 'openai'
                        ? 'https://api.openai.com/v1'
                        : 'https://api.example.com'
                    }
                    className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                  />
                )}
              </div>

              {/* OpenAI Bridge Settings - only for custom providers with OpenAI protocol */}
              {!editingProvider.provider.isBuiltin &&
                editingProvider.editApiProtocol === 'openai' && (
                  <>
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                        {tSettings('providers.custom.upstreamFormat')}
                      </label>
                      <div className="flex gap-4">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="radio"
                            name="edit-upstreamFormat"
                            value="chat_completions"
                            checked={
                              (editingProvider.editUpstreamFormat ||
                                'chat_completions') === 'chat_completions'
                            }
                            onChange={() =>
                              setEditingProvider((p) =>
                                p
                                  ? {
                                      ...p,
                                      editUpstreamFormat: 'chat_completions',
                                      editMaxOutputTokensParamName:
                                        p.editMaxOutputTokensParamName ===
                                        'max_output_tokens'
                                          ? 'max_tokens'
                                          : p.editMaxOutputTokensParamName,
                                    }
                                  : null,
                              )
                            }
                            className="accent-[var(--ink)]"
                          />
                          <span className="text-sm text-[var(--ink)]">
                            Chat Completions
                          </span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="radio"
                            name="edit-upstreamFormat"
                            value="responses"
                            checked={
                              editingProvider.editUpstreamFormat === 'responses'
                            }
                            onChange={() =>
                              setEditingProvider((p) =>
                                p
                                  ? {
                                      ...p,
                                      editUpstreamFormat: 'responses',
                                      editMaxOutputTokensParamName:
                                        'max_output_tokens',
                                    }
                                  : null,
                              )
                            }
                            className="accent-[var(--ink)]"
                          />
                          <span className="text-sm text-[var(--ink)]">
                            Responses API
                          </span>
                        </label>
                      </div>
                    </div>
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                        {tSettings('providers.custom.maxOutputTokens')}
                      </label>
                      <div className="flex gap-2 items-center">
                        <CustomSelect
                          value={
                            editingProvider.editMaxOutputTokensParamName ??
                            'max_tokens'
                          }
                          onChange={(v) =>
                            setEditingProvider((p) =>
                              p
                                ? {
                                    ...p,
                                    editMaxOutputTokensParamName: v as
                                      | 'max_tokens'
                                      | 'max_completion_tokens'
                                      | 'max_output_tokens',
                                  }
                                : null,
                            )
                          }
                          options={
                            (editingProvider.editUpstreamFormat ||
                              'chat_completions') === 'responses'
                              ? [
                                  {
                                    value: 'max_output_tokens',
                                    label: 'max_output_tokens',
                                  },
                                ]
                              : [
                                  { value: 'max_tokens', label: 'max_tokens' },
                                  {
                                    value: 'max_completion_tokens',
                                    label: 'max_completion_tokens',
                                  },
                                ]
                          }
                          compact
                          className="shrink-0"
                        />
                        <input
                          type="number"
                          value={editingProvider.editMaxOutputTokens || ''}
                          onChange={(e) =>
                            setEditingProvider((p) =>
                              p
                                ? { ...p, editMaxOutputTokens: e.target.value }
                                : null,
                            )
                          }
                          placeholder={tSettings(
                            'providers.custom.unlimitedPlaceholder',
                          )}
                          className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                        />
                      </div>
                    </div>
                  </>
                )}

              {/* Auth Type - only for custom providers with Anthropic protocol */}
              {!editingProvider.provider.isBuiltin &&
                editingProvider.editApiProtocol !== 'openai' && (
                  <div>
                    <label className="mb-0.5 block text-sm font-medium text-[var(--ink)]">
                      {tSettings('providers.custom.authType')}
                    </label>
                    <p className="mb-1.5 text-xs text-[var(--ink-muted)]">
                      {tSettings('providers.custom.authTypeDescription')}
                    </p>
                    <div className="flex gap-4">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="edit-authType"
                          value="auth_token"
                          checked={
                            editingProvider.editAuthType === 'auth_token'
                          }
                          onChange={() =>
                            setEditingProvider((p) =>
                              p ? { ...p, editAuthType: 'auth_token' } : null,
                            )
                          }
                          className="accent-[var(--ink)]"
                        />
                        <span className="text-sm text-[var(--ink)]">
                          AUTH_TOKEN
                        </span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="edit-authType"
                          value="api_key"
                          checked={editingProvider.editAuthType === 'api_key'}
                          onChange={() =>
                            setEditingProvider((p) =>
                              p ? { ...p, editAuthType: 'api_key' } : null,
                            )
                          }
                          className="accent-[var(--ink)]"
                        />
                        <span className="text-sm text-[var(--ink)]">
                          API_KEY
                        </span>
                      </label>
                    </div>
                  </div>
                )}

              {/* Models — preview + manage button */}
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-sm font-medium text-[var(--ink)]">
                    {tSettings('providers.custom.models')}
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      setManagingProviderId(editingProvider.provider.id)
                    }
                    className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-warm-subtle)]"
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                    {tSettings('providers.custom.manageModels')}
                  </button>
                </div>
                <p className="truncate text-sm text-[var(--ink-muted)]">
                  {editingProvider.provider.models.length > 0
                    ? editingProvider.provider.models
                        .map((m) => m.modelName || m.model)
                        .join(', ')
                    : tSettings('providers.noModels')}
                </p>
              </div>

              {/* Advanced Options - Model Alias Mapping (not shown for Anthropic providers) */}
              {editingProvider.provider.id !== 'anthropic-sub' &&
                editingProvider.provider.id !== 'anthropic-api' && (
                  <div className="border-t border-[var(--line)] pt-3">
                    <button
                      type="button"
                      onClick={() =>
                        setEditingProvider((p) =>
                          p ? { ...p, showAdvanced: !p.showAdvanced } : null,
                        )
                      }
                      className="flex w-full items-center gap-1.5 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
                    >
                      <ChevronDown
                        className={`h-4 w-4 transition-transform ${editingProvider.showAdvanced ? '' : '-rotate-90'}`}
                      />
                      {tSettings('providers.custom.advanced')}
                    </button>
                    {editingProvider.showAdvanced &&
                      (() => {
                        const aliasModels = [
                          {
                            value: '',
                            label: tSettings('providers.custom.unset'),
                          },
                          ...editingProvider.provider.models
                            .filter(
                              (m) =>
                                !editingProvider.removedModels.includes(
                                  m.model,
                                ),
                            )
                            .map((m) => ({
                              value: m.model,
                              label: m.modelName,
                            })),
                          ...editingProvider.customModels.map((m) => ({
                            value: m,
                            label: m,
                          })),
                        ];
                        const ALIAS_LABELS: Record<string, string> = {
                          fable: tSettings('providers.custom.aliasFable'),
                          opus: tSettings('providers.custom.aliasOpus'),
                          sonnet: tSettings('providers.custom.aliasSonnet'),
                          haiku: tSettings('providers.custom.aliasHaiku'),
                        };
                        return (
                          <div className="mt-3">
                            <label className="mb-1 block text-sm font-medium text-[var(--ink)]">
                              {tSettings('providers.custom.aliasMapping')}
                            </label>
                            <p className="mb-3 text-xs leading-relaxed text-[var(--ink-muted)]">
                              {tSettings('providers.custom.aliasDescription')}
                            </p>
                            <div className="space-y-2.5">
                              {(
                                ['fable', 'opus', 'sonnet', 'haiku'] as const
                              ).map((alias) => (
                                <div
                                  key={alias}
                                  className="flex items-center gap-2.5"
                                >
                                  <span className="w-[90px] shrink-0 text-xs text-[var(--ink-muted)]">
                                    {ALIAS_LABELS[alias]}
                                  </span>
                                  <CustomSelect
                                    value={
                                      editingProvider.editModelAliases?.[
                                        alias
                                      ] || ''
                                    }
                                    options={aliasModels}
                                    onChange={(v) =>
                                      setEditingProvider((p) =>
                                        p
                                          ? {
                                              ...p,
                                              editModelAliases: {
                                                ...p.editModelAliases,
                                                [alias]: v,
                                              },
                                            }
                                          : null,
                                      )
                                    }
                                    placeholder={tSettings(
                                      'providers.custom.unset',
                                    )}
                                    compact
                                    className="flex-1"
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })()}
                  </div>
                )}
            </div>

            <div className="flex-shrink-0 border-t border-[var(--line)] px-6 pt-6 pb-4">
              <div className="flex items-center justify-between">
                {!editingProvider.provider.isBuiltin ? (
                  <button
                    onClick={() =>
                      setDeleteConfirmProvider(editingProvider.provider)
                    }
                    className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-[var(--error)] transition-colors hover:bg-[var(--error-bg)]"
                  >
                    <Trash2 className="h-4 w-4" />
                    {tSettings('providers.custom.delete')}
                  </button>
                ) : (
                  <div />
                )}

                <div className="flex gap-3">
                  <button
                    onClick={() => setEditingProvider(null)}
                    className="rounded-lg border border-[var(--line)] px-4 py-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]"
                  >
                    {tSettings('providers.custom.cancel')}
                  </button>
                  <button
                    onClick={saveProviderEdits}
                    className="rounded-lg bg-[var(--button-primary-bg)] px-4 py-2.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                  >
                    {tSettings('providers.custom.save')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </OverlayBackdrop>
      )}

      {/* Model Management Panel */}
      {managingProvider && (
        <ModelManagementPanel
          provider={managingProvider}
          apiKey={apiKeys[managingProvider.id]}
          config={config}
          onClose={() => {
            setManagingProviderId(null);
            // Refresh editingProvider with latest provider data after model changes
            if (editingProvider && managingProvider) {
              const fresh = providers.find(
                (p) => p.id === editingProvider.provider.id,
              );
              if (fresh)
                setEditingProvider((prev) =>
                  prev ? { ...prev, provider: fresh } : null,
                );
            }
          }}
          onSaveCustomModels={savePresetCustomModels}
          onUpdateCustomProvider={updateCustomProvider}
          onSetPrimaryModel={savePrimaryModel}
          onRefresh={async () => {
            await refreshConfig();
            await refreshProviders();
          }}
          discoveryAction={
            managingProvider.id === XAI_SUBSCRIPTION_PROVIDER_ID &&
            providerVerifyStatus[XAI_SUBSCRIPTION_PROVIDER_ID]?.status ===
              'valid'
              ? discoverGrokModels
              : undefined
          }
          discoveryUnavailableMessage={
            managingProvider.id === XAI_SUBSCRIPTION_PROVIDER_ID &&
            providerVerifyStatus[XAI_SUBSCRIPTION_PROVIDER_ID]?.status !==
              'valid'
              ? tSettings('providers.grok.loginToDiscover')
              : undefined
          }
        />
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmProvider && (
        <OverlayBackdrop className="z-[60]">
          <div className="mx-4 w-full max-w-sm rounded-2xl bg-[var(--paper-elevated)] p-6 shadow-xl">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--error-bg)]">
                <Trash2 className="h-5 w-5 text-[var(--error)]" />
              </div>
              <h3 className="text-lg font-semibold text-[var(--ink)]">
                {tSettings('providers.custom.deleteTitle')}
              </h3>
            </div>
            <p className="mb-6 text-sm text-[var(--ink-muted)]">
              {tSettings('providers.custom.deleteMessage', {
                name: deleteConfirmProvider.name,
              })}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteConfirmProvider(null)}
                className="flex-1 rounded-lg border border-[var(--line)] px-4 py-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]"
              >
                {tSettings('providers.custom.cancel')}
              </button>
              <button
                onClick={confirmDeleteCustomProvider}
                className="flex-1 rounded-lg bg-[var(--error)] px-4 py-2.5 text-sm font-medium text-[var(--on-error)] transition-colors hover:bg-[var(--error-hover)]"
              >
                {tSettings('providers.custom.delete')}
              </button>
            </div>
          </div>
        </OverlayBackdrop>
      )}

      {/* Runtime not found dialog */}
      {runtimeDialog.show && (
        <OverlayBackdrop
          onClose={() => setRuntimeDialog({ show: false })}
          className="z-50"
        >
          <div className="mx-4 w-full max-w-sm rounded-2xl bg-[var(--paper-elevated)] p-6 shadow-xl">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--warning-bg)]">
                <AlertCircle className="h-5 w-5 text-[var(--warning)]" />
              </div>
              <h3 className="flex-1 text-lg font-semibold text-[var(--ink)]">
                {tSettings('toolbox.dialogs.runtimeMissing.title')}
              </h3>
              <button
                onClick={() => setRuntimeDialog({ show: false })}
                aria-label={tSettings('toolbox.dialogs.runtimeMissing.close')}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-4 text-sm text-[var(--ink-muted)]">
              {tSettings('toolbox.dialogs.runtimeMissing.descriptionPrefix')}{' '}
              <span className="font-medium text-[var(--ink)]">
                {runtimeDialog.runtimeName}
              </span>{' '}
              {tSettings('toolbox.dialogs.runtimeMissing.descriptionSuffix')}
            </p>
            <div className="mt-6 flex gap-3">
              <div
                className="flex-1"
                onClick={() => setRuntimeDialog({ show: false })}
              >
                <ExternalLink
                  href={runtimeDialog.downloadUrl || '#'}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--line)] px-4 py-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]"
                >
                  {tSettings('toolbox.dialogs.runtimeMissing.downloadOfficial')}
                  <ExternalLinkIcon className="h-3.5 w-3.5" />
                </ExternalLink>
              </div>
              {showAiInstallButton && (
                <button
                  onClick={handleAiInstallRuntime}
                  className="flex-1 rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-[var(--on-accent)] transition-colors hover:bg-[var(--accent-warm-hover)]"
                >
                  {tSettings('toolbox.dialogs.runtimeMissing.askHelperInstall')}
                </button>
              )}
            </div>
          </div>
        </OverlayBackdrop>
      )}

      {/* Bug Report Overlay */}
      {showBugReport && (
        <BugReportOverlay
          onClose={() => setShowBugReport(false)}
          onNavigateToProviders={() => {
            setShowBugReport(false);
            setActiveSection('providers');
          }}
          appVersion={appVersion}
          providers={providers}
          apiKeys={apiKeys}
          providerVerifyStatus={providerVerifyStatus}
          initialProviderId={helperAgentDefaults.initialProviderId}
          initialModel={helperAgentDefaults.initialModel}
          onModelChange={helperAgentDefaults.onModelChange}
          assistantEntry="settings"
        />
      )}

      {/* Agent detail overlay */}
      {overlayAgent && (
        <WorkspaceConfigPanel
          agentDir={overlayAgent.workspacePath}
          onClose={() => setOverlayAgent(null)}
          initialTab="agent"
          initialAddChannelPlatform={overlayAgent.initialAddChannelPlatform}
          onInitialAddChannelPlatformConsumed={
            handleInitialAddChannelPlatformConsumed
          }
        />
      )}
    </div>
  );
}
