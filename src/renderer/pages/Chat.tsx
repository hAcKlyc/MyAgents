import type { FilePreviewHandle } from '@/components/FilePreviewModal';
import { AlertTriangle, Bot, Globe, History, Loader2, MessageSquarePlus, PanelRight, RotateCcw, TerminalSquare, X } from 'lucide-react';
import { forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useMemo, useReducer, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { track } from '@/analytics';
import type { HistoryEntrySource } from '@/analytics';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import ConfirmDialog from '@/components/ConfirmDialog';
import WorkspaceIcon from '@/components/launcher/WorkspaceIcon';
import { useToast } from '@/components/Toast';
import {
  classifyCodexRewindTransportOutcome,
  projectCodexRewindRecovery,
  type RewindResponse,
  warnRewindFileOutcome as showRewindFileOutcomeWarning,
} from '@/utils/rewindFileOutcome';
import Tip from '@/components/Tip';
import DirectoryPanel, { type DirectoryPanelHandle, type WorkspaceTreePersistedState } from '@/components/DirectoryPanel';
import DropZoneOverlay from '@/components/DropZoneOverlay';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import MessageList from '@/components/MessageList';
import SessionHistoryDropdown from '@/components/SessionHistoryDropdown';
import SessionSurfaceTags from '@/components/SessionSurfaceTags';
import SessionMenuButton, { type BotChannelCandidate } from '@/components/SessionMenuButton';
import UserTagPills from '@/components/session-tags/UserTagPills';
import { FileActionProvider } from '@/context/FileActionContext';
import SimpleChatInput, { type ImageAttachment, type SimpleChatInputHandle } from '@/components/SimpleChatInput';
import type { SlashCommand as InputSlashCommand } from '@/components/SlashCommandMenu';
import AgentStatusPanel from '@/components/agent-status/AgentStatusPanel';
import ContextUsageIndicator from '@/components/ContextUsageIndicator';
import ChatBootOverlay from '@/components/ChatBootOverlay';
import {
  sessionConfigPushFingerprint,
  shouldPushSessionConfig,
  type SessionConfigPushMode,
} from '@/utils/sessionConfigPushPolicy';
import QueryNavigator from '@/components/chat/QueryNavigator';
import ChatSearchPanel from '@/components/ChatSearchPanel';
import { useChatSearch, isHighlightApiSupported } from '@/hooks/useChatSearch';
import { useBrowserResourceReady } from '@/hooks/useBrowserResourceReady';
import SelectionCommentMenu from '@/components/SelectionCommentMenu';
import TerminalReasonBanner from '@/components/TerminalReasonBanner';
import RuntimeDiagnosticsBanner from '@/components/RuntimeDiagnosticsBanner';
import { UnifiedLogsPanel } from '@/components/UnifiedLogsPanel';
import WorkspaceConfigPanel, { type Tab as WorkspaceTab } from '@/components/WorkspaceConfigPanel';
import CronTaskSettingsModal, {
  GOAL_SLASH_PRESET,
  type CronInitialConfig,
  type CronSettingsResult,
} from '@/components/cron/CronTaskSettingsModal';
import { transitionChannelBoundSession } from '@/pages/chatChannelSession';
import { useTabState, useTabActive } from '@/context/TabContext';
import { useChatScrollController } from '@/hooks/useChatScrollController';
import { useChatScrollModel } from '@/hooks/useChatScrollModel';
import { useAgentStatuses } from '@/hooks/useAgentStatuses';
import { useProjectCapabilities } from '@/hooks/useProjectCapabilities';
import { useSessionSurfaces, type ChannelSurface } from '@/hooks/useSessionSurfaces';
import { actions as taskCenterActions, resolveFloatingBallBoundSession } from '@/hooks/taskCenterStore';
import { usePassiveSessionMetadata } from '@/hooks/useTaskCenterData';
import { sameSessionUserTags } from '../../shared/session-user-tags';
import { useConfig } from '@/hooks/useConfig';
import { useFileDropZone } from '@/hooks/useFileDropZone';
import { useTauriFileDrop } from '@/hooks/useTauriFileDrop';
import { useCronTask } from '@/hooks/useCronTask';
import { useSessionGoal } from '@/hooks/useSessionGoal';
import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import { useWorkspaceChangeSignal } from '@/hooks/useWorkspaceChangeSignal';
import { isIntroductionAbsentError, shouldShowIntroductionOverlay, useIntroductionContent } from '@/hooks/useIntroductionContent';
import { resolveAdoptedBuiltinProviderId } from '@/utils/sessionConfigAdoption';
import { getSessionCronTask, isTaskExecuting, createCronTask, startCronTask as startCronTaskIpc } from '@/api/cronTaskClient';
import { updateSession as patchSessionMetadata } from '@/api/sessionClient';
import { releaseTabSession, sessionHasPersistentOwners } from '@/api/tauriClient';
import { persistInputOptionChange, type BuiltinModelSelection, type BuiltinProviderEnvPolicy } from '@/api/persistInputOption';
import { materializePendingSessionConfig } from '@/api/sessionMaterialize';
import type { CronTask } from '@/types/cronTask';
import type { SessionGoal, SessionGoalDraftConfig } from '@/types/sessionGoal';
import { isTerminalGoalStatus } from '@/types/sessionGoal';
import { formatCronScheduleDescription } from '@/utils/cronTaskI18n';
import CronTaskCard from '@/components/scheduled-tasks/CronTaskCard';
import CronTaskDetailPanel from '@/components/CronTaskDetailPanel';
import { projectTaskExecutionOverrides } from '@/utils/taskProviderProjection';
import { isTauriEnvironment } from '@/utils/browserMock';
import { isDebugMode } from '@/utils/debug';
import { getChannelTypeLabel } from '@/utils/taskCenterUtils';
import { appendCronPromptToDraft } from '@/utils/cronComposerRecovery';
import { runtimeModelCatalogPath } from '@/utils/runtimeModelCatalog';
import { launchSupportDiagnostics } from '@/utils/supportDiagnostics';
import { createDefaultSessionGoalDraftConfig } from '@/utils/sessionGoalDraft';
import { MANAGED_CODEX_COMPACT_SLASH_COMMAND } from '@/utils/slashActions';
import { CODEX_SUBSCRIPTION_PROVIDER_ID, type PermissionMode, type McpServerDefinition, type Project, type Provider, getEffectiveModelAliases } from '@/config/types';
import { syncMcpServerNames } from '@/components/tools/toolBadgeConfig';
import {
  getAllMcpServers,
  getEnabledMcpServerIds,
  isImageUnderstandingSelectionAvailable,
  isProviderAvailable,
  resolveProvider,
} from '@/config/configService';
import { patchAgentConfig, patchAgentProjectConfig, getAgentById } from '@/config/services/agentConfigService';
import { BrowserPanelContext } from '@/context/BrowserPanelContext';
import { BROWSER_BLANK_URL } from '@/components/browserConstants';
import { CUSTOM_EVENTS, isPendingSessionId } from '../../shared/constants';
import {
  applyBuiltinBrowserExecutionToolToggle,
  MANAGED_BROWSER_MCP_ID,
} from '../../shared/browserTools';
import {
  IMAGE_UNDERSTANDING_TOOL_ID,
  OFFICIAL_TOOLS,
  normalizeOfficialToolIds,
  type OfficialToolId,
} from '../../shared/official-tools';
import { isSupportedLocale } from '../../shared/i18n';
import { workspacePathsEqual } from '../../shared/workspacePath';
import type { MainWindowPresentation } from '@/utils/mainWindowPresentation';
import { supportsCodexConversationBranch } from '../../shared/codex-conversation-capability';
import { coerceReasoningEffortForRuntime, reasoningEffortChoices } from '../../shared/reasoningEffort';
import type { ProviderHistoryEnv } from '../../shared/providerHistory';
import { createConcreteProviderRoute, hasProviderRouteCredential, isConcreteProviderRoute } from '../../shared/providerRoute';
import type { ProviderRoute } from '../../shared/providerRoute';
import {
  agentUsesManagedCodexProvider,
  isRuntimeBackedProvider,
  managedCodexRuntimePermissionToProviderPermission,
  projectManagedCodexPermissionToRuntime,
  runtimeBackedProviderPermissionMode,
  toProviderExecutionIntent,
  type RuntimeBackedProviderIdentity,
  type ProviderExecutionIntent,
} from '../../shared/providerExecution';
import type { SessionOrigin } from '../../shared/session-origin';
import type { CapabilityInitialSelect } from '../../shared/skillsTypes';
import {
  buildRuntimeChangePatch,
  CC_MODELS,
  CC_PERMISSION_MODES,
  CODEX_PERMISSION_MODES,
  coerceModelForRuntime,
  GEMINI_PERMISSION_MODES,
  getDefaultRuntimePermissionMode,
  projectPermissionModeForRuntime,
} from '../../shared/types/runtime';
import type { RuntimeType, RuntimeDetections, RuntimeConfig, RuntimeDiagnostics, RuntimeExtensionDiagnostics } from '../../shared/types/runtime';
import type { FilePreviewIntent, InitialMessage, LaunchSessionBirthHint, SidecarConfigDisposition } from '@/types/tab';
import type { FilePreviewFocusTarget } from '@/types/filePreview';
import { shouldAutoSendInitialMessage } from '@/utils/initialMessageAutoSend';
import {
  canResumeProviderHistoryForSwitch,
  resolveBuiltinPermissionMode,
  resolveCurrentProviderForSession,
  resolveLegacyBuiltinSnapshotProviderId,
  isPinnedProviderUnavailable,
  shouldBlockSendForLabsDisabledExternalRuntime,
  shouldResetModelOnProviderChange,
  shouldSkipSnapshotWrite,
} from '@/utils/optionResolve';
import { buildProviderSwitchSessionBirth } from '@/utils/providerSwitchSessionBirth';
import {
  projectInputChromeRuntime,
  projectRuntimeExtensionUpdateNotice,
  shouldShowBuiltinSdkSlashCommands,
  shouldUseExternalRuntimeInputControls,
} from '@/utils/runtimeUiProjection';
import {
  createWorkspacePanelDisclosureState,
  DEFAULT_WORKSPACE_LAYOUT_METRICS,
  nextSplitViewAfterBrowserClose,
  reduceWorkspacePanelDisclosure,
  resolveWorkspacePanelMode,
  shouldPresentBrowserFullscreen,
} from '@/utils/chatWorkspaceLayout';
import {
  isManagedProviderSessionSnapshot,
  managedProviderSnapshotModel,
  managedProviderSnapshotProviderId,
  shouldSessionSnapshotUseProviderPicker,
} from '@/utils/sessionSnapshotProviderProjection';
import { coerceRuntimeBirthPermissionMode } from '../../shared/runtimeBirthFields';
// CronTaskConfig type is used via useCronTask hook

import { getRichDocKind, isPreviewable, type RichDocKind } from '../../shared/fileTypes';

const DESKTOP_SESSION_FORK_ORIGIN: SessionOrigin = { kind: 'desktop', surface: 'session_fork' };
const WORKSPACE_PANEL_TRANSITION_MS = 200;

type ExtensionUpdateResponse = {
  success?: boolean;
  error?: string;
  extensionStatus?: RuntimeExtensionDiagnostics;
};

type SessionConfigPushKind = 'mcp' | 'agents';

type SplitPreviewFile = {
  name: string;
  content: string;
  size: number;
  path: string;
  sourceScope?: 'workspace' | 'local';
  localPath?: string;
  richDocKind?: RichDocKind;
  initialEditMode?: boolean;
  initialLineNumber?: number;
  focusTarget?: FilePreviewFocusTarget;
};

type SwitchDialogCopy = {
  title: string;
  message: string;
  confirmText: string;
};

type WorkspaceLayoutMetrics = {
  viewportWidthPx: number;
  contentMinWidthPx: number;
  sidebarMinWidthPx: number;
};

function readRootPixelToken(tokenName: string, fallback: number): number {
  if (typeof document === 'undefined') return fallback;
  const value = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(tokenName),
  );
  return Number.isFinite(value) ? value : fallback;
}

function readWorkspaceLayoutMetrics(): WorkspaceLayoutMetrics {
  return {
    viewportWidthPx: typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth,
    contentMinWidthPx: readRootPixelToken(
      '--breakpoint-mobile',
      DEFAULT_WORKSPACE_LAYOUT_METRICS.contentMinWidthPx,
    ),
    sidebarMinWidthPx: readRootPixelToken(
      '--sidebar-min-width',
      DEFAULT_WORKSPACE_LAYOUT_METRICS.sidebarMinWidthPx,
    ),
  };
}

function shouldShowWorkspaceByDefault(): boolean {
  const metrics = readWorkspaceLayoutMetrics();
  return metrics.viewportWidthPx - metrics.sidebarMinWidthPx >= metrics.contentMinWidthPx;
}

// Lazy load FilePreviewModal for split view panel
const FilePreviewModal = lazy(() => import('@/components/FilePreviewModal'));
// Lazy load TerminalPanel for embedded terminal
const LazyTerminalPanel = lazy(() => import('@/components/TerminalPanel').then(m => ({ default: m.TerminalPanel })));
// Lazy load BrowserPanel for embedded browser
const LazyBrowserPanel = lazy(() => import('@/components/BrowserPanel'));
// Lazy load IntroductionOverlay for empty session welcome content
const LazyIntroductionOverlay = lazy(() => import('@/components/IntroductionOverlay'));
// Terminal chrome now uses CSS tokens that auto-switch with light/dark theme.
// No need for cached theme constants — the header uses var(--paper), var(--ink), etc.

/** Human-readable label for a runtime type (used in confirm dialogs, toasts, etc.) */
function getRuntimeDisplayLabel(runtime: RuntimeType | undefined): string {
  switch (runtime) {
    case 'claude-code': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'gemini': return 'Gemini CLI';
    case 'builtin':
    default:
      return 'MyAgents';
  }
}

function buildBuiltinProviderRoute(provider: Provider | undefined, model: string | undefined): ProviderRoute | undefined {
  if (!provider || !model) return undefined;
  if (isRuntimeBackedProvider(provider)) return undefined;
  return createConcreteProviderRoute(provider.id, model);
}

function buildProviderExecutionIntent(
  provider: Pick<Provider, 'id' | 'execution'> | undefined,
  model: string | undefined,
): ProviderExecutionIntent | undefined {
  if (!provider || !model) return undefined;
  return toProviderExecutionIntent(provider, model);
}

function isRuntimeBackedIntent(intent: ProviderExecutionIntent | undefined): boolean {
  return intent?.kind === 'runtime-backed-provider';
}

function isCodexSubscriptionIntent(intent: ProviderExecutionIntent | undefined): boolean {
  return intent?.kind === 'runtime-backed-provider'
    && intent.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID;
}

function providerDisplayName(
  provider: Pick<Provider, 'id' | 'name'> | undefined,
  fallback: string,
): string {
  return provider?.name?.trim() || provider?.id || fallback;
}

function buildProviderSwitchDialogCopy(t: TFunction<'chat'>, args: {
  currentProvider?: Pick<Provider, 'id' | 'name'>;
  targetProvider?: Pick<Provider, 'id' | 'name'>;
  currentIntent?: ProviderExecutionIntent;
  targetIntent?: ProviderExecutionIntent;
  targetModel?: string;
  targetProviderId?: string;
}): SwitchDialogCopy {
  const currentIsCodex = isCodexSubscriptionIntent(args.currentIntent);
  const targetIsCodex = isCodexSubscriptionIntent(args.targetIntent);
  const currentProviderName = currentIsCodex
    ? t('shell.providerSwitch.codexSubscription')
    : providerDisplayName(args.currentProvider, t('shell.providerSwitch.currentProviderFallback'));
  const targetProviderName = targetIsCodex
    ? t('shell.providerSwitch.codexSubscription')
    : providerDisplayName(args.targetProvider, args.targetProviderId ?? t('shell.providerSwitch.targetProviderFallback'));

  if (targetIsCodex && !currentIsCodex) {
    return {
      title: t('shell.providerSwitch.codexTarget.title'),
      message: t('shell.providerSwitch.codexTarget.message'),
      confirmText: t('shell.providerSwitch.codexTarget.confirm'),
    };
  }

  if (currentIsCodex && !targetIsCodex) {
    return {
      title: t('shell.providerSwitch.newSessionTitle'),
      message: t('shell.providerSwitch.codexCurrent.message'),
      confirmText: t('shell.providerSwitch.createNewSession'),
    };
  }

  if (isRuntimeBackedIntent(args.currentIntent) || isRuntimeBackedIntent(args.targetIntent)) {
    return {
      title: t('shell.providerSwitch.newSessionTitle'),
      message: t('shell.providerSwitch.runtimeBacked.message'),
      confirmText: t('shell.providerSwitch.createNewSession'),
    };
  }

  const sameProvider = !!args.currentProvider?.id
    && args.currentProvider.id === (args.targetProvider?.id ?? args.targetProviderId);
  if (sameProvider) {
    const targetModel = args.targetModel ?? t('shell.providerSwitch.targetModelFallback');
    return {
      title: t('shell.providerSwitch.newSessionTitle'),
      message: t('shell.providerSwitch.sameProvider.message', { targetModel }),
      confirmText: t('shell.providerSwitch.createNewSession'),
    };
  }

  return {
    title: t('shell.providerSwitch.newSessionTitle'),
    message: t('shell.providerSwitch.crossProvider.message', { currentProviderName, targetProviderName }),
    confirmText: t('shell.providerSwitch.createNewSession'),
  };
}

function coerceExternalRuntimeModelForUi(model: string | undefined, runtime: RuntimeType): string | undefined {
  return runtime === 'builtin' ? model : coerceModelForRuntime(model, runtime);
}

function coerceExternalRuntimePermissionForUi(mode: string | undefined, runtime: RuntimeType): string | undefined {
  return runtime === 'builtin' ? mode : projectPermissionModeForRuntime(mode, runtime);
}

function coerceInitialMessageRuntimePermission(
  initialMessage: InitialMessage,
  runtime: RuntimeType,
): string | undefined {
  const identity = initialMessage.providerExecutionIdentity;
  if (identity) {
    return runtimeBackedProviderPermissionMode(identity, initialMessage.permissionMode);
  }
  return coerceExternalRuntimePermissionForUi(initialMessage.permissionMode, runtime);
}

function coerceReasoningEffortForUi(effort: string | undefined, runtime: RuntimeType): string | undefined {
  return coerceReasoningEffortForRuntime(effort, runtime);
}

function toProviderHistoryEnv(
  provider: Pick<Provider, 'id' | 'type' | 'config' | 'apiProtocol'> | undefined,
  model?: string,
): ProviderHistoryEnv | undefined {
  if (!provider) return model ? { model } : undefined;
  if (provider.type === 'subscription') {
    return {
      providerId: provider.id,
      model,
    };
  }
  return {
    providerId: provider.id,
    baseUrl: provider.config.baseUrl,
    apiProtocol: provider.apiProtocol,
    model,
  };
}

/** Imperative handle exposed by SessionTitleEditor — lets the SessionMenuButton's
 *  "重命名" item drive the same inline editor that title-click triggers. */
export interface SessionTitleEditorHandle {
  openRename: () => void;
}

/** Inline-editable session title — click to edit, Enter/Blur to save, Esc to cancel */
const SessionTitleEditor = forwardRef<
  SessionTitleEditorHandle,
  { title: string; onRename: (newTitle: string) => void }
>(function SessionTitleEditor({ title, onRename }, ref) {
  const { t } = useTranslation('chat');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setDraft(title); }, [title]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  useImperativeHandle(ref, () => ({
    openRename: () => setEditing(true),
  }), []);

  const commit = () => {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed && trimmed !== title) {
      track('session_title_edit', {});
      onRename(trimmed);
    }
  };

  return (
    <div className="min-w-0 max-w-[360px]">
      {editing ? (
        <input
          ref={inputRef}
          className="w-full rounded border border-[var(--line)] bg-[var(--paper-inset)] px-1.5 py-0.5 text-sm font-medium text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') inputRef.current?.blur();
            if (e.key === 'Escape') { setDraft(title); setEditing(false); }
          }}
        />
      ) : (
        <span
          className="block truncate cursor-pointer px-1.5 py-0.5 text-sm font-medium text-[var(--ink-subtle)] hover:text-[var(--ink)] transition-colors"
          onClick={() => setEditing(true)}
          title={t('shell.sessionTitle.renameTitle')}
        >
          {title}
        </span>
      )}
    </div>
  );
});

interface ChatProps {
  /** Native shown/not-minimized lifecycle; focus is intentionally independent. */
  windowPresentation: MainWindowPresentation;
  /** Called when user starts a new session. Returns true if handled externally (background completion started). */
  onNewSession?: () => Promise<boolean>;
  /** Opens a persisted Session through App's canonical new/jump/revive path. */
  onOpenSession?: (sessionId: string, title: string, historyEntrySource?: HistoryEntrySource) => void;
  /** Explicit per-row new-tab action; it shares the same canonical App path. */
  onOpenSessionInNewTab?: (sessionId: string, title: string) => void;
  /** Initial message from Launcher for auto-send on workspace open */
  initialMessage?: InitialMessage;
  /** Called after initialMessage has been consumed */
  onInitialMessageConsumed?: () => void;
  /** How this chat reconciles config with its sidecar: 'push' (push tab config),
   *  'adopt' (adopt the live sidecar's config), or 'pending' (instant flip before
   *  ensure resolved — do NEITHER until the post-ensure resolver decides). See the
   *  SidecarConfigDisposition type doc. */
  sidecarConfigDisposition: SidecarConfigDisposition;
  /** Called after the sidecar's config has been adopted (disposition 'adopt') */
  onSidecarConfigAdopted?: () => void;
  /** Current session title (from tab state) */
  sessionTitle?: string;
  /** Called when user renames the session */
  onRenameSession?: (newTitle: string) => void;
  /** Called when user forks session at a specific assistant message — App creates new tab */
  onForkSession?: (newSessionId: string, agentDir: string, title: string, initialMessage?: string) => Promise<boolean>;
  /** App-owned fresh-session launch for a runtime-backed provider switch. */
  onLaunchRuntimeBackedProviderSession?: (
    project: Project,
    sessionBirthHint: LaunchSessionBirthHint & { providerExecutionIdentity: RuntimeBackedProviderIdentity },
    title: string,
  ) => Promise<string | null>;
  /** Runtime-only request from App/floating-ball to open a file preview once. */
  pendingFilePreview?: FilePreviewIntent;
  onFilePreviewIntentConsumed?: (intentId: string) => void;
  sessionNotificationBadgeCounts?: ReadonlyMap<string, number>;
  /** Open App Shell history with a clean, single-Tag aggregation intent. */
  onOpenHistoryTag?: (tag: string) => void;
}

function isCurrentSessionGoal(goal: SessionGoal | null | undefined): goal is SessionGoal {
  return Boolean(goal);
}

export default function Chat({ windowPresentation, onNewSession, onOpenSession, onOpenSessionInNewTab, initialMessage, onInitialMessageConsumed, sidecarConfigDisposition, onSidecarConfigAdopted, sessionTitle, onRenameSession, onForkSession, onLaunchRuntimeBackedProviderSession, pendingFilePreview, onFilePreviewIntentConsumed, sessionNotificationBadgeCounts, onOpenHistoryTag }: ChatProps) {
  // Get state from TabContext (required - Chat must be inside TabProvider)
  const {
    tabId,
    agentDir,
    sessionId,
    messages,
    historyMessages,
    streamingMessage,
    firstItemIndex,
    hasMoreBefore: _hasMoreBefore,
    loadOlderMessages,
    isLoading,
    getQueryElapsedSeconds,
    isSessionLoading,
    sessionRestoreError,
    sessionState,
    sessionRuntime,
    sessionRuntimeSource,
    sessionMeta,
    setSessionMeta,
    unifiedLogs,
    systemInitInfo,
    mcpEffectiveSnapshot,
    sdkSlashCommands,
    runtimeDiagnostics,
    agentError,
    systemStatus,
    systemNotice,
    lastTerminalReason,
    pendingPermission,
    pendingAskUserQuestion,
    pendingExitPlanMode,
    pendingEnterPlanMode,
    respondExitPlanMode,
    toolCompleteCount,
    setMessages,
    setIsLoading,
    setAgentError,
    setLastTerminalReason,
    setSystemNotice,
    sendMessage,
    stopResponse,
    retryCurrentSessionRestore,
    resetSession,
    adoptMigratedSession,
    clearUnifiedLogs,
    respondPermission,
    respondAskUserQuestion,
    apiPost,
    apiGet,
    setSessionState,
    queuedMessages,
    cancelQueuedMessage,
    forceExecuteQueuedMessage,
    isConnected,
  } = useTabState();
  const projectedSessionMeta = usePassiveSessionMetadata(agentDir, sessionId);

  useEffect(() => {
    if (!projectedSessionMeta) return;
    setSessionMeta((current) => {
      if (!current || current.id !== projectedSessionMeta.id) return current;
      if (sameSessionUserTags(current.userTags, projectedSessionMeta.userTags)) return current;
      return { ...current, userTags: projectedSessionMeta.userTags };
    });
  }, [projectedSessionMeta, setSessionMeta]);
  const isActive = useTabActive();
  const toast = useToast();
  const { t } = useTranslation('chat');
  const { t: tSettings } = useTranslation('settings');
  const { t: tTask, i18n } = useTranslation('task');
  const managedBrowserReady = useBrowserResourceReady();
  const taskLocale = isSupportedLocale(i18n.language) ? i18n.language : 'zh-CN';
  const tRef = useRef(t);
  tRef.current = t;

  // Workspace file service owns ordinary workspace IO. Capability policy is
  // resolved once by the Sidecar endpoint below; Chat injects that same
  // effective snapshot into its sidebar and slash picker.
  const fileService = useWorkspaceFileService(agentDir);

  // Get config to find current project provider
  const { config, projects, providers, patchProject, apiKeys, providerVerifyStatus, refreshProviderData, refreshConfig } = useConfig();
  const currentProject = projects.find((p) => workspacePathsEqual(p.path, agentDir));
  // AgentConfig is source of truth for AI settings, Project is fallback for non-agent workspaces
  const currentAgent = currentProject?.agentId ? getAgentById(config, currentProject.agentId) : undefined;
  // Local provider state: snapshot from AgentConfig (priority) or Project at creation.
  // Prevents cross-tab pollution when another tab patches the shared project.
  const [selectedProviderId, setSelectedProviderId] = useState<string | undefined>(
    currentAgent?.providerId ?? currentProject?.providerId ?? config.defaultProviderId ?? undefined
  );
  const sessionSnapshotOwnsConfig = !!sessionMeta?.configSnapshotAt;
  const waitingForExistingSessionMeta = !!sessionId && !isPendingSessionId(sessionId) && !sessionMeta;
  const sessionSnapshotRuntime = (sessionMeta?.runtime as RuntimeType | undefined) ?? 'builtin';
  const sessionSnapshotIsManagedProvider = sessionSnapshotOwnsConfig
    && isManagedProviderSessionSnapshot(sessionMeta);
  const sessionSnapshotUsesProviderPicker = sessionSnapshotOwnsConfig
    && shouldSessionSnapshotUseProviderPicker({
      session: sessionMeta,
      runtime: sessionSnapshotRuntime,
    });
  const concreteSessionProviderRoute = isConcreteProviderRoute(sessionMeta?.providerRoute)
    ? sessionMeta.providerRoute
    : undefined;
  const sessionSnapshotProviderId = sessionSnapshotUsesProviderPicker
    ? (sessionSnapshotIsManagedProvider
      ? (sessionMeta ? managedProviderSnapshotProviderId(sessionMeta) : undefined)
      : (concreteSessionProviderRoute?.providerId ?? resolveLegacyBuiltinSnapshotProviderId({
        snapshotProviderId: sessionMeta?.providerId,
        snapshotModel: sessionMeta?.model,
        selectedProviderId,
        providers,
        apiKeys,
        providerVerifyStatus,
      })))
    : undefined;
  const effectiveSelectedProviderId = sessionSnapshotUsesProviderPicker
    ? sessionSnapshotProviderId
    : selectedProviderId;
  const selectedProviderExact = effectiveSelectedProviderId ? providers.find(p => p.id === effectiveSelectedProviderId) : undefined;
  const selectedProviderAvailable = selectedProviderExact
    ? (
      isRuntimeBackedProvider(selectedProviderExact)
        ? isProviderAvailable(selectedProviderExact, apiKeys, providerVerifyStatus)
        : sessionSnapshotOwnsConfig && selectedProviderExact.type === 'subscription'
        ? hasProviderRouteCredential(selectedProviderExact, { apiKeys, verifyStatus: providerVerifyStatus })
        : isProviderAvailable(selectedProviderExact, apiKeys, providerVerifyStatus)
    )
    : false;
  const availableProviderIdsForInput = useMemo(() => providers
    .filter(provider => isRuntimeBackedProvider(provider)
      ? isProviderAvailable(provider, apiKeys, providerVerifyStatus)
      : provider.type === 'subscription'
        ? provider.enabled !== false && hasProviderRouteCredential(provider, { apiKeys, verifyStatus: providerVerifyStatus })
        : isProviderAvailable(provider, apiKeys, providerVerifyStatus))
    .map(provider => provider.id), [providers, apiKeys, providerVerifyStatus]);
  const fallbackProvider = resolveProvider(effectiveSelectedProviderId, providers, apiKeys, providerVerifyStatus);
  const currentProvider = resolveCurrentProviderForSession({
    sessionSnapshotOwnsConfig,
    selectedProviderId: effectiveSelectedProviderId,
    selectedProvider: selectedProviderExact,
    selectedProviderAvailable,
    fallbackProvider,
  });
  const currentProviderForHistory = sessionSnapshotOwnsConfig
    ? selectedProviderExact
    : currentProvider;
  const builtinSnapshotProviderHistoryUnknown = sessionSnapshotOwnsConfig
    && sessionSnapshotRuntime === 'builtin'
    && !!sessionMeta?.model
    && !currentProviderForHistory;
  const builtinSnapshotProviderSelectionIncomplete = sessionSnapshotOwnsConfig
    && sessionSnapshotRuntime === 'builtin'
    && !!sessionMeta?.model
    && !effectiveSelectedProviderId;
  const currentProviderAvailableForInput = builtinSnapshotProviderSelectionIncomplete
    || (!!currentProvider && availableProviderIdsForInput.includes(currentProvider.id));

  // PERFORMANCE: Ref-stabilize object deps used in handleSendMessage
  // Prevents useCallback from creating new references when these objects change,
  // which would defeat SimpleChatInput's memo.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const channelSurfaceRef = useRef<ChannelSurface | null>(null);
  const currentProviderRef = useRef(currentProvider);
  currentProviderRef.current = currentProvider;
  const apiKeysRef = useRef(apiKeys);
  apiKeysRef.current = apiKeys;
  const configRef = useRef(config);
  configRef.current = config;

  /** Build providerEnv for a given provider, including modelAliases for sub-agent model resolution */
  const buildProviderEnv = useCallback((provider: typeof currentProvider) => {
    if (!provider || provider.type === 'subscription') return undefined;
    const aliases = getEffectiveModelAliases(provider, configRef.current.providerModelAliases);
    return {
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: provider.config.baseUrl,
      apiKey: apiKeysRef.current[provider.id],
      authType: provider.authType,
      apiProtocol: provider.apiProtocol,
      maxOutputTokens: provider.maxOutputTokens,
      maxOutputTokensParamName: provider.maxOutputTokensParamName,
      upstreamFormat: provider.upstreamFormat,
      ...(aliases ? { modelAliases: aliases } : {}),
    };
  }, []);

  // PERFORMANCE: inputValue is now managed internally by SimpleChatInput
  // to avoid re-rendering Chat (and MessageList) on every keystroke
  const [showLogs, setShowLogs] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const isChatHistoryEntryVisible = config.showChatHistoryEntry === true;
  useEffect(() => {
    if (!isChatHistoryEntryVisible) setShowHistory(false);
  }, [isChatHistoryEntryVisible]);
  const historyBtnRef = useRef<HTMLButtonElement>(null);
  // Imperative handle for the inline title editor — lets the SessionMenuButton's
  // "重命名" item invoke the same flow as clicking the title.
  const titleEditorRef = useRef<SessionTitleEditorHandle>(null);
  const [workspaceLayoutMetrics, setWorkspaceLayoutMetrics] = useState(readWorkspaceLayoutMetrics);
  const isNarrowLayout = workspaceLayoutMetrics.viewportWidthPx < workspaceLayoutMetrics.contentMinWidthPx;
  // If workspace would render as an overlay at startup, keep it hidden so it
  // does not block the chat before the user explicitly opens it.
  const [workspacePanelDisclosure, dispatchWorkspacePanelDisclosure] = useReducer(
    reduceWorkspacePanelDisclosure,
    undefined,
    () => createWorkspacePanelDisclosureState(shouldShowWorkspaceByDefault()),
  );
  const {
    visible: showWorkspace,
    mounted: workspacePanelMounted,
    motion: workspacePanelMotion,
  } = workspacePanelDisclosure;
  const workspacePanelUnmountTimerRef = useRef<number | null>(null);
  const clearWorkspacePanelUnmountTimer = useCallback(() => {
    if (workspacePanelUnmountTimerRef.current === null) return;
    window.clearTimeout(workspacePanelUnmountTimerRef.current);
    workspacePanelUnmountTimerRef.current = null;
  }, []);
  const handleExpandWorkspace = useCallback(() => {
    clearWorkspacePanelUnmountTimer();
    dispatchWorkspacePanelDisclosure({ type: 'open' });
  }, [clearWorkspacePanelUnmountTimer]);
  const handleCollapseWorkspace = useCallback(() => {
    clearWorkspacePanelUnmountTimer();
    dispatchWorkspacePanelDisclosure({ type: 'close' });
    workspacePanelUnmountTimerRef.current = window.setTimeout(() => {
      dispatchWorkspacePanelDisclosure({ type: 'settle-close' });
      workspacePanelUnmountTimerRef.current = null;
    }, WORKSPACE_PANEL_TRANSITION_MS);
  }, [clearWorkspacePanelUnmountTimer]);
  useEffect(() => clearWorkspacePanelUnmountTimer, [clearWorkspacePanelUnmountTimer]);
  const [showWorkspaceConfig, setShowWorkspaceConfig] = useState(false); // Workspace config panel
  // State to trigger workspace refresh
  const [workspaceRefreshTrigger, setWorkspaceRefreshTrigger] = useState(0);
  const [introductionRefreshTrigger, setIntroductionRefreshTrigger] = useState(0);
  const workspaceChangeSignal = useWorkspaceChangeSignal(agentDir || null, fileService.isAvailable);
  // Introduction overlay: INTRODUCTION.md content for empty session welcome.
  // Workspace-scoped, not session-scoped: sidecar/session id transitions must not
  // unmount and replay the welcome page while a fresh workspace is booting.
  const readIntroductionContent = useCallback(async (path: string) => {
    if (!fileService.isAvailable) return null;
    try {
      const preview = await fileService.readPreview({ path });
      return preview.content;
    } catch (err) {
      if (isIntroductionAbsentError(err)) return null;
      throw err;
    }
  }, [fileService]);
  const introductionContent = useIntroductionContent(
    agentDir,
    introductionRefreshTrigger + workspaceChangeSignal,
    readIntroductionContent,
  );
  useEffect(() => {
    const updateLayoutMetrics = () => setWorkspaceLayoutMetrics(readWorkspaceLayoutMetrics());
    updateLayoutMetrics();
    window.addEventListener('resize', updateLayoutMetrics);
    return () => window.removeEventListener('resize', updateLayoutMetrics);
  }, []);

  // Split view: right-side file preview panel (experimental).
  // `initialEditMode` is set when a fresh `note-…md` is created via 「新建笔记」 —
  // FilePreviewModal opens directly in the editable Monaco view instead of the
  // markdown rendered preview.
  const isSplitViewEnabled = config.experimentalSplitView ?? true;
  const [splitFile, setSplitFile] = useState<SplitPreviewFile | null>(null);
  const splitFilePreviewRef = useRef<FilePreviewHandle>(null);
  // Clear split panel when feature is turned off (prevents stale split state)
  useEffect(() => { if (!isSplitViewEnabled) setSplitFile(null); }, [isSplitViewEnabled]);
  const [splitRatio, setSplitRatio] = useState(0.5); // 0-1, left panel fraction
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const [isSplitWidthTransitioning, setIsSplitWidthTransitioning] = useState(false);
  const isDraggingSplitRef = useRef(false);
  const splitRatioRef = useRef(splitRatio);
  splitRatioRef.current = splitRatio;
  const isWindowsPlatform = useMemo(
    () => typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('win'),
    [],
  );
  // Store drag listeners in refs so unmount cleanup can remove them
  const dragMoveRef = useRef<((ev: MouseEvent) => void) | null>(null);
  const dragUpRef = useRef<(() => void) | null>(null);

  // ── Embedded terminal state ──
  // Terminal lifecycle is tied to this Tab, not to the panel visibility.
  // Hiding the panel keeps the PTY alive; only Tab close kills it.
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [terminalAlive, setTerminalAlive] = useState(false);
  const terminalIdRef = useRef<string | null>(null);
  terminalIdRef.current = terminalId;
  // Whether the user has the terminal "pinned" to the split panel.
  // true = terminal is shown in the panel (or being created).
  // false = terminal may be alive in background but not displayed.
  // Clicking terminal icon sets true; clicking terminal × sets false.
  const [terminalPinned, setTerminalPinned] = useState(false);
  // Which view is active in the right panel: 'file', 'terminal', or 'browser'
  const [splitActiveView, setSplitActiveView] = useState<'file' | 'terminal' | 'browser'>('file');

  // ── Embedded browser state ──
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);
  const [browserAlive, setBrowserAlive] = useState(false);
  const [browserReloadSignal, setBrowserReloadSignal] = useState(0);
  // When browser is previewing a local file, store its metadata for editor toggle
  const [browserSourceFile, setBrowserSourceFile] = useState<{ name: string; content: string; size: number; path: string } | null>(null);
  // Live URL surfaced from BrowserPanel (Rust `browser:url-changed`). Drives
  // the split-view tab label; `browserUrl` is the seed URL only and never
  // updates after navigation.
  const [browserCurrentUrl, setBrowserCurrentUrl] = useState<string>('');
  const handleBrowserUrlChange = useCallback((u: string) => {
    setBrowserCurrentUrl(u);
  }, []);

  // Browser resource cleanup has one owner. Every close entry point delegates
  // here so a surviving terminal/file view always takes over consistently.
  const handleBrowserClose = useCallback(() => {
    setBrowserUrl(null);
    setBrowserAlive(false);
    setBrowserSourceFile(null);
    setBrowserCurrentUrl('');
    const nextView = nextSplitViewAfterBrowserClose({
      terminalVisible: terminalPinned && terminalAlive,
      fileVisible: splitFile !== null,
    });
    if (nextView) setSplitActiveView(nextView);
  }, [terminalPinned, terminalAlive, splitFile]);

  // Browser links stay inside MyAgents even when the split layout has no room.
  // In that case the same BrowserPanel owner fills the Chat surface instead of
  // falling back to a system browser.
  const browserUsesFullscreen = shouldPresentBrowserFullscreen({
    browserPresented: browserUrl !== null && splitActiveView === 'browser',
    splitViewEnabled: isSplitViewEnabled,
    narrowLayout: isNarrowLayout,
  });

  // Derived: is the right split panel visible?
  const splitPanelVisible = splitFile !== null
    || (terminalPinned && (terminalAlive || splitActiveView === 'terminal'))
    || (browserUrl !== null);
  // Should the terminal component stay mounted? (for xterm.js state preservation)
  const terminalMounted = terminalAlive || (terminalPinned && splitActiveView === 'terminal');

  const splitWidthTransitionTimerRef = useRef<number | null>(null);
  const startSplitWidthTransitionSuspension = useCallback(() => {
    if (!isWindowsPlatform) return;
    setIsSplitWidthTransitioning(true);
    if (splitWidthTransitionTimerRef.current !== null) {
      window.clearTimeout(splitWidthTransitionTimerRef.current);
    }
    splitWidthTransitionTimerRef.current = window.setTimeout(() => {
      setIsSplitWidthTransitioning(false);
      splitWidthTransitionTimerRef.current = null;
    }, 320);
  }, [isWindowsPlatform]);
  useEffect(() => () => {
    if (splitWidthTransitionTimerRef.current !== null) {
      window.clearTimeout(splitWidthTransitionTimerRef.current);
    }
  }, []);
  const startBrowserSplitTransitionIfNeeded = useCallback(() => {
    if (!splitPanelVisible) startSplitWidthTransitionSuspension();
  }, [splitPanelVisible, startSplitWidthTransitionSuspension]);

  const workspacePanelMode = resolveWorkspacePanelMode({
    viewportWidthPx: workspaceLayoutMetrics.viewportWidthPx,
    splitPanelVisible: isSplitViewEnabled && splitPanelVisible && !browserUsesFullscreen,
    splitRatio,
    contentMinWidthPx: workspaceLayoutMetrics.contentMinWidthPx,
    sidebarMinWidthPx: workspaceLayoutMetrics.sidebarMinWidthPx,
  });
  const shouldUseWorkspaceOverlay = workspacePanelMode === 'overlay';

  // Cmd+W: split panel visible → always close the active view first (no focus detection).
  // Simpler mental model: Cmd+W closes from right to left, outside to inside.
  // Split panel acts as a buffer — absorbs Cmd+W before it reaches the tab.
  useCloseLayer(() => {
    if (!splitPanelVisible) return false;
    if (splitActiveView === 'file' && splitFile) {
      splitFilePreviewRef.current?.close();
      return true;
    }
    if (splitActiveView === 'terminal' && terminalPinned) {
      setTerminalPinned(false);
      if (browserUrl) setSplitActiveView('browser');
      else if (splitFile) setSplitActiveView('file');
      return true;
    }
    if (splitActiveView === 'browser' && browserUrl) {
      handleBrowserClose();
      return true;
    }
    return false;
  }, 0);

  // Fullscreen BrowserPanel is an overlay-like surface above Chat chrome.
  useCloseLayer(() => {
    if (!isActive || !browserUsesFullscreen || splitActiveView !== 'browser' || !browserUrl) return false;
    handleBrowserClose();
    return true;
  }, 30);

  // Fullscreen preview triggered from split panel's "全屏预览" button
  const [fullscreenPreviewFile, setFullscreenPreviewFile] = useState<SplitPreviewFile | null>(null);

  const handleSplitFilePreview = useCallback((file: SplitPreviewFile, options?: { initialEditMode?: boolean }) => {
    const ext = file.name.toLowerCase().split('.').pop();
    const isLocalFile = file.sourceScope === 'local';
    if ((ext === 'html' || ext === 'htm') && isSplitViewEnabled && !file.focusTarget) {
      // HTML files → open in embedded browser for live preview
      // Store file metadata so browser toolbar can offer "Edit Source" toggle
      setBrowserSourceFile(isLocalFile ? null : file);
      // Workspace files are relative to agentDir; local file links already carry
      // an absolute path.
      const sep = agentDir?.includes('\\') ? '\\' : '/';
      const absPath = isLocalFile ? (file.localPath ?? file.path) : (agentDir ? `${agentDir}${sep}${file.path}` : file.path);
      startBrowserSplitTransitionIfNeeded();
      setBrowserUrl(absPath);
      setSplitActiveView('browser');
    } else {
      setSplitFile({ ...file, initialEditMode: options?.initialEditMode });
      setSplitActiveView('file');
    }
    // Keep workspace open — user can dismiss it manually
  }, [isSplitViewEnabled, agentDir, startBrowserSplitTransitionIfNeeded]);

  useEffect(() => {
    if (!pendingFilePreview) return;
    let cancelled = false;
    const intent = pendingFilePreview;

    const consume = () => {
      onFilePreviewIntentConsumed?.(intent.id);
    };

    const openIntentPreview = async () => {
      try {
        if (!fileService.isAvailable) {
          toastRef.current.error(t('shell.toasts.previewWorkspaceUnavailable'));
          return;
        }
        const fileName = intent.path.split(/[/\\]/).pop() ?? intent.path;
        const richDocKind = getRichDocKind(fileName);
        let file: SplitPreviewFile | null = null;

        if (richDocKind) {
          file = {
            name: fileName,
            content: '',
            size: 0,
            path: intent.path,
            richDocKind,
            initialLineNumber: intent.initialLineNumber,
          };
        } else if (isPreviewable(fileName)) {
          const resp = await fileService.readPreview({ path: intent.path });
          file = {
            name: resp.name,
            content: resp.content,
            size: resp.size,
            path: intent.path,
            initialLineNumber: intent.initialLineNumber,
          };
        } else {
          toastRef.current.info(t('shell.toasts.previewUnsupportedType'));
          return;
        }

        if (cancelled || !file) return;
        if (isSplitViewEnabled && !isNarrowLayout) {
          handleSplitFilePreview(file);
        } else {
          setFullscreenPreviewFile(file);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('[Chat] Failed to open pending file preview:', err);
          toastRef.current.error(t('shell.toasts.previewOpenFailed'));
        }
      } finally {
        if (!cancelled) consume();
      }
    };

    void openIntentPreview();
    return () => {
      cancelled = true;
    };
  }, [
    pendingFilePreview,
    fileService,
    handleSplitFilePreview,
    isSplitViewEnabled,
    isNarrowLayout,
    onFilePreviewIntentConsumed,
    t,
  ]);

  // Open terminal in split panel (called from DirectoryPanel header button)
  const handleOpenTerminal = useCallback(() => {
    setTerminalPinned(true);
    setSplitActiveView('terminal');
    // If terminal was already created, just switch view; otherwise TerminalPanel will create it
  }, []);

  // Open a URL in the embedded browser panel
  const handleOpenInBrowserPanel = useCallback((url: string) => {
    if (isSplitViewEnabled && !isNarrowLayout) startBrowserSplitTransitionIfNeeded();
    setBrowserUrl(url);
    setSplitActiveView('browser');
  }, [isNarrowLayout, isSplitViewEnabled, startBrowserSplitTransitionIfNeeded]);

  // Open empty browser from toolbar button.
  // First click → create blank webview (BROWSER_BLANK_URL is a data: URL, not
  // about:blank — see browserConstants.ts for why). Subsequent clicks just
  // switch view (URL preserved).
  const handleOpenBrowser = useCallback(() => {
    startBrowserSplitTransitionIfNeeded();
    setBrowserUrl((prev) => prev ?? BROWSER_BLANK_URL);
    setSplitActiveView('browser');
  }, [startBrowserSplitTransitionIfNeeded]);

  const handleBrowserCreated = useCallback(() => setBrowserAlive(true), []);
  const handleBrowserCreateFailed = useCallback(() => {
    handleBrowserClose();
  }, [handleBrowserClose]);

  // Switch from browser preview to editor for a local HTML file.
  // Re-reads from disk to ensure editor shows the latest saved content
  // (browserSourceFile holds the initial snapshot which may be stale).
  const handleBrowserSwitchToEditor = useCallback(async () => {
    if (!browserSourceFile || !agentDir) return;
    setSplitActiveView('file');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const sep = agentDir.includes('\\') ? '\\' : '/';
      const absPath = `${agentDir}${sep}${browserSourceFile.path}`;
      const fresh = await invoke<string | null>('cmd_read_workspace_file', { path: absPath });
      if (fresh !== null) {
        const updated = { ...browserSourceFile, content: fresh, size: new Blob([fresh]).size };
        setBrowserSourceFile(updated);
        setSplitFile(updated);
      } else {
        setSplitFile(browserSourceFile);
      }
    } catch {
      setSplitFile(browserSourceFile); // fallback: use cached version
    }
  }, [browserSourceFile, agentDir]);

  // Switch from editor back to browser preview for an HTML file.
  // Reloads webview so it reflects any edits saved to disk.
  const handleEditorSwitchToBrowser = useCallback(() => {
    if (!browserUrl) return;
    setSplitActiveView('browser');
    // Give auto-save a moment to flush, then reload the webview
    setTimeout(() => {
      setBrowserReloadSignal(value => value + 1);
    }, 300);
  }, [browserUrl]);

  // Stable context value for the Chat-owned browser. Presentation (split vs.
  // fullscreen) is decided here, not by individual link renderers.
  const browserPanelCtx = useMemo(
    () => ({ openUrl: handleOpenInBrowserPanel }),
    [handleOpenInBrowserPanel],
  );

  // Listen for the global LinkContextMenuProvider's "预览（内置浏览器）" intent.
  // Only the active Chat tab claims the global context-menu action. Wide layouts
  // use the split panel; narrow/disabled split layouts use fullscreen BrowserPanel.
  useEffect(() => {
    if (!isActive || !browserPanelCtx) return;
    const handler = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const url = (e.detail as { url?: unknown } | null)?.url;
      if (typeof url !== 'string' || !url) return;
      e.preventDefault();
      browserPanelCtx.openUrl(url);
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_IN_BROWSER_PANEL, handler);
    return () => window.removeEventListener(CUSTOM_EVENTS.OPEN_IN_BROWSER_PANEL, handler);
  }, [isActive, browserPanelCtx]);

  // Cleanup terminal PTY on unmount (Tab close)
  useEffect(() => {
    return () => {
      const id = terminalIdRef.current;
      if (id) {
        // Fire-and-forget: Rust will clean up the PTY
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke('cmd_terminal_close', { terminalId: id }).catch(() => {});
        });
      }
    };
  }, []);

  const handleSplitDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingSplitRef.current = true;
    setIsDraggingSplit(true);
    const startX = e.clientX;
    const startRatio = splitRatioRef.current;
    const containerWidth = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().width;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingSplitRef.current) return;
      const dx = ev.clientX - startX;
      const newRatio = Math.max(0.35, Math.min(0.65, startRatio + dx / containerWidth));
      setSplitRatio(newRatio);
    };
    const onMouseUp = () => {
      isDraggingSplitRef.current = false;
      setIsDraggingSplit(false);
      dragMoveRef.current = null;
      dragUpRef.current = null;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    dragMoveRef.current = onMouseMove;
    dragUpRef.current = onMouseUp;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []); // stable — uses ref for splitRatio

  // Cleanup drag listeners on unmount (prevents leak if component unmounts mid-drag)
  useEffect(() => {
    return () => {
      if (dragMoveRef.current) document.removeEventListener('mousemove', dragMoveRef.current);
      if (dragUpRef.current) document.removeEventListener('mouseup', dragUpRef.current);
      isDraggingSplitRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  const [workspaceRefreshKey, _setWorkspaceRefreshKey] = useState(0); // Key to trigger workspace refresh
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    (currentAgent?.permissionMode as PermissionMode | undefined) ?? currentProject?.permissionMode ?? 'auto'
  );
  const [selectedModel, setSelectedModel] = useState<string | undefined>(
    currentAgent?.model ?? currentProject?.model ?? currentProvider?.primaryModel
  );
  const currentProviderExecutionIntent = useMemo(
    () => sessionMeta?.providerExecutionIdentity
      ?? buildProviderExecutionIntent(currentProviderForHistory, selectedModel),
    [
      sessionMeta?.providerExecutionIdentity,
      currentProviderForHistory,
      selectedModel,
    ],
  );
  const currentRuntimeSource = sessionMeta?.runtimeSource
    ?? sessionRuntimeSource
    ?? (currentProviderExecutionIntent?.kind === 'runtime-backed-provider'
      ? currentProviderExecutionIntent.runtimeSource
      : undefined);
  const managedProviderRuntimeActive = currentRuntimeSource === 'managed-provider';
  // #324 — 推理强度 setting ('default' | level). ONE state for both runtimes
  // (the storage location splits on isExternalRuntime at persist time, like
  // model). Lifecycle mirrors selectedModel: seeded from agent, restored from
  // session snapshot, live-pushed to the sidecar via /api/reasoning-effort/set.
  const [reasoningEffort, setReasoningEffort] = useState<string>(() => {
    const rc = currentAgent?.runtimeConfig as { reasoningEffort?: string } | undefined;
    const fromAgent = currentAgent?.runtime && currentAgent.runtime !== 'builtin'
      ? rc?.reasoningEffort
      : currentAgent?.reasoningEffort;
    return fromAgent ?? 'default';
  });
  // Cron task state
  const [showCronSettings, setShowCronSettings] = useState(false);
  const [cronPrompt, setCronPrompt] = useState('');
  // Preset applied when Goal's draft bar opens the optional settings modal.
  // Cleared on open-via-定时-button / close / confirm so it never leaks.
  const [cronOpenPreset, setCronOpenPreset] = useState<CronInitialConfig | null>(null);
  const [goalDraftConfig, setGoalDraftConfig] = useState<SessionGoalDraftConfig | null>(null);
  const goalDraftConfigRef = useRef<SessionGoalDraftConfig | null>(null);
  goalDraftConfigRef.current = goalDraftConfig;
  const [cronCardTask, setCronCardTask] = useState<CronTask | null>(null);
  const [cronDetailTask, setCronDetailTask] = useState<CronTask | null>(null);
  const [goalEditOpen, setGoalEditOpen] = useState(false);
  const [goalEditDraft, setGoalEditDraft] = useState('');
  const [goalEditSubmitting, setGoalEditSubmitting] = useState(false);
  const [goalCancelConfirmOpen, setGoalCancelConfirmOpen] = useState(false);
  const [stoppedCronRecovery, setStoppedCronRecovery] = useState<{
    prompt: string;
    task: CronTask | null;
    sessionId: string;
  } | null>(null);

  // Track permission mode before AI-triggered plan mode (for restore on ExitPlanMode)
  const prePlanPermissionModeRef = useRef<PermissionMode | null>(null);

  // Boot overlay — the "AI 启动中" loading state shown from the instant a chat is
  // entered until the session connects. Initialised true on every fresh Chat mount
  // because every fresh mount is a session that still has to connect (cold sidecar
  // boot OR join): new session (pending id), workspace-card open, launcher send, AND
  // a cold history open (real id, instant-flipped before the boot). Dismissed on
  // connect (see the effect below) — for a session that's already up the connect is
  // fast, so the overlay is just a brief "connecting" flash. App renders the same
  // ChatBootOverlay as the lazy-Chat Suspense fallback, so the chunk-load → mount
  // handoff is seamless: ONE continuous loading state from flip to ready.
  const [showStartupOverlay, setShowStartupOverlay] = useState(true);

  // Time rewind state
  const [rewindTarget, setRewindTarget] = useState<{
    messageId: string;
    content: string;
    attachments?: import('@/types/chat').MessageAttachment[];
    replacesDraft: boolean;
  } | null>(null);
  const [rewindStatus, setRewindStatus] = useState<string | null>(null);

  // Fork state
  const [forkTarget, setForkTarget] = useState<string | null>(null); // assistant message ID
  const [forkPending, setForkPending] = useState(false);
  const conversationOperationPendingRef = useRef(false);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // Refs for one-time project settings sync (see effect after provider change effect)
  const hadInitialMessage = useRef(!!initialMessage);
  // For a launcher-handoff tab (has initialMessage), autoSend owns the INITIAL
  // MCP push — it pushes the user's per-session launcher selection, which may
  // differ from the workspace default. The mount MCP effect skips its initial
  // push while this is true so the two pushers can't race and stomp the launcher
  // choice; autoSend clears it after its MCP block, handing later config-change
  // re-pushes back to the mount effect. (codex review: dual MCP-push race.)
  const launcherOwnsInitialMcpRef = useRef(hadInitialMessage.current);
  const launcherOwnsInitialOfficialToolsRef = useRef(hadInitialMessage.current);
  const [launcherMcpFallbackRevision, setLauncherMcpFallbackRevision] = useState(0);
  const projectSyncedRef = useRef(false);

  // Ref for input focus
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Ref for SimpleChatInput to call processDroppedFiles
  const chatInputRef = useRef<SimpleChatInputHandle>(null);

  // Ref for DirectoryPanel to trigger refresh
  const directoryPanelRef = useRef<DirectoryPanelHandle>(null);

  // "在文件目录中展示" from the chat path context menu. Opening the workspace
  // panel (if collapsed) mounts DirectoryPanel; the declarative request prop is
  // consumed there (its reveal helper polls for node meta, so it waits out the
  // initial tree load — no ref-timing race).
  const [treeExternalReveal, setTreeExternalReveal] = useState<{ id: number; path: string } | null>(null);
  const treeExternalRevealIdRef = useRef(0);
  const handleRevealInTree = useCallback((path: string) => {
    // Opening is idempotent: a reveal into an already-visible tree must not
    // manufacture another panel/conversation entrance animation.
    handleExpandWorkspace();
    setTreeExternalReveal({ id: ++treeExternalRevealIdRef.current, path });
  }, [handleExpandWorkspace]);
  // Consume-once: clear after the panel picks it up, so reopening the workspace
  // panel later doesn't replay a stale reveal (the panel remounts + resets its
  // local dedup). Codex review catch.
  const handleExternalRevealHandled = useCallback((id: number) => {
    setTreeExternalReveal((prev) => (prev?.id === id ? null : prev));
  }, []);

  // Per-tab persistence for the file-tree view state (expand set + loaded tree).
  // Chat is a per-tab instance kept mounted for the tab's lifetime, so holding
  // this here lets the file tree keep its expansion across the workspace panel's
  // dismiss/reopen (DirectoryPanel unmounts after the exit animation completes).
  const workspaceTreeStateRef = useRef<WorkspaceTreePersistedState>({
    openPaths: new Set(),
    directoryInfo: null,
  });

  // Ref for tracking previous isActive state (for config sync on tab switch)
  const prevIsActiveRef = useRef(isActive);

  // Track previous `isConnected` so we can re-sync Tab-scoped state after a
  // mid-session Sidecar restart (crash + Rust health-monitor recovery, or
  // `recoverSessionSidecar` path). The startup race in the AI-讨论 flow is
  // handled structurally in `tauriClient.getTabServerUrl` (it waits for
  // Sidecar readiness), so this effect is NOT the startup band-aid —
  // it's the recovery hook.
  const prevIsConnectedRef = useRef(isConnected);

  // Background hydration has several legitimate triggers (mount, reconnect,
  // config refresh, tab activation), but they all project the same two
  // Sidecar-owned values. Coalesce identical payloads per Sidecar generation;
  // explicit user mutations still bypass the dedupe and receive their response.
  const lastSessionConfigPushRef = useRef<Record<SessionConfigPushKind, string | null>>({
    mcp: null,
    agents: null,
  });
  const pushSessionConfig = useCallback(async (
    kind: SessionConfigPushKind,
    path: '/api/mcp/set' | '/api/agents/set',
    body: unknown,
    mode: SessionConfigPushMode,
  ): Promise<ExtensionUpdateResponse | null> => {
    const fingerprint = sessionConfigPushFingerprint(body);
    if (!shouldPushSessionConfig(lastSessionConfigPushRef.current[kind], fingerprint, mode)) {
      return null;
    }
    lastSessionConfigPushRef.current[kind] = fingerprint;
    try {
      const response = await apiPost<ExtensionUpdateResponse>(path, body);
      if (response.success === false) {
        throw new Error(response.error ?? `Failed to sync ${kind} configuration`);
      }
      return response;
    } catch (error) {
      // Clear only if no newer payload superseded this attempt.
      if (lastSessionConfigPushRef.current[kind] === fingerprint) {
        lastSessionConfigPushRef.current[kind] = null;
      }
      throw error;
    }
  }, [apiPost]);

  // Disposition gate for config reconciliation (replaces joinedExistingSidecar).
  // configDispositionRef holds the CURRENT value (read at effect-run time); the
  // derived booleans are for effect deps.
  // RULE (load-bearing): PUSH/persist effects gate on
  // `configDispositionRef.current === 'push'` and list `configPending` in deps — so
  // pending→push re-runs them, but adopt→push (markSidecarConfigAdopted) does NOT
  // replay (configPending stays false). The ADOPTION effect gates on `isAdopt` and
  // lists it in deps — so pending→adopt fires it exactly once. While 'pending',
  // every config write waits; the single post-ensure resolver decides push|adopt.
  const configDispositionRef = useRef(sidecarConfigDisposition);
  configDispositionRef.current = sidecarConfigDisposition;
  const configPending = sidecarConfigDisposition === 'pending';
  const isAdopt = sidecarConfigDisposition === 'adopt';

  // Sessions whose live sidecar config has been adopted (disposition 'adopt' flow).
  // Snapshot sync uses this as a sticky guard: even after the disposition resolves
  // from 'adopt' to 'push' (markSidecarConfigAdopted), persisted sessionMeta must not
  // overwrite the adopted runtime/model/permission/MCP — the live sidecar is the
  // truth. Race fixed: adoption finishes and flips to 'push' before sessionMeta
  // hydration commits, so a disposition-only guard misses the sessionMeta dispatch
  // and reintroduces the "joined sidecar overwrite"
  // class of bug.
  const adoptedSessionRef = useRef<string | null>(null);

  // Ref for chat content area (for Tauri drop zone)
  const chatContentRef = useRef<HTMLDivElement>(null);
  const [inputOverlayHeight, setInputOverlayHeight] = useState(176);

  // Ref for directory panel container (for Tauri drop zone)
  const directoryPanelContainerRef = useRef<HTMLDivElement>(null);

  // Enabled sub-agents for sidebar display
  const [enabledAgents, setEnabledAgents] = useState<Record<string, { description: string; prompt?: string; model?: string; scope?: 'user' | 'project'; folderName?: string }> | undefined>();
  const {
    enabledSkills,
    enabledCommands,
    globalSkillFolderNames,
    loadSkillsAndCommands,
  } = useProjectCapabilities(apiGet);
  // Initial tab for workspace config panel (set when opening from capabilities panel)
  const [workspaceConfigInitialTab, setWorkspaceConfigInitialTab] = useState<WorkspaceTab | undefined>();
  // Initial item selection — when set, WorkspaceConfigPanel opens already showing that item's detail.
  const [workspaceConfigInitialSelect, setWorkspaceConfigInitialSelect] = useState<CapabilityInitialSelect | undefined>();
  const workspaceCapabilitySlashCommands = useMemo<InputSlashCommand[]>(() => [
    ...enabledCommands.map(command => ({
      name: command.name,
      invocationName: command.invocationName,
      description: command.description,
      source: 'custom' as const,
      scope: command.scope,
      fileName: command.fileName,
    })),
    ...enabledSkills.map(skill => ({
      name: skill.name,
      description: skill.description,
      source: 'skill' as const,
      scope: skill.scope,
      folderName: skill.folderName,
    })),
  ], [enabledCommands, enabledSkills]);

  // Agent Runtime detection (v0.1.59)
  const [runtimeDetections, setRuntimeDetections] = useState<RuntimeDetections>({
    'builtin': { installed: true },
    'claude-code': { installed: false },
    'codex': { installed: false },
    'gemini': { installed: false },
  });
  // Gate: when multiAgentRuntime is off, treat everything as builtin regardless of agent config.
  // This gate is applied at the definition of currentRuntime itself so ALL downstream
  // derivations (runtimePermissionModes, runtimeModels, etc.) are automatically safe.
  const multiAgentRuntimeEnabled = !!config.multiAgentRuntime;
  // Agent's currently-configured runtime — used as the default for NEW sessions.
  // Managed Codex is a provider default, not the legacy user-managed Codex CLI
  // runtime, so stale `agent.runtime=codex` must not leak into Chat chrome.
  const agentUsesManagedProvider = agentUsesManagedCodexProvider(currentAgent);
  const agentRuntime: RuntimeType = agentUsesManagedProvider
    ? 'builtin'
    : multiAgentRuntimeEnabled
    ? ((currentAgent?.runtime as RuntimeType) || 'builtin')
    : 'builtin';
  // v0.1.69: session is self-contained — its frozen runtime is authoritative for
  // both display and message routing within this tab. Falls back to agentRuntime
  // only before the session has loaded (sessionRuntime===null) or for newly-created
  // sessions before TabProvider syncs metadata. Changing agent.runtime in another
  // tab does NOT change an existing session's display: the session's Sidecar was
  // spawned with its frozen runtime and the backend routes by sessionId.
  const currentRuntime: RuntimeType = (sessionRuntime as RuntimeType | null) ?? agentRuntime;
  const isExternalRuntime = currentRuntime !== 'builtin';
  const codexConversationBranchSupported = currentRuntime === 'codex'
    && supportsCodexConversationBranch(currentRuntimeSource, runtimeDetections.codex.version);
  const handleDiagnoseAgentError = useCallback((message: string) => {
    launchSupportDiagnostics({
      source: 'agent_error',
      message,
      terminalReason: lastTerminalReason,
      sessionId: sessionIdRef.current,
      workspacePath: agentDir,
      runtime: currentRuntime,
    });
  }, [agentDir, currentRuntime, lastTerminalReason]);
  const handleDiagnoseTerminalReason = useCallback((reason: string) => {
    launchSupportDiagnostics({
      source: 'terminal_reason',
      terminalReason: reason,
      sessionId: sessionIdRef.current,
      workspacePath: agentDir,
      runtime: currentRuntime,
    });
  }, [agentDir, currentRuntime]);
  const handleDiagnoseRuntimeDiagnostics = useCallback((diagnostics: RuntimeDiagnostics) => {
    launchSupportDiagnostics({
      source: 'runtime_diagnostics',
      runtimeDiagnostics: diagnostics,
      sessionId: sessionIdRef.current,
      workspacePath: agentDir,
      runtime: currentRuntime,
    });
  }, [agentDir, currentRuntime]);
  const inputChromeRuntime = projectInputChromeRuntime({
    currentRuntime,
    managedProviderRuntimeActive,
  });
  const inputUsesExternalRuntimeControls = shouldUseExternalRuntimeInputControls({
    currentRuntime,
    managedProviderRuntimeActive,
  });
  const showLegacyRuntimeSelector = multiAgentRuntimeEnabled;
  const showBuiltinSdkSlashCommands = shouldShowBuiltinSdkSlashCommands(currentRuntime);
  const visibleSdkSlashCommands = useMemo(
    () => showBuiltinSdkSlashCommands ? sdkSlashCommands : [],
    [showBuiltinSdkSlashCommands, sdkSlashCommands],
  );

  // Detect installed runtimes once on mount
  useEffect(() => {
    let cancelled = false;
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<Record<string, { installed: boolean; version?: string; path?: string }>>('cmd_detect_runtimes')
        .then(detections => { if (!cancelled) setRuntimeDetections(detections as RuntimeDetections); })
        .catch(() => { /* detection failure is non-fatal */ });
    });
    return () => { cancelled = true; };
  }, []);
  const [runtimeModel, setRuntimeModel] = useState<string | undefined>(
    (currentAgent?.runtimeConfig as { model?: string } | undefined)?.model
  );
  const [runtimePermissionMode, setRuntimePermissionMode] = useState<string>(
    coerceExternalRuntimePermissionForUi(
      (currentAgent?.runtimeConfig as { permissionMode?: string } | undefined)?.permissionMode,
      currentRuntime,
    )
    || getDefaultRuntimePermissionMode(currentRuntime) || 'default'
  );

  // Sync runtimePermissionMode + runtimeModel when currentRuntime transitions.
  //
  // Background: the useState initializers above run ONCE on mount. On the first
  // render `currentRuntime` may still be 'builtin' because useConfig is loading
  // asynchronously. More importantly, the agent's runtimeConfig may carry a stale
  // permissionMode value from a previous runtime (e.g. 'no-restrictions' left over
  // from a Codex session, confirmed in unified-2026-04-15.log:918). Reading that
  // value verbatim means the Gemini permission dropdown shows its fallback first
  // item instead of the correct mapped mode.
  //
  // Fix: on every currentRuntime transition, validate the persisted value against
  // the current runtime's allowed mode set and only honor it if it's legal; else
  // fall back to the runtime's default mode. This effect does not fire on every
  // re-render (deps are currentRuntime + isExternalRuntime), so in-session user
  // selections made via the dropdown are never overwritten.
  useEffect(() => {
    if (!isExternalRuntime) return;
    const cfg = currentAgent?.runtimeConfig as { permissionMode?: string; model?: string } | undefined;
    const saved = managedProviderRuntimeActive
      ? currentAgent?.permissionMode
      : cfg?.permissionMode;
    const effective = managedProviderRuntimeActive
      ? (projectManagedCodexPermissionToRuntime(saved) ?? 'auto-edit')
      : (coerceExternalRuntimePermissionForUi(saved, currentRuntime)
        ?? (getDefaultRuntimePermissionMode(currentRuntime) || 'default'));
    setRuntimePermissionMode(effective);
    setRuntimeModel(coerceExternalRuntimeModelForUi(cfg?.model, currentRuntime));
    // #324 — re-seed effort on runtime transition. RUNTIME_CONFIG_PER_RUNTIME_FIELDS
    // scrubs reasoningEffort on agent runtime change, so a leftover value from a
    // different runtime can't be read here; absent = 'default'.
    setReasoningEffort(coerceReasoningEffortForUi((cfg as { reasoningEffort?: string } | undefined)?.reasoningEffort, currentRuntime) ?? 'default');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: only re-sync on runtime transitions, not on every currentAgent.runtimeConfig edit
  }, [currentRuntime, isExternalRuntime, managedProviderRuntimeActive]);

  // Runtime-specific models and permission modes
  const runtimePermissionModes = currentRuntime === 'claude-code' ? CC_PERMISSION_MODES
    : currentRuntime === 'codex' ? CODEX_PERMISSION_MODES
    : currentRuntime === 'gemini' ? GEMINI_PERMISSION_MODES
    : undefined;

  // Codex + Gemini models are dynamic (fetched from the CLI); CC models are static
  const [codexModels, setCodexModels] = useState<typeof CC_MODELS>([]);
  const [geminiModels, setGeminiModels] = useState<typeof CC_MODELS>([]);
  useEffect(() => {
    if (!multiAgentRuntimeEnabled || managedProviderRuntimeActive || currentRuntime !== 'codex') return;
    let cancelled = false;
    // AbortController so a tab-close (effect cleanup) silences the
    // proxyFetch "Sidecar gone" warning that would otherwise fire when
    // this in-flight request lands on a sidecar port that just got
    // released. Tauri invoke can't be cancelled mid-flight, but the
    // post-hoc filter in proxyFetch turns the rejection into a silent
    // AbortError instead of a noisy lifecycle log line.
    const controller = new AbortController();
    apiGet(runtimeModelCatalogPath('codex', 'system-cli'), { signal: controller.signal }).then((res: unknown) => {
      const data = res as { models?: typeof CC_MODELS } | undefined;
      if (!cancelled && data?.models?.length) setCodexModels(data.models);
    }).catch(() => {});
    return () => { cancelled = true; controller.abort(); };
  }, [multiAgentRuntimeEnabled, managedProviderRuntimeActive, currentRuntime, apiGet]);
  useEffect(() => {
    if (!multiAgentRuntimeEnabled || currentRuntime !== 'gemini') return;
    let cancelled = false;
    const controller = new AbortController();
    apiGet(runtimeModelCatalogPath('gemini'), { signal: controller.signal }).then((res: unknown) => {
      const data = res as { models?: typeof CC_MODELS } | undefined;
      if (!cancelled && data?.models?.length) setGeminiModels(data.models);
    }).catch(() => {});
    return () => { cancelled = true; controller.abort(); };
  }, [multiAgentRuntimeEnabled, currentRuntime, apiGet]);

  // ─── External runtime pre-warm (v0.1.68) ───
  //
  // Gemini and Codex run as persistent JSON-RPC processes (`gemini --acp` /
  // `codex app-server`). On a cold start their first message pays 10–15s for
  // CLI spawn + initialize handshake + session/new (and on Gemini: base-prompt
  // extraction). Firing /api/runtime/prewarm as soon as the tab is ready
  // overlaps that cost with the user still typing — by the time they hit
  // send, the process is already alive and the message goes straight to
  // stdin via sendExternalMessage Case 3.
  //
  // Only fires for Gemini/Codex (backend no-ops for CC since `-p` mode exits
  // per turn) and only once per (tab, session, runtime) combo — a ref keyed
  // by sessionId+runtime guards against re-firing on model/permission changes
  // or mid-session SSE reconnects. If the user sends a message before the
  // pre-warm finishes, sendExternalMessage's `startingPromise` await safely
  // serializes the two calls.
  const prewarmedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!multiAgentRuntimeEnabled && !managedProviderRuntimeActive) return;
    if (currentRuntime !== 'gemini' && currentRuntime !== 'codex') return;
    if (!isActive || !isConnected || !sessionId) return;
    // Only a 'push' tab prewarms the sidecar with ITS config (model/permission).
    // 'pending' waits for the post-ensure resolver; 'adopt' must not override the
    // live sidecar's config. (External-runtime sibling of the MCP/model push gates.)
    if (configDispositionRef.current !== 'push') return;
    // Cross-runtime sessions are opened in read-only mode until the user
    // confirms a fresh session — don't pre-warm those (the confirmation flow
    // resets sessionId, which retriggers this effect). Mirrors the
    // `isCrossRuntimeSession` const defined later in this file, inlined here
    // to avoid the TDZ ordering dependency.
    // Backend also enforces this via SessionStore metadata check — belt-and-
    // suspenders against a loading-session race where sessionRuntime is still
    // null when this effect fires.
    if (sessionRuntime !== null && sessionRuntime !== currentRuntime) return;
    // Do NOT gate on runtime-model list readiness. /api/runtime/models itself
    // spawns a `gemini --acp` (or codex app-server) subprocess that pays the
    // same ~14s cold-start as pre-warm — gating pre-warm on it would serialize
    // the two 14s costs and defeat the whole optimization (user would stare
    // at 14s+ of empty UI after hitting send). Firing with an undefined model
    // is safe: gemini.ts:~809 guards `options.model && options.model.length>0`
    // and Codex treats null `model` as "use default". When the user later
    // picks a specific model in the UI, setExternalModel() routes through
    // the in-place `runtime.setModel()` path (Gemini: one ACP RPC; Codex/CC:
    // fall back to stop+resume) — cheap in the common case.
    const key = `${sessionId}::${currentRuntime}`;
    if (prewarmedKeyRef.current === key) return;
    prewarmedKeyRef.current = key;
    // AbortController so tab close (effect cleanup) silences the proxyFetch
    // lifecycle warning when this request lands on a just-released sidecar
    // port. The actual prewarm subprocess startup is fire-and-forget — if
    // the tab closes mid-prewarm we don't care about the result anyway.
    const controller = new AbortController();
    apiPost('/api/runtime/prewarm', {
      sessionId,
      model: effectiveModel,  // may be undefined — runtime falls back to its default
    }, { signal: controller.signal }).then((res) => {
      // Backend returns { success: true, prewarmed: false, reason: '...' } when
      // the endpoint short-circuits (already-active/starting, runtime mismatch,
      // non-persistent runtime). In those cases the subprocess is NOT warm, so
      // clear the ref to allow a retry when conditions change (e.g., sessionRuntime
      // populates later and matches currentRuntime).
      const data = res as { prewarmed?: boolean } | undefined;
      if (data && data.prewarmed === false) {
        prewarmedKeyRef.current = null;
      }
    }).catch((err: unknown) => {
      // Aborted (tab close, dep change) is the expected silent path.
      if (err instanceof DOMException && err.name === 'AbortError') {
        prewarmedKeyRef.current = null; // allow re-fire if effect re-runs
        return;
      }
      // Pre-warm failure is non-fatal — the first user message path still
      // starts the runtime normally (just without the latency optimization).
      console.debug('[prewarm] request failed (non-fatal):', err);
      prewarmedKeyRef.current = null; // allow a later retry
    });
    return () => { controller.abort(); };
    // Intentionally omit effectiveModel from deps —
    // config changes kill the pre-warmed process via setExternalModel/
    // setExternalPermissionMode, and the next user message will resume with
    // the new settings. Re-firing pre-warm on every keystroke-driven option
    // change would thrash the subprocess.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiAgentRuntimeEnabled, managedProviderRuntimeActive, currentRuntime, isActive, isConnected, sessionId, sessionRuntime, apiPost, configPending]);

  const runtimeModels = currentRuntime === 'claude-code' ? CC_MODELS
    : currentRuntime === 'codex' ? (managedProviderRuntimeActive ? [] : codexModels)
    : currentRuntime === 'gemini' ? geminiModels
    : undefined;

  // Effective model/permission based on runtime.
  // For external runtimes: if user hasn't explicitly selected a model (runtimeModel=undefined),
  // use the default model from the runtime's model list — this matches what the UI displays.
  const effectiveRuntimeModel = isExternalRuntime
    ? coerceExternalRuntimeModelForUi(runtimeModel, currentRuntime)
    : undefined;
  const effectiveModel = isExternalRuntime
    ? (effectiveRuntimeModel ?? runtimeModels?.find(m => m.isDefault)?.value)
    : selectedModel;
  const effectiveRuntimePermissionMode = isExternalRuntime
    ? (coerceExternalRuntimePermissionForUi(runtimePermissionMode, currentRuntime)
      ?? getDefaultRuntimePermissionMode(currentRuntime)
      ?? 'default')
    : undefined;
  // #244: the `permissionMode` useState initializer runs while useConfig() is
  // still loading, and the one-time project-sync effect that corrects it fires
  // AFTER first paint — so a fresh-tab first send could ship the stale 'auto'.
  // resolveBuiltinPermissionMode() falls back to the configured value until the
  // state becomes authoritative. Drives BOTH the selector display and the send,
  // so the two never disagree.
  //
  // "Authoritative" = projectSyncedRef (project-sync effect ran, or the user
  // toggled the control) OR hadInitialMessage (launcher handoff — autoSend sets
  // `permissionMode` from initialMessage.permissionMode and the project-sync
  // effect is skipped, so trusting state here preserves the launcher's explicit
  // choice instead of overriding it with the agent default).
  const permissionStateAuthoritative =
    projectSyncedRef.current || hadInitialMessage.current || sessionSnapshotOwnsConfig;
  const effectivePermissionMode = isExternalRuntime
    ? effectiveRuntimePermissionMode as PermissionMode
    : resolveBuiltinPermissionMode({
        projectSynced: permissionStateAuthoritative,
        statePermissionMode: permissionMode,
        agentPermissionMode: currentAgent?.permissionMode as string | undefined,
        projectPermissionMode: currentProject?.permissionMode,
        defaultPermissionMode: config.defaultPermissionMode,
      });

  const buildCronRuntimeConfig = useCallback((): RuntimeConfig | undefined => {
    if (!isExternalRuntime) return undefined;
    const base = { ...((currentAgent?.runtimeConfig as RuntimeConfig | undefined) ?? {}) };
    if (currentProviderExecutionIntent?.kind === 'runtime-backed-provider') {
      base.source = currentProviderExecutionIntent.runtimeSource;
      base.model = currentProviderExecutionIntent.model;
    }
    const persistedModel = coerceExternalRuntimeModelForUi(base.model, currentRuntime);
    if (persistedModel) {
      base.model = persistedModel;
    } else {
      delete base.model;
    }
    const selectedRuntimeModel = coerceExternalRuntimeModelForUi(runtimeModel, currentRuntime);
    if (selectedRuntimeModel !== undefined) {
      base.model = selectedRuntimeModel;
    }
    const persistedPermission = coerceExternalRuntimePermissionForUi(base.permissionMode, currentRuntime);
    if (persistedPermission) {
      base.permissionMode = persistedPermission;
    } else {
      delete base.permissionMode;
    }
    const selectedPermission = effectiveRuntimePermissionMode ?? getDefaultRuntimePermissionMode(currentRuntime);
    if (persistedPermission !== undefined || selectedPermission !== getDefaultRuntimePermissionMode(currentRuntime)) {
      base.permissionMode = selectedPermission;
    }
    return Object.keys(base).length > 0 ? base : undefined;
  }, [isExternalRuntime, currentAgent?.runtimeConfig, currentProviderExecutionIntent, runtimeModel, effectiveRuntimePermissionMode, currentRuntime]);

  const buildCronExecutionOverrides = useCallback((args: {
    providerId?: string;
    model?: string;
  }) => projectTaskExecutionOverrides({
    providers,
    runtime: currentRuntime,
    providerId: args.providerId,
    model: args.model,
    runtimeConfig: buildCronRuntimeConfig(),
  }), [providers, currentRuntime, buildCronRuntimeConfig]);

  // Callback to refresh workspace (exposed to SimpleChatInput)
  const triggerWorkspaceRefresh = useCallback(() => {
    setWorkspaceRefreshTrigger(prev => prev + 1);
    setIntroductionRefreshTrigger(prev => prev + 1);
  }, []);

  // Stable callbacks for DirectoryPanel → AgentCapabilitiesPanel
  const handleInsertReference = useCallback((paths: string[]) => {
    chatInputRef.current?.insertReferences(paths);
  }, []);

  const handleInsertSlashCommand = useCallback((command: string) => {
    chatInputRef.current?.insertSlashCommand(command);
  }, []);

  const handleOpenSettings = useCallback((initialSelect?: CapabilityInitialSelect) => {
    // All three kinds (skill/command/agent) live under the 'skills' tab in the
    // project workspace — that tab renders SkillsCommandsList AND WorkspaceAgentsList.
    setWorkspaceConfigInitialTab('skills');
    setWorkspaceConfigInitialSelect(initialSelect);
    setShowWorkspaceConfig(true);
  }, []);

  // Auto-send initial message from Launcher
  const initialMessageConsumedRef = useRef(false);
  const onInitialMessageConsumedRef = useRef(onInitialMessageConsumed);
  onInitialMessageConsumedRef.current = onInitialMessageConsumed;
  const initialMessageRuntimeReady = useMemo(() => {
    const identity = initialMessage?.providerExecutionIdentity;
    if (!identity) return true;
    if (currentRuntime !== identity.runtime) return false;
    return currentRuntimeSource === identity.runtimeSource;
  }, [initialMessage?.providerExecutionIdentity, currentRuntime, currentRuntimeSource]);

  useEffect(() => {
    if (!initialMessage) return;
    // Wait for SSE connection (sidecar reachable) instead of non-pending sessionId.
    // The sessionId upgrades from pending only after the first message is processed,
    // but the first message IS the auto-send — so checking isPendingSessionId would deadlock.
    if (!shouldAutoSendInitialMessage({
      hasInitialMessage: true,
      alreadyConsumed: initialMessageConsumedRef.current,
      hasSessionId: !!sessionId,
      isConnected,
      isActive,
      runtimeReady: initialMessageRuntimeReady,
    })) return;

    const launchMessage = initialMessage;
    initialMessageConsumedRef.current = true;

    // Resolved values hoisted out of `try` so the `catch` failure-recovery path
    // (PRD 0.2.7 §4.5) can reference them when restoring the launcher draft.
    const builtinSel = launchMessage.builtinSelection;
    // #244 (cross-review W2): when the initialMessage carries no explicit
    // permissionMode (internal producers — Task discussion / support / fork —
    // unlike the launcher, don't set it), derive the builtin mode from config
    // rather than the raw `permissionMode` state, which is still the mount-time
    // 'auto' default if useConfig() hasn't resolved yet. projectSynced:false
    // forces the agent→project→global fallback (there's no explicit choice to
    // honor on this auto-send).
    const initialRuntimePermission = isExternalRuntime
      ? coerceInitialMessageRuntimePermission(launchMessage, currentRuntime)
      : undefined;
    const effectivePermission = (isExternalRuntime
      ? (initialRuntimePermission
        ?? effectiveRuntimePermissionMode
        ?? getDefaultRuntimePermissionMode(currentRuntime)
        ?? 'default')
      : (launchMessage.permissionMode ?? resolveBuiltinPermissionMode({
          projectSynced: false,
          statePermissionMode: permissionMode,
          agentPermissionMode: currentAgent?.permissionMode as string | undefined,
          projectPermissionMode: currentProject?.permissionMode,
          defaultPermissionMode: config.defaultPermissionMode,
        }))) as PermissionMode;
    const effectiveModel = isExternalRuntime
      ? (coerceExternalRuntimeModelForUi(launchMessage.runtimeModel, currentRuntime)
        ?? effectiveRuntimeModel
        ?? runtimeModels?.find(m => m.isDefault)?.value)
      : (builtinSel?.model ?? selectedModel);
    const provider = builtinSel
      ? providers.find(p => p.id === builtinSel.providerId) ?? currentProvider
      : currentProvider;
    const providerRoute = buildBuiltinProviderRoute(provider, effectiveModel);
    const providerEnv = providerRoute ? undefined : buildProviderEnv(provider);

    const autoSend = async () => {
      try {
        // 1. Sync MCP configuration. autoSend is the authoritative INITIAL MCP
        // pusher for launcher-handoff tabs (the mount MCP effect skips its initial
        // push for these — see launcherOwnsInitialMcpRef). Push only when the
        // launcher enabled ≥1 server; disable-all (`[]`) / undefined need no push:
        // the sidecar has no config-file fallback (`currentMcpServers ?? []` in
        // agent-session.ts), so an absent push already yields no MCP — and pushing
        // `[]` after the sidecar pre-warmed with `null` could trip a fingerprint
        // diff → abort/restart for no benefit.
        if (launchMessage.mcpEnabledServers?.length) {
          const allServers = await getAllMcpServers();
          syncMcpServerNames(allServers);
          const globalEnabled = await getEnabledMcpServerIds();
          const effective = allServers.filter(s =>
            globalEnabled.includes(s.id) && launchMessage.mcpEnabledServers!.includes(s.id)
          );
          await pushSessionConfig('mcp', '/api/mcp/set', { servers: effective }, 'explicit');
        }
        // Hand later config-change MCP pushes back to the mount effect now that
        // autoSend has applied the launcher's initial selection.
        launcherOwnsInitialMcpRef.current = false;

        // 1b. PRD 0.2.17 — Sync plugin selection (Launcher → new Tab handoff).
        // Both `setWorkspaceEnabledPlugins` local state AND a session-enable
        // push so the sidecar's commonQueryOptions picks up the choice on
        // first pre-warm. Symmetric with MCP above.
        if (launchMessage.enabledPluginIds) {
          setWorkspaceEnabledPlugins(launchMessage.enabledPluginIds);
          await apiPost('/api/cc-plugin/session-enable', {
            enabledIds: launchMessage.enabledPluginIds,
          });
        }

        if (launchMessage.enabledOfficialToolIds !== undefined) {
          setWorkspaceOfficialToolEnabled(normalizeOfficialToolIds(launchMessage.enabledOfficialToolIds));
          await apiPost('/api/official-tools/session-enable', {
            enabledIds: launchMessage.enabledOfficialToolIds,
          });
        }
        launcherOwnsInitialOfficialToolsRef.current = false;

        // 3. Update local UI state to reflect Launcher choices
        if (launchMessage.permissionMode) {
          // External runtime has its own permission mode state (runtimePermissionMode),
          // while builtin uses permissionMode. Set the correct one based on runtime.
          if (isExternalRuntime) {
            setRuntimePermissionMode(
              initialRuntimePermission
              ?? getDefaultRuntimePermissionMode(currentRuntime)
              ?? 'default',
            );
            const providerPermission = launchMessage.providerExecutionIdentity
              ? managedCodexRuntimePermissionToProviderPermission(launchMessage.permissionMode)
              : undefined;
            if (providerPermission) {
              setPermissionMode(providerPermission);
            }
          } else {
            setPermissionMode(launchMessage.permissionMode);
            // #244: the launcher choice is now the authoritative builtin mode —
            // mark synced so effectivePermissionMode trusts state and doesn't
            // re-derive from the agent default (the project-sync effect is
            // skipped on initialMessage tabs).
            projectSyncedRef.current = true;
          }
        }
        if (isExternalRuntime) {
          if (launchMessage.runtimeModel) {
            setRuntimeModel(coerceExternalRuntimeModelForUi(launchMessage.runtimeModel, currentRuntime));
          }
        } else if (builtinSel) {
          // Apply the paired (provider, model) atomically — type system guarantees both present.
          setSelectedProviderId(builtinSel.providerId);
          setSelectedModel(builtinSel.model);
          providerInitRef.current = true; // suppress deferred provider-change effect
        }
        // #324 — launcher hand-carry (don't rely on the async agent-config
        // write having landed before this tab seeded from currentAgent).
        // Set BEFORE the sends below so the builtin send payload carries it;
        // for external runtimes push it explicitly (no payload channel).
        if (launchMessage.reasoningEffort) {
          const launchReasoningEffort = isExternalRuntime
            ? (coerceReasoningEffortForUi(launchMessage.reasoningEffort, currentRuntime) ?? 'default')
            : launchMessage.reasoningEffort;
          setReasoningEffort(launchReasoningEffort);
          if (configDispositionRef.current === 'pending') {
            deferredEffortPushRef.current = launchReasoningEffort;
          } else {
            pushReasoningEffort(launchReasoningEffort);
          }
        }

        // 5. Send message (fire-and-forget — resolves before backend turn actually starts)
        setIsLoading(true);
        scrollToBottom();

        // 5a. Cron handoff (PRD 0.2.7): if launcher staged a cron config, switch
        //     from the normal send path to startCronTask. This both creates the
        //     CronTask via Rust and triggers the first execution — same as if the
        //     user had typed in the chat input and clicked send with cron enabled.
        if (launchMessage.cron) {
          const cronExecution = buildCronExecutionOverrides({
            providerId: !isExternalRuntime && provider ? provider.id : undefined,
            model: effectiveModel,
          });
          const cronPermissionMode = coerceRuntimeBirthPermissionMode(
            effectivePermission,
            cronExecution.runtime ?? currentRuntime,
          );
          enableCronMode({
            taskKind: launchMessage.cron.taskKind,
            prompt: launchMessage.text,
            intervalMinutes: launchMessage.cron.intervalMinutes,
            endConditions: launchMessage.cron.endConditions,
            runMode: launchMessage.cron.runMode,
            notifyEnabled: launchMessage.cron.notifyEnabled,
            schedule: launchMessage.cron.schedule,
            delivery: launchMessage.cron.delivery,
            model: cronExecution.model,
            permissionMode: cronPermissionMode,
            providerId: cronExecution.providerId,
            runtime: cronExecution.runtime,
            runtimeConfig: cronExecution.runtimeConfig,
            // Without this, the editor reopens defaulting to 'current_session'
            // because cronState.config.executionTarget is undefined → modal's
            // computed runMode lies about the user's choice. (Bug 2A.)
            executionTarget: launchMessage.cron.executionTarget,
            // Pin the cron task's MCP set to the launcher's chosen list so
            // /cron/execute-sync's `applyMcpOverrideAndAwaitReady` matches
            // the pre-warm fingerprint and short-circuits as a no-op
            // (agent-session.ts:1282) instead of an abort+restart that
            // wastes ~5s on every launcher cron handoff.
            mcpEnabledServers: launchMessage.mcpEnabledServers,
          });
          const startedKind = await startScheduledTask(launchMessage.text);
          if (startedKind === 'goal') {
            await sendMessage(
              launchMessage.text,
              launchMessage.images,
              effectivePermission,
              effectiveModel,
              isExternalRuntime || providerRoute ? undefined : providerEnv,
              undefined,
              isExternalRuntime ? undefined : (launchMessage.reasoningEffort ?? reasoningEffort),
              isExternalRuntime ? undefined : providerRoute,
            );
          }
        } else {
          // 5b. Normal send path.
          await sendMessage(
            launchMessage.text,
            launchMessage.images,
            effectivePermission,
            effectiveModel,
            isExternalRuntime || providerRoute ? undefined : providerEnv,
            undefined,
            // launch value directly — the setReasoningEffort above isn't
            // visible in this closure (same-render state), and the first
            // message must already carry the launcher's choice.
            isExternalRuntime ? undefined : (launchMessage.reasoningEffort ?? reasoningEffort),
            isExternalRuntime ? undefined : providerRoute,
            launchMessage.requiredSystemSkill,
          );
        }

        // 6. Mark initialMessage consumed. DO NOT close overlay here:
        //    sendMessage() returns immediately (fire-and-forget), and on external
        //    runtimes (gemini/codex) the backend is still in prewarm — sessionState
        //    stays `idle` and isLoading gets cleared by the prewarm chat:init event.
        //    Closing the overlay now produced the "stable idle" gap the user saw.
        //    Overlay closure is now driven by the dedicated effect below — it waits
        //    for the AI to actually start (sessionState='running' or streaming).
        onInitialMessageConsumedRef.current?.();
      } catch (err) {
        console.error('[Chat] Auto-send failed:', err);
        if (launcherOwnsInitialMcpRef.current) {
          launcherOwnsInitialMcpRef.current = false;
          setLauncherMcpFallbackRevision((revision) => revision + 1);
        }
        setShowStartupOverlay(false);
        // PRD 0.2.7 §4.5 failure recovery: restore the launcher draft (text /
        // images / cron config) into the chat input so the user can retry
        // without losing what they typed. Pre-PRD-0.2.7 the toast just said
        // "请重试" while the textarea was empty, silently dropping the draft.
        try {
          chatInputRef.current?.setValue(launchMessage.text);
          if (launchMessage.images && launchMessage.images.length > 0) {
            chatInputRef.current?.setImages(launchMessage.images);
          }
          if (launchMessage.cron) {
            const cronExecution = buildCronExecutionOverrides({
              providerId: !isExternalRuntime && provider ? provider.id : undefined,
              model: effectiveModel,
            });
            const cronPermissionMode = coerceRuntimeBirthPermissionMode(
              effectivePermission,
              cronExecution.runtime ?? currentRuntime,
            );
            enableCronMode({
              taskKind: launchMessage.cron.taskKind,
              prompt: launchMessage.text,
              intervalMinutes: launchMessage.cron.intervalMinutes,
              endConditions: launchMessage.cron.endConditions,
              runMode: launchMessage.cron.runMode,
              notifyEnabled: launchMessage.cron.notifyEnabled,
              schedule: launchMessage.cron.schedule,
              delivery: launchMessage.cron.delivery,
              model: cronExecution.model,
              permissionMode: cronPermissionMode,
              providerId: cronExecution.providerId,
              runtime: cronExecution.runtime,
              runtimeConfig: cronExecution.runtimeConfig,
              executionTarget: launchMessage.cron.executionTarget,
              mcpEnabledServers: launchMessage.mcpEnabledServers,
            });
          }
        } catch (restoreErr) {
          // Restore is best-effort; don't double-fail the user.
          console.warn('[Chat] failed to restore launcher draft:', restoreErr);
        }
        onInitialMessageConsumedRef.current?.();
        toast.error(tRef.current('shell.toasts.autoSendRestoredDraft'));
      }
    };
    void autoSend();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage, isActive, sessionId, isConnected, initialMessageRuntimeReady]);

  // Close startup overlay as soon as the backend has acknowledged the request
  // — either by transitioning to 'starting' (subprocess launched, system_init
  // pending) or 'running' (turn actively processing). (issue #174) Including
  // 'starting' is required because the overlay is z-30 and covers the input
  // (z-20); leaving it up during 'starting' would hide both the new Stop
  // button and the MessageList "AI 启动中…" hint, defeating the whole point
  // of the new state. `streamingMessage` covers the case where status events
  // were missed but content has arrived. `agentError` covers async send
  // failures: sendMessage is fire-and-forget so autoSend's try/catch can't
  // observe backend rejection / network errors — they land on agentError
  // instead, and the user needs to see the error banner immediately rather
  // than wait out the 30s safety timeout.
  useEffect(() => {
    if (!showStartupOverlay) return;
    if (
      sessionState === 'running'
      || sessionState === 'starting'
      || streamingMessage
      || agentError
      // Workspace-card / no-auto-send entry: there is no turn to wait for, so the
      // chat is "ready" the moment the session connects (SSE up). The
      // initialMessage path keeps waiting for the turn (conditions above) so the
      // overlay doesn't flash an empty chat before the auto-sent message lands.
      || (isConnected && !hadInitialMessage.current && !isSessionLoading)
    ) {
      setShowStartupOverlay(false);
    }
  }, [showStartupOverlay, sessionState, streamingMessage, agentError, isConnected, isSessionLoading]);

  // Safety timeout (30s) — covers prewarm failures / unresponsive backend.
  // Prevents the overlay from sticking forever if neither sessionState nor
  // streamingMessage ever advances.
  useEffect(() => {
    if (!showStartupOverlay) return;
    const t = setTimeout(() => setShowStartupOverlay(false), 30000);
    return () => clearTimeout(t);
  }, [showStartupOverlay]);

  const materializeScheduledOwner = useCallback(async () => {
    if (!sessionId) throw new Error('Goal requires a session identity.');
    if (!isPendingSessionId(sessionId)) return { sessionId, workspacePath: agentDir };
    if (!agentDir) throw new Error('Cannot materialize Goal without workspace path.');

    const result = await materializePendingSessionConfig({
      pendingSessionId: sessionId,
      tabId,
      workspacePath: agentDir,
      snapshotPatch: {},
      transport: {
        postCurrent: (body) => apiPost('/api/session/materialize', body),
      },
    });
    const adopted = await adoptMigratedSession(result.sessionId, { sidecarAlreadyMigrated: true });
    if (!adopted) throw new Error(`Failed to adopt Goal session ${result.sessionId}.`);
    setSessionMeta(result.metadata);
    return { sessionId: result.sessionId, workspacePath: agentDir };
  }, [sessionId, tabId, agentDir, apiPost, adoptMigratedSession, setSessionMeta]);

  // Cron task management hook
  const {
    state: cronState,
    enableCronMode,
    disableCronMode,
    updateConfig: _updateCronConfig,
    updateRunningConfig,
    setExecutionState: setCronExecutionState,
    startTask: startCronTask,
    stop: stopCronTask,
    restoreFromTask: restoreCronTask,
  } = useCronTask({
    workspacePath: agentDir,
    sessionId: sessionId ?? '',
    materializeOwner: materializeScheduledOwner,
    onComplete: (task, reason) => {
      console.log('[Chat] Cron task completed:', task.id, reason);
    },
    onExecutionComplete: (task, success) => {
      // TabProvider owns exact-Session refresh from the same Tauri completion
      // event. Chat only clears its local execution projection here.
      const effectiveSessionId = task.internalSessionId || task.sessionId;
      console.log('[Chat] Cron execution complete:', task.id, task.executionCount, 'effectiveSessionId:', effectiveSessionId, 'success:', success);
      setIsLoading(false);
    },
  });
  const {
    state: sessionGoalState,
    start: startGoal,
    pause: pauseGoal,
    resume: resumeGoal,
    cancel: cancelGoal,
    dismiss: dismissGoal,
    cancelPendingStart: cancelPendingGoalStart,
  } = useSessionGoal({
    workspacePath: agentDir,
    sessionId: sessionId ?? '',
    materializeOwner: materializeScheduledOwner,
  });

  // PERFORMANCE: Ref-stabilize cronState for handleSendMessage
  const cronStateRef = useRef(cronState);
  cronStateRef.current = cronState;
  const sessionGoalStateRef = useRef(sessionGoalState);
  sessionGoalStateRef.current = sessionGoalState;
  // Surface tags (PRD 0.2.14): pull agent status snapshot for the channel pill.
  // Keeping this beside deletion protection lets channel owner changes refresh
  // the menu projection without duplicating the owner predicate in Chat.
  const { statuses: agentStatuses } = useAgentStatuses(true);
  const surfaces = useSessionSurfaces(sessionId, agentStatuses, cronState.task);
  channelSurfaceRef.current = surfaces.channel;
  const startScheduledTask = useCallback(async (prompt: string): Promise<'goal' | 'cron' | null> => {
    const goalConfig = goalDraftConfigRef.current;
    if (goalConfig) {
      const goal = await startGoal({ ...goalConfig, taskKind: 'goal' }, prompt);
      setGoalDraftConfig(null);
      return goal ? 'goal' : null;
    }
    const config = cronStateRef.current.config;
    if (!config) throw new Error('[Chat] Scheduled task draft is missing');
    if (config.taskKind === 'goal') {
      const goal = await startGoal({ ...config, taskKind: 'goal' }, prompt);
      disableCronMode();
      return goal ? 'goal' : null;
    }
    await startCronTask(prompt);
    return 'cron';
  }, [disableCronMode, startCronTask, startGoal]);
  const activeCurrentSessionCronTask = cronState.task?.status === 'running' && cronState.task.runMode !== 'new_session'
    ? cronState.task
    : null;
  const [sessionDeleteProtected, setSessionDeleteProtected] = useState(false);
  useEffect(() => {
    let canceled = false;
    if (!sessionId) {
      setSessionDeleteProtected(false);
      return;
    }
    // Show a fail-closed protection hint while lifecycle truth is loading.
    // Rust still makes the final lock-held deletion decision after confirm.
    setSessionDeleteProtected(true);
    void sessionHasPersistentOwners(sessionId).then((protectedByOwner) => {
      if (!canceled) setSessionDeleteProtected(protectedByOwner);
    });
    return () => { canceled = true; };
  }, [
    sessionId,
    cronState.task?.status,
    sessionGoalState.goal?.revision,
    sessionGoalState.goal?.status,
    surfaces.channel?.sessionKey,
  ]);
  const composerConfigLockedReason = activeCurrentSessionCronTask
      ? t('shell.toasts.composerLockedByCron')
    : undefined;
  const showPinnedProviderUnavailableToast = useCallback(() => {
    toastRef.current.error(t('shell.toasts.providerUnavailable', { providerId: effectiveSelectedProviderId }));
  }, [effectiveSelectedProviderId, t]);
  const showSnapshotProviderIncompleteToast = useCallback(() => {
    toastRef.current.warning(t('shell.toasts.snapshotProviderIncomplete'));
  }, [t]);
  const guardCronConfigMutation = useCallback(() => {
    if (!composerConfigLockedReason) return false;
    toastRef.current.warning(composerConfigLockedReason, 3500);
    return true;
  }, [composerConfigLockedReason]);
  const stoppedCronTaskForInput = useMemo(
    () => stoppedCronRecovery?.task && stoppedCronRecovery.sessionId === sessionId
      ? { ...stoppedCronRecovery.task, status: 'stopped' as const }
      : null,
    [stoppedCronRecovery, sessionId],
  );

  useEffect(() => {
    setStoppedCronRecovery(null);
    setGoalCancelConfirmOpen(false);
    setGoalDraftConfig(null);
  }, [sessionId]);

  // File drop zone for chat area (HTML5 drag-drop for non-Tauri/development)
  const handleFileDrop = useCallback((files: File[]) => {
    chatInputRef.current?.processDroppedFiles(files);
  }, []);

  const { isDragActive, dragHandlers } = useFileDropZone({
    onFilesDropped: handleFileDrop,
  });

  // Handle Tauri file drop on chat area (copy to myagents_files + insert reference)
  const handleTauriChatDrop = useCallback(async (paths: string[]) => {
    if (isDebugMode()) {
      console.log('[Chat] Tauri drop on chat area:', paths);
    }
    // Use the SimpleChatInput's method to process file paths
    await chatInputRef.current?.processDroppedFilePaths?.(paths);
    // Refresh workspace to show new files
    triggerWorkspaceRefresh();
  }, [triggerWorkspaceRefresh]);

  // Handle Tauri file drop on directory panel. Forward the drop position so
  // the panel resolves the target folder from the tree row under the pointer
  // (instead of the current selection — see DirectoryPanelHandle.handleFileDrop).
  const handleTauriDirectoryDrop = useCallback(async (paths: string[], position?: { x: number; y: number }) => {
    if (isDebugMode()) {
      console.log('[Chat] Tauri drop on directory panel:', paths, position);
    }
    await directoryPanelRef.current?.handleFileDrop(paths, position);
  }, []);

  // Use refs to avoid recreating onDrop callback when handlers change
  const handleTauriChatDropRef = useRef(handleTauriChatDrop);
  const handleTauriDirectoryDropRef = useRef(handleTauriDirectoryDrop);
  useEffect(() => {
    handleTauriChatDropRef.current = handleTauriChatDrop;
    handleTauriDirectoryDropRef.current = handleTauriDirectoryDrop;
  }, [handleTauriChatDrop, handleTauriDirectoryDrop]);

  const { isDragging: isTauriDragging, activeZoneId, registerZone, unregisterZone } = useTauriFileDrop({
    // Tauri drag events are window-global and fire on every mounted hook instance.
    // Without this gate, a single Finder drop (or image drag) lands in ALL open tabs'
    // attachment/workspace state because every hidden tab's zone still matches the
    // geometric check (absolute inset-0 overlap) AND the `zoneId === null` fallback
    // below defaults to chat-drop regardless. Gating at the hook ensures only the
    // visible tab reacts.
    enabled: isActive,
    onDrop: (paths, zoneId, position) => {
      if (isDebugMode()) {
        console.log('[Chat] Tauri drop event - zoneId:', zoneId, 'paths:', paths);
      }
      if (zoneId === 'chat-content') {
        void handleTauriChatDropRef.current(paths);
      } else if (zoneId === 'directory-panel') {
        void handleTauriDirectoryDropRef.current(paths, position);
      } else {
        // Default: drop to chat area
        void handleTauriChatDropRef.current(paths);
      }
    },
  });

  // Register drop zones for Tauri (only for position detection, handlers are in onDrop above)
  useEffect(() => {
    if (!isTauriEnvironment()) return;

    // Register chat content drop zone (empty callback - handled in global onDrop)
    registerZone('chat-content', chatContentRef.current, () => {});

    // Register directory panel drop zone (empty callback - handled in global onDrop)
    registerZone('directory-panel', directoryPanelContainerRef.current, () => {});

    return () => {
      unregisterZone('chat-content');
      unregisterZone('directory-panel');
    };
  }, [registerZone, unregisterZone]);

  // Combined drag active state (HTML5 or Tauri)
  const isAnyDragActive = isDragActive || isTauriDragging;

  // MCP state
  const [mcpServers, setMcpServers] = useState<McpServerDefinition[]>([]);
  const [globalMcpEnabled, setGlobalMcpEnabled] = useState<string[]>([]);
  const [workspaceMcpEnabled, setWorkspaceMcpEnabled] = useState<string[]>(
    currentAgent?.mcpEnabledServers ?? currentProject?.mcpEnabledServers ?? []
  );
  const runtimeMcpTools = useMemo(
    () => mcpEffectiveSnapshot?.tools
      ?? (isExternalRuntime
        ? (systemInitInfo?.tools ?? []).filter(tool => tool.startsWith('mcp__'))
        : []),
    [isExternalRuntime, mcpEffectiveSnapshot?.tools, systemInitInfo?.tools],
  );

  // PRD 0.2.17 — Claude plugin per-workspace enable state. Init from Agent
  // (preferred) or Project. Layer 1 (global visibility) is applied later
  // when computing the dropdown candidate list.
  const [workspaceEnabledPlugins, setWorkspaceEnabledPlugins] = useState<string[]>(
    currentAgent?.enabledPluginIds ?? currentProject?.enabledPluginIds ?? []
  );
  const [workspaceOfficialToolEnabled, setWorkspaceOfficialToolEnabled] = useState<OfficialToolId[]>(
    normalizeOfficialToolIds(currentAgent?.enabledOfficialToolIds ?? currentProject?.enabledOfficialToolIds ?? [])
  );
  const globalOfficialToolEnabled = useMemo(
    () => normalizeOfficialToolIds(config.enabledOfficialToolIds ?? []),
    [config.enabledOfficialToolIds],
  );
  const imageUnderstandingConfiguredForInput = useMemo(() => {
    return isImageUnderstandingSelectionAvailable(
      providers,
      apiKeys,
      providerVerifyStatus,
      config.officialToolSettings,
    );
  }, [apiKeys, config.officialToolSettings, providerVerifyStatus, providers]);
  const officialToolNeedsConfig = useMemo(
    () => ({ [IMAGE_UNDERSTANDING_TOOL_ID]: !imageUnderstandingConfiguredForInput }),
    [imageUnderstandingConfiguredForInput],
  );

  // Track which session's cron task state has been loaded
  const cronLoadedSessionRef = useRef<string | null>(null);

  // Track if we need to set loading state after TabProvider's loadSession completes
  // This is used when restoring a cron task that is currently executing
  const pendingCronLoadingRef = useRef(false);

  // Track previous messages reference to detect when loadSession completes
  // Using reference comparison instead of length to handle edge case where
  // message count stays the same after loadSession
  const prevMessagesRef = useRef(messages);

  // Restore or clear cron task state when session changes
  // 方案 A: Rust 统一恢复 - Scheduler 由 Rust 层 initialize_cron_manager 自动恢复
  // 前端只负责同步 UI 状态
  //
  // This handles:
  // 1. App restart recovery - restore cron task UI for running/paused tasks
  //    (Scheduler already started by Rust layer)
  // 2. Tab re-open - reconnect to existing cron task
  // 3. Session switch - clear cron state if switching to a session without cron task
  useEffect(() => {
    if (!sessionId || !tabId || !isTauriEnvironment()) return;

    // Skip if already loaded for this session
    if (cronLoadedSessionRef.current === sessionId) return;

    const loadCronTaskState = async () => {
      try {
        const task = await getSessionCronTask(sessionId);

        if (task && task.status === 'running') {
          console.log('[Chat] Restoring cron task UI for session:', sessionId, task.id, 'to tab:', tabId);

          // Restore UI state only. The Rust Task scheduler owns recovery.
          restoreCronTask(task);
          setStoppedCronRecovery(null);

          // Check if task is currently executing (e.g., execution started before app restart)
          // If executing, mark it so we can set loading state after TabProvider's loadSession completes
          // NOTE: Do NOT call loadSession here - TabProvider already handles session loading
          // Calling it here causes infinite loop with TabProvider's session loading effect
          const executing = await isTaskExecuting(task.id);
          if (executing) {
            if (sessionIdRef.current !== sessionId) return;
            console.log('[Chat] Cron task is currently executing, marking for loading state');
            pendingCronLoadingRef.current = true;
            setCronExecutionState(task.id, true, (task.executionCount ?? 0) + 1);
          }
        } else if (cronState.task && cronState.task.sessionId && cronState.task.sessionId !== sessionId) {
          // Current cron state is for a different session - clear FRONTEND state only
          // This happens when user switches from a cron-task session to a regular session
          // Note: Only clear if cronState.task.sessionId is NOT empty (empty means task was just created)
          //
          // IMPORTANT: We do NOT call stopCronTask() here because:
          // 1. The task should continue running for its original session
          // 2. The Rust scheduler executes on session-specific Sidecar
          // 3. When user goes back to the original session, state will be restored (above code)
          // 4. Per PRD: "暂停后允许手动对话" - task continues while user interacts with other sessions
          //
          // EXCEPTION: Don't clear if this is a pending -> real session ID upgrade (same cron task!)
          // This happens when SDK creates the real session after first message
          const isSessionUpgrade = isPendingSessionId(cronState.task.sessionId) && !isPendingSessionId(sessionId);
          if (isSessionUpgrade) {
            console.log('[Chat] Session ID upgraded from pending to real, keeping cron state:', cronState.task.sessionId, '->', sessionId);
          } else {
            console.log('[Chat] Clearing frontend cron state (session changed from', cronState.task.sessionId, 'to', sessionId, ')');
            disableCronMode();
          }
        }

        cronLoadedSessionRef.current = sessionId;
      } catch (error) {
        console.error('[Chat] Failed to load cron task state:', error);
      }
    };

    void loadCronTaskState();
  }, [sessionId, tabId, restoreCronTask, disableCronMode, cronState.task, setIsLoading, setCronExecutionState]);

  // Set loading state after TabProvider's loadSession completes (for cron task executing scenario)
  // This effect watches for messages reference changes, which indicates loadSession has completed
  // Using reference comparison (not length) to handle edge case where message count stays the same
  useEffect(() => {
    // Only proceed if we have pending cron loading and messages array has changed
    if (pendingCronLoadingRef.current && messages !== prevMessagesRef.current) {
      console.log('[Chat] loadSession completed, setting loading state for cron execution');
      setIsLoading(true);
      pendingCronLoadingRef.current = false;
    }
    prevMessagesRef.current = messages;
  }, [messages, setIsLoading]);

  // Load MCP config on mount and sync to backend
  useEffect(() => {
    const loadMcpConfig = async () => {
      try {
        // When joining an existing sidecar (e.g. IM Bot session), skip pushing Tab's
        // MCP config to avoid overwriting the session's current config.
        // Still load local MCP state for sidebar display.
        const servers = await getAllMcpServers();
        const enabledIds = await getEnabledMcpServerIds();
        setMcpServers(servers);
        syncMcpServerNames(servers);
        setGlobalMcpEnabled(enabledIds);

        if (configDispositionRef.current !== 'push') {
          if (isDebugMode()) {
            console.log('[Chat] Skipping MCP push (joined existing sidecar)');
          }
          return;
        }

        // Push only when the sidecar is reachable. This effect re-fires on the
        // isConnected false→true transition (isConnected is in the deps), so a
        // freshly-spawned / reconnected / respawned sidecar always re-receives
        // the MCP set — in-process MCP state dies with the old sidecar process
        // (mirrors the model-push pattern below). The sidecar NEVER falls back to
        // a config file (buildSdkMcpServers uses `currentMcpServers ?? []` — see
        // agent-session.ts), so a missing push = the SDK runs with NO MCP (the
        // user's enabled servers silently absent), and a late push after pre-warm
        // fingerprints can trigger an abort + ~30s restart. Local state
        // (setMcpServers etc.) above is display-only, intentionally NOT gated.
        // (#300/#301 config-stomping class.)
        if (!isConnected) return;
        if (isSessionLoading) return;

        // Launcher-handoff tabs: autoSend owns the INITIAL push (the user's
        // per-session launcher MCP selection, which may differ from the workspace
        // default computed below). Skip here so the two pushers don't race and
        // stomp the launcher choice; autoSend clears the ref after its MCP block,
        // so later config-change re-runs of this effect push normally.
        if (launcherOwnsInitialMcpRef.current) return;

        // CRITICAL: Always sync effective MCP servers to backend on initial load
        // This ensures the Agent SDK has correct MCP config (including empty = no MCP)
        // Without this, backend currentMcpServers stays null and falls back to file config
        const workspaceEnabled = workspaceMcpEnabled;
        const effectiveServers = servers.filter(s =>
          enabledIds.includes(s.id) && workspaceEnabled.includes(s.id)
        );

        // Always call /api/mcp/set, even with empty array
        // Empty array means "user explicitly disabled all MCP"
        // null (not calling) means "use file config fallback" - which we don't want
        await pushSessionConfig(
          'mcp',
          '/api/mcp/set',
          { servers: effectiveServers },
          'background',
        );
        if (isDebugMode()) {
          console.log('[Chat] Initial MCP sync:', effectiveServers.map(s => s.id).join(', ') || 'none');
        }
      } catch (err) {
        console.error('[Chat] Failed to load MCP config:', err);
      }
    };
    loadMcpConfig();
    // Re-fires on:
    //  - workspace MCP toggles / session snapshot sync (workspaceMcpEnabled)
    //  - global enable/disable (config.mcpEnabledServers) — covers Settings
    //    toggling a server on/off globally
    //  - env / args / server-definition edits (config.mcpServerEnv /
    //    mcpServerArgs / mcpServers) — issue #303: when the user adds
    //    MINERU_API_KEY via Settings (which writes config.mcpServerEnv only,
    //    not workspace-level mcpEnabledServers), ConfigProvider re-loads on
    //    CONFIG_CHANGED_EVENT → `config` becomes a new reference → this effect
    //    fires → /api/mcp/set re-pushes the merged server list so the
    //    sidecar's currentMcpServers picks up the env on its next pre-warm
    //    fingerprint diff.
  }, [
    configPending, // re-run when the instant-flip disposition resolves (pending→push)
    isConnected, // re-push MCP when the sidecar becomes reachable (re)connect — see guard above
    isSessionLoading,
    workspaceMcpEnabled,
    config?.mcpEnabledServers,
    config?.mcpServerEnv,
    config?.mcpServerArgs,
    config?.mcpServers,
    launcherMcpFallbackRevision,
    pushSessionConfig,
  ]);

  useEffect(() => {
    const syncOfficialTools = async () => {
      if (configDispositionRef.current !== 'push') return;
      if (!isConnected || isSessionLoading) return;
      if (launcherOwnsInitialOfficialToolsRef.current) return;
      try {
        await apiPost('/api/official-tools/session-enable', {
          enabledIds: workspaceOfficialToolEnabled,
        });
      } catch (err) {
        console.error('[Chat] Failed to sync official tools:', err);
      }
    };
    void syncOfficialTools();
  }, [
    apiPost,
    configPending,
    isConnected,
    isSessionLoading,
    workspaceOfficialToolEnabled,
    config?.enabledOfficialToolIds,
    config?.officialToolSettings,
  ]);

  // Load enabled agents and sync to backend
  const loadAndSyncAgents = useCallback(async () => {
    try {
      const response = await apiGet<{ success: boolean; agents: Record<string, { description: string; prompt: string; model?: string; scope?: 'user' | 'project'; folderName?: string }> }>('/api/agents/enabled');
      if (response.success && response.agents) {
        setEnabledAgents(response.agents);
        // Skip push when joining existing sidecar to avoid overwriting session config
        if (configDispositionRef.current !== 'push') {
          if (isDebugMode()) {
            console.log('[Chat] Skipping agents push (joined existing sidecar)');
          }
          return;
        }
        // Sync to backend for SDK injection
        await pushSessionConfig(
          'agents',
          '/api/agents/set',
          { agents: response.agents },
          'background',
        );
        if (isDebugMode()) {
          console.log('[Chat] Agents synced:', Object.keys(response.agents).join(', ') || 'none');
        }
      }
    } catch (err) {
      console.error('[Chat] Failed to load agents:', err);
    }
  // configPending is an INTENTIONAL re-trigger dep (not referenced in the body — the
  // gate reads configDispositionRef.current): changing the callback identity when the
  // disposition resolves makes the calling effect re-run loadAndSyncAgents, so a
  // 'pending'→'push' history open pushes agents even if it skipped during pending.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiGet, configPending, pushSessionConfig]);

  // Sync project skill to global
  const loadSkillsAndCommandsRef = useRef(loadSkillsAndCommands);
  loadSkillsAndCommandsRef.current = loadSkillsAndCommands;

  const handleSyncSkillToGlobal = useCallback(async (folderName: string) => {
    try {
      const res = await apiPost<{ success: boolean; error?: string }>('/api/skill/copy-to-global', { folderName });
      if (res.success) {
        toastRef.current.success(t('shell.toasts.skillSyncedToGlobal'));
        loadSkillsAndCommandsRef.current();
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED));
      } else {
        toastRef.current.error(res.error || t('shell.toasts.syncFailed'));
      }
    } catch (err) {
      console.error('[Chat] Sync skill to global failed:', err);
      toastRef.current.error(t('shell.toasts.syncFailedRetry'));
    }
  }, [apiPost, t]);

  // Load capabilities on mount and when workspace config changes (e.g. skill copied, settings saved)
  useEffect(() => {
    loadAndSyncAgents();
    loadSkillsAndCommands();
  }, [
    currentAgent?.capabilitySelection,
    loadAndSyncAgents,
    loadSkillsAndCommands,
    workspaceRefreshTrigger,
  ]);

  // Sync workspace MCP to project config when it changes
  useEffect(() => {
    if (sessionMeta?.configSnapshotAt) return;
    if (currentProject?.mcpEnabledServers) {
      setWorkspaceMcpEnabled(currentProject.mcpEnabledServers);
    }
  }, [currentProject?.mcpEnabledServers, sessionMeta?.configSnapshotAt]);

  useEffect(() => {
    if (sessionMeta?.configSnapshotAt) return;
    const next = currentAgent?.enabledOfficialToolIds ?? currentProject?.enabledOfficialToolIds;
    if (next) setWorkspaceOfficialToolEnabled(normalizeOfficialToolIds(next));
  }, [currentAgent?.enabledOfficialToolIds, currentProject?.enabledOfficialToolIds, sessionMeta?.configSnapshotAt]);

  // v0.1.69 — owned (Desktop/Cron) sessions lock config via SessionMetadata snapshot
  // (configSnapshotAt stamped at creation per `snapshotForOwnedSession`). Tab-level UI
  // changes in a desktop Tab MUST first land in the session snapshot. Agent is
  // still updated as the template for future sessions, but the current Tab's
  // session authority is the snapshot once the user touches a config knob.
  const isOwnedSession = sessionSnapshotOwnsConfig;

  // v0.2.39 — desktop Tab config edits always snapshot first. Even if the
  // session originated from IM and is currently live-following, a user edit in
  // the Tab promotes it to a self-contained snapshot until the channel creates a
  // new session. The resolver remains as the single policy hook and currently
  // returns false for every Tab edit.
  const skipSnapshotWrite = shouldSkipSnapshotWrite({
    sessionMetaSource: sessionMeta?.source ?? null,
    sessionMetaConfigSnapshotAt: sessionMeta?.configSnapshotAt ?? null,
    sessionMetaLoaded: !!sessionMeta,
  });

  // #300 — the session pinned a provider (selectedProviderId) but resolveProvider
  // silently fell back to a different one because the pinned provider is
  // unavailable (no API key / disabled / deleted). Drives both the "don't stomp
  // the pinned model" guards below and the send block, so the renderer never
  // silently routes an owned session onto — and bills — the wrong provider.
  const pinnedProviderUnavailable = isPinnedProviderUnavailable({
    isOwnedSession,
    isExternalRuntime,
    selectedProviderId: effectiveSelectedProviderId,
    resolvedProviderId: currentProvider?.id,
    providersLoaded: providers.length > 0,
  });

  /**
   * Patch one or more snapshot fields on the current session and mirror the update
   * into TabContext so `sessionMeta`-driven derivations (see the sync effect above)
   * don't rubber-band back to the old value on the next render. Safe no-op if there
   * is no current sessionId (new-tab pre-create race).
   */
  const patchSnapshot = useCallback(async (patch: Parameters<typeof patchSessionMetadata>[1]) => {
    if (!sessionId) return;
    if (isPendingSessionId(sessionId)) {
      if (!agentDir) {
        throw new Error('Cannot materialize pending session without workspace path.');
      }

      const result = await materializePendingSessionConfig({
        pendingSessionId: sessionId,
        tabId,
        workspacePath: agentDir,
        snapshotPatch: patch,
        transport: {
          postCurrent: (body) => apiPost('/api/session/materialize', body),
        },
      });
      const adopted = await adoptMigratedSession(result.sessionId, { sidecarAlreadyMigrated: true });
      if (!adopted) {
        throw new Error(`Failed to adopt materialized session ${result.sessionId}.`);
      }
      setSessionMeta(result.metadata);
      return;
    }
    const updated = await patchSessionMetadata(sessionId, patch);
    if (!updated) {
      throw new Error(`Session ${sessionId} not found.`);
    }
    setSessionMeta(updated);
  }, [sessionId, tabId, agentDir, apiPost, adoptMigratedSession, setSessionMeta]);

  // Persist a Tab-UI config change to session snapshot (owned) + project + agent.
  // See PRD v0.1.69 §4.3 rule 2. Toasts on persistence failure without rolling
  // back local UI state — the user already sees their intent in the UI and the
  // current session is using the value in-memory; only on-disk drift is
  // surfaced so the user knows to retry or expects a possible revert on reload.
  //
  // PRD 0.2.7: dual-write fan-out lives in the shared `persistInputOptionChange`
  // helper, so Chat and Launcher write the exact same fields to the exact same
  // places. The helper ALSO branches permission mode / model on
  // `isExternalRuntime` (writing to `agent.runtimeConfig` for external runtimes
  // instead of `agent.permissionMode` / `agent.model`) — fixing a long-standing
  // bug where Chat's path sent external-runtime permission to the wrong field.
  const persistTabConfigChange = useCallback(async (patch: {
    builtinSelection?: BuiltinModelSelection;
    builtinProviderEnvPolicy?: BuiltinProviderEnvPolicy;
    runtimeBackedProviderSelection?: RuntimeBackedProviderIdentity;
    providerId?: string;
    /** Builtin model. Use `runtimeModel` instead for external runtimes. */
    model?: string | null;
    /** External runtime model. Routed to `agent.runtimeConfig.model`. */
    runtimeModel?: string | null;
    permissionMode?: PermissionMode | string;
    /** #324 — 推理强度 setting ('default' | level). The helper routes it to
     *  `agent.reasoningEffort` (builtin) / `agent.runtimeConfig.reasoningEffort`
     *  (external) + the session snapshot. */
    reasoningEffort?: string;
    mcpEnabledServers?: string[];
    enabledPluginIds?: string[];
    enabledOfficialToolIds?: OfficialToolId[];
  }) => {
    if (!currentProject) return false;
    const handleExtensionUpdateResponse = (response: ExtensionUpdateResponse): void => {
      const status = response.extensionStatus;
      if (response.success === false || status?.state === 'failed') {
        throw new Error(response.error ?? 'Managed Codex extension update failed');
      }
      const notice = projectRuntimeExtensionUpdateNotice(status);
      if (notice === 'deferred') {
        toastRef.current.info(t('shell.toasts.extensionsDeferred'));
      } else if (notice === 'unsupported') {
        toastRef.current.warning(t('shell.toasts.extensionsUnsupported'));
      }
    };
    const result = await persistInputOptionChange({
      workspaceId: currentProject.id,
      agentId: currentProject.agentId ?? null,
      isExternalRuntime,
      currentRuntimeConfig: currentAgent?.runtimeConfig,
      currentProviderId: currentAgent?.providerId ?? currentProject.providerId,
      fields: {
        builtinSelection: patch.builtinSelection,
        builtinProviderEnvPolicy: patch.builtinProviderEnvPolicy,
        runtimeBackedProviderSelection: patch.runtimeBackedProviderSelection,
        providerId: patch.providerId,
        builtinModel: patch.model,
        runtimeModel: patch.runtimeModel,
        permissionMode: patch.permissionMode,
        reasoningEffort: patch.reasoningEffort,
        mcpEnabledServers: patch.mcpEnabledServers,
        enabledPluginIds: patch.enabledPluginIds,
        enabledOfficialToolIds: patch.enabledOfficialToolIds,
      },
      patchProject,
      patchAgentConfig,
      patchAgentProjectConfig,
      // v0.2.39: desktop Tab user intent always snapshots first; the helper is
      // still wired with a policy hook so future non-Tab surfaces cannot drift.
      patchSnapshot: skipSnapshotWrite ? undefined : patchSnapshot,
      snapshotWriteMode: skipSnapshotWrite ? 'disabled' : 'required',
      // Cross-review: Chat's MCP toggle previously did its own
      // `apiPost('/api/mcp/set')` AFTER the helper, leaving the helper's
      // `pushMcpToSidecar` plumbing dead-code. Wire it through so the
      // "single source of truth" promise is real.
      pushMcpToSidecar: async (servers) => {
        // Defer the live-sidecar push while the disposition is unresolved (instant
        // flip pre-ensure) — pushing now could stomp a sidecar that resolves to
        // 'adopt'. The disk dual-write (patchProject/patchSnapshot) still happens, so
        // on 'push' the mount effect re-pushes the effective set on resolve, and on
        // 'adopt' the user's choice is persisted for future sessions. Post-resolution
        // (push OR adopt) a user toggle is explicit intent and DOES reach the sidecar.
        if (configDispositionRef.current === 'pending') return;
        const response = await pushSessionConfig(
          'mcp',
          '/api/mcp/set',
          { servers },
          'explicit',
        );
        if (response) handleExtensionUpdateResponse(response);
      },
      getAllMcpServers,
      getGlobalMcpEnabled: getEnabledMcpServerIds,
      // PRD 0.2.17 — push plugin selection to the running sidecar so the
      // SDK options for the next pre-warm pick up the change immediately,
      // mirroring the MCP push above.
      pushPluginsToSidecar: async (enabledIds) => {
        if (configDispositionRef.current === 'pending') return; // defer while unresolved; disk write still happens
        const response = await apiPost<ExtensionUpdateResponse>('/api/cc-plugin/session-enable', { enabledIds });
        handleExtensionUpdateResponse(response);
      },
      pushOfficialToolsToSidecar: async (enabledIds) => {
        if (configDispositionRef.current === 'pending') return;
        await apiPost('/api/official-tools/session-enable', { enabledIds });
      },
      pushRuntimeConfigToSidecar: async (runtimeConfig) => {
        if (configDispositionRef.current === 'pending') return; // defer while unresolved; disk write still happens
        await apiPost('/api/runtime/config', {
          runtime: currentRuntime,
          runtimeConfig,
        });
      },
    });
    if (!result.ok) {
      console.error('[chat] tab config dual-write failed:', result.errors);
      toastRef.current.warning(t('shell.toasts.configPartiallySaved'));
    }
    return !result.snapshotWriteFailed;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- narrowed deps; persistInputOptionChange is a pure import, runtimeConfig accessed via currentAgent ref, apiPost is stable from TabContext
  }, [skipSnapshotWrite, currentProject?.id, currentProject?.agentId, isExternalRuntime, currentRuntime, currentAgent?.runtimeConfig, patchSnapshot, patchProject, t]);

  // Handle workspace MCP toggle — Tab UI edits dual-write:
  // (1) session snapshot so THIS session uses the new tool set immediately (owned sessions only
  //     — unlocked/IM have no snapshot);
  // (2) project + agent so FUTURE new sessions inherit the user's latest choice (PRD
  //     v0.1.69 §4.3 rule 2: "写 Session + 向上写 Agent"). For unlocked/IM this is also
  //     the live-follow source, so the single write covers both roles.
  const handleWorkspaceMcpToggle = useCallback(async (serverId: string, enabled: boolean) => {
    if (guardCronConfigMutation()) return;
    if (serverId === MANAGED_BROWSER_MCP_ID && enabled && !managedBrowserReady) {
      toastRef.current.warning(tSettings('toolbox.browserResource.installFirst'));
      return;
    }
    const newEnabled = applyBuiltinBrowserExecutionToolToggle(
      workspaceMcpEnabled,
      serverId,
      enabled,
      managedBrowserReady,
    );

    setWorkspaceMcpEnabled(newEnabled);

    // PRD 0.2.7: persistTabConfigChange now also handles the sidecar push
    // (via the helper's `pushMcpToSidecar` callback) so this site is just a
    // single delegate call — disk dual-write + live MCP swap on the running
    // session in one transaction. Pre-PRD-0.2.7 the duplicate `apiPost`
    // here ran AFTER persist and left the helper's plumbing as dead code.
    const persisted = await persistTabConfigChange({ mcpEnabledServers: newEnabled });
    if (!persisted) {
      setWorkspaceMcpEnabled(workspaceMcpEnabled);
    }
  }, [workspaceMcpEnabled, persistTabConfigChange, guardCronConfigMutation, managedBrowserReady, tSettings]);

  // PRD 0.2.17 — Claude plugin per-workspace toggle. Mirrors MCP exactly:
  // optimistic local update + dual-write via persistTabConfigChange (which
  // also pushes /api/cc-plugin/session-enable to the running sidecar so
  // the SDK options pick up the new plugin set on next pre-warm).
  const handleWorkspacePluginToggle = useCallback(async (pluginId: string, enabled: boolean) => {
    if (guardCronConfigMutation()) return;
    const newEnabled = enabled
      ? [...workspaceEnabledPlugins, pluginId]
      : workspaceEnabledPlugins.filter(id => id !== pluginId);
    setWorkspaceEnabledPlugins(newEnabled);
    const persisted = await persistTabConfigChange({ enabledPluginIds: newEnabled });
    if (!persisted) {
      setWorkspaceEnabledPlugins(workspaceEnabledPlugins);
    }
  }, [workspaceEnabledPlugins, persistTabConfigChange, guardCronConfigMutation]);

  const handleWorkspaceOfficialToolToggle = useCallback(async (toolId: OfficialToolId, enabled: boolean) => {
    if (guardCronConfigMutation()) return;
    const newEnabled = normalizeOfficialToolIds(
      enabled
        ? [...workspaceOfficialToolEnabled, toolId]
        : workspaceOfficialToolEnabled.filter(id => id !== toolId),
    );
    setWorkspaceOfficialToolEnabled(newEnabled);
    const persisted = await persistTabConfigChange({ enabledOfficialToolIds: newEnabled });
    if (!persisted) {
      setWorkspaceOfficialToolEnabled(workspaceOfficialToolEnabled);
    }
  }, [workspaceOfficialToolEnabled, persistTabConfigChange, guardCronConfigMutation]);

  // Sync selectedModel when provider changes (skip initial mount to preserve project-stored model)
  const providerInitRef = useRef(true);
  useEffect(() => {
    if (providerInitRef.current) {
      providerInitRef.current = false;
      return;
    }
    if (sessionSnapshotOwnsConfig) return;
    // #300: when the pinned provider is unavailable, `currentProvider` is a
    // silent first-available fallback (e.g. deepseek). Judging — let alone
    // resetting — the pinned model against the fallback's model list is exactly
    // the bug. Leave it; the send guard surfaces the unavailability instead.
    if (pinnedProviderUnavailable) return;
    // #300: reset ONLY when the model is genuinely invalid for the resolved
    // provider. Resetting unconditionally on every `currentProvider.id` change
    // stomped a still-valid pinned model on the apiKeys-load availability flip
    // (unavailable→available), discarding the user's per-session model choice.
    if (!shouldResetModelOnProviderChange({
      providerType: currentProvider?.type,
      providerModels: currentProvider?.models?.map(m => m.model),
      selectedModel,
    })) return;
    if (currentProvider?.primaryModel) {
      setSelectedModel(currentProvider.primaryModel);
    }
  }, [currentProvider?.id, currentProvider?.primaryModel, currentProvider?.models, currentProvider?.type, selectedModel, pinnedProviderUnavailable, sessionSnapshotOwnsConfig]);

  // One-time sync: apply project-stored settings after useConfig finishes async load.
  // useState initializers run with currentProject=undefined (useConfig loads asynchronously),
  // so project settings must be re-applied once currentProject becomes available.
  // Placed AFTER provider change effect so project model takes priority in same render cycle.
  // Skipped when initialMessage is provided (BrandSection path applies its own settings).
  useEffect(() => {
    // While 'pending' (instant flip pre-ensure), wait WITHOUT marking
    // projectSyncedRef — so this re-runs once the disposition resolves (configPending
    // is in deps). On 'adopt' the model seed below is gated to 'push' so adoption owns it.
    if (!currentProject || projectSyncedRef.current || hadInitialMessage.current || configPending) return;
    if (waitingForExistingSessionMeta) return;
    if (sessionSnapshotOwnsConfig) {
      projectSyncedRef.current = true;
      return;
    }
    projectSyncedRef.current = true;
    // AgentConfig is source of truth, Project is fallback for non-agent workspaces
    const effectivePermission = (currentAgent?.permissionMode as PermissionMode | undefined) ?? currentProject.permissionMode ?? config.defaultPermissionMode;
    setPermissionMode(effectivePermission);
    // Runtime-specific permission mode sync is handled by the `[currentRuntime, isExternalRuntime]`
    // effect higher up, which validates the persisted value against the current runtime's mode
    // set and falls back to the runtime default if stale. Don't override here without validation —
    // doing so reintroduces the cross-runtime leak (e.g. Codex's 'no-restrictions' bleeding into
    // a Gemini session, confirmed in ~/Downloads/myagents-logs-2026-04-14T17-28-53.txt:174).
    // Sync provider (useState initializer runs when currentProject is still undefined).
    // Re-arm providerInitRef to suppress the deferred provider-change effect (fires next render)
    // that would otherwise override the project-stored model with provider's primaryModel.
    const effectiveProvider = currentAgent?.providerId ?? currentProject.providerId;
    if (effectiveProvider) {
      setSelectedProviderId(effectiveProvider);
      providerInitRef.current = true;
    }
    // Skip model override when joining existing sidecar — adoption effect will set the correct model
    const effectiveModel = currentAgent?.model ?? currentProject.model;
    if (effectiveModel && configDispositionRef.current === 'push') {
      setSelectedModel(effectiveModel);
    }
    // #324 — same gating as model: builtin effort seeds from the agent default.
    // (External runtime seeding lives in the runtime-transition effect above.)
    if (!isExternalRuntime && configDispositionRef.current === 'push') {
      setReasoningEffort(currentAgent?.reasoningEffort ?? 'default');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time sync when project first loads
  }, [currentProject?.id, configPending, sessionId, sessionMeta, sessionSnapshotOwnsConfig]);

  // v0.1.69: session snapshot → local state (session-first per D7 Option C).
  // Also handles T11 reset-on-session-switch: when switching to an unlocked / IM session
  // (no snapshot), fall back to the agent's current config so stale local state from a
  // previously-loaded locked session doesn't bleed across. Runs on session load AND after
  // PATCH /sessions/:id. React bails on setState when target === current, so no render loop.
  useEffect(() => {
    if (!sessionMeta) return;  // Not loaded yet — keep mount-time defaults
    if (configDispositionRef.current !== 'push') return;  // Adoption effect handles it
    // Sticky guard: adoption may have already completed and cleared the flag
    // BEFORE this sessionMeta dispatch arrived (loadSession sets sessionMeta after
    // /api/session/config returns). Re-applying persisted snapshot here would
    // overwrite the just-adopted live sidecar config.
    if (adoptedSessionRef.current && adoptedSessionRef.current === sessionMeta.id) return;
    // Field-by-field merge remains for unlocked / live-follow sessions. Owned
    // sessions are source-owned by SessionMetadata: falling back to the current
    // Agent during the async metadata window reintroduces cross-session config
    // stomp (#395/#396).
    const snapshotRuntime = (sessionMeta.runtime as RuntimeType | undefined) ?? agentRuntime;
    const snapshotIsExternal = snapshotRuntime !== 'builtin';
    const snapshotIsManagedProvider = snapshotIsExternal
      && isManagedProviderSessionSnapshot(sessionMeta);
    const snapshotUsesProviderPicker = shouldSessionSnapshotUseProviderPicker({
      session: sessionMeta,
      runtime: snapshotRuntime,
    });
    const snapshotOwnsConfig = Boolean(sessionMeta.configSnapshotAt);
    const fallbackModel = snapshotIsExternal && !snapshotIsManagedProvider
      ? (currentAgent?.runtimeConfig as RuntimeConfig | undefined)?.model
      : currentAgent?.model;
    const rawModel = snapshotOwnsConfig ? sessionMeta.model : (sessionMeta.model ?? fallbackModel);
    const runtimeModelValue = snapshotIsExternal
      ? coerceExternalRuntimeModelForUi(rawModel, snapshotRuntime)
      : rawModel;
    const providerModelValue = snapshotIsManagedProvider
      ? managedProviderSnapshotModel(sessionMeta, rawModel)
      : rawModel;
    const fallbackMode = currentAgent?.permissionMode as string | undefined;
    const rawMode = snapshotIsExternal
      ? sessionMeta.permissionMode
      : (snapshotOwnsConfig ? sessionMeta.permissionMode : (sessionMeta.permissionMode ?? fallbackMode));
    const runtimePermissionValue = snapshotIsManagedProvider
      ? (projectManagedCodexPermissionToRuntime(rawMode) ?? 'auto-edit')
      : snapshotIsExternal
      ? coerceExternalRuntimePermissionForUi(rawMode, snapshotRuntime)
      : rawMode;
    const providerPermissionValue = snapshotIsManagedProvider
      ? managedCodexRuntimePermissionToProviderPermission(
        runtimePermissionValue ?? getDefaultRuntimePermissionMode(snapshotRuntime),
      )
      : rawMode;
    const providerId = snapshotOwnsConfig
      ? (snapshotIsManagedProvider
        ? managedProviderSnapshotProviderId(sessionMeta)
        : (
          isConcreteProviderRoute(sessionMeta.providerRoute)
            ? sessionMeta.providerRoute.providerId
            : resolveLegacyBuiltinSnapshotProviderId({
              snapshotProviderId: sessionMeta.providerId,
              snapshotModel: sessionMeta.model,
              selectedProviderId,
              providers,
              apiKeys,
              providerVerifyStatus,
            })
        ))
      : (sessionMeta.providerId ?? currentAgent?.providerId);
    const mcp = snapshotOwnsConfig ? sessionMeta.mcpEnabledServers : (sessionMeta.mcpEnabledServers ?? currentAgent?.mcpEnabledServers);
    const plugins = snapshotOwnsConfig
      ? (sessionMeta.enabledPluginIds ?? [])
      : (sessionMeta.enabledPluginIds ?? currentAgent?.enabledPluginIds ?? currentProject?.enabledPluginIds ?? []);
    const officialTools = snapshotOwnsConfig
      ? (sessionMeta.enabledOfficialToolIds ?? [])
      : normalizeOfficialToolIds(sessionMeta.enabledOfficialToolIds ?? currentAgent?.enabledOfficialToolIds ?? currentProject?.enabledOfficialToolIds ?? []);
    // #324 — snapshot effort wins over agent default; a persisted 'default'
    // is meaningful (session explicitly reverted) and flows through as-is.
    // UNCONDITIONAL set (`?? 'default'`, unlike model's `if (model)`): effort's
    // undefined has a defined meaning (= default), so a session without the
    // field must reset the picker — keeping the previous session's value here
    // is a cross-session leak (cross-review Critical).
    const fallbackEffort = snapshotIsExternal
      ? (currentAgent?.runtimeConfig as RuntimeConfig | undefined)?.reasoningEffort
      : currentAgent?.reasoningEffort;
    const snapEffort = snapshotOwnsConfig ? sessionMeta.reasoningEffort : (sessionMeta.reasoningEffort ?? fallbackEffort);
    if (snapshotOwnsConfig) {
      projectSyncedRef.current = true;
    }
    if (snapshotIsExternal) {
      setRuntimeModel(runtimeModelValue);
    }
    if (snapshotUsesProviderPicker && (snapshotOwnsConfig || providerModelValue)) {
      setSelectedModel(providerModelValue);
    }
    setReasoningEffort(
      (snapshotIsExternal
        ? coerceReasoningEffortForUi(snapEffort, snapshotRuntime)
        : snapEffort)
      ?? 'default',
    );
    if (snapshotIsExternal) {
      setRuntimePermissionMode(runtimePermissionValue ?? getDefaultRuntimePermissionMode(snapshotRuntime) ?? 'default');
    }
    if (snapshotUsesProviderPicker && (snapshotOwnsConfig || providerPermissionValue)) {
      setPermissionMode((providerPermissionValue as PermissionMode | undefined) ?? 'auto');
    }
    if (snapshotUsesProviderPicker && providerId) {
      setSelectedProviderId(providerId);
    } else if (!snapshotIsExternal && snapshotOwnsConfig && providers.length > 0) {
      setSelectedProviderId(undefined);
    }
    if (mcp) setWorkspaceMcpEnabled(mcp);
    setWorkspaceEnabledPlugins(plugins);
    setWorkspaceOfficialToolEnabled(normalizeOfficialToolIds(officialTools));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- currentAgent derived from config, listening to its identity would re-fire on unrelated agent changes
  }, [sessionMeta, configPending, selectedProviderId, providers]);

  // 若 selectedModel 不在当前 provider 的 models 中（如模型已被删除），回退到 primaryModel 并更新项目
  useEffect(() => {
    if (!currentProject || !currentProvider || configDispositionRef.current !== 'push') return;
    if (waitingForExistingSessionMeta) return;
    if (sessionSnapshotOwnsConfig) return;
    // #300: `currentProvider` here is the fallback provider, NOT the session's
    // pinned one — the pinned model legitimately isn't in its model list. Without
    // this guard the effect would "heal" the model to the fallback provider's
    // primaryModel AND persist it to project/agent, permanently corrupting the
    // user's choice. Leave it; the send guard surfaces the unavailability instead.
    if (pinnedProviderUnavailable) return;
    if (currentProvider.type === 'subscription' && !isRuntimeBackedProvider(currentProvider)) return;
    if (!Array.isArray(currentProvider.models) || currentProvider.models.length === 0) return;
    if (!selectedModel) return;
    const modelIds = currentProvider.models.map((m) => m.model);
    if (modelIds.includes(selectedModel)) return;
    const fallback = currentProvider.primaryModel;
    if (fallback) {
      setSelectedModel(fallback);
      void persistInputOptionChange({
        workspaceId: currentProject.id,
        agentId: currentProject.agentId ?? null,
        isExternalRuntime: false,
        currentRuntimeConfig: currentAgent?.runtimeConfig,
        currentProviderId: currentAgent?.providerId ?? currentProject.providerId,
        fields: { builtinModel: fallback },
        snapshotWriteMode: 'disabled',
        patchProject,
        patchAgentConfig,
        patchAgentProjectConfig,
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to specific sub-properties, not full object refs
  }, [currentProject?.id, currentProvider?.id, currentProvider?.models, currentProvider?.primaryModel, selectedModel, patchProject, pinnedProviderUnavailable, configPending, sessionSnapshotOwnsConfig, waitingForExistingSessionMeta, currentAgent?.runtimeConfig, currentAgent?.providerId, currentProject?.providerId]);

  // Unified model-push effect — single source of truth for `/api/model/set`.
  //
  // Replaces three formerly-independent push paths (mount-time builtin sync,
  // mount-time external sync, post-connect re-sync). The split was a race:
  // each effect re-derived `modelToPush` from `isExternalRuntime` independently,
  // and during the first render(s) `currentAgent` / `sessionRuntime` may both
  // still be loading → `isExternalRuntime` transiently `false` → the builtin
  // path posts `agent.primaryModel` (e.g. "Pro/moonshotai/Kimi-K2.6") even on
  // a session whose frozen runtime is `codex`, killing the just-prewarmed
  // external process via setExternalModel's "Stopping process for model change".
  //
  // Invariants this effect enforces:
  //   1. Session runtime is FROZEN (v0.1.69) — `currentRuntime` resolves to one
  //      value per Tab; we WAIT for runtime resolution before any push instead
  //      of speculatively filling.
  //   2. External runtime + user hasn't explicitly picked a model → DON'T push.
  //      Codex/Gemini fall back to their own default (gpt-5.5 / auto-gemini-3)
  //      when /api/model/set is never called. Pushing the builtin preset here
  //      is a category error: that preset belongs to the builtin code path that
  //      this session will never take.
  //   3. Builtin runtime → push `selectedModel` (agent's primaryModel).
  //   4. Idempotent: dedupe via ref so re-renders (sessionId upgrade, runtime
  //      model list arrival, runtimeModel state init) don't cause repeats.
  //      Reset on disconnect so a sidecar restart re-pushes — in-process model
  //      state lives only in the old sidecar process and dies with it.
  const lastPushedModelKeyRef = useRef<string | null>(null);
  useEffect(() => {
    // Sidecar gone → in-process model state cleared; allow re-push on reconnect.
    if (!isConnected) {
      lastPushedModelKeyRef.current = null;
      return;
    }
    // Wait until runtime is determinable. `currentRuntime` falls back to
    // 'builtin' when both async sources are pending; pushing in that window
    // risks the "wrong-runtime push kills correct-runtime prewarm" race.
    //
    // Known limitation: this gate accepts `currentAgent` as authoritative
    // before `sessionRuntime` arrives via SSE chat:system-init / REST
    // loadSession. For the vast majority of opens that's correct — the
    // sidecar was just spawned with `MYAGENTS_RUNTIME` derived from the
    // same `currentAgent.runtime` we read here. The narrow race window is:
    // user changes agent.runtime in another tab AFTER its sidecar spawned
    // with the old value but BEFORE this tab's first render. Tightening
    // to `sessionRuntime !== null` alone would close it but cost ~1s of
    // delay before the builtin model push reaches a fresh sidecar (SDK
    // pre-warm would init with self-resolved disk values instead of the
    // user-selected model). Trade-off chosen: optimize for the common
    // case; if the cross-tab race becomes a real reported issue, revisit.
    const runtimeResolved = sessionRuntime !== null || currentAgent !== undefined;
    if (!runtimeResolved) return;
    // IM Bot / cross-session join — adoption effect mirrors sidecar config
    // back into our state; we must NOT overwrite the live sidecar's model.
    //
    // Note: this effect intentionally does NOT use the snapshot-sync's
    // `adoptedSessionRef` sticky guard. That guard exists to prevent persisted
    // sessionMeta from clobbering the adopted live config — it must persist
    // beyond adoption-complete because the racing dispatch comes from outside
    // this component's control. THIS effect, by contrast, fires from the
    // user's own state changes (selectedModel/runtimeModel/permission). After
    // adoption clears the flag, the user's later edits SHOULD reach the
    // sidecar — applying a sticky guard here would silently swallow them.
    if (configDispositionRef.current !== 'push') return;
    // Existing-session restore: wait for REST metadata before pushing model
    // state. The local picker may still contain Agent defaults until
    // `sessionMeta` hydrates; pushing in that window overwrites the session's
    // owned sidecar config (#396).
    if (isSessionLoading) return;

    const modelToPush = isExternalRuntime ? runtimeModel : selectedModel;
    if (sessionSnapshotOwnsConfig) {
      const snapshotModel = isExternalRuntime
        ? coerceExternalRuntimeModelForUi(sessionMeta?.model, currentRuntime)
        : sessionMeta?.model;
      if (modelToPush !== snapshotModel) return;
    }
    // External + no explicit pick → defer to runtime's built-in default.
    if (!modelToPush) return;

    const dedupeKey = `${sessionId}::${modelToPush}`;
    if (lastPushedModelKeyRef.current === dedupeKey) return;
    lastPushedModelKeyRef.current = dedupeKey;

    apiPost('/api/model/set', { model: modelToPush }).catch(err => {
      console.error('[Chat] sync model failed:', err);
      lastPushedModelKeyRef.current = null; // allow retry
    });
  }, [isConnected, sessionRuntime, currentAgent, isExternalRuntime,
      runtimeModel, selectedModel, sessionId, apiPost, configPending, isSessionLoading,
      sessionSnapshotOwnsConfig, sessionMeta?.model, currentRuntime]);

  // #324 — NO mount-time effort-push effect, deliberately diverging from the
  // model-push effect above. The sidecar self-resolves effort at boot from the
  // same `snapshot ?? agent` chain the UI seeds from (initializeAgent /
  // switchToSession / external restore), so a mount push is redundant — and
  // actively harmful for Anthropic-protocol effort, where every value change
  // costs a subprocess respawn: the mount push fires with the agent-default
  // state BEFORE the snapshot sync lands, stomping the sidecar's correctly
  // restored value and then paying a second respawn to put it back
  // (cross-review: double-respawn churn + cross-session push amplification).
  // The explicit push lives in handleReasoningEffortChange (user intent only);
  // the chat-send payload remains the builtin safety net.

  // Adopt sidecar config when joining an existing sidecar (e.g. IM Bot session).
  // Reads the sidecar's current model and applies it to React state so the Tab
  // reflects the session's actual config instead of overwriting it with its own.
  const onSidecarConfigAdoptedRef = useRef(onSidecarConfigAdopted);
  onSidecarConfigAdoptedRef.current = onSidecarConfigAdopted;
  useEffect(() => {
    if (!isAdopt) return;
    // Capture the session this adoption is for; after the await, sessionId may
    // have advanced (user switched again), and we must not record adoption
    // ownership for a session whose live config we never actually read.
    const adoptingSessionId = sessionId;
    const isCurrentAdoption = () =>
      adoptingSessionId === sessionIdRef.current && configDispositionRef.current === 'adopt';

    const adoptConfig = async () => {
      try {
        const config = await apiGet<{
          success: boolean;
          runtime?: RuntimeType;
          model?: string | null;
          mcpServerIds?: string[] | null;
          enabledOfficialToolIds?: OfficialToolId[] | null;
          permissionMode?: string | null;
          providerId?: string | null;
          reasoningEffort?: string | null;
        }>('/api/session/config');
        if (config.success) {
          if (!isCurrentAdoption()) return;
          // Server now always returns `runtime`; the `?? currentRuntime` is a
          // backward-compat hedge for older sidecars that pre-date the field.
          // Keep the fallback so a stale-binary sidecar doesn't crash adoption.
          const sidecarRuntime = config.runtime ?? currentRuntime;
          const sidecarIsExternal = sidecarRuntime !== 'builtin';

          if (config.model) {
            if (sidecarIsExternal) {
              setRuntimeModel(config.model);
            } else {
              setSelectedModel(config.model);
            }
          }
          if (config.permissionMode) {
            if (sidecarIsExternal) {
              setRuntimePermissionMode(config.permissionMode);
            } else {
              setPermissionMode(config.permissionMode as PermissionMode);
            }
          }
          const adoptedProviderId = resolveAdoptedBuiltinProviderId(sidecarIsExternal, config.providerId);
          if (adoptedProviderId !== undefined) {
            setSelectedProviderId(adoptedProviderId);
          }
          if (Array.isArray(config.mcpServerIds)) {
            setWorkspaceMcpEnabled(config.mcpServerIds);
          }
          if (Array.isArray(config.enabledOfficialToolIds)) {
            setWorkspaceOfficialToolEnabled(normalizeOfficialToolIds(config.enabledOfficialToolIds));
          }
          // #324 — server returns 'default' when unset, so truthiness works.
          if (config.reasoningEffort) {
            setReasoningEffort(config.reasoningEffort);
          }
          if (adoptingSessionId) {
            adoptedSessionRef.current = adoptingSessionId;
          }
          console.log('[Chat] Adopted sidecar config:', {
            runtime: sidecarRuntime,
            model: config.model,
            providerId: config.providerId,
            permissionMode: config.permissionMode,
            mcpServerIds: config.mcpServerIds,
            enabledOfficialToolIds: config.enabledOfficialToolIds,
          });
        }
      } catch (err) {
        console.error('[Chat] Failed to read sidecar config:', err);
      } finally {
        // Clear the flag whether adoption succeeded or failed
        if (isCurrentAdoption()) {
          onSidecarConfigAdoptedRef.current?.();
        }
      }
    };

    adoptConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time adoption when disposition becomes 'adopt'
  }, [isAdopt]);

  const chatScrollModel = useChatScrollModel({
    historyMessages,
    streamingMessage,
    firstItemIndex,
    sessionId,
  });
  const rewindableUserMessageIds = useMemo(() => {
    const ids = new Set<string>();
    for (const message of historyMessages) {
      const rootUserMessageId = message.runtimeTurnAnchor?.rootUserMessageId;
      if (message.role === 'assistant' && rootUserMessageId) ids.add(rootUserMessageId);
    }
    return ids;
  }, [historyMessages]);
  const chatScrollController = useChatScrollController({
    messages: chatScrollModel.data,
    isActive,
    windowPresentation,
    sessionId,
    rootRef: chatContentRef,
  });
  const {
    virtuosoRef,
    scrollerRef,
    followEnabledRef,
    scrollToBottom,
    pauseAutoScroll,
    handleAtBottomChange,
    attachScroller,
    onViewportAdmissionChanged,
    onItemsRendered,
    isViewportRecoveryFenced,
    scrollToMessage,
    scrollToTool,
    captureAnchor,
    restoreAnchorAfterNextCommit,
    onRowLayoutChanged,
  } = chatScrollController;
  const handleInputOverlayHeightChange = useCallback((height: number) => {
    setInputOverlayHeight(prev => Math.abs(prev - height) < 1 ? prev : Math.ceil(height));
  }, []);

  // ── In-page text finder (Cmd/Ctrl+F) ──
  // Scope: the full message array — virtualized rows are counted from
  // messages[] and reached via ChatScrollController on navigation.
  // Full cross-session search still lives in the global search engine.
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const chatSearch = useChatSearch({
    scrollerRef: scrollerRef as React.RefObject<HTMLElement | null>,
    messages: chatScrollModel.data,
    scrollToMessage,
    active: chatSearchOpen,
  });

  const handleLoadOlderMessages = useCallback(() => {
    void loadOlderMessages({
      beforePrepend: () => {
        const anchor = captureAnchor('prepend-older');
        if (anchor) {
          restoreAnchorAfterNextCommit(anchor, { behavior: 'auto' });
        }
      },
    });
  }, [captureAnchor, loadOlderMessages, restoreAnchorAfterNextCommit]);
  const chatSearchSetQueryRef = useRef(chatSearch.setQuery);
  chatSearchSetQueryRef.current = chatSearch.setQuery;
  const closeChatSearch = useCallback(() => {
    setChatSearchOpen(false);
    chatSearchSetQueryRef.current('');
  }, []);
  // Esc / Cmd+W closes the panel first. z-index 100 sits between the split
  // panel (0) and overlay layers (200+), matching the shared overlay hierarchy.
  useCloseLayer(() => {
    if (!chatSearchOpen) return false;
    closeChatSearch();
    return true;
  }, 100);
  useCloseLayer(() => {
    if (!goalEditOpen) return false;
    setGoalEditOpen(false);
    return true;
  }, 200);
  // Register Cmd/Ctrl+F only while this Tab is active so background tabs don't
  // steal the shortcut and open phantom panels.
  useEffect(() => {
    if (!isActive) return;
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== 'f') return;
      event.preventDefault();
      if (!isHighlightApiSupported()) {
        toast.error(t('shell.toasts.searchUnsupported'));
        return;
      }
      setChatSearchOpen(true);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isActive, toast, t]);
  // When the tab becomes inactive, close the panel so a) the global
  // CSS.highlights registry doesn't retain stale Range objects from this tab,
  // and b) switching back shows a fresh state rather than a rotting counter.
  useEffect(() => {
    if (!isActive && chatSearchOpen) closeChatSearch();
  }, [isActive, chatSearchOpen, closeChatSearch]);

  // Auto-focus input when Tab becomes active
  useEffect(() => {
    if (isActive && inputRef.current) {
      // Small delay to ensure DOM is ready
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [isActive]);

  // Refresh config when the Tab becomes active. ConfigProvider reloads the
  // authoritative disk snapshot; the existing MCP/capability effects consume
  // that state. A second imperative MCP push here raced explicit user edits
  // and duplicated the same synchronization path.
  useEffect(() => {
    const wasInactive = !prevIsActiveRef.current;
    prevIsActiveRef.current = isActive;

    if (!wasInactive || !isActive) return;
    void refreshProviderData().catch((error) => {
      console.error('[Chat] Failed to refresh config on tab activate:', error);
    });

    // One shared refresh trigger reloads agents, skills/commands and the
    // file tree. Calling the loaders here as well made every activation do the
    // same work twice.
    setWorkspaceRefreshTrigger(prev => prev + 1);
  }, [isActive, refreshProviderData]);

  // Persisted capability mutations invalidate every mounted Tab snapshot.
  // Note: WorkspaceConfigPanel has its own event listener for internalRefreshKey
  useEffect(() => {
    const handleCapabilitiesChanged = () => {
      setWorkspaceRefreshTrigger(k => k + 1);
    };
    window.addEventListener(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED, handleCapabilitiesChanged);
    return () => window.removeEventListener(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED, handleCapabilitiesChanged);
  }, []);

  // Workspace refresh on sidecar reconnect (mid-session crash recovery, Rust
  // health-monitor restart, `recoverSessionSidecar`). Bumps the trigger that
  // re-runs `loadAndSyncAgents` / `loadSkillsAndCommands` / DirectoryPanel.
  //
  // Model re-push after reconnect is handled by the unified model-push effect
  // above — its `lastPushedModelKeyRef` is cleared on `isConnected=false`, so
  // the next true reading naturally re-pushes the current runtime's model.
  useEffect(() => {
    const wasConnected = prevIsConnectedRef.current;
    prevIsConnectedRef.current = isConnected;
    if (!isConnected) {
      // These fingerprints describe in-process Sidecar state and must die with
      // that process so reconnect naturally rehydrates the replacement.
      lastSessionConfigPushRef.current = { mcp: null, agents: null };
      return;
    }
    if (!wasConnected && isConnected) {
      setWorkspaceRefreshTrigger(k => k + 1);
    }
  }, [isConnected]);

  // Handle provider change with analytics tracking.
  // targetModel: when provided, use this model instead of the provider's primaryModel
  // (avoids useEffect race when user picks a specific model from a different provider).
  const handleProviderChange = useCallback(async (providerId: string, targetModel?: string) => {
    if (guardCronConfigMutation()) return;
    // Skip if selecting the same provider (compare against local state, not shared project)
    if (effectiveSelectedProviderId === providerId) {
      // Provider unchanged but caller passed a specific model — treat as model change.
      // Same dual-write policy as handleModelChange (PRD §4.3 rule 2).
      if (targetModel) {
        if (targetModel === selectedModel) return;
        const currentProviderHistoryEnv = currentProviderForHistory
          ? toProviderHistoryEnv(currentProviderForHistory, selectedModel)
          : undefined;
        const nextIntent = buildProviderExecutionIntent(currentProviderForHistory, targetModel);
        const canResumeProviderHistory = canResumeProviderHistoryForSwitch({
          currentIntent: currentProviderExecutionIntent,
          nextIntent,
          currentProviderEnv: currentProviderHistoryEnv,
          nextProviderEnv: currentProviderForHistory
            ? toProviderHistoryEnv(currentProviderForHistory, targetModel)
            : undefined,
          legacyCurrentProviderUnknown: builtinSnapshotProviderHistoryUnknown,
        });
        if (!canResumeProviderHistory && (messagesRef.current.length > 0 || isRuntimeBackedIntent(currentProviderExecutionIntent) || isRuntimeBackedIntent(nextIntent))) {
          setPendingProviderSwitch({ providerId, model: targetModel });
          return;
        }
        const persisted = await persistTabConfigChange({
          ...(nextIntent?.kind === 'runtime-backed-provider'
            ? { runtimeBackedProviderSelection: nextIntent }
            : {
                builtinSelection: { providerId, model: targetModel },
                builtinProviderEnvPolicy: 'preserve-provider-env' as const,
              }),
          permissionMode: effectivePermissionMode,
        });
        if (!persisted) return;
        setSelectedModel(targetModel);
        if (nextIntent?.kind === 'runtime-backed-provider') {
          setRuntimeModel(nextIntent.model);
        }
      }
      return;
    }

    // Track provider_switch event
    track('provider_switch', { provider_id: providerId });

    const newProvider = providers.find(p => p.id === providerId);
    const model = targetModel ?? newProvider?.primaryModel;
    const nextIntent = buildProviderExecutionIntent(newProvider, model);
    const canResumeProviderHistory = canResumeProviderHistoryForSwitch({
      currentIntent: currentProviderExecutionIntent,
      nextIntent,
      currentProviderEnv: currentProviderForHistory
        ? toProviderHistoryEnv(currentProviderForHistory, selectedModel)
        : undefined,
      nextProviderEnv: toProviderHistoryEnv(newProvider, model),
      legacyCurrentProviderUnknown: builtinSnapshotProviderHistoryUnknown,
    });

    // Existing SDK transcripts only need a new tab when crossing provider-history
    // families. Ordinary third-party providers share a portable protocol family;
    // entries in providerHistory's isolated set intentionally do not.
    if (!canResumeProviderHistory && (messagesRef.current.length > 0 || isRuntimeBackedIntent(currentProviderExecutionIntent) || isRuntimeBackedIntent(nextIntent))) {
      setPendingProviderSwitch({ providerId, model });
      return;  // Don't update state — dialog will handle it
    }

    // Write back: owned session snapshots this choice locally so the current session
    // keeps using it; agent/project always gets written so FUTURE new sessions inherit
    // the user's latest preference (PRD v0.1.69 §4.3 rule 2 dual-write).
    if (!model) return;
    const persisted = await persistTabConfigChange({
      ...(nextIntent?.kind === 'runtime-backed-provider'
        ? { runtimeBackedProviderSelection: nextIntent }
        : {
            builtinSelection: { providerId, model },
            builtinProviderEnvPolicy: 'clear-stale-provider-env' as const,
          }),
      permissionMode: effectivePermissionMode,
    });
    if (!persisted) return;

    // Update local state only after the snapshot write succeeds. The model-push
    // effect is state-driven, so this prevents pushing a model that failed to
    // persist as the session authority.
    setSelectedProviderId(providerId);
    if (model) {
      setSelectedModel(model);
      if (nextIntent?.kind === 'runtime-backed-provider') {
        setRuntimeModel(nextIntent.model);
      }
    }

    // Suppress the deferred provider-change useEffect — we've already set the correct model
    providerInitRef.current = true;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- narrowed deps; messagesRef avoids dep on messages array
  }, [
    effectiveSelectedProviderId,
    selectedModel,
    providers,
    currentProviderForHistory?.id,
    currentProviderForHistory?.type,
    currentProviderForHistory?.config.baseUrl,
    currentProviderForHistory?.apiProtocol,
    currentProviderExecutionIntent,
    builtinSnapshotProviderHistoryUnknown,
    effectivePermissionMode,
    persistTabConfigChange,
    guardCronConfigMutation,
  ]);

  const handleBuiltinModelSelect = useCallback(async (selection: BuiltinModelSelection) => {
    await handleProviderChange(selection.providerId, selection.model);
  }, [handleProviderChange]);

  // Handle model change with analytics tracking.
  // Dual-write per PRD v0.1.69 §4.3 rule 2 "写 Session + 向上写 Agent": owned sessions
  // snapshot the new model locally so this session persists the choice; project + agent
  // also get written so FUTURE new sessions / Bots / Crons inherit the latest preference.
  const handleModelChange = useCallback(async (model: string) => {
    if (guardCronConfigMutation()) return;
    // Skip if selecting the same model
    if (selectedModel === model) {
      return;
    }

    // Track model_switch event
    track('model_switch', { model });

    const nextIntent = buildProviderExecutionIntent(currentProviderForHistory, model);
    const canResumeProviderHistory = canResumeProviderHistoryForSwitch({
      currentIntent: currentProviderExecutionIntent,
      nextIntent,
      currentProviderEnv: currentProviderForHistory
        ? toProviderHistoryEnv(currentProviderForHistory, selectedModel)
        : undefined,
      nextProviderEnv: currentProviderForHistory
        ? toProviderHistoryEnv(currentProviderForHistory, model)
        : undefined,
      legacyCurrentProviderUnknown: builtinSnapshotProviderHistoryUnknown,
    });
    const currentProviderId = effectiveSelectedProviderId ?? currentProvider?.id;
    if (!canResumeProviderHistory && (messagesRef.current.length > 0 || isRuntimeBackedIntent(currentProviderExecutionIntent) || isRuntimeBackedIntent(nextIntent)) && currentProviderId) {
      setPendingProviderSwitch({ providerId: currentProviderId, model });
      return;
    }

    if (!currentProviderId) return;
    const persisted = await persistTabConfigChange({
      ...(nextIntent?.kind === 'runtime-backed-provider'
        ? { runtimeBackedProviderSelection: nextIntent }
        : {
            builtinSelection: { providerId: currentProviderId, model },
            builtinProviderEnvPolicy: 'preserve-provider-env' as const,
          }),
      permissionMode: effectivePermissionMode,
    });
    if (!persisted) return;
    setSelectedModel(model);
    if (nextIntent?.kind === 'runtime-backed-provider') {
      setRuntimeModel(nextIntent.model);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- narrowed deps; currentProvider fields cover toProviderHistoryEnv inputs
  }, [
    selectedModel,
    currentProviderForHistory?.id,
    currentProviderForHistory?.type,
    currentProviderForHistory?.config.baseUrl,
    currentProviderForHistory?.apiProtocol,
    currentProviderExecutionIntent,
    effectiveSelectedProviderId,
    currentProvider?.id,
    builtinSnapshotProviderHistoryUnknown,
    effectivePermissionMode,
    persistTabConfigChange,
    guardCronConfigMutation,
  ]);

  // External-runtime model change. Same dual-write policy as builtin
  // `handleModelChange`, routed through `runtimeModel` so the helper writes
  // to `agent.runtimeConfig.model` rather than `agent.model`. Pre-PRD-0.2.7
  // chat would only call `setRuntimeModel` (UI state), so the user's choice
  // was lost on next session — matching launcher's persist behavior closes
  // that gap.
  const handleRuntimeModelChange = useCallback(async (model: string) => {
    if (guardCronConfigMutation()) return;
    if (runtimeModel === model) return;
    const persisted = await persistTabConfigChange({ runtimeModel: model });
    if (!persisted) return;
    setRuntimeModel(model);
  }, [runtimeModel, persistTabConfigChange, guardCronConfigMutation]);

  // #324 — reasoning effort change. Same dual-write policy as handleModelChange
  // (snapshot + agent; live sidecar apply rides the effort-push effect, and the
  // send payload is the safety net). One handler for both runtimes — the
  // persist helper routes the storage location on isExternalRuntime.
  // #324 — explicit change made while disposition is 'pending' is REMEMBERED
  // and flushed once the disposition resolves (effect below). Builtin has the
  // send-payload safety net, but external runtimes apply effort only via the
  // push endpoint — dropping the pending-window push would silently lose the
  // user's choice for the live external process (cross-review Critical).
  const deferredEffortPushRef = useRef<string | null>(null);
  const pushReasoningEffort = useCallback((effort: string) => {
    apiPost('/api/reasoning-effort/set', { effort }).catch(err => {
      console.error('[Chat] push reasoning effort failed (send payload will correct at next message):', err);
    });
  }, [apiPost]);
  useEffect(() => {
    if (configPending) return;
    const deferred = deferredEffortPushRef.current;
    if (deferred === null) return;
    deferredEffortPushRef.current = null;
    pushReasoningEffort(deferred);
  }, [configPending, pushReasoningEffort]);

  const handleReasoningEffortChange = useCallback(async (effort: string) => {
    if (guardCronConfigMutation()) return;
    if (reasoningEffort === effort) return;
    track('reasoning_effort_switch', { effort });
    const persisted = await persistTabConfigChange({ reasoningEffort: effort });
    if (!persisted) return;
    setReasoningEffort(effort);
    // Live push on explicit user intent only (see the no-mount-push note by
    // the model-push effect). defer-while-pending: while the sidecar
    // disposition is unresolved we queue the push (flushed by the effect
    // above); push/adopt both push immediately — user intent.
    if (configDispositionRef.current === 'pending') {
      deferredEffortPushRef.current = effort;
    } else {
      pushReasoningEffort(effort);
    }
  }, [reasoningEffort, persistTabConfigChange, pushReasoningEffort, guardCronConfigMutation]);

  // #324 — clamp effort on provider-protocol change. An OpenAI-only level
  // (e.g. 'minimal') left selected after switching to an Anthropic-protocol
  // provider would keep DISPLAYING as active while the wire silently sends
  // the SDK default 'high' (the query-time isSdkEffortLevel gate). Reset to
  // 'default' (persisted + pushed via the handler) so UI and wire agree.
  useEffect(() => {
    if (isExternalRuntime || !currentProvider) return;
    if (configDispositionRef.current !== 'push') return;
    if (reasoningEffort === 'default') return;
    const choices = reasoningEffortChoices(
      'builtin',
      currentProvider.apiProtocol,
      currentProvider.id,
      selectedModel,
    );
    if (choices && !choices.includes(reasoningEffort)) {
      void handleReasoningEffortChange('default');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- narrowed to protocol-relevant provider fields
  }, [isExternalRuntime, currentProvider?.id, currentProvider?.apiProtocol, selectedModel, reasoningEffort, handleReasoningEffortChange]);

  // Handle permission mode change — same dual-write policy as handleModelChange.
  const handlePermissionModeChange = useCallback(async (mode: PermissionMode) => {
    // Lock in the user's explicit choice: mark the project as synced so
    // `effectivePermissionMode` (#244) trusts `permissionMode` from here on
    // instead of re-deriving from config — even if the one-time project-sync
    // effect hasn't fired yet (user toggled before config finished loading).
    const persisted = await persistTabConfigChange({ permissionMode: mode });
    if (!persisted) return;
    projectSyncedRef.current = true;
    if (isExternalRuntime) {
      setRuntimePermissionMode(mode);
    } else {
      setPermissionMode(mode);
    }
  }, [isExternalRuntime, persistTabConfigChange]);

  const handleInputPermissionModeChange = useCallback(async (mode: PermissionMode) => {
    if (guardCronConfigMutation()) return;
    if (!managedProviderRuntimeActive) {
      await handlePermissionModeChange(mode);
      return;
    }

    if (currentProviderExecutionIntent?.kind !== 'runtime-backed-provider') return;
    const runtimeMode = runtimeBackedProviderPermissionMode(
      currentProviderExecutionIntent,
      mode,
    ) ?? 'auto-edit';
    const persisted = await persistTabConfigChange({
      runtimeBackedProviderSelection: currentProviderExecutionIntent,
      permissionMode: mode,
    });
    if (!persisted) return;
    projectSyncedRef.current = true;
    setPermissionMode(mode);
    setRuntimePermissionMode(runtimeMode);
  }, [
    managedProviderRuntimeActive,
    handlePermissionModeChange,
    currentProviderExecutionIntent,
    persistTabConfigChange,
    guardCronConfigMutation,
  ]);

  const inputChromePermissionMode = managedProviderRuntimeActive
    ? permissionMode
    : effectivePermissionMode;

  // Cross-runtime SDK protection: only fires when the multiAgentRuntime feature
  // gate is OFF but the session was created by an external runtime (Codex/CC/
  // Gemini). In that case the backend would try to run the built-in SDK against
  // an external-runtime session → "No conversation found" crash, so we MUST block
  // sending and route the user through fork-to-new-session instead.
  //
  // Normal agent-runtime drift does NOT trigger this (per v0.1.69 self-contained
  // principle): when the feature gate is on, existing sessions keep their frozen
  // runtime and the backend routes by sessionId to the correct Sidecar — no fork
  // needed. The previous formula `sessionRuntime !== currentRuntime` was wrong
  // because it compared session-actual against agent-preference, which forced an
  // unnecessary fork every time the user changed agent.runtime in another tab.
  const isCrossRuntimeSession = shouldBlockSendForLabsDisabledExternalRuntime({
    sessionRuntime,
    sessionRuntimeSource: currentRuntimeSource,
    multiAgentRuntimeEnabled,
  });
  const [pendingCrossRuntimeMessage, setPendingCrossRuntimeMessage] = useState<{
    text: string;
    images: ImageAttachment[];
  } | null>(null);

  // PERFORMANCE: text is now passed from SimpleChatInput (which manages its own state)
  // This avoids re-rendering Chat on every keystroke.
  // Returns false to signal SimpleChatInput NOT to clear the input (e.g., on rejection).
  const handleSendMessage = useCallback(async (text: string, images?: ImageAttachment[]): Promise<boolean | void> => {
    // Must have content and not be in stopping state
    if (isSessionLoading || (!text && (!images || images.length === 0)) || sessionState === 'stopping') {
      return false;
    }

    // Cross-runtime guard: session was created by external runtime (Codex/CC) but
    // current runtime is builtin. Show confirm dialog instead of sending directly.
    if (isCrossRuntimeSession) {
      setPendingCrossRuntimeMessage({ text, images: images ?? [] });
      return false;  // Signal SimpleChatInput NOT to clear the input
    }

    // #300: the session pinned a provider that is no longer available (missing
    // API key / disabled / deleted). resolveProvider would silently fall back to a
    // DIFFERENT provider and bill it (the reported 402 from the very provider the
    // user switched away from). Refuse to send and tell the user how to fix it,
    // instead of routing to the wrong provider and resetting their model.
    if (pinnedProviderUnavailable) {
      showPinnedProviderUnavailableToast();
      return false;
    }
    if (builtinSnapshotProviderSelectionIncomplete) {
      showSnapshotProviderIncompleteToast();
      return false;
    }
    if (!isExternalRuntime && isRuntimeBackedProvider(currentProviderRef.current)) {
      toastRef.current.warning(t('shell.toasts.codexSubscriptionNeedsSession'));
      return false;
    }

    // Queue limit: max 5 queued messages.
    // (issue #174) 'starting' is also busy — SDK subprocess is launching but
    // hasn't sent system_init yet. Including it prevents the queue cap from
    // being bypassed while the user keeps typing during the startup window.
    const isAiBusy = isLoading || sessionState === 'running' || sessionState === 'starting';
    if (isAiBusy && queuedMessages.length >= 5) {
      toastRef.current.warning(t('shell.toasts.queueLimit'));
      return false;
    }

    // Scroll to bottom immediately so user sees their query
    // This also re-enables auto-scroll if user had scrolled up
    scrollToBottom();

    const pendingGoalStart = goalDraftConfigRef.current !== null
      || (cronStateRef.current.isEnabled
        && !cronStateRef.current.task
        && cronStateRef.current.config?.taskKind === 'goal');

    // Goal creation is a fast state mutation, not an AI turn. Keep the global
    // loading surface idle until the original query is sent through /chat/send.
    if (!isAiBusy && !pendingGoalStart) {
      setIsLoading(true);
    }

    // Note: User message is added by SSE replay from backend
    // TabProvider.sendMessage passes attachments which will be merged with the replay message

    try {
      // Build provider env from current provider config (read from refs for stability)
      // For subscription type, don't send providerEnv (use SDK's default auth)
      const providerRoute = buildBuiltinProviderRoute(currentProviderRef.current, effectiveModel);
      const providerEnv = providerRoute ? undefined : buildProviderEnv(currentProviderRef.current);

      // If cron mode is enabled and task hasn't started yet, start the task
      const cron = cronStateRef.current;
      if (goalDraftConfigRef.current) {
        const startedKind = await startScheduledTask(text);
        if (startedKind !== 'goal') return;
        if (!isAiBusy) setIsLoading(true);
      } else if (cron.isEnabled && !cron.task && cron.config) {
        setStoppedCronRecovery(null);
        if (cron.config.taskKind === 'cron' && cron.config.executionTarget === 'new_task') {
          // ── New standalone task: create independently, show card in chat ──
          try {
            const sessionId = `cron-standalone-${crypto.randomUUID()}`;
            const cronExecution = projectTaskExecutionOverrides({
              providers,
              runtime: cron.config.runtime,
              providerId: cron.config.providerId,
              model: cron.config.model,
              runtimeConfig: cron.config.runtimeConfig,
            });
            const cronPermissionMode = coerceRuntimeBirthPermissionMode(
              cron.config.permissionMode,
              cronExecution.runtime ?? currentRuntime,
            );
            const task = await createCronTask({
              workspacePath: agentDir,
              sessionId,
              prompt: text,
              intervalMinutes: cron.config.intervalMinutes,
              endConditions: cron.config.endConditions,
              runMode: 'new_session',
              notifyEnabled: cron.config.notifyEnabled,
              model: cronExecution.model,
              permissionMode: cronPermissionMode,
              providerId: cronExecution.providerId,
              runtime: cronExecution.runtime,
              runtimeConfig: cronExecution.runtimeConfig,
              schedule: cron.config.schedule,
              delivery: cron.config.delivery,
            });
            await startCronTaskIpc(task.id);
            setCronCardTask(task);
            disableCronMode();
            setIsLoading(false);
            toastRef.current?.success(t('shell.toasts.cronTaskCreated'));
          } catch (err) {
            disableCronMode();
            setIsLoading(false);
            toastRef.current?.error(t('shell.toasts.createFailedWithError', { error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }
        // ── Current session: legacy cron behavior ──
        const startedKind = await startScheduledTask(text);
        if (startedKind !== 'goal') return;
        if (!isAiBusy) setIsLoading(true);
        // A Goal is Session state. Its first user query still follows the
        // ordinary chat path so the visible tail produces the normal bubble
        // and all streaming blocks arrive live.
      }

      // sendMessage is fire-and-forget (returns true immediately for optimistic UI).
      // Error handling is done inside sendMessage's .then()/.catch() in TabProvider.
      // Use effective model/permission (runtime-aware) — not the builtin values
      await sendMessage(text, images, effectivePermissionMode, effectiveModel, isExternalRuntime ? undefined : providerEnv, undefined,
        // #324 — builtin only: external runtimes apply effort via /api/reasoning-effort/set
        isExternalRuntime ? undefined : reasoningEffort,
        isExternalRuntime ? undefined : providerRoute);
    } catch (error) {
      const errorMessage = {
        id: `error-${crypto.randomUUID()}`,
        role: 'assistant' as const,
        content: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
        timestamp: new Date()
      };
      setMessages((prev) => [...prev, errorMessage]);
      // Reset both isLoading and sessionState to ensure UI recovers
      if (!isAiBusy) {
        setIsLoading(false);
        setSessionState('idle');
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- toastRef/currentProviderRef/apiKeysRef/cronStateRef are refs (stable); scrollToBottom/setMessages/setIsLoading/setSessionState are stable
  }, [sessionState, isSessionLoading, isLoading, queuedMessages.length, startScheduledTask, sendMessage, effectivePermissionMode, effectiveModel, reasoningEffort, isExternalRuntime, isCrossRuntimeSession, scrollToBottom, pinnedProviderUnavailable, builtinSnapshotProviderSelectionIncomplete, showPinnedProviderUnavailableToast, showSnapshotProviderIncompleteToast, t]);

  // Ref-stabilize handleSendMessage for handleRetry (avoids frequent re-creation)
  const handleSendMessageRef = useRef(handleSendMessage);
  handleSendMessageRef.current = handleSendMessage;

  // Triggered from the SystemPromptsPanel empty state ("智能生成" card). Closes the
  // workspace settings overlay and dispatches `/init` to the current Tab so the user
  // sees the Claude Code SDK builtin slash command run in the chat surface.
  const handleRequestInitFromSettings = useCallback(() => {
    setShowWorkspaceConfig(false);
    setWorkspaceConfigInitialTab(undefined);
    void handleSendMessageRef.current('/init');
  }, []);

  // Cancel a queued message and restore its text (and images if any) to the input box
  const handleCancelQueued = useCallback(async (queueId: string) => {
    // Snapshot the queued message info before it's removed (for image restore)
    const queuedMsg = queuedMessages.find(q => q.queueId === queueId);
    const cancelledText = await cancelQueuedMessage(queueId);
    if (cancelledText) {
      chatInputRef.current?.setValue(cancelledText);
      // Restore images if the queued message had them
      // Note: We only have preview data URLs (not File blobs) to avoid memory leaks,
      // so we reconstruct ImageAttachment with a minimal placeholder File.
      if (queuedMsg?.images && queuedMsg.images.length > 0) {
        const restoredImages: ImageAttachment[] = queuedMsg.images.map(img => ({
          id: img.id,
          file: new File([], img.name, { type: img.mimeType || 'application/octet-stream' }), // Placeholder — original blob is gone
          preview: img.preview,
          source: img.source,
          name: img.name,
          mimeType: img.mimeType,
          sizeBytes: img.sizeBytes,
          relativePath: img.relativePath,
        }));
        chatInputRef.current?.setImages(restoredImages);
      }
    }
  }, [cancelQueuedMessage, queuedMessages]);

  // Force-execute a queued message (interrupt current AI response)
  const handleForceExecuteQueued = useCallback(async (queueId: string) => {
    await forceExecuteQueuedMessage(queueId);
  }, [forceExecuteQueuedMessage]);

  // Stable callbacks for SimpleChatInput (extracted from inline arrows to enable memo)
  const handleStop = useCallback(async () => {
    try {
      const goal = sessionGoalStateRef.current.goal;
      const pendingGoalDraft = !goal
        && sessionGoalStateRef.current.isStarting
        && (goalDraftConfigRef.current !== null
          || cronStateRef.current.config?.taskKind === 'goal');
      if (pendingGoalDraft) {
        // The first Goal create may still be round-tripping through Rust, so
        // there is no Goal snapshot to pause yet. Treat the red Stop button as
        // an explicit draft cancel; useSessionGoal will terminalize any late
        // create response instead of letting it resurrect the Goal.
        cancelPendingGoalStart();
        disableCronMode();
        return;
      }
      const stopped = await stopResponse();
      if (stopped.success && stopped.alreadyStopped && goal?.status === 'active') {
        await pauseGoal();
      }
    } catch (error) {
      console.error('[Chat] Failed to stop message:', error);
    }
  }, [cancelPendingGoalStart, disableCronMode, pauseGoal, stopResponse]);

  const handleOpenAgentSettings = useCallback(() => setShowWorkspaceConfig(true), []);

  // Provider switch on non-empty builtin history: keep the current tab unchanged,
  // save the new provider as workspace default, and open a fresh session in a new tab.
  const [pendingProviderSwitch, setPendingProviderSwitch] = useState<{
    providerId: string;
    model?: string;
  } | null>(null);

  // Runtime change — show confirm dialog, then open new Tab (v0.1.59)
  const [pendingRuntimeChange, setPendingRuntimeChange] = useState<RuntimeType | null>(null);

  const providerSwitchDialogCopy = useMemo(() => {
    if (!pendingProviderSwitch) return null;
    const targetProvider = providers.find(p => p.id === pendingProviderSwitch.providerId);
    const targetModel = pendingProviderSwitch.model ?? targetProvider?.primaryModel;
    const targetIntent = buildProviderExecutionIntent(targetProvider, targetModel);
    return buildProviderSwitchDialogCopy(t, {
      currentProvider: currentProviderForHistory ?? currentProvider,
      targetProvider,
      currentIntent: currentProviderExecutionIntent,
      targetIntent,
      targetModel,
      targetProviderId: pendingProviderSwitch.providerId,
    });
  }, [
    pendingProviderSwitch,
    providers,
    currentProviderForHistory,
    currentProvider,
    currentProviderExecutionIntent,
    t,
  ]);

  const handleRuntimeChange = useCallback((runtime: RuntimeType) => {
    if (guardCronConfigMutation()) return;
    if (!currentAgent || runtime === currentRuntime) return;
    setPendingRuntimeChange(runtime);
  }, [currentAgent, currentRuntime, guardCronConfigMutation]);

  const transferBindingToForkedSession = useCallback(async (channel: ChannelSurface, targetSessionId: string) => {
    if (!agentDir) {
      throw new Error('Missing workspace path for channel binding transfer');
    }
    const { handoverSessionToChannel } = await import('@/api/sessionHandoverClient');
    const result = await handoverSessionToChannel({
      sessionId: targetSessionId,
      agentId: channel.agentId,
      channelId: channel.channelId,
      sessionKey: channel.sessionKey,
      workspacePath: agentDir,
    });
    if (!result.ok) {
      throw new Error('Channel binding transfer failed');
    }
    if (!result.notified) {
      toastRef.current.warning(t('shell.toasts.channelNotificationFailed'));
    }
  }, [agentDir, t]);

  const deleteUnopenedForkSession = useCallback(async (targetSessionId: string): Promise<boolean> => {
    try {
      const { deleteSession } = await import('@/api/sessionClient');
      const result = await deleteSession(targetSessionId);
      return result.deleted || result.reason === 'not-found';
    } catch (err) {
      console.warn('[chat] Failed to delete unopened fork session:', err);
      return false;
    }
  }, []);

  const confirmRuntimeChange = useCallback(async () => {
    if (guardCronConfigMutation()) {
      setPendingRuntimeChange(null);
      return;
    }
    const runtime = pendingRuntimeChange;
    setPendingRuntimeChange(null);
    if (!runtime || !currentAgent) return;
    // Unified Tab-UI dual-write policy (matches handleModelChange /
    // handlePermissionModeChange / etc., PRD v0.1.69 §4.3 rule 2 extended to
    // runtime): fork a new Tab pinned to the chosen runtime AND update the
    // workspace template. The confirm dialog's copy explicitly tells the user
    // both halves will happen, so mutating agent.runtime is no longer a
    // surprise-leak — it's the advertised behavior.
    //
    // Why this is safe despite the older "deliberately do NOT" comment:
    //   - Existing Tabs with non-empty sessions hydrate currentRuntime from
    //     SessionMetadata.runtime (session-self-contained, D1). Changing
    //     agent.runtime doesn't flip their displayed runtime because their
    //     session snapshot is authoritative.
    //   - Empty Tabs and new Sidecars (Bot / Cron / new Tab) read agent.runtime
    //     as the template — which is EXACTLY the semantic we want.
    //   - The fork-new-tab step is still required because switching the current
    //     session's runtime in-place is an incompatibility hard-guard (D6).
    //
    // Ordering (cross-review Codex Warning): create the fork FIRST — if that
    // fails we leave the workspace default untouched. Only after the session
    // is confirmed created do we persist the agent patch. This prevents the
    // "future Tabs silently inherit new runtime even though user's fork
    // failed" leak.
    if (!onForkSession || !agentDir) return;
    const boundChannel = channelSurfaceRef.current;
    let session: { id: string } | undefined;
    try {
      const { createSession } = await import('@/api/sessionClient');
      session = await createSession(agentDir, runtime, { origin: DESKTOP_SESSION_FORK_ORIGIN });
    } catch (err) {
      console.error('[chat] Failed to create session for runtime fork:', err);
      toastRef.current.error(t('shell.toasts.runtimeSwitchCreateFailed'));
      return;
    }
    // Fork metadata succeeded — now persist workspace default before opening
    // the tab. For ordinary desktop forks an agent patch failure is non-fatal:
    // the new session snapshot is still usable. For channel-bound forks, the
    // binding migration depends on the live Agent template being updated, so
    // the failure stays blocking and the hidden target session is deleted.
    //
    // buildRuntimeChangePatch centralizes the "drop non-portable
    // runtimeConfig fields (model / permissionMode / additionalArgs), keep
    // envPolicy" policy — see its doc comment for the bug-class rationale.
    // All 4 runtime-change callsites (here / Settings / Launcher / agent
    // set CLI) MUST go through this helper.
    let agentTemplateUpdated = false;
    if (currentAgent.id) {
      try {
        await patchAgentConfig(currentAgent.id, buildRuntimeChangePatch(currentAgent.runtimeConfig, runtime));
        agentTemplateUpdated = true;
      } catch (err) {
        console.warn('[chat] Runtime fork succeeded but agent template update failed:', err);
        if (boundChannel) {
          await deleteUnopenedForkSession(session.id);
          toastRef.current.error(t('shell.toasts.runtimeSwitchDefaultUpdateFailed'));
          return;
        }
        toastRef.current.warning(t('shell.toasts.runtimeSwitchDefaultUpdateWarning'));
      }
    }
    const runtimeLabel = getRuntimeDisplayLabel(runtime);
    const opened = await onForkSession(session.id, agentDir, `${runtimeLabel} Session`);
    if (!opened) {
      await deleteUnopenedForkSession(session.id);
      if (agentTemplateUpdated) {
        try {
          await patchAgentConfig(currentAgent.id, {
            runtime: currentAgent.runtime ?? 'builtin',
            runtimeConfig: currentAgent.runtimeConfig,
          });
        } catch (rollbackErr) {
          console.warn('[chat] Runtime rollback after fork tab open failure also failed:', rollbackErr);
        }
      }
      toastRef.current.error(t('shell.toasts.runtimeSwitchTabOpenFailed'));
      return;
    }
    if (boundChannel && session) {
      try {
        await transferBindingToForkedSession(boundChannel, session.id);
      } catch (err) {
        console.error('[chat] Runtime fork channel binding transfer failed:', err);
        try {
          await patchAgentConfig(currentAgent.id, {
            runtime: currentAgent.runtime ?? 'builtin',
            runtimeConfig: currentAgent.runtimeConfig,
          });
        } catch (rollbackErr) {
          console.warn('[chat] Runtime rollback after failed channel transfer also failed:', rollbackErr);
        }
        toastRef.current.error(t('shell.toasts.runtimeSwitchChannelTransferFailed'));
        return;
      }
    }
  }, [pendingRuntimeChange, currentAgent, onForkSession, agentDir, transferBindingToForkedSession, deleteUnopenedForkSession, guardCronConfigMutation, t]);

  // Provider/model history-boundary confirm: create a fresh session in a new
  // tab so the old transcript is not reused across incompatible provider
  // families. The new session gets an owned snapshot, and the user's latest
  // provider/model choice is still written upward to Project/Agent defaults
  // without mutating the old session snapshot.
  const confirmProviderSwitch = useCallback(async () => {
    if (guardCronConfigMutation()) {
      setPendingProviderSwitch(null);
      return;
    }
    const pending = pendingProviderSwitch;
    setPendingProviderSwitch(null);
    if (!pending || !agentDir) return;
    const boundChannel = channelSurfaceRef.current;

    let forkTabOpened = false;
    const newProvider = providers.find(p => p.id === pending.providerId);
    const targetModel = pending.model ?? newProvider?.primaryModel;
    const targetIntent = buildProviderExecutionIntent(newProvider, targetModel);

    if (!newProvider || !targetModel || !targetIntent) {
      toastRef.current.error(t('shell.toasts.providerSwitchTargetUnavailable'));
      return;
    }

    try {
      const sessionTitle = `${newProvider.name} 会话`;
      let openedSessionId: string;
      if (targetIntent.kind === 'runtime-backed-provider') {
        if (!currentProject || !onLaunchRuntimeBackedProviderSession) {
          throw new Error('App runtime-backed provider launch owner is unavailable');
        }
        const launchedSessionId = await onLaunchRuntimeBackedProviderSession(
          currentProject,
          {
            providerExecutionIdentity: targetIntent,
            // LaunchSessionBirthHint carries product-facing values. App is the
            // sole birth owner and converts them to runtime vocabulary once.
            permissionMode: inputChromePermissionMode,
            reasoningEffort,
            mcpEnabledServers: workspaceMcpEnabled,
            enabledPluginIds: workspaceEnabledPlugins,
            enabledOfficialToolIds: workspaceOfficialToolEnabled,
            origin: DESKTOP_SESSION_FORK_ORIGIN,
          },
          sessionTitle,
        );
        if (!launchedSessionId) {
          throw new Error('App failed to open runtime-backed provider Session');
        }
        openedSessionId = launchedSessionId;
      } else {
        if (!onForkSession) {
          throw new Error('App fork owner is unavailable');
        }
        const birth = buildProviderSwitchSessionBirth({
          targetIntent,
          providerId: pending.providerId,
          model: targetModel,
          permissionMode: inputChromePermissionMode,
          reasoningEffort,
          mcpEnabledServers: workspaceMcpEnabled,
          enabledPluginIds: workspaceEnabledPlugins,
          enabledOfficialToolIds: workspaceOfficialToolEnabled,
        });
        const { createSession } = await import('@/api/sessionClient');
        const session = await createSession(
          agentDir,
          birth.runtime,
          { ...birth.opts, origin: DESKTOP_SESSION_FORK_ORIGIN },
        );
        const opened = await onForkSession(session.id, agentDir, sessionTitle);
        if (!opened) {
          await deleteUnopenedForkSession(session.id);
          throw new Error('Fork tab failed to open');
        }
        openedSessionId = session.id;
      }
      forkTabOpened = true;
      if (currentProject) {
        const defaultWriteResult = await persistInputOptionChange({
          workspaceId: currentProject.id,
          agentId: currentProject.agentId,
          isExternalRuntime: false,
          currentRuntimeConfig: currentAgent?.runtimeConfig as RuntimeConfig | undefined,
          currentProviderId: currentAgent?.providerId ?? currentProject.providerId,
          fields: {
            ...(targetIntent.kind === 'runtime-backed-provider'
              ? { runtimeBackedProviderSelection: targetIntent }
              : { builtinSelection: { providerId: pending.providerId, model: targetModel } }),
            permissionMode: inputChromePermissionMode,
          },
          snapshotWriteMode: 'disabled',
          patchProject,
          patchAgentConfig,
          patchAgentProjectConfig,
        });
        if (!defaultWriteResult.ok) {
          console.error('[chat] Provider switch default write failed:', defaultWriteResult.errors);
          toastRef.current.warning(t('shell.toasts.providerSwitchDefaultSaveFailed'));
        }
        try {
          await refreshConfig();
        } catch (refreshErr) {
          console.warn('[chat] Provider switch config refresh failed:', refreshErr);
        }
      }
      if (boundChannel) {
        await transferBindingToForkedSession(boundChannel, openedSessionId);
      }
    } catch (err) {
      console.error('[chat] Failed to create cross-provider session:', err);
      toastRef.current.error(
        forkTabOpened
          ? t('shell.toasts.providerSwitchChannelTransferFailed')
          : t('shell.toasts.createNewSessionFailed'),
      );
    }
  }, [pendingProviderSwitch, agentDir, onForkSession, onLaunchRuntimeBackedProviderSession, providers, transferBindingToForkedSession, deleteUnopenedForkSession, inputChromePermissionMode, reasoningEffort, workspaceMcpEnabled, workspaceEnabledPlugins, workspaceOfficialToolEnabled, currentProject, currentAgent, patchProject, refreshConfig, guardCronConfigMutation, t]);

  // Cross-runtime confirm: create new session in new tab and send the pending message
  const confirmCrossRuntimeSend = useCallback(async () => {
    const pending = pendingCrossRuntimeMessage;
    if (!pending || !agentDir || !onForkSession) return;
    try {
      const { createSession } = await import('@/api/sessionClient');
      // Pass currentRuntime so the new session has matching runtime metadata,
      // preventing infinite cross-runtime detection loop.
      const session = await createSession(agentDir, currentRuntime, { origin: DESKTOP_SESSION_FORK_ORIGIN });
      setPendingCrossRuntimeMessage(null);  // Clear only after success
      // Open new tab with the pending message as initialMessage
      if (pending.images.length > 0) {
        toastRef.current.warning(t('shell.toasts.imagesNotTransferred'));
      }
      const opened = await onForkSession(session.id, agentDir, pending.text.slice(0, 40) || t('shell.toasts.newSession'), pending.text);
      if (!opened) {
        await deleteUnopenedForkSession(session.id);
      }
    } catch (err) {
      setPendingCrossRuntimeMessage(null);  // Clear on error too (dialog dismissed)
      console.error('[chat] Failed to create cross-runtime session:', err);
      toastRef.current.error(t('shell.toasts.createNewSessionFailed'));
    }
  }, [pendingCrossRuntimeMessage, agentDir, onForkSession, currentRuntime, deleteUnopenedForkSession, t]);

  // Issue #231: snapshot the current input value at the moment the user opens
  // the cron-settings modal, instead of keeping `cronPrompt` continuously in
  // sync with every keystroke (the prior `onInputChange={setCronPrompt}` wiring
  // re-rendered the entire Chat tree on every paste — see SimpleChatInput #231
  // comment).
  const handleOpenCronSettings = useCallback(() => {
    if (guardCronConfigMutation()) return;
    setStoppedCronRecovery(null);
    setCronPrompt(chatInputRef.current?.getCurrentValue() ?? '');
    setCronOpenPreset(null); // 定时 button = no slash preset
    setShowCronSettings(true);
  }, [guardCronConfigMutation]);

  const handleCronDraftCancel = useCallback(() => {
    cancelPendingGoalStart();
    disableCronMode();
  }, [cancelPendingGoalStart, disableCronMode]);

  const handleGoalDraftCancel = useCallback(() => {
    cancelPendingGoalStart();
    setGoalDraftConfig(null);
  }, [cancelPendingGoalStart]);

  const handleGoalDraftSettings = useCallback(() => {
    setCronPrompt(chatInputRef.current?.getCurrentValue() ?? '');
    const draft = goalDraftConfigRef.current;
    setCronOpenPreset(draft ? {
      ...GOAL_SLASH_PRESET,
      endConditions: draft.endConditions,
      notifyEnabled: draft.notifyEnabled,
    } : GOAL_SLASH_PRESET);
    setShowCronSettings(true);
  }, []);

  const managedCodexCompactSupported = currentRuntime === 'codex' && managedProviderRuntimeActive;
  const manualContextCompactSupported = currentRuntime === 'builtin' || managedCodexCompactSupported;
  const runtimeClientActionSlashCommands = useMemo(
    () => managedCodexCompactSupported ? [MANAGED_CODEX_COMPACT_SLASH_COMMAND] : [],
    [managedCodexCompactSupported],
  );

  // Both the context card and `/compact` dispatch this action. Builtin keeps
  // the Claude SDK command path; Managed Codex uses its native SessionEngine
  // control operation so no synthetic user message enters the transcript.
  const handleCompactContext = useCallback(() => {
    if (managedCodexCompactSupported) {
      void apiPost<{ success: boolean; error?: string }>('/api/session/compact')
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          toastRef.current.error(`${t('input.operationFailed')}: ${message}`);
        });
      return;
    }
    if (currentRuntime !== 'builtin') return;
    if (pinnedProviderUnavailable) {
      showPinnedProviderUnavailableToast();
      return;
    }
    if (builtinSnapshotProviderSelectionIncomplete) {
      showSnapshotProviderIncompleteToast();
      return;
    }
    const providerRoute = buildBuiltinProviderRoute(currentProviderRef.current, effectiveModel);
    const providerEnv = providerRoute ? undefined : buildProviderEnv(currentProviderRef.current);
    void sendMessage(
      '/compact',
      undefined,
      effectivePermissionMode,
      effectiveModel,
      providerEnv,
      undefined,
      reasoningEffort,
      providerRoute,
    );
  }, [
    apiPost,
    buildProviderEnv,
    builtinSnapshotProviderSelectionIncomplete,
    currentRuntime,
    effectiveModel,
    effectivePermissionMode,
    managedCodexCompactSupported,
    pinnedProviderUnavailable,
    reasoningEffort,
    sendMessage,
    showPinnedProviderUnavailableToast,
    showSnapshotProviderIncompleteToast,
    t,
  ]);

  // `/goal` is a product action, not a Runtime command. Arm the lightweight
  // composer draft immediately; the bar's settings button owns optional tuning.
  const handleSlashAction = useCallback((name: string) => {
    if (name === 'compact') {
      handleCompactContext();
      return;
    }
    if (name === 'goal' || name === 'loop') {
      setStoppedCronRecovery(null);
      if (!cronStateRef.current.task) disableCronMode();
      const goalExecution = buildCronExecutionOverrides({
        providerId: !isExternalRuntime && currentProvider ? currentProvider.id : undefined,
        model: isExternalRuntime ? undefined : selectedModel,
      });
      setGoalDraftConfig(createDefaultSessionGoalDraftConfig({
        permissionMode: isExternalRuntime ? effectiveRuntimePermissionMode : permissionMode,
        runtime: goalExecution.runtime,
      }));
      setCronPrompt('');
      setCronOpenPreset(null);
      setShowCronSettings(false);
    }
  }, [
    buildCronExecutionOverrides,
    currentProvider,
    disableCronMode,
    effectiveRuntimePermissionMode,
    handleCompactContext,
    isExternalRuntime,
    permissionMode,
    selectedModel,
  ]);

  const handleCronStop = useCallback(async () => {
    const stopSessionId = sessionIdRef.current;
    const result = await stopCronTask();
    if (!result || sessionIdRef.current !== stopSessionId) return;
    const promptToRecover = result.prompt;
    if (promptToRecover) {
      setStoppedCronRecovery({
        prompt: promptToRecover,
        task: result.task,
        sessionId: stopSessionId ?? '',
      });
    }
  }, [stopCronTask]);

  const handleGoalCancelOpen = useCallback(() => {
    const currentGoal = sessionGoalStateRef.current.goal;
    if (isCurrentSessionGoal(currentGoal) && !isTerminalGoalStatus(currentGoal.status)) {
      setGoalCancelConfirmOpen(true);
    }
  }, []);

  const handleGoalCancelConfirm = useCallback(async () => {
    const stopSessionId = sessionIdRef.current;
    try {
      const result = await cancelGoal('Canceled by user');
      if (!result) {
        toastRef.current.error(tTask('cron.statusBar.cancelGoalFailed'));
        return;
      }
      if (sessionIdRef.current !== stopSessionId) return;
      setStoppedCronRecovery(null);
    } finally {
      setGoalCancelConfirmOpen(false);
    }
  }, [cancelGoal, tTask]);

  const handleGoalEditOpen = useCallback(() => {
    const goal = sessionGoalStateRef.current.goal;
    if (!isCurrentSessionGoal(goal) || isTerminalGoalStatus(goal.status)) return;
    setGoalEditDraft(goal.objective);
    setGoalEditOpen(true);
  }, []);

  const handleGoalEditSubmit = useCallback(async () => {
    const objective = goalEditDraft.trim();
    if (!objective) {
      toastRef.current.warning(t('goalEdit.empty'));
      return;
    }
    const beforeGoal = sessionGoalStateRef.current.goal;
    if (!isCurrentSessionGoal(beforeGoal) || isTerminalGoalStatus(beforeGoal.status)) {
      setGoalEditOpen(false);
      return;
    }
    setGoalEditSubmitting(true);
    try {
      const result = await apiPost<{ success: boolean; error?: string }>(
        '/api/goal/objective',
        { objective, sessionId: beforeGoal.sessionId },
      );
      if (!result.success) {
        console.error('[Chat] Goal objective update rejected:', result.error);
        toastRef.current.error(t('goalEdit.updateFailed'));
        return;
      }
      setGoalEditOpen(false);
      toastRef.current.success(t('goalEdit.updated'));
    } catch (error) {
      console.error('[Chat] Failed to update Goal objective:', error);
      toastRef.current.error(t('goalEdit.updateFailed'));
    } finally {
      setGoalEditSubmitting(false);
    }
  }, [apiPost, goalEditDraft, t]);

  const handleCronDismissStopped = useCallback(() => {
    if (stoppedCronRecovery?.prompt) {
      const currentValue = chatInputRef.current?.getCurrentValue() ?? '';
      const nextValue = appendCronPromptToDraft(currentValue, stoppedCronRecovery.prompt);
      chatInputRef.current?.setValue(nextValue);
      chatInputRef.current?.focus();
    }
    setStoppedCronRecovery(null);
  }, [stoppedCronRecovery]);

  const handleGoalDismiss = useCallback(() => {
    dismissGoal();
  }, [dismissGoal]);

  const handleCancelQueuedVoid = useCallback(
    (queueId: string) => { void handleCancelQueued(queueId); },
    [handleCancelQueued]
  );

  const handleForceExecuteQueuedVoid = useCallback(
    (queueId: string) => { void handleForceExecuteQueued(queueId); },
    [handleForceExecuteQueued]
  );

  // Format selected text as Markdown blockquote
  const formatQuote = useCallback((text: string) =>
    text.split('\n').map(line => `> ${line}`).join('\n'),
  []);

  // Quote selected text — append blockquote + placeholder for user to type over
  const handleQuoteSelection = useCallback((selectedText: string) => {
    const currentValue = inputRef.current?.value ?? '';
    // Only prepend \n when there's existing content (so the quote starts on a new line)
    const prefix = currentValue ? '\n' : '';
    const quote = `${prefix}${formatQuote(selectedText)}\n${t('shell.selection.quotePrompt')}`;
    const appended = currentValue + quote;
    chatInputRef.current?.setValue(appended);
    // Move cursor to end + scroll textarea to bottom so user sees the appended quote
    setTimeout(() => {
      const textarea = inputRef.current;
      if (textarea) {
        textarea.setSelectionRange(appended.length, appended.length);
        textarea.scrollTop = textarea.scrollHeight;
        textarea.focus();
      }
    }, 0);
  }, [inputRef, formatQuote, t]);

  // Elaborate = quote + placeholder + "深入讲讲" then auto-send
  const handleElaborateSelection = useCallback((selectedText: string) => {
    const prompt = `${formatQuote(selectedText)}\n${t('shell.selection.elaboratePrompt')}`;
    void handleSendMessageRef.current(prompt);
  }, [formatQuote, t]);

  // File preview「引用文件」: append `@<path> ` to chat input. Token-format matches existing
  // `@file` mention (server's fallback-path collector treats literal `@path` as a file
  // reference). Path normalised to POSIX so Windows backslashes don't reach the model —
  // the @-mention parser and downstream tools both expect forward-slash paths.
  const handleQuoteFile = useCallback((path: string) => {
    const posix = path.replace(/\\/g, '/');
    chatInputRef.current?.appendReferenceToken(`@${posix}`);
  }, []);

  // File preview selection-quote: append `@<path>#L<start>[-L<end>] ` to chat input.
  // GitHub-permalink syntax — there is no server-side `#L` parsing; the model interprets
  // the line range from prompt context (Claude is heavily exposed to GitHub permalinks in
  // training data, so the convention reads naturally). Single-line selections collapse to
  // `#L7` to match GitHub's convention. Path normalised to POSIX (Windows safety).
  const handleQuoteFileSelection = useCallback((path: string, startLine: number, endLine: number) => {
    const posix = path.replace(/\\/g, '/');
    const range = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
    chatInputRef.current?.appendReferenceToken(`@${posix}#${range}`);
  }, []);

  // Navigate to a specific query message (used by QueryNavigator).
  // ChatScrollController owns virtualized message navigation.
  const handleNavigateToQuery = useCallback((messageId: string) => {
    scrollToMessage(messageId, { behavior: 'smooth', align: 'start', pauseMs: 2000 });
  }, [scrollToMessage]);

  // PRD 0.2.17 Agent Status Panel — 点击 SubAgent 行跳转到对话流中对应 TaskTool。
  // ChatScrollController owns host-message resolution and the two-stage
  // virtual-row mount + precise DOM scroll.
  const handleJumpToTool = useCallback((toolId: string) => {
    scrollToTool(toolId);
  }, [scrollToTool]);

  // PRD 0.2.17 / v0.2.19 — AgentStatusPanel 通过 slot 注入 SimpleChatInput，
  // 与 QueuedMessagesPanel 同居一个 flex 行（避免两者撞 z-20 / 同 Y 重叠）。
  // P3: slot 不再依赖高频的 messages —— AgentStatusPanel 自己从 TabContext
  // 订阅 messages（见该组件）。这样本 slot 的 useMemo 在流式期间 identity 保持
  // 稳定，SimpleChatInput 的 React.memo 不再被打穿，输入框在 AI 流式输出时不会
  // 每 token 重渲染。AgentStatusPanel 内部仍随 commit 重渲染，其 DOM 仅在
  // 派生 todos/subagents 变化时才改，成本由 React 协调器吸收。
  const supportsAgentStatusPanel = currentRuntime === 'builtin' || currentRuntime === 'codex';
  const agentStatusSlot = useMemo(
    () => !supportsAgentStatusPanel
      ? undefined
      : (
        <AgentStatusPanel
          containerRef={chatContentRef}
          onJumpToTool={handleJumpToTool}
        />
      ),
    [supportsAgentStatusPanel, handleJumpToTool],
  );

  // PRD 0.2.32 — context 用量指示器 slot。自取数（内部 useTabState 订阅 contextUsage），
  // 数据不经 SimpleChatInput props；useMemo 让 slot identity 在流式期间稳定，不打穿
  // SimpleChatInput 的 React.memo（与 agentStatusSlot 同款）。
  const contextIndicatorSlot = useMemo(
    // key on sessionId → remount on session switch resets local open/timer state
    // (review #W3). sessionId is stable during streaming, so the memo still holds.
    () => (
      <ContextUsageIndicator
        key={sessionId ?? 'none'}
        onCompact={manualContextCompactSupported ? handleCompactContext : undefined}
      />
    ),
    [handleCompactContext, manualContextCompactSupported, sessionId],
  );

  // P3 (second memo-breaker): this list was computed inline in the SimpleChatInput
  // JSX, so a fresh array was created on every Chat re-render → broke
  // SimpleChatInput's shallow React.memo on every streamed token. Memoize it so
  // its identity only changes when the plugin config actually changes.
  // Layer-1 visible plugins = Settings 开关 ON. (mcpServerNames is added by the
  // sidecar's /api/cc-plugin/list and lives only on PluginListItem, not the bare
  // PluginEntry in AppConfig — undefined here; the chat submenu hides it.)
  const globallyVisiblePlugins = useMemo(
    () => (config.plugins ?? [])
      .filter(p => config.enabledPlugins?.[p.id] === true)
      .map(p => ({ id: p.id, name: p.name, description: p.description })),
    [config.plugins, config.enabledPlugins],
  );

  // Stable callbacks for MessageList (extracted from inline arrows to enable memo)
  const handlePermissionDecision = useCallback((requestId: string, decision: 'deny' | 'allow_once' | 'always_allow') => {
    return respondPermission(decision, requestId);
  }, [respondPermission]);

  const handleAskUserQuestionSubmit = useCallback((_requestId: string, answers: Record<string, string>) => {
    void respondAskUserQuestion(answers);
  }, [respondAskUserQuestion]);

  const handleAskUserQuestionCancel = useCallback(() => {
    void respondAskUserQuestion(null);
  }, [respondAskUserQuestion]);

  const handleExitPlanModeApprove = useCallback(async () => {
    const ok = await respondExitPlanMode(true);
    if (!ok) toastRef.current.error(t('shell.toasts.submitFailedRetry'));
    // Mode restore is handled by the useEffect below reacting to resolved='approved'
  }, [respondExitPlanMode, t]);

  const handleExitPlanModeReject = useCallback(async (feedback?: string) => {
    const ok = await respondExitPlanMode(false, feedback);
    if (!ok) toastRef.current.error(t('shell.toasts.submitFailedRetry'));
  }, [respondExitPlanMode, t]);

  const handleDismissSystemNotice = useCallback(() => {
    setSystemNotice(null);
  }, [setSystemNotice]);

  // React to plan mode changes: auto-approved by SDK, or user-approved via card
  // Single source of truth for permission mode switch during plan mode
  useEffect(() => {
    if (pendingEnterPlanMode?.resolved === 'approved' && permissionMode !== 'plan') {
      prePlanPermissionModeRef.current = permissionMode;
      setPermissionMode('plan');
    }
  }, [pendingEnterPlanMode?.resolved, pendingEnterPlanMode?.requestId]); // eslint-disable-line react-hooks/exhaustive-deps -- read permissionMode without dep to avoid loop

  useEffect(() => {
    if (pendingExitPlanMode?.resolved === 'approved' && prePlanPermissionModeRef.current) {
      setPermissionMode(prePlanPermissionModeRef.current);
      prePlanPermissionModeRef.current = null;
    }
  }, [pendingExitPlanMode?.resolved, pendingExitPlanMode?.requestId]);

  // Sync permission mode from backend → frontend.
  // Backend is the source of truth: SDK tools (EnterPlanMode/ExitPlanMode) and
  // setSessionPermissionMode() all broadcast 'chat:permission-mode-changed'.
  // This ensures the UI toggle always reflects the actual SDK subprocess state.
  const permissionModeRef = useRef(permissionMode);
  permissionModeRef.current = permissionMode;
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      // Tab isolation: only process events for this tab (SSE is tab-scoped,
      // but the DOM CustomEvent is global — filter by tabId)
      if (detail?.tabId && detail.tabId !== tabId) return;
      const mode = detail?.permissionMode as PermissionMode | undefined;
      if (mode && mode !== permissionModeRef.current) {
        setPermissionMode(mode);
      }
    };
    window.addEventListener('permission-mode-sync', handler);
    return () => window.removeEventListener('permission-mode-sync', handler);
  }, [tabId]); // stable — reads permissionMode via ref

  const warnRewindFileOutcome = useCallback((result: RewindResponse | undefined) => {
    showRewindFileOutcomeWarning(result, toastRef.current.warning, t);
  }, [t]);

  // Stable callback for time rewind — uses ref for messages to keep reference stable
  const handleRewind = useCallback((messageId: string) => {
    const msgs = messagesRef.current;
    const msg = msgs.find(m => m.id === messageId);
    if (!msg) return;
    setRewindTarget({
      messageId,
      content: typeof msg.content === 'string' ? msg.content : '',
      attachments: msg.attachments,
      replacesDraft: Boolean(
        chatInputRef.current?.getCurrentValue().trim()
        || chatInputRef.current?.getImages().length
      ),
    });
  }, []); // [] — 通过 ref 读取 messages，引用永远稳定

  const handleRewindConfirm = useCallback(() => {
    if (!rewindTarget || conversationOperationPendingRef.current) return;
    conversationOperationPendingRef.current = true;
    const { messageId, content, attachments } = rewindTarget;

    // 快照：保存当前 messages 以便后端失败时回滚
    const snapshot = messagesRef.current.slice();
    const composerSnapshot = {
      value: chatInputRef.current?.getCurrentValue() ?? '',
      images: chatInputRef.current?.getImages() ?? [],
    };
    const rewindSessionId = sessionIdRef.current;
    const isCodexRewind = currentRuntime === 'codex';

    // 1. 乐观更新 UI（瞬时反馈）
    // Pause auto-scroll to prevent animated scrolling during rewind's DOM changes.
    // Without this, the smooth scroll animation fights with the browser's natural
    // scroll clamping (messages removed → scrollHeight shrinks → scrollTop adjusts).
    pauseAutoScroll(500);
    setRewindTarget(null);
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === messageId);
      return idx >= 0 ? prev.slice(0, idx) : prev;
    });
    chatInputRef.current?.setValue(content);
    const imageAttachments = attachments?.filter(a =>
      a.isImage || a.mimeType?.startsWith('image/')
    );
    const restoredImages: ImageAttachment[] = imageAttachments?.map(a => ({
        id: a.id,
        file: new File([], a.name, { type: a.mimeType }),
        preview: a.previewUrl || '',
        source: a.relativePath || a.savedPath ? 'attachment_ref' : undefined,
        name: a.name,
        mimeType: a.mimeType,
        sizeBytes: a.size,
        relativePath: a.relativePath || a.savedPath,
      })) ?? [];
    chatInputRef.current?.setImages(restoredImages);

    // 2. 后端回溯（rewindPromise 会阻塞 enqueueUserMessage 防止竞态）
    //    成功：丢弃快照；失败：从快照回滚 UI
    setIsLoading(true);
    setRewindStatus('rewinding');
    apiPost('/chat/rewind', { userMessageId: messageId })
      .then(res => {
        if (sessionIdRef.current !== rewindSessionId) return;
        const r = res as RewindResponse | undefined;
        track('session_rewind', {
          runtime: currentRuntime,
          runtime_source: currentRuntime === 'builtin' ? null : (currentRuntimeSource ?? 'system-cli'),
          result: r?.errorCode ?? (r?.success === false ? 'failed' : 'success'),
        });
        if (r && !r.success) {
          // 后端明确返回失败 → 回滚 UI
          setMessages(snapshot);
          chatInputRef.current?.setValue(composerSnapshot.value);
          chatInputRef.current?.setImages(composerSnapshot.images);
          const error = r.errorCode
            ? t(`shell.toasts.conversationError.${r.errorCode}`)
            : r.error || t('shell.toasts.unknownError');
          toastRef.current.error(t('shell.toasts.rewindFailedWithError', { error }));
        } else {
          if (isCodexRewind || r?.rewindScope === 'conversation-only') {
            if (r?.errorCode === 'restore_failed') {
              toastRef.current.warning(t('shell.toasts.codexRestoreFailed'));
            } else {
              toastRef.current.success(t('shell.toasts.codexRewindSuccess'));
            }
          } else {
            warnRewindFileOutcome(r);
          }
        }
      })
      .catch(async err => {
        if (sessionIdRef.current !== rewindSessionId) return;
        console.error('[Chat] Rewind failed:', err);
        const structured = err && typeof err === 'object'
          ? err as { status?: unknown; errorCode?: unknown }
          : null;
        const errorCode = typeof structured?.errorCode === 'string' ? structured.errorCode : undefined;
        track('session_rewind', {
          runtime: currentRuntime,
          runtime_source: currentRuntime === 'builtin' ? null : (currentRuntimeSource ?? 'system-cli'),
          result: errorCode ?? (typeof structured?.status === 'number' ? 'failed' : 'transport_error'),
        });

        // A structured HTTP rejection proves the server did not commit. A
        // transport failure is ambiguous, so Codex reloads SessionStore
        // authority instead of restoring a possibly stale pre-rewind tail.
        const reconciliation = isCodexRewind
          && typeof structured?.status !== 'number'
          ? await retryCurrentSessionRestore(messageId)
          : null;
        if (sessionIdRef.current !== rewindSessionId) return;
        const transportOutcome = classifyCodexRewindTransportOutcome(reconciliation);
        const recovery = projectCodexRewindRecovery(transportOutcome);
        if (recovery.restoreMessageSnapshot) {
          setMessages(snapshot);
        }
        if (recovery.restoreComposerSnapshot) {
          chatInputRef.current?.setValue(composerSnapshot.value);
          chatInputRef.current?.setImages(composerSnapshot.images);
        }
        if (transportOutcome === 'committed') {
          toastRef.current.warning(t('shell.toasts.codexRewindReconciled'));
        } else if (errorCode) {
          toastRef.current.error(t('shell.toasts.rewindFailedWithError', {
            error: t(`shell.toasts.conversationError.${errorCode}`),
          }));
        } else {
          toastRef.current.error(t('shell.toasts.rewindFailedRetry'));
        }
      })
      .finally(() => {
        conversationOperationPendingRef.current = false;
        if (sessionIdRef.current === rewindSessionId) {
          setRewindStatus(null);
          setIsLoading(false);
        }
      });
  }, [rewindTarget, apiPost, setMessages, setIsLoading, pauseAutoScroll, t, warnRewindFileOutcome, currentRuntime, currentRuntimeSource, retryCurrentSessionRestore]);

  // Retry = rewind to before user message + auto-resend
  // Rewind to before the given user message and re-send its content.
  // Shared by per-assistant retry (handleRetry) and banner-level retry
  // (handleRetryLastUserMessage). Uses refs throughout so deps stay stable.
  //
  // Retry remains a separate operation from Codex historical Rewind. Every
  // external runtime uses /chat/external-retry here: it removes only the
  // failed tail user turn from allSessionMessages, persists that truncation,
  // and lets the auto-resend below become the replacement user turn.
  const performRetryFromUserMessage = useCallback((userMsg: typeof messagesRef.current[number]) => {
    const content = typeof userMsg.content === 'string' ? userMsg.content : '';
    const attachments = userMsg.attachments;
    const userMessageId = userMsg.id;
    const retryEndpoint = isExternalRuntime ? '/chat/external-retry' : '/chat/rewind';

    // 快照：后端失败时回滚（与 handleRewindConfirm 一致）
    const snapshot = messagesRef.current.slice();

    // 1. Optimistic UI: truncate to before user message
    pauseAutoScroll(500);
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === userMessageId);
      return idx >= 0 ? prev.slice(0, idx) : prev;
    });

    // 2. Rewind + auto-resend
    let resendFired = false;
    setIsLoading(true);
    setRewindStatus('rewinding');
    apiPost(retryEndpoint, { userMessageId })
      .then(res => {
        const r = res as RewindResponse | undefined;
        if (r && !r.success) {
          setMessages(snapshot);
          toastRef.current.error(t('shell.toasts.retryFailedWithError', { error: r.error || t('shell.toasts.unknownError') }));
          return;
        }
        warnRewindFileOutcome(r);
        // Rewind succeeded → auto-resend the original message
        track('message_retry', {});
        resendFired = true;
        const imageAttachments = attachments?.filter(a =>
          a.isImage || a.mimeType?.startsWith('image/')
        ).map(a => ({
          id: a.id,
          file: new File([], a.name, { type: a.mimeType }),
          preview: a.previewUrl || '',
          source: a.relativePath || a.savedPath ? 'attachment_ref' as const : undefined,
          name: a.name,
          mimeType: a.mimeType,
          sizeBytes: a.size,
          relativePath: a.relativePath || a.savedPath,
        }));
        handleSendMessageRef.current(content, imageAttachments?.length ? imageAttachments : undefined);
      })
      .catch(err => {
        console.error('[Chat] Retry failed:', err);
        setMessages(snapshot);
        toastRef.current.error(t('shell.toasts.retryFailed'));
      })
      .finally(() => {
        setRewindStatus(null);
        // Only clear loading on error — successful resend manages its own loading state
        if (!resendFired) {
          setIsLoading(false);
        }
      });
  }, [apiPost, setMessages, setIsLoading, pauseAutoScroll, isExternalRuntime, t, warnRewindFileOutcome]); // all stable — refs handle the rest

  // Uses refs for messagesRef/toastRef/handleSendMessageRef — deps are all stable → reference stable
  const handleRetry = useCallback((assistantMessageId: string) => {
    const msgs = messagesRef.current;
    const aIdx = msgs.findIndex(m => m.id === assistantMessageId);
    if (aIdx < 0) return;

    // Find the nearest real user message before this assistant message
    // (skip synthetic task-notification messages which are injected as role='user')
    let userMsg: typeof msgs[number] | null = null;
    for (let i = aIdx - 1; i >= 0; i--) {
      if (msgs[i].role === 'user' && !msgs[i].id.startsWith('task-notification-')) { userMsg = msgs[i]; break; }
    }
    if (!userMsg) return;
    performRetryFromUserMessage(userMsg);
  }, [performRetryFromUserMessage]);

  // Banner-level retry: find the last real user message in the session and rewind+resend it.
  // Used by the agentError banner's 「重新发送」 button (issue #183).
  const handleRetryLastUserMessage = useCallback(() => {
    const msgs = messagesRef.current;
    let userMsg: typeof msgs[number] | null = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user' && !msgs[i].id.startsWith('task-notification-')) { userMsg = msgs[i]; break; }
    }
    if (!userMsg) return;
    setAgentError(null);
    performRetryFromUserMessage(userMsg);
  }, [performRetryFromUserMessage, setAgentError]);

  // Fork = create a new independent session branch at a specific assistant message
  const handleFork = useCallback((assistantMessageId: string) => {
    setForkTarget(assistantMessageId);
  }, []);

  const handleForkConfirm = useCallback(() => {
    if (!forkTarget || forkPending || conversationOperationPendingRef.current) return;
    conversationOperationPendingRef.current = true;
    const messageId = forkTarget;
    setForkTarget(null);
    setForkPending(true);

    apiPost('/sessions/fork', { messageId })
      .then(async res => {
        const r = res as { success?: boolean; newSessionId?: string; agentDir?: string; title?: string; error?: string; errorCode?: string } | undefined;
        track('session_fork', {
          runtime: currentRuntime,
          runtime_source: currentRuntime === 'builtin' ? null : (currentRuntimeSource ?? 'system-cli'),
          result: r?.errorCode ?? (r?.success ? 'success' : 'failed'),
        });
        if (r?.success && r.newSessionId && r.agentDir) {
          const forkSessionId = r.newSessionId;
          const discardUnopenedFork = async () => {
            const removed = await deleteUnopenedForkSession(forkSessionId);
            if (removed && currentRuntime === 'codex') {
              console.error(
                `[chat] Codex conversation branch orphan sessionId=${forkSessionId}`
                  + ` runtimeSource=${currentRuntimeSource ?? 'system-cli'}`
                  + ' reason=fork_tab_open_failed orphan=true',
              );
            }
          };
          if (!onForkSession) {
            await discardUnopenedFork();
            toastRef.current.error(t('shell.toasts.forkOpenFailed'));
            return;
          }
          const opened = await onForkSession(forkSessionId, r.agentDir, r.title || 'Fork');
          if (!opened) {
            await discardUnopenedFork();
            toastRef.current.error(t('shell.toasts.forkOpenFailed'));
          }
        } else {
          const error = r?.errorCode
            ? t(`shell.toasts.conversationError.${r.errorCode}`)
            : r?.error || t('shell.toasts.unknownError');
          toastRef.current.error(t('shell.toasts.forkFailedWithError', { error }));
        }
      })
      .catch(err => {
        console.error('[Chat] Fork failed:', err);
        const errorCode = err && typeof err === 'object' && 'errorCode' in err
          && typeof err.errorCode === 'string'
          ? err.errorCode
          : undefined;
        track('session_fork', {
          runtime: currentRuntime,
          runtime_source: currentRuntime === 'builtin' ? null : (currentRuntimeSource ?? 'system-cli'),
          result: errorCode ?? 'transport_error',
        });
        if (errorCode) {
          toastRef.current.error(t('shell.toasts.forkFailedWithError', {
            error: t(`shell.toasts.conversationError.${errorCode}`),
          }));
        } else {
          toastRef.current.error(t('shell.toasts.forkFailed'));
        }
      })
      .finally(() => {
        conversationOperationPendingRef.current = false;
        setForkPending(false);
      });
  }, [forkTarget, forkPending, apiPost, onForkSession, deleteUnopenedForkSession, t, currentRuntime, currentRuntimeSource]);

  const handleSelectSession = useCallback((
    id: string,
    title: string,
    historyEntrySource: HistoryEntrySource = 'chat_dropdown',
  ) => {
    if (!onOpenSession) {
      console.error('[Chat] Cannot open history Session without the App navigation owner');
      return;
    }
    onOpenSession(id, title, historyEntrySource);
  }, [onOpenSession]);

  // Handover-button visibility predicate (Q10 lockdown):
  //   - session is currently NOT bound to any channel
  //   - session was not originally created from an IM source (sessionMeta.source)
  //   - workspace's Agent has at least one online channel to hand off to
  //   - not a background-completing session
  const availableHandoverChannels = useMemo<BotChannelCandidate[]>(() => {
    if (!currentAgent) return [];
    const out: BotChannelCandidate[] = [];
    const status = agentStatuses[currentAgent.id];
    if (!status) return out;
    for (const ch of status.channels) {
      if (ch.status !== 'online') continue;
      const base = {
        agentId: status.agentId,
        agentName: status.agentName,
        channelId: ch.channelId,
        channelType: ch.channelType,
        // Prefer botUsername (e.g. `feishu_mino`) so the menu reads as
        // `<localized platform> · <bot identity>` instead of falling back to
        // the human-friendly Agent name (which would duplicate the agent dir).
        channelName: ch.botUsername || ch.name || ch.channelType,
        platformLabel: getChannelTypeLabel(ch.channelType),
      };
      if (ch.activeSessions.length === 0) {
        out.push({
          ...base,
          disabledReason: t('shell.handover.noActiveSessions'),
        });
        continue;
      }
      for (const active of ch.activeSessions) {
        out.push({
          ...base,
          sessionKey: active.sessionKey,
          sessionId: active.sessionId,
          sourceType: active.sourceType,
          sourceId: active.sourceId,
          sourceDisplayName: active.sourceDisplayName || active.sourceId,
        });
      }
    }
    return out;
  }, [currentAgent, agentStatuses, t]);

/**
   * Migrate the current channel binding to a new session id, then reset the
   * tab onto the new session. Pulled out of `handleNewSession` so the
   * SessionMenuButton's "新会话（保留绑定）" submenu item can drive the
   * exact same flow without re-running the unbound fallback paths.
   */
  const newSessionKeepingBinding = useCallback(async (): Promise<boolean> => {
    const boundChannel = surfaces.channel;
    if (!boundChannel || !sessionId) return false;
    const { migrateChannelToNewSession } = await import('@/api/sessionHandoverClient');
    return await transitionChannelBoundSession({
      sessionId,
      tabId,
      boundChannel,
      migrateChannelToNewSession,
      adoptMigratedSession,
      releaseMigratedTabOwner: releaseTabSession,
      reportError: (message) => toastRef.current.error(message),
    });
  }, [surfaces.channel, sessionId, tabId, adoptMigratedSession]);

  const showIntroductionOverlay = shouldShowIntroductionOverlay({
    content: introductionContent,
    historyMessageCount: historyMessages.length,
    hasStreamingMessage: !!streamingMessage,
    isSessionLoading,
    isLoading,
    sessionState,
    showStartupOverlay,
  });

  // Internal handler for starting a new session
  // If AI is running, App.tsx handles it via background completion (returns true).
  // If AI is idle, falls back to resetSession (reuses Sidecar).
  // PRD 0.2.14: when current session is IM-channel-bound, migrate the binding
  // to the new session so the IM channel keeps routing here. Unlike IM `/new`,
  // this is an explicit Tab + Agent joint migration.
  const handleNewSession = useCallback(async (): Promise<boolean> => {
    if (surfaces.channel && sessionId) {
      return await newSessionKeepingBinding();
    }

    if (onNewSession) {
      const handled = await onNewSession();
      if (handled) {
        // App.tsx started background completion and created new Sidecar
        // TabProvider will detect sessionId change and reconnect
        return true;
      }
    }

    // Fallback: AI is idle, reset session within existing Sidecar
    console.log('[Chat] Starting new session...');
    const success = await resetSession();
    if (success) {
      console.log('[Chat] New session started');
    } else {
      console.error('[Chat] Failed to start new session');
    }
    return success;
  }, [onNewSession, resetSession, surfaces.channel, sessionId, newSessionKeepingBinding]);

  return (
    <div className="relative flex h-full flex-row overflow-hidden overscroll-none bg-[var(--paper-elevated)] text-[var(--ink)]">
      {/* Left side: chat area (+ side workspace when wide) */}
      <div
        className={`relative flex min-w-0 flex-row overflow-hidden ${!isDraggingSplit ? 'transition-[width] duration-300 ease-in-out' : ''}`}
        style={{ width: splitPanelVisible && !browserUsesFullscreen ? `${splitRatio * 100}%` : '100%' }}
        data-chat-workspace-motion={shouldUseWorkspaceOverlay ? undefined : (workspacePanelMotion ?? undefined)}
      >
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden" data-chat-conversation>
        {/* Compact header - single row */}
        <div className="relative z-10 flex h-12 flex-shrink-0 items-center justify-between bg-[var(--paper-elevated)] px-4 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-3 after:bg-gradient-to-b after:from-[var(--paper-elevated)] after:to-[var(--paper-elevated-a0)]">
          <div className="flex min-w-0 items-center gap-2">
            {/* Project name */}
            {agentDir && (
              <span className="flex flex-shrink-0 items-center gap-1.5 text-sm font-medium text-[var(--ink)]">
                <WorkspaceIcon icon={currentProject?.icon} size={16} />
                {agentDir.split(/[/\\]/).filter(Boolean).pop()}
              </span>
            )}
            {/* Session title — click to rename */}
            {sessionTitle && sessionTitle !== 'New Tab' && sessionTitle !== 'New Chat' && (
              <>
                <span className="flex-shrink-0 text-[var(--ink-subtle)]">/</span>
                <SessionTitleEditor
                  ref={titleEditorRef}
                  title={sessionTitle}
                  onRename={(newTitle) => onRenameSession?.(newTitle)}
                />
              </>
            )}
            <UserTagPills
              tags={sessionMeta?.userTags}
              onTagClick={(name) => onOpenHistoryTag?.(name)}
              className="max-w-56"
            />
            {/* Surface tags (channel/cron/floating-ball pill) — display-only since the menu owns actions */}
            <SessionSurfaceTags
              channel={surfaces.channel}
              cron={surfaces.cron}
              floatingBall={!!sessionId && resolveFloatingBallBoundSession(config) === sessionId}
            />
            {/* Session ⋯ menu — rename/favorite/export/stats/bot binding/delete */}
            {sessionId && agentDir && (
              <SessionMenuButton
                sessionId={sessionId}
                sessionTitle={sessionTitle ?? t('shell.currentChatFallback')}
                workspacePath={agentDir}
                boundChannel={surfaces.channel}
                availableChannels={availableHandoverChannels}
                deleteProtected={sessionDeleteProtected}
                favorite={!!sessionMeta?.favorite}
                userTags={sessionMeta?.userTags}
                // The inline editor only mounts once a session has a real
                // title (see the `sessionTitle && sessionTitle !== 'New Tab' …`
                // gate above). Mirror that condition here so the menu's
                // 重命名 row reflects whether the editor exists to open.
                canRename={!!sessionTitle && sessionTitle !== 'New Tab' && sessionTitle !== 'New Chat'}
                // `/context` is a builtin SDK slash command — external runtimes
                // (Claude Code CLI / Codex / Gemini) don't share this surface,
                // so we omit the callback and let the menu hide the row entirely.
                onShowContext={isExternalRuntime ? undefined : () => { void handleSendMessageRef.current('/context'); }}
                onOpenRename={() => titleEditorRef.current?.openRename()}
                onFavoriteChanged={(_, updated) => { if (updated) setSessionMeta(updated); }}
                onSessionMetadataMutationStart={taskCenterActions.beginSessionMetadataMutation}
                onSessionMetadataChanged={(updated, mutationSequence) => {
                  const accepted = taskCenterActions.applySessionMetadata(updated, mutationSequence);
                  if (accepted) setSessionMeta(updated);
                  return accepted;
                }}
                onGlobalTagChange={() => taskCenterActions.refreshSessions()}
              />
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {/* New Session button - before History */}
            <button
              type="button"
              onClick={handleNewSession}
              className="flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              title={t('shell.header.newChat')}
            >
              <MessageSquarePlus className="h-3.5 w-3.5 flex-shrink-0" />
              {!splitFile && <span>{t('shell.header.newChatShort')}</span>}
            </button>
            {/* Developer setting keeps this legacy entry reversible while it is phased out. */}
            {isChatHistoryEntryVisible && (
              <>
                {/* History button */}
                <button
                  ref={historyBtnRef}
                  type="button"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => setShowHistory((prev) => !prev)}
                  className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-sm font-medium transition-colors ${showHistory
                    ? 'bg-[var(--paper-inset)] text-[var(--ink)]'
                    : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
                    }`}
                >
                  <History className="h-3.5 w-3.5 flex-shrink-0" />
                  {!splitFile && <span>{t('shell.header.history')}</span>}
                </button>
                <SessionHistoryDropdown
                  agentDir={agentDir}
                  currentSessionId={sessionId}
                  onSelectSession={(id, title) => handleSelectSession(id, title, 'chat_dropdown')}
                  onOpenInNewTab={onOpenSessionInNewTab}
                  isOpen={showHistory}
                  onClose={() => setShowHistory(false)}
                  triggerRef={historyBtnRef}
                  sessionNotificationBadgeCounts={sessionNotificationBadgeCounts}
                />
              </>
            )}
            {/* Dev-only buttons - controlled by config.showDevTools */}
            {config.showDevTools && (
              <>
                <button
                  type="button"
                  onClick={() => setShowLogs((prev) => !prev)}
                  className={`rounded-lg px-2.5 py-1 text-sm font-medium transition-colors ${showLogs
                    ? 'bg-[var(--paper-inset)] text-[var(--ink)]'
                    : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
                    }`}
                >
                  Logs
                </button>
                </>
            )}
            {/* Workspace toggle button - always visible when workspace is hidden */}
            {!showWorkspace && (
              <Tip label={t('shell.header.expandWorkspace')} position="bottom" align="end">
                <button
                  type="button"
                  onClick={handleExpandWorkspace}
                  aria-label={t('shell.header.expandWorkspace')}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                >
                  <PanelRight className="h-4 w-4" />
                </button>
              </Tip>
            )}
          </div>
        </div>

        {/* Content area with relative positioning for floating input */}
        <div
          ref={chatContentRef}
          className="relative flex flex-1 flex-col overflow-hidden"
          {...dragHandlers}
        >
          {/* In-page text finder — Cmd/Ctrl+F */}
          {chatSearchOpen && (
            <ChatSearchPanel controller={chatSearch} onClose={closeChatSearch} />
          )}
          {/* Drop zone overlay for file drag */}
          <DropZoneOverlay
            isVisible={isAnyDragActive && (!isTauriDragging || activeZoneId === 'chat-content' || activeZoneId === null)}
            message={t('shell.dropZone.message')}
            subtitle={t('shell.dropZone.subtitle')}
          />

          {/* Unified boot overlay — same component App renders as the lazy-Chat
              Suspense fallback, so the chunk-load → mount handoff is seamless: ONE
              continuous "AI 启动中" state from the Launcher→Chat flip through the
              sidecar boot. Persisted history keeps the same shell until its REST
              projection commits, so cold SSE replay is never a visible phase. */}
          <ChatBootOverlay
            show={showStartupOverlay || isSessionLoading}
            error={sessionRestoreError}
            onRetry={sessionRestoreError && sessionId
              ? () => { void retryCurrentSessionRestore(); }
              : undefined}
          />

          {/* SDK 0.2.91+ terminal_reason banner. For error-severity reasons that
              already surface via agentError (image_error / model_error), suppress
              this banner to avoid double-stacking ~80px of banner region. agentError
              carries the richer provider-level message; the reason banner's info
              would just duplicate it. notice/info-severity reasons (max_turns,
              prompt_too_long, etc.) still render alongside agentError since they
              carry actionable signals agentError doesn't. */}
          <TerminalReasonBanner
            reason={agentError ? null : lastTerminalReason}
            onDismiss={() => setLastTerminalReason(null)}
            onNewSession={handleNewSession}
            onDiagnose={handleDiagnoseTerminalReason}
          />

          {/* Issue #194 — external-runtime self-diagnostic banner. Only renders
              for actionable auth/runtime/extension failures. Normal lifecycle
              and isolated diagnostic failures stay in diagnostics/logs. */}
          <RuntimeDiagnosticsBanner
            diagnostics={runtimeDiagnostics}
            onDiagnose={handleDiagnoseRuntimeDiagnostics}
          />

          {agentError && (() => {
            // Find the last real user message — drives both the oversized-image
            // rewind hint and the banner-level "重新发送" button (issue #183).
            const msgs = messagesRef.current;
            let lastUserMsg: typeof msgs[number] | null = null;
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'user' && !msgs[i].id.startsWith('task-notification-')) { lastUserMsg = msgs[i]; break; }
            }
            const canRetry = !!lastUserMsg && !isLoading;
            return (
            <div className="relative z-10 flex-shrink-0 border-b border-[var(--line)] bg-[var(--paper-inset)] px-4 py-2 text-xs text-[var(--ink)]">
              <div className="mx-auto flex max-w-3xl items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
                <div className="flex-1">
                  <span className="font-semibold text-[var(--ink)]">{t('shell.agentError.title')}</span>
                  <span className="text-[var(--ink-muted)]">{agentError}</span>
                  {/* Oversized image hint: detect API 400 about image dimensions and offer rewind.
                      Pattern synced with backend (agent-session.ts shouldResetSessionAfterError).
                      Known API error: "...image dimensions exceed max allowed size: 8000 pixels" */}
                  {lastUserMsg && /image.*exceed.*max allowed size/i.test(agentError) && (
                    <div className="mt-1">
                      <span className="text-[var(--ink-muted)]">{t('shell.agentError.imageTooLargePrefix')}</span>
                      <button
                        type="button"
                        onClick={() => { setAgentError(null); handleRewind(lastUserMsg!.id); }}
                        className="text-[var(--accent)] underline underline-offset-2 hover:text-[var(--accent-hover)]"
                      >
                        {t('shell.agentError.rewindAction')}
                      </button>
                    </div>
                  )}
                </div>
                <div className="flex flex-shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleDiagnoseAgentError(agentError)}
                    className="rounded p-0.5 text-[var(--ink-subtle)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--accent)]"
                    title={t('shell.diagnostics.askHelper')}
                    aria-label={t('shell.diagnostics.askHelper')}
                  >
                    <Bot className="h-3.5 w-3.5" />
                  </button>
                  {canRetry && (
                    <button
                      type="button"
                      onClick={handleRetryLastUserMessage}
                      className="flex items-center gap-1 rounded-md px-2 py-0.5 text-sm font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-warm-subtle)]"
                    >
                      <RotateCcw className="h-3 w-3" />
                      {t('shell.agentError.resend')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setAgentError(null)}
                    className="flex-shrink-0 rounded p-0.5 text-[var(--ink-subtle)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink-muted)]"
                    title={t('shell.common.close')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
            );
          })()}
          {/* Unified Logs Panel - fullscreen modal displaying logs */}
          <UnifiedLogsPanel
            sseLogs={unifiedLogs}
            isVisible={showLogs}
            onClose={() => setShowLogs(false)}
            onClearAll={clearUnifiedLogs}
          />

          {/* Query Navigator — floating right-side panel for quick session navigation */}
          <QueryNavigator
            messages={chatScrollModel.data}
            scrollContainerRef={scrollerRef as React.RefObject<HTMLDivElement | null>}
            pauseAutoScroll={pauseAutoScroll}
            onNavigateToQuery={handleNavigateToQuery}
          />

          {/* Message list with max-width */}
          <BrowserPanelContext.Provider value={browserPanelCtx}>
          {/*
            FileActionProvider.refreshTrigger intentionally excludes
            toolCompleteCount. toolCompleteCount bumps when AI file-modifying
            tools complete, and tying every completion to a full cache wipe
            caused requery storms. The ref-counted workspace watcher is the
            filesystem mutation authority; FileActionProvider invalidates the
            old affordance and mounted consumers lazily re-request in batches.
            Explicit UI refreshes remain a second controlled source.
          */}
          <FileActionProvider
            workspacePath={agentDir}
            onInsertReference={handleInsertReference}
            refreshTrigger={workspaceRefreshTrigger + workspaceChangeSignal}
            onFilePreviewExternal={isSplitViewEnabled && !isNarrowLayout ? handleSplitFilePreview : undefined}
            onQuoteFile={handleQuoteFile}
            onQuoteSelection={handleQuoteFileSelection}
            onRevealInTree={handleRevealInTree}
          >
            <MessageList
              messages={chatScrollModel.data}
              streamingMessage={streamingMessage}
              firstItemIndex={chatScrollModel.firstItemIndex}
              heightEstimateSeed={chatScrollModel.heightEstimateSeed}
              layoutByMessageId={chatScrollModel.layoutByMessageId}
              onLoadOlder={handleLoadOlderMessages}
              isLoading={isLoading}
              getQueryElapsedSeconds={getQueryElapsedSeconds}
              sessionId={sessionId}
              isActive={isActive}
              windowPresentation={windowPresentation}
              onViewportAdmissionChanged={onViewportAdmissionChanged}
              onItemsRendered={onItemsRendered}
              isViewportRecoveryFenced={isViewportRecoveryFenced}
              virtuosoRef={virtuosoRef}
              onScrollerRef={attachScroller}
              followEnabledRef={followEnabledRef}
              scrollToBottom={scrollToBottom}
              handleAtBottomChange={handleAtBottomChange}
              onRowLayoutChanged={onRowLayoutChanged}
              pendingPermission={pendingPermission}
              onPermissionDecision={handlePermissionDecision}
              pendingAskUserQuestion={pendingAskUserQuestion}
              onAskUserQuestionSubmit={handleAskUserQuestionSubmit}
              onAskUserQuestionCancel={handleAskUserQuestionCancel}
              pendingExitPlanMode={pendingExitPlanMode}
              onExitPlanModeApprove={handleExitPlanModeApprove}
              onExitPlanModeReject={handleExitPlanModeReject}
              systemStatus={rewindStatus || systemStatus}
              systemNotice={systemNotice}
              onDismissSystemNotice={handleDismissSystemNotice}
              isStreaming={isLoading || sessionState === 'running' || sessionState === 'starting'}
              sessionState={sessionState}
              onRewind={isExternalRuntime
                ? (codexConversationBranchSupported
                  && !isLoading
                  && sessionState === 'idle'
                  && queuedMessages.length === 0
                  && !forkPending
                  && !rewindStatus
                    ? handleRewind
                    : undefined)
                : handleRewind}
              onRetry={handleRetry}
              onFork={isExternalRuntime
                ? (codexConversationBranchSupported
                  && !isLoading
                  && sessionState === 'idle'
                  && queuedMessages.length === 0
                  && !forkPending
                  && !rewindStatus
                    ? handleFork
                    : undefined)
                : handleFork}
              conversationOperations={currentRuntime === 'codex' ? 'codex' : 'builtin'}
              rewindableUserMessageIds={rewindableUserMessageIds}
              bottomSpacerPx={inputOverlayHeight}
            />

            {/* Introduction overlay — shown in empty sessions when INTRODUCTION.md exists */}
            {showIntroductionOverlay && introductionContent && (
              <Suspense fallback={null}>
                <LazyIntroductionOverlay content={introductionContent} />
              </Suspense>
            )}

            {/* Inline cron task card — shown in message flow after creating a "新开对话" task */}
            {cronCardTask && (
              <div className="mx-auto w-full max-w-3xl px-4 py-2">
                <CronTaskCard
                  taskId={cronCardTask.id}
                  name={cronCardTask.name || cronCardTask.prompt.slice(0, 20)}
                  scheduleDesc={formatCronScheduleDescription(cronCardTask, tTask, taskLocale)}
                  onOpenDetail={task => { setCronDetailTask(task); setCronCardTask(null); }}
                />
              </div>
            )}
          </FileActionProvider>
          </BrowserPanelContext.Provider>

          {/* Text selection floating menu for quoting AI text */}
          <SelectionCommentMenu
            onQuote={handleQuoteSelection}
            onElaborate={handleElaborateSelection}
          />

          {/* Floating input with integrated cron task components.
              PRD 0.2.17 — AgentStatusPanel (Todo + SubAgent 聚合) 现在作为 slot
              传给 SimpleChatInput，与 QueuedMessagesPanel 同居一个 flex 行，避
              免两者用各自的 absolute 定位在输入框上方同 Y 抢同一片右上角导致
              z-20 paint-order 冲突（v0.2.19 修复：发消息时 queue panel 把 Todo
              覆盖掉）。Lazy mount 仍由 AgentStatusPanel 内部判定（未触发
              TodoWrite / Task 工具时返回 null）。外部 Runtime 下 slot 直接传
              undefined，避免它们若未来 emit 出 `tool.name === 'Task'` 的归一化
              事件意外触发面板（PRD D15）。onJumpToTool 由 Chat 实现是因为
              具体滚动由 ChatScrollController 统一处理。 */}
          <SimpleChatInput
            ref={chatInputRef}
            onSend={handleSendMessage}
            onStop={handleStop}
            active={isActive}
            sendBlocked={isSessionLoading}
            isLoading={isLoading || sessionState === 'running' || sessionState === 'starting'}
            sessionState={sessionState}
            systemStatus={systemStatus}
            agentDir={agentDir}
            workspacePath={agentDir}
            sessionId={sessionId}
            showBuiltinSdkSlashCommands={showBuiltinSdkSlashCommands}
            clientActionSlashCommands={runtimeClientActionSlashCommands}
            workspaceSlashCommands={workspaceCapabilitySlashCommands}
            sdkSlashCommands={visibleSdkSlashCommands}
            provider={currentProvider}
            providers={providers}
            providerAvailable={currentProviderAvailableForInput}
            availableProviderIds={availableProviderIdsForInput}
            providerUnavailableMessage={builtinSnapshotProviderSelectionIncomplete
              ? t('shell.toasts.reselectModelFirst')
              : undefined}
            onProviderChange={handleProviderChange}
            selectedModel={inputUsesExternalRuntimeControls ? runtimeModel : selectedModel}
            onBuiltinModelSelect={inputUsesExternalRuntimeControls ? undefined : handleBuiltinModelSelect}
            onModelChange={inputUsesExternalRuntimeControls ? handleRuntimeModelChange : handleModelChange}
            reasoningEffort={reasoningEffort}
            onReasoningEffortChange={handleReasoningEffortChange}
            contextIndicator={contextIndicatorSlot}
            permissionMode={inputChromePermissionMode}
            onPermissionModeChange={handleInputPermissionModeChange}
            apiKeys={apiKeys}
            providerVerifyStatus={providerVerifyStatus}
            inputRef={inputRef}
            workspaceMcpEnabled={workspaceMcpEnabled}
            globalMcpEnabled={globalMcpEnabled}
            mcpServers={mcpServers}
            runtimeMcpTools={runtimeMcpTools}
            mcpEffectiveSnapshot={mcpEffectiveSnapshot}
            onWorkspaceMcpToggle={handleWorkspaceMcpToggle}
            officialTools={OFFICIAL_TOOLS}
            workspaceOfficialToolEnabled={workspaceOfficialToolEnabled}
            globalOfficialToolEnabled={globalOfficialToolEnabled}
            officialToolNeedsConfig={officialToolNeedsConfig}
            onWorkspaceOfficialToolToggle={handleWorkspaceOfficialToolToggle}
            // PRD 0.2.17 — Claude plugins. globallyVisiblePlugins is the
            // Layer 1 (Settings 开关 ON) candidate list; workspaceEnabledPlugins
            // is the Layer 2 actually-enabled subset for this workspace.
            globallyVisiblePlugins={globallyVisiblePlugins}
            workspaceEnabledPlugins={workspaceEnabledPlugins}
            onWorkspacePluginToggle={handleWorkspacePluginToggle}
            onRefreshProviders={refreshProviderData}
            onOpenAgentSettings={handleOpenAgentSettings}
            onWorkspaceRefresh={triggerWorkspaceRefresh}
            // Cron task props - the non-blocking status bar is rendered inside SimpleChatInput.
            cronModeEnabled={cronState.isEnabled}
            cronConfig={cronState.config}
            goalDraftActive={goalDraftConfig !== null}
            cronTask={cronState.task}
            sessionGoal={sessionGoalState.goal}
            stoppedCronTask={stoppedCronTaskForInput}
            cronIsExecuting={cronState.isExecuting}
            cronExecutionNumber={cronState.executionNumber}
            goalIsExecuting={sessionGoalState.isExecuting}
            goalExecutionNumber={sessionGoalState.executionNumber}
            composerConfigLockedReason={composerConfigLockedReason}
            onCronButtonClick={handleOpenCronSettings}
            onCronSettings={handleOpenCronSettings}
            onCronCancel={handleCronDraftCancel}
            onGoalDraftSettings={handleGoalDraftSettings}
            onGoalDraftCancel={handleGoalDraftCancel}
            onCronStop={handleCronStop}
            onCronDismissStopped={handleCronDismissStopped}
            onGoalEdit={handleGoalEditOpen}
            onGoalResume={() => { void resumeGoal(); }}
            onGoalCancel={handleGoalCancelOpen}
            onGoalDismiss={handleGoalDismiss}
            onSlashAction={handleSlashAction}
            runtime={inputChromeRuntime}
            runtimeDetections={showLegacyRuntimeSelector ? runtimeDetections : undefined}
            onRuntimeChange={showLegacyRuntimeSelector ? handleRuntimeChange : undefined}
            runtimeModels={inputUsesExternalRuntimeControls ? runtimeModels : undefined}
            runtimePermissionModes={inputUsesExternalRuntimeControls ? runtimePermissionModes : undefined}
            queuedMessages={queuedMessages}
            onCancelQueued={handleCancelQueuedVoid}
            onForceExecuteQueued={handleForceExecuteQueuedVoid}
            agentStatusSlot={agentStatusSlot}
            onOverlayHeightChange={handleInputOverlayHeightChange}
          />
        </div>
      </div>

      {/* Workspace panel — single instance, container style switches between side panel and overlay */}
      {workspacePanelMounted && (
        <>
          {/* Click-away layer for overlay mode */}
          {showWorkspace && shouldUseWorkspaceOverlay && (
            <OverlayBackdrop
              onClose={handleCollapseWorkspace}
              className="!absolute z-40 !block !bg-transparent !backdrop-blur-none"
            >
              {null}
            </OverlayBackdrop>
          )}
          <div
            ref={directoryPanelContainerRef}
            className={shouldUseWorkspaceOverlay
              ? 'absolute bottom-0 right-0 top-0 z-50 flex w-[340px] max-w-[85%] flex-col bg-[var(--paper-elevated)] shadow-lg'
              : showWorkspace
                ? 'relative z-10 flex w-[var(--chat-workspace-panel-width)] shrink-0 flex-col'
                : 'pointer-events-none absolute bottom-0 right-0 top-0 z-20 flex w-[var(--chat-workspace-panel-width)] flex-col'
            }
            aria-hidden={!showWorkspace}
            inert={!showWorkspace}
            data-chat-workspace-panel
            data-chat-workspace-panel-motion={workspacePanelMotion ?? undefined}
          >
            <span
              aria-hidden="true"
              className={`pointer-events-none absolute bottom-4 left-0 top-4 z-20 w-px ${
                shouldUseWorkspaceOverlay ? 'bg-[var(--line)]' : 'bg-[var(--line-subtle)]'
              }`}
              data-chat-workspace-divider
            />
            <DirectoryPanel
              ref={directoryPanelRef}
              agentDir={agentDir}
              projectIcon={currentProject?.icon}
              projectDisplayName={currentProject?.displayName}
              provider={currentProvider}
              providers={providers}
              onProviderChange={handleProviderChange}
              onCollapse={handleCollapseWorkspace}
              onOpenConfig={handleOpenAgentSettings}
              refreshTrigger={toolCompleteCount + workspaceRefreshTrigger}
              persistedTreeStateRef={workspaceTreeStateRef}
              isTauriDragActive={isTauriDragging && activeZoneId === 'directory-panel'}
              onInsertReference={handleInsertReference}
              onQuoteFile={handleQuoteFile}
              onQuoteSelection={handleQuoteFileSelection}
              externalRevealRequest={treeExternalReveal}
              onExternalRevealHandled={handleExternalRevealHandled}
              enabledAgents={enabledAgents}
              enabledSkills={enabledSkills}
              enabledCommands={enabledCommands}
              globalSkillFolderNames={globalSkillFolderNames}
              onInsertSlashCommand={handleInsertSlashCommand}
              onOpenSettings={handleOpenSettings}
              onSyncSkillToGlobal={handleSyncSkillToGlobal}
              onRefreshAll={triggerWorkspaceRefresh}
              onFilePreviewExternal={isSplitViewEnabled && !isNarrowLayout ? handleSplitFilePreview : undefined}
              onOpenTerminal={isSplitViewEnabled && !isNarrowLayout ? handleOpenTerminal : undefined}
              terminalAlive={terminalAlive}
              onOpenBrowser={isSplitViewEnabled && !isNarrowLayout ? handleOpenBrowser : undefined}
            />
          </div>
        </>
      )}
      </div>{/* End left-side wrapper */}

      {/* Split view: draggable divider + right panel.
          Rendered when panel is visible OR terminal is alive (to preserve xterm.js state).
          Uses `hidden` CSS when panel is not visible but terminal is alive in background. */}
      {(splitPanelVisible || terminalMounted) && (
        <>
          {/* Draggable divider — hidden when panel is not visible */}
          <div
            className={`z-10 flex w-1 cursor-col-resize items-center justify-center bg-[var(--line)] transition-colors hover:bg-[var(--accent)] ${!splitPanelVisible || browserUsesFullscreen ? 'hidden' : ''}`}
            onMouseDown={handleSplitDividerMouseDown}
          >
            <div className="h-8 w-0.5 rounded-full bg-[var(--ink-subtle)]" />
          </div>
          {/* Right panel — single flex-1 container for tab bar + file + terminal.
              Uses `hidden` when panel is not visible but terminal is alive in background. */}
          <div className={browserUsesFullscreen
            ? 'absolute inset-0 z-30 flex min-w-0 flex-col overflow-hidden bg-[var(--paper)]'
            : `flex min-w-0 flex-1 flex-col overflow-hidden ${!splitPanelVisible ? 'hidden' : ''}`}
          >
            {/* Tab switcher — only when 2+ views are active */}
            {(() => {
              const activeViews = [splitFile, terminalPinned && terminalAlive, browserUrl].filter(Boolean).length;
              return activeViews >= 2;
            })() && (
              <div className="flex h-9 flex-shrink-0 items-center gap-0.5 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-2">
                {/* File tab + its own × */}
                {splitFile && (
                  <button
                    type="button"
                    onClick={() => setSplitActiveView('file')}
                    className={`group relative flex items-center gap-1 rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${
                      splitActiveView === 'file'
                        ? 'text-[var(--ink)]'
                        : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                    }`}
                  >
                    <span className="max-w-[120px] truncate">{splitFile.name}</span>
                    <span
                      role="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        splitFilePreviewRef.current?.close();
                      }}
                      className="ml-0.5 flex h-5 w-5 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--paper-inset)] group-hover:opacity-100"
                      title={t('shell.split.closeFile')}
                    >
                      <span className="text-sm leading-none text-[var(--ink-muted)]">×</span>
                    </span>
                    {splitActiveView === 'file' && (
                      <div className="absolute inset-x-1 -bottom-[5px] h-[2px] rounded-full bg-[var(--accent-warm)]" />
                    )}
                  </button>
                )}
                {/* Terminal tab + its own × */}
                {terminalPinned && terminalAlive && (
                  <button
                    type="button"
                    onClick={() => setSplitActiveView('terminal')}
                    className={`group relative flex items-center gap-1 rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${
                      splitActiveView === 'terminal'
                        ? 'text-[var(--ink)]'
                        : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                    }`}
                  >
                    <TerminalSquare className="h-3 w-3" />
                    {t('shell.split.terminal')}
                    <span
                      role="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setTerminalPinned(false);
                        if (browserUrl) setSplitActiveView('browser');
                        else if (splitFile) setSplitActiveView('file');
                      }}
                      className="ml-0.5 flex h-5 w-5 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--paper-inset)] group-hover:opacity-100"
                      title={t('shell.split.hideTerminal')}
                    >
                      <span className="text-sm leading-none text-[var(--ink-muted)]">×</span>
                    </span>
                    {splitActiveView === 'terminal' && (
                      <div className="absolute inset-x-1 -bottom-[5px] h-[2px] rounded-full bg-[var(--accent-warm)]" />
                    )}
                  </button>
                )}
                {/* Browser tab + its own × */}
                {browserUrl && (
                  <button
                    type="button"
                    onClick={() => setSplitActiveView('browser')}
                    className={`group relative flex items-center gap-1 rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${
                      splitActiveView === 'browser'
                        ? 'text-[var(--ink)]'
                        : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                    }`}
                  >
                    <Globe className="h-3 w-3" />
                    <span className="max-w-[120px] truncate">
                      {browserSourceFile
                        ? browserSourceFile.name
                        : (() => {
                            // Prefer the live URL surfaced from BrowserPanel — the
                            // `browserUrl` prop is the seed only and stays at
                            // BROWSER_BLANK_URL even after the user navigates.
                            const liveUrl = browserCurrentUrl || browserUrl;
                            try {
                              return new URL(liveUrl).hostname || t('shell.split.newTab');
                            } catch {
                              return t('shell.split.browser');
                            }
                          })()}
                    </span>
                    <span
                      role="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleBrowserClose();
                      }}
                      className="ml-0.5 flex h-5 w-5 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--paper-inset)] group-hover:opacity-100"
                      title={t('shell.split.closeBrowser')}
                    >
                      <span className="text-sm leading-none text-[var(--ink-muted)]">×</span>
                    </span>
                    {splitActiveView === 'browser' && (
                      <div className="absolute inset-x-1 -bottom-[5px] h-[2px] rounded-full bg-[var(--accent-warm)]" />
                    )}
                  </button>
                )}
              </div>
            )}

            {/* File preview view */}
            {splitFile && (
              <div className={`flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--paper-elevated)] ${splitActiveView !== 'file' ? 'hidden' : ''}`}>
                <Suspense fallback={<div className="flex h-full items-center justify-center text-[var(--ink-muted)]"><Loader2 className="h-5 w-5 animate-spin" /></div>}>
                  <FilePreviewModal
                    ref={splitFilePreviewRef}
                    name={splitFile.name}
                    content={splitFile.content}
                    size={splitFile.size}
                    path={splitFile.path}
                    localPath={splitFile.localPath}
                    richDocKind={splitFile.richDocKind}
                    workspacePath={splitFile.sourceScope === 'local' ? null : agentDir}
                    initialEditMode={splitFile.initialEditMode}
                    initialLineNumber={splitFile.initialLineNumber}
                    focusTarget={splitFile.focusTarget}
                    externalRefreshSignal={toolCompleteCount}
                    onExternalContentUpdated={(updated) => {
                      setSplitFile(prev => prev && prev.path === updated.path
                        ? { ...prev, name: updated.name, content: updated.content, size: updated.size, initialEditMode: undefined }
                        : prev);
                    }}
                    onClose={() => {
                      setSplitFile(null);
                      if (browserUrl) setSplitActiveView('browser');
                      else if (terminalPinned && terminalAlive) setSplitActiveView('terminal');
                    }}
                    onSaved={() => setWorkspaceRefreshTrigger(prev => prev + 1)}
                    onRenamed={(newPath, newName) => {
                      setSplitFile(prev => prev ? { ...prev, path: newPath, name: newName, initialEditMode: undefined } : prev);
                      setWorkspaceRefreshTrigger(prev => prev + 1);
                    }}
                    embedded
                    onFullscreen={(currentContent) => {
                      const file = currentContent !== undefined ? { ...splitFile!, content: currentContent } : splitFile!;
                      setSplitFile(null);
                      setFullscreenPreviewFile(file);
                    }}
                    onSwitchToBrowser={browserUrl ? handleEditorSwitchToBrowser : undefined}
                    onQuoteFile={handleQuoteFile}
                    onRevealInTree={handleRevealInTree}
                    onQuoteSelection={handleQuoteFileSelection}
                  />
                </Suspense>
              </div>
            )}

            {/* Terminal — INSIDE the right panel div (same flex column).
                Stays mounted while alive, uses `hidden` when not the active view. */}
            {terminalMounted && (
              <div className={`flex min-w-0 flex-1 flex-col overflow-hidden ${splitActiveView !== 'terminal' ? 'hidden' : ''}`}>
                {/* Terminal header — only when tab switcher is NOT showing (single view) */}
                {[splitFile, terminalPinned && terminalAlive, browserUrl].filter(Boolean).length < 2 && (
                  <div className="flex h-9 flex-shrink-0 items-center justify-between bg-[var(--paper)] px-3">
                    <div className="flex items-center gap-1.5">
                      <TerminalSquare className="h-3.5 w-3.5 text-[var(--ink)]" />
                      <span className="text-sm font-medium text-[var(--ink)]">{t('shell.split.terminal')}</span>
                      <span className="text-xs text-[var(--ink-muted)]">
                        {agentDir ? `~/${agentDir.split(/[/\\]/).pop()}` : ''}
                      </span>
                    </div>
                    <Tip label={t('shell.split.hideTerminal')} position="bottom">
                      <button
                        type="button"
                        onClick={() => {
                          setTerminalPinned(false);
                          if (browserUrl) setSplitActiveView('browser');
                          else if (splitFile) setSplitActiveView('file');
                        }}
                        className="flex h-5 w-5 items-center justify-center rounded text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </Tip>
                  </div>
                )}
                <Suspense fallback={<div className="flex h-full items-center justify-center bg-[var(--paper)]"><Loader2 className="h-5 w-5 animate-spin text-[var(--ink-muted)]" /></div>}>
                  <LazyTerminalPanel
                    workspacePath={agentDir}
                    terminalId={terminalId}
                    sessionId={sessionId}
                    isVisible={splitPanelVisible && splitActiveView === 'terminal'}
                    onTerminalCreated={(id) => {
                      setTerminalId(id);
                      setTerminalAlive(true);
                    }}
                    onTerminalExited={() => {
                      const deadId = terminalId;
                      setTerminalAlive(false);
                      setTerminalPinned(false);
                      setTerminalId(null);
                      if (deadId) {
                        import('@tauri-apps/api/core').then(({ invoke: inv }) => {
                          inv('cmd_terminal_close', { terminalId: deadId }).catch(() => {});
                        });
                      }
                    }}
                  />
                </Suspense>
              </div>
            )}

            {/* Browser — embedded Tauri child Webview */}
            {browserUrl && (
              <div className={`flex min-w-0 flex-1 flex-col overflow-hidden ${splitActiveView !== 'browser' ? 'hidden' : ''}`}>
                <Suspense fallback={<div className="flex h-full items-center justify-center bg-[var(--paper)]"><Loader2 className="h-5 w-5 animate-spin text-[var(--ink-muted)]" /></div>}>
                  <LazyBrowserPanel
                    tabId={tabId}
                    url={browserUrl}
                    isVisible={isActive && splitPanelVisible && splitActiveView === 'browser'}
                    isDraggingSplit={isDraggingSplit}
                    isSplitTransitioning={isSplitWidthTransitioning}
                    browserAlive={browserAlive}
                    reloadSignal={browserReloadSignal}
                    sourceFile={browserSourceFile}
                    workspace={agentDir}
                    onBrowserCreated={handleBrowserCreated}
                    onCreateFailed={handleBrowserCreateFailed}
                    onClose={handleBrowserClose}
                    onSwitchToEditor={handleBrowserSwitchToEditor}
                    onUrlChange={handleBrowserUrlChange}
                  />
                </Suspense>
              </div>
            )}
          </div>
        </>
      )}

      {/* Fullscreen preview from split panel */}
      {fullscreenPreviewFile && (
        <Suspense fallback={null}>
          <FilePreviewModal
            name={fullscreenPreviewFile.name}
            content={fullscreenPreviewFile.content}
            size={fullscreenPreviewFile.size}
            path={fullscreenPreviewFile.path}
            localPath={fullscreenPreviewFile.localPath}
            richDocKind={fullscreenPreviewFile.richDocKind}
            workspacePath={fullscreenPreviewFile.sourceScope === 'local' ? null : agentDir}
            initialEditMode={fullscreenPreviewFile.initialEditMode}
            initialLineNumber={fullscreenPreviewFile.initialLineNumber}
            focusTarget={fullscreenPreviewFile.focusTarget}
            externalRefreshSignal={toolCompleteCount}
            onExternalContentUpdated={(updated) => {
              setFullscreenPreviewFile(prev => prev && prev.path === updated.path
                ? { ...prev, name: updated.name, content: updated.content, size: updated.size, initialEditMode: undefined }
                : prev);
            }}
            onClose={() => setFullscreenPreviewFile(null)}
            onSaved={() => setWorkspaceRefreshTrigger(prev => prev + 1)}
            onRenamed={(newPath, newName) => {
              setFullscreenPreviewFile(prev => prev ? { ...prev, path: newPath, name: newName, initialEditMode: undefined } : prev);
              setWorkspaceRefreshTrigger(prev => prev + 1);
            }}
            onQuoteFile={handleQuoteFile}
            onRevealInTree={handleRevealInTree}
            onQuoteSelection={handleQuoteFileSelection}
          />
        </Suspense>
      )}

      {/* Workspace Config Panel */}
      {showWorkspaceConfig && (
        <WorkspaceConfigPanel
          agentDir={agentDir}
          onClose={() => {
            setShowWorkspaceConfig(false);
            setWorkspaceConfigInitialTab(undefined);
            setWorkspaceConfigInitialSelect(undefined);
            // Refresh capabilities data in case settings were changed
            setWorkspaceRefreshTrigger(prev => prev + 1);
            setIntroductionRefreshTrigger(prev => prev + 1);
          }}
          refreshKey={workspaceRefreshKey}
          initialTab={workspaceConfigInitialTab}
          initialSelect={workspaceConfigInitialSelect}
          onRequestInit={handleRequestInitFromSettings}
        />
      )}

      {/* Cross-Runtime Session Confirm Dialog */}
      {pendingCrossRuntimeMessage && (
        <ConfirmDialog
          title={t('shell.dialogs.crossRuntime.title')}
          message={t('shell.dialogs.crossRuntime.message', {
            sessionRuntime: getRuntimeDisplayLabel(sessionRuntime as RuntimeType | undefined),
            currentRuntime: getRuntimeDisplayLabel(currentRuntime),
          })}
          confirmText={t('shell.dialogs.crossRuntime.confirm')}
          cancelText={t('shell.common.cancel')}
          onConfirm={confirmCrossRuntimeSend}
          onCancel={() => setPendingCrossRuntimeMessage(null)}
        />
      )}

      {/* Runtime Switch Confirm Dialog (v0.1.59) */}
      {pendingRuntimeChange && (() => {
        const label = getRuntimeDisplayLabel(pendingRuntimeChange);
        return (
          <ConfirmDialog
            title={t('shell.dialogs.runtimeSwitch.title')}
            message={
              t('shell.dialogs.runtimeSwitch.message', {
                currentRuntime: getRuntimeDisplayLabel(currentRuntime),
                targetRuntime: label,
              })
            }
            confirmText={t('shell.dialogs.runtimeSwitch.confirm')}
            cancelText={t('shell.common.cancel')}
            onConfirm={confirmRuntimeChange}
            onCancel={() => setPendingRuntimeChange(null)}
          />
        );
      })()}

      {/* Provider / Model History-Boundary Confirm Dialog */}
      {pendingProviderSwitch && (
        <ConfirmDialog
          title={providerSwitchDialogCopy?.title ?? t('shell.providerSwitch.newSessionTitle')}
          message={providerSwitchDialogCopy?.message ?? t('shell.providerSwitch.defaultMessage')}
          confirmText={providerSwitchDialogCopy?.confirmText ?? t('shell.providerSwitch.createNewSession')}
          cancelText={t('shell.common.cancel')}
          onConfirm={confirmProviderSwitch}
          onCancel={() => setPendingProviderSwitch(null)}
        />
      )}

      {/* Time Rewind Confirm Dialog */}
      {rewindTarget && (
        <ConfirmDialog
          title={t(currentRuntime === 'codex' ? 'shell.dialogs.codexRewind.title' : 'shell.dialogs.rewind.title')}
          message={t(currentRuntime === 'codex'
            ? (rewindTarget.replacesDraft ? 'shell.dialogs.codexRewind.messageWithDraft' : 'shell.dialogs.codexRewind.message')
            : 'shell.dialogs.rewind.message')}
          confirmText={t(currentRuntime === 'codex' ? 'shell.dialogs.codexRewind.confirm' : 'shell.dialogs.rewind.confirm')}
          cancelText={t('shell.common.cancel')}
          confirmVariant="danger"
          onConfirm={handleRewindConfirm}
          onCancel={() => setRewindTarget(null)}
        />
      )}

      {/* Fork Session Confirm Dialog */}
      {forkTarget && (
        <ConfirmDialog
          title={t('shell.dialogs.fork.title')}
          message={t('shell.dialogs.fork.message')}
          confirmText={t('shell.dialogs.fork.confirm')}
          cancelText={t('shell.common.cancel')}
          confirmVariant="primary"
          onConfirm={handleForkConfirm}
          onCancel={() => setForkTarget(null)}
        />
      )}

      {goalCancelConfirmOpen && (
        <ConfirmDialog
          title={tTask('cron.statusBar.cancelGoalConfirmTitle')}
          message={tTask('cron.statusBar.cancelGoalConfirmMessage')}
          confirmText={tTask('cron.statusBar.cancelGoalButton')}
          cancelText={tTask('cron.settingsModal.cancel')}
          confirmVariant="danger"
          onConfirm={handleGoalCancelConfirm}
          onCancel={() => setGoalCancelConfirmOpen(false)}
        />
      )}

      {goalEditOpen && (
        <OverlayBackdrop
          onClose={goalEditSubmitting ? undefined : () => setGoalEditOpen(false)}
          className="z-[200] px-4"
        >
          <div className="flex w-full max-w-lg flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-xl">
            <div className="flex items-center justify-between border-b border-[var(--line)] px-6 py-4">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-[var(--ink)]">{t('goalEdit.title')}</h2>
                <p className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">{t('goalEdit.subtitle')}</p>
              </div>
              <button
                type="button"
                onClick={() => setGoalEditOpen(false)}
                disabled={goalEditSubmitting}
                className="shrink-0 rounded-lg p-1 text-[var(--ink-muted)] transition hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="px-6 py-4">
              <textarea
                value={goalEditDraft}
                onChange={(event) => setGoalEditDraft(event.target.value)}
                className="min-h-32 w-full resize-y rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 text-sm leading-relaxed text-[var(--ink)] outline-none transition focus:border-[var(--accent)]"
                placeholder={t('goalEdit.placeholder')}
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2 border-t border-[var(--line)] px-6 py-3.5">
              <button
                type="button"
                onClick={() => setGoalEditOpen(false)}
                disabled={goalEditSubmitting}
                className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition hover:bg-[var(--paper-inset)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('shell.common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleGoalEditSubmit()}
                disabled={goalEditSubmitting || !goalEditDraft.trim()}
                className="rounded-lg bg-[var(--accent)] px-5 py-2 text-sm font-medium text-[var(--on-accent)] transition hover:bg-[var(--accent-warm-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {goalEditSubmitting ? t('goalEdit.updating') : t('goalEdit.update')}
              </button>
            </div>
          </div>
        </OverlayBackdrop>
      )}

      {/* Cron Task Settings Modal */}
      <CronTaskSettingsModal
        isOpen={showCronSettings}
        onClose={() => { setShowCronSettings(false); setCronOpenPreset(null); }}
        initialPrompt={cronPrompt}
        // Editing a RUNNING task always wins (cronState.task). Otherwise the
        // Goal bar's optional settings preset applies over an armed-but-unsent
        // config. Plain 定时-button opens (no preset) fall back to
        // cronState.config either way.
        initialConfig={cronOpenPreset?.taskKind === 'goal'
          ? cronOpenPreset
          : (cronState.task ? cronState.config : (cronOpenPreset ?? cronState.config))}
        workspacePath={agentDir}
        onConfirm={async (config: CronSettingsResult) => {
          if (composerConfigLockedReason && config.taskKind !== 'goal') {
            toastRef.current.warning(composerConfigLockedReason, 3500);
            setShowCronSettings(false);
            setCronOpenPreset(null);
            return;
          }
          const cronExecution = buildCronExecutionOverrides({
            providerId: !isExternalRuntime && currentProvider ? currentProvider.id : undefined,
            model: isExternalRuntime ? undefined : selectedModel,
          });
          const enrichedConfig = {
            ...config,
            model: cronExecution.model,
            permissionMode: isExternalRuntime
              ? (config.taskKind === 'goal' ? effectiveRuntimePermissionMode : undefined)
              : permissionMode,
            providerId: cronExecution.providerId,
            runtime: cronExecution.runtime,
            runtimeConfig: cronExecution.runtimeConfig,
            executionTarget: config.executionTarget,
          };

          if (config.taskKind === 'goal') {
            if (!cronState.task) disableCronMode();
            setGoalDraftConfig({
              taskKind: 'goal',
              prompt: '',
              endConditions: config.endConditions,
              notifyEnabled: config.notifyEnabled,
              permissionMode: enrichedConfig.permissionMode,
              runtime: enrichedConfig.runtime,
            });
          } else {
            setGoalDraftConfig(null);
            if (cronState.task) {
              updateRunningConfig(enrichedConfig);
            } else {
              enableCronMode(enrichedConfig);
            }
          }

          if (config.taskKind === 'cron') {
            track('cron_enable', {
              interval_minutes: config.intervalMinutes,
              run_mode: config.runMode,
              execution_target: config.executionTarget,
              has_time_limit: !!config.endConditions.deadline,
              has_count_limit: !!(config.endConditions.maxExecutions && config.endConditions.maxExecutions > 0),
              notify_enabled: config.notifyEnabled,
            });
          }
          setShowCronSettings(false);
          setCronOpenPreset(null);
        }}
      />

      {/* Cron task detail panel */}
      {cronDetailTask && (
        <CronTaskDetailPanel
          task={cronDetailTask}
          onClose={() => setCronDetailTask(null)}
          onDelete={async (taskId) => {
            const { deleteCronTask } = await import('@/api/cronTaskClient');
            await deleteCronTask(taskId);
            setCronDetailTask(null);
            toastRef.current?.success(t('shell.toasts.taskDeleted'));
          }}
          onResume={async (taskId) => {
            await startCronTaskIpc(taskId);
            const { getCronTask } = await import('@/api/cronTaskClient');
            const updated = await getCronTask(taskId);
            setCronDetailTask(updated);
            toastRef.current?.success(t('shell.toasts.taskResumed'));
          }}
          onStop={async (taskId) => {
            const { stopCronTask } = await import('@/api/cronTaskClient');
            await stopCronTask(taskId);
            const { getCronTask } = await import('@/api/cronTaskClient');
            const updated = await getCronTask(taskId);
            setCronDetailTask(updated);
            toastRef.current?.success(t('shell.toasts.taskStopped'));
          }}
          onOpenSession={(id) => handleSelectSession(id, '', 'task_run_history')}
        />
      )}
    </div>
  );
}
