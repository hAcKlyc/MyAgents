import { useChatWorkspaceLayout } from '@/hooks/useChatWorkspaceLayout';
import { resolveDefaultMcpSelection } from '../../shared/mcpSelection';
import { useChatDraftScope } from "@/hooks/useChatDraftScope";
import type { Message } from "@/types/chat";
import TaskDiscussionRecovery from "@/components/TaskDiscussionRecovery";
import { desktopContextOf } from "../../shared/agentMentions";
import type { AskUserQuestionAnswers } from '../../shared/types/askUserQuestion';
import {
  AsyncQuestionContext,
  type AsyncQuestionActions,
} from '@/context/AsyncQuestionContext';
import { AsyncQuestionComposerTarget } from '@/components/AsyncQuestionCard';
import {
  restoreAsyncQuestionAnswerDraft,
  sameAsyncQuestionReply,
  type AsyncQuestionReply,
} from '../../shared/asyncUserQuestions';
import { isImeComposingEvent } from '@/utils/imeKeyboard';
import type { FilePreviewHandle } from '@/components/FilePreviewModal';
import {
  WarningIcon,
  HelperIcon,
  GlobeIcon,
  HistoryIcon,
  LoaderIcon,
  ComposeIcon,
  PanelRightIcon,
  UndoIcon,
  TerminalIcon,
  CloseIcon,
} from '@/components/icons';
import {
  forwardRef,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { track } from '@/analytics';
import type { HistoryEntrySource } from '@/analytics';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import ConfirmDialog from '@/components/ConfirmDialog';
import WorkspaceIcon from '@/components/launcher/WorkspaceIcon';
import { useToast } from '@/components/Toast';
import {
  classifyRewindTransportOutcome,
  getConversationRejectionMessage,
  projectRewindRecovery,
  type RewindResponse,
  warnRewindFileOutcome as showRewindFileOutcomeWarning,
} from '@/utils/rewindFileOutcome';
import Tip from '@/components/Tip';
import DirectoryPanel, {
  type DirectoryPanelHandle,
  type WorkspaceTreePersistedState,
} from '@/components/DirectoryPanel';
import DropZoneOverlay from '@/components/DropZoneOverlay';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import MessageList from '@/components/MessageList';
import type { Message as MessageType } from '@/types/chat';
import SessionHistoryDropdown from '@/components/SessionHistoryDropdown';
import SessionSurfaceTags from '@/components/SessionSurfaceTags';
import SessionMenuButton, {
  type BotChannelCandidate,
} from '@/components/SessionMenuButton';
import { sessionMenuRuntimeIdentity } from '@/utils/sessionMenuRuntime';
import UserTagPills from '@/components/session-tags/UserTagPills';
import { FileActionProvider } from '@/context/FileActionContext';
import SimpleChatInput, {
  type ImageAttachment,
  type SimpleChatInputHandle,
} from '@/components/SimpleChatInput';
import type { SlashCommand as InputSlashCommand } from '@/components/SlashCommandMenu';
import AgentStatusPanel from '@/components/agent-status/AgentStatusPanel';
import ContextUsageIndicator from '@/components/ContextUsageIndicator';
import ChatBootOverlay from '@/components/ChatBootOverlay';
import { useChatStartupOverlay } from '@/hooks/useChatStartupOverlay';
import { restoreMessageImages } from '@/context/userImageAttachmentProjection';
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
import WorkspaceConfigPanel, {
  type Tab as WorkspaceTab,
} from '@/components/WorkspaceConfigPanel';
import CronTaskSettingsModal, {
  GOAL_SLASH_PRESET,
  type CronInitialConfig,
  type CronSettingsResult,
} from '@/components/cron/CronTaskSettingsModal';
import { useTabState, useTabActive } from '@/context/TabContext';
import { useChatScrollController } from '@/hooks/useChatScrollController';
import { useChatScrollModel } from '@/hooks/useChatScrollModel';
import { useAgentStatuses } from '@/hooks/useAgentStatuses';
import { useProjectCapabilities } from '@/hooks/useProjectCapabilities';
import {
  useSessionSurfaces,
  type ChannelSurface,
} from '@/hooks/useSessionSurfaces';
import {
  actions as taskCenterActions,
  resolveFloatingBallBoundSession,
} from '@/hooks/taskCenterStore';
import { usePassiveSessionMetadata } from '@/hooks/useTaskCenterData';
import { sameSessionUserTags } from '../../shared/session-user-tags';
import { useConfig } from '@/hooks/useConfig';
import { useFileDropZone } from '@/hooks/useFileDropZone';
import { useTauriFileDrop } from '@/hooks/useTauriFileDrop';
import { useCronTask } from '@/hooks/useCronTask';
import { useSessionGoal } from '@/hooks/useSessionGoal';
import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import { useWorkspaceChangeSignal } from '@/hooks/useWorkspaceChangeSignal';
import {
  isIntroductionAbsentError,
  shouldShowIntroductionOverlay,
  useIntroductionContent,
} from '@/hooks/useIntroductionContent';
import { resolveAdoptedBuiltinProviderId } from '@/utils/sessionConfigAdoption';
import {
  createAndStartCronTask,
  startCronTask as startCronTaskIpc,
} from '@/api/cronTaskClient';
import { updateSession as patchSessionMetadata } from '@/api/sessionClient';
import {
  sessionHasPersistentOwners,
} from '@/api/tauriClient';
import {
  persistInputOptionChange,
  type BuiltinModelSelection,
  type BuiltinProviderEnvPolicy,
} from '@/api/persistInputOption';
import { materializePendingSessionConfig } from '@/api/sessionMaterialize';
import type { CronTask } from '@/types/cronTask';
import type { SessionGoal, SessionGoalDraftConfig } from '@/types/sessionGoal';
import { isTerminalGoalStatus } from '@/types/sessionGoal';
import { formatCronScheduleDescription } from '@/utils/cronTaskI18n';
import CronTaskCard from '@/components/scheduled-tasks/CronTaskCard';
import CronTaskDetailPanel from '@/components/CronTaskDetailPanel';
import { projectTaskExecutionOverrides } from '@/utils/taskProviderProjection';
import { isTauriEnvironment } from '@/utils/browserMock';
import { useSessionCronRestore } from '@/hooks/useSessionCronRestore';
import { isDebugMode } from '@/utils/debug';
import { getChannelTypeLabel } from '@/utils/taskCenterUtils';
import { appendCronPromptToDraft } from '@/utils/cronComposerRecovery';
import { runtimeModelCatalogPath } from '@/utils/runtimeModelCatalog';
import { launchSupportDiagnostics } from '@/utils/supportDiagnostics';
import { createDefaultSessionGoalDraftConfig } from '@/utils/sessionGoalDraft';
import { MANAGED_CODEX_COMPACT_SLASH_COMMAND } from '@/utils/slashActions';
import {
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  type PermissionMode,
  type McpServerDefinition,
  type Project,
  type Provider,
  getEffectiveModelAliases,
} from '@/config/types';
import { resolveProviderForModel } from '../../shared/provider-model-routing';
import { getAllMcpServersFromConfig } from '@/config/services/mcpService';
import { syncMcpServerNames } from '@/components/tools/toolBadgeConfig';
import {
  getAllMcpServers,
  getEnabledMcpServerIds,
  isImageUnderstandingSelectionAvailable,
  isProviderAvailable,
  resolveProvider,
} from '@/config/configService';
import {
  patchAgentConfig,
  patchAgentProjectConfig,
  getAgentById,
} from '@/config/services/agentConfigService';
import { BrowserPanelContext } from '@/context/BrowserPanelContext';
import { BROWSER_BLANK_URL } from '@/components/browserConstants';
import { CUSTOM_EVENTS, isPendingSessionId } from '../../shared/constants';
import { syncTeamAiPeerProfile } from '@/features/team-ai/client';
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
import {
  coerceReasoningEffortForRuntime,
  reasoningEffortChoices,
  reasoningEffortAfterModelChange,
} from '../../shared/reasoningEffort';
import {
  createConcreteProviderRoute,
  hasProviderRouteCredential,
  isConcreteProviderRoute,
} from '../../shared/providerRoute';
import type { ProviderRoute } from '../../shared/providerRoute';
import {
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
  CC_MODELS,
  CC_PERMISSION_MODES,
  CODEX_PERMISSION_MODES,
  coerceModelForRuntime,
  DSH_PERMISSION_MODES,
  getDefaultRuntimePermissionMode,
  projectPermissionModeForRuntime,
  resolveEffectiveRuntime,
  runtimeSourceForRuntimeType,
  runtimeSupportsPrewarm,
} from '../../shared/types/runtime';
import type {
  RuntimeType,
  RuntimeDetections,
  RuntimeConfig,
  RuntimeDiagnostics,
  RuntimeExtensionDiagnostics,
} from '../../shared/types/runtime';
import type {
  FilePreviewIntent,
  InitialMessage,
  LaunchSessionBirthHint,
  SidecarConfigDisposition,
} from '@/types/tab';
import type { FilePreviewTarget } from '@/types/filePreview';
import { filePreviewErrorMessage, type LoadedFilePreview, type ResolvedFilePreview } from '@/utils/filePreview';
import { useChatFilePreviewNavigation } from './useChatFilePreviewNavigation';
import { shouldAutoSendInitialMessage } from '@/utils/initialMessageAutoSend';
import {
  canResumeProviderHistoryForSwitch,
  toProviderHistoryEnv,
  resolveBuiltinPermissionMode,
  resolveCurrentProviderForSession,
  resolveLegacyBuiltinSnapshotProviderId,
  isPinnedProviderUnavailable,
  shouldResetModelOnProviderChange,
  shouldSkipSnapshotWrite,
} from '@/utils/optionResolve';
import {
  buildProviderSwitchSessionBirth,
  resolveProviderSwitchIntegratedRuntime,
} from '@/utils/providerSwitchSessionBirth';
import {
  projectInputChromeRuntime,
  projectRuntimeExtensionUpdateNotice,
  shouldShowBuiltinSdkSlashCommands,
  shouldUseExternalRuntimeInputControls,
  supportsRuntimeConversationBranches,
} from '@/utils/runtimeUiProjection';
import {
  isProviderModelCompatibleWithRuntime,
  projectProvidersForRuntime,
} from '@/utils/runtimeProviderProjection';
import {
  createWorkspacePanelDisclosureState,
  nextSplitViewAfterBrowserClose,
  reduceWorkspacePanelDisclosure,
} from '@/utils/chatWorkspaceLayout';
import {
  isManagedProviderSessionSnapshot,
  managedProviderSnapshotModel,
  managedProviderSnapshotProviderId,
  shouldSessionSnapshotUseProviderPicker,
} from '@/utils/sessionSnapshotProviderProjection';
import { coerceRuntimeBirthPermissionMode } from '../../shared/runtimeBirthFields';
// CronTaskConfig type is used via useCronTask hook

import {
  getRichDocKind,
  isPreviewable,
} from '../../shared/fileTypes';

const DESKTOP_SESSION_FORK_ORIGIN: SessionOrigin = {
  kind: 'desktop',
  surface: 'session_fork',
};
const WORKSPACE_PANEL_TRANSITION_MS = 200;

type ExtensionUpdateResponse = {
  success?: boolean;
  error?: string;
  extensionStatus?: RuntimeExtensionDiagnostics;
};

type SessionConfigPushKind = 'mcp' | 'agents';

type SplitPreviewFile = LoadedFilePreview;

type SwitchDialogCopy = {
  title: string;
  message: string;
  confirmText: string;
};

// Lazy load FilePreviewModal for split view panel
const FilePreviewModal = lazy(() => import('@/components/FilePreviewModal'));
// Lazy load TerminalPanel for embedded terminal
const LazyTerminalPanel = lazy(() =>
  import('@/components/TerminalPanel').then((m) => ({
    default: m.TerminalPanel,
  })),
);
// Lazy load BrowserPanel for embedded browser
const LazyBrowserPanel = lazy(() => import('@/components/BrowserPanel'));
// Lazy load IntroductionOverlay for empty session welcome content
const LazyIntroductionOverlay = lazy(
  () => import('@/components/IntroductionOverlay'),
);
// Terminal chrome now uses CSS tokens that auto-switch with light/dark theme.
// No need for cached theme constants — the header uses var(--paper), var(--ink), etc.

function buildBuiltinProviderRoute(
  provider: Provider | undefined,
  model: string | undefined,
): ProviderRoute | undefined {
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

function isRuntimeBackedIntent(
  intent: ProviderExecutionIntent | undefined,
): boolean {
  return intent?.kind === 'runtime-backed-provider';
}

function isCodexSubscriptionIntent(
  intent: ProviderExecutionIntent | undefined,
): boolean {
  return (
    intent?.kind === 'runtime-backed-provider' &&
    intent.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID
  );
}

function providerDisplayName(
  provider: Pick<Provider, 'id' | 'name'> | undefined,
  fallback: string,
): string {
  return provider?.name?.trim() || provider?.id || fallback;
}

function buildProviderSwitchDialogCopy(
  t: TFunction<'chat'>,
  args: {
    currentProvider?: Pick<Provider, 'id' | 'name'>;
    targetProvider?: Pick<Provider, 'id' | 'name'>;
    currentIntent?: ProviderExecutionIntent;
    targetIntent?: ProviderExecutionIntent;
    targetModel?: string;
    targetProviderId?: string;
  },
): SwitchDialogCopy {
  const currentIsCodex = isCodexSubscriptionIntent(args.currentIntent);
  const targetIsCodex = isCodexSubscriptionIntent(args.targetIntent);
  const currentProviderName = currentIsCodex
    ? t('shell.providerSwitch.codexSubscription')
    : providerDisplayName(
        args.currentProvider,
        t('shell.providerSwitch.currentProviderFallback'),
      );
  const targetProviderName = targetIsCodex
    ? t('shell.providerSwitch.codexSubscription')
    : providerDisplayName(
        args.targetProvider,
        args.targetProviderId ??
          t('shell.providerSwitch.targetProviderFallback'),
      );

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

  if (
    isRuntimeBackedIntent(args.currentIntent) ||
    isRuntimeBackedIntent(args.targetIntent)
  ) {
    return {
      title: t('shell.providerSwitch.newSessionTitle'),
      message: t('shell.providerSwitch.runtimeBacked.message'),
      confirmText: t('shell.providerSwitch.createNewSession'),
    };
  }

  const sameProvider =
    !!args.currentProvider?.id &&
    args.currentProvider.id ===
      (args.targetProvider?.id ?? args.targetProviderId);
  if (sameProvider) {
    const targetModel =
      args.targetModel ?? t('shell.providerSwitch.targetModelFallback');
    return {
      title: t('shell.providerSwitch.newSessionTitle'),
      message: t('shell.providerSwitch.sameProvider.message', { targetModel }),
      confirmText: t('shell.providerSwitch.createNewSession'),
    };
  }

  return {
    title: t('shell.providerSwitch.newSessionTitle'),
    message: t('shell.providerSwitch.crossProvider.message', {
      currentProviderName,
      targetProviderName,
    }),
    confirmText: t('shell.providerSwitch.createNewSession'),
  };
}

function coerceExternalRuntimeModelForUi(
  model: string | undefined,
  runtime: RuntimeType,
): string | undefined {
  return runtime === 'builtin' ? model : coerceModelForRuntime(model, runtime);
}

function coerceExternalRuntimePermissionForUi(
  mode: string | undefined,
  runtime: RuntimeType,
): string | undefined {
  return runtime === 'builtin'
    ? mode
    : projectPermissionModeForRuntime(mode, runtime);
}

function coerceInitialMessageRuntimePermission(
  initialMessage: InitialMessage,
  runtime: RuntimeType,
): string | undefined {
  const identity = initialMessage.providerExecutionIdentity;
  if (identity) {
    return runtimeBackedProviderPermissionMode(
      identity,
      initialMessage.permissionMode,
    );
  }
  return coerceExternalRuntimePermissionForUi(
    initialMessage.permissionMode,
    runtime,
  );
}

function coerceReasoningEffortForUi(
  effort: string | undefined,
  runtime: RuntimeType,
): string | undefined {
  return coerceReasoningEffortForRuntime(effort, runtime);
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

  useEffect(() => {
    setDraft(title);
  }, [title]);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  useImperativeHandle(
    ref,
    () => ({
      openRename: () => setEditing(true),
    }),
    [],
  );

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
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (isImeComposingEvent(e)) return;
            if (e.key === 'Enter') inputRef.current?.blur();
            if (e.key === 'Escape') {
              setDraft(title);
              setEditing(false);
            }
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
  registerFileEditSubmitter?: (
    tabId: string,
    submit: () => Promise<boolean>,
  ) => () => void;
  /** Native shown/not-minimized lifecycle; focus is intentionally independent. */
  windowPresentation: MainWindowPresentation;
  /** Opens a separate conversation after Rust has retained the source Session. */
  onNewSession?: (sourceSessionId: string) => Promise<boolean>;
  /** Opens a persisted Session through App's canonical new/jump/revive path. */
  onOpenSession?: (
    sessionId: string,
    title: string,
    historyEntrySource?: HistoryEntrySource,
  ) => void;
  /** Explicit per-row new-tab action; it shares the same canonical App path. */
  onOpenSessionInNewTab?: (sessionId: string, title: string) => void;
  /** Initial message from Launcher for auto-send on workspace open */
  initialMessage?: InitialMessage;
  discussionId?: string;
  startupError?: string | null;
  onRetryStartup?: () => Promise<void | undefined>;
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
  onForkSession?: (newSessionId: string, agentDir: string, title: string, initialMessage?: string, context?: import("../../shared/agentMentions").QueryMentionContext) => Promise<boolean>;
  /** App-owned fresh-session launch for a runtime-backed provider switch. */
  onLaunchRuntimeBackedProviderSession?: (
    project: Project,
    sessionBirthHint: LaunchSessionBirthHint & {
      providerExecutionIdentity: RuntimeBackedProviderIdentity;
    },
    title: string,
  ) => Promise<string | null>;
  /** Runtime-only request from App/floating-ball to open a file preview once. */
  pendingFilePreview?: FilePreviewIntent;
  onFilePreviewIntentConsumed?: (intentId: string) => void;
  sessionNotificationBadgeCounts?: ReadonlyMap<string, number>;
  /** Open App Shell history with a clean, single-Tag aggregation intent. */
  onOpenHistoryTag?: (tag: string) => void;
}

function isCurrentSessionGoal(
  goal: SessionGoal | null | undefined,
): goal is SessionGoal {
  return Boolean(goal);
}

export default function Chat({
  registerFileEditSubmitter,
  windowPresentation,
  onNewSession,
  onOpenSession,
  onOpenSessionInNewTab,
  initialMessage,
  discussionId,
  startupError,
  onRetryStartup,
  onInitialMessageConsumed,
  sidecarConfigDisposition,
  onSidecarConfigAdopted,
  sessionTitle,
  onRenameSession,
  onForkSession,
  onLaunchRuntimeBackedProviderSession,
  pendingFilePreview,
  onFilePreviewIntentConsumed,
  sessionNotificationBadgeCounts,
  onOpenHistoryTag,
}: ChatProps) {
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
    sessionRuntimeSessionId,
    sessionMeta,
    setSessionMeta,
    systemInitInfo,
    mcpEffectiveSnapshot,
    sdkSlashCommands,
    runtimeDiagnostics,
    agentError,
    agentErrorUserMessageId,
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
      if (sameSessionUserTags(current.userTags, projectedSessionMeta.userTags))
        return current;
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
  const {
    config,
    projects,
    providers,
    patchProject,
    apiKeys,
    providerVerifyStatus,
    refreshProviderData,
    refreshConfig,
  } = useConfig();
  const currentProject = projects.find((p) =>
    workspacePathsEqual(p.path, agentDir),
  );
  // AgentConfig is source of truth for AI settings, Project is fallback for non-agent workspaces
  const currentAgent = currentProject?.agentId
    ? getAgentById(config, currentProject.agentId)
    : undefined;
  const providerUiRuntime: RuntimeType =
    (sessionRuntime as RuntimeType | null) ??
    resolveEffectiveRuntime(
      currentAgent?.runtime,
      currentAgent?.runtimePreference,
      currentAgent?.runtimeConfig?.source,
      currentAgent?.providerId,
      undefined,
      config.defaultIntegratedRuntime,
    );
  const providerUiProviders = useMemo(
    () => projectProvidersForRuntime(providers, providerUiRuntime),
    [providers, providerUiRuntime],
  );
  // Local provider state: snapshot from AgentConfig (priority) or Project at creation.
  // Prevents cross-tab pollution when another tab patches the shared project.
  const [selectedProviderId, setSelectedProviderId] = useState<
    string | undefined
  >(
    currentAgent?.providerId ??
      currentProject?.providerId ??
      config.defaultProviderId ??
      undefined,
  );
  const sessionSnapshotOwnsConfig = !!sessionMeta?.configSnapshotAt;
  const waitingForExistingSessionMeta =
    !!sessionId && !isPendingSessionId(sessionId) && !sessionMeta;
  const sessionSnapshotRuntime =
    (sessionMeta?.runtime as RuntimeType | undefined) ?? 'builtin';
  const sessionSnapshotIsManagedProvider =
    sessionSnapshotOwnsConfig && isManagedProviderSessionSnapshot(sessionMeta);
  const sessionSnapshotUsesProviderPicker =
    sessionSnapshotOwnsConfig &&
    shouldSessionSnapshotUseProviderPicker({
      session: sessionMeta,
      runtime: sessionSnapshotRuntime,
    });
  const concreteSessionProviderRoute = isConcreteProviderRoute(
    sessionMeta?.providerRoute,
  )
    ? sessionMeta.providerRoute
    : undefined;
  const sessionSnapshotProviderId = sessionSnapshotUsesProviderPicker
    ? sessionSnapshotIsManagedProvider
      ? sessionMeta
        ? managedProviderSnapshotProviderId(sessionMeta)
        : undefined
      : (concreteSessionProviderRoute?.providerId ??
        resolveLegacyBuiltinSnapshotProviderId({
          snapshotProviderId: sessionMeta?.providerId,
          snapshotModel: sessionMeta?.model,
          selectedProviderId,
          providers,
          apiKeys,
          providerVerifyStatus,
        }))
    : undefined;
  const effectiveSelectedProviderId = sessionSnapshotUsesProviderPicker
    ? sessionSnapshotProviderId
    : selectedProviderId;
  const selectedProviderExact = effectiveSelectedProviderId
    ? providers.find((p) => p.id === effectiveSelectedProviderId)
    : undefined;
  const selectedProviderAvailable = selectedProviderExact
    ? isRuntimeBackedProvider(selectedProviderExact)
      ? isProviderAvailable(
          selectedProviderExact,
          apiKeys,
          providerVerifyStatus,
        )
      : sessionSnapshotOwnsConfig &&
          selectedProviderExact.type === 'subscription'
        ? hasProviderRouteCredential(selectedProviderExact, {
            apiKeys,
            verifyStatus: providerVerifyStatus,
          })
        : isProviderAvailable(
            selectedProviderExact,
            apiKeys,
            providerVerifyStatus,
          )
    : false;
  const availableProviderIdsForInput = useMemo(
    () =>
      providerUiProviders
        .filter((provider) =>
          isRuntimeBackedProvider(provider)
            ? isProviderAvailable(provider, apiKeys, providerVerifyStatus)
            : provider.type === 'subscription'
              ? provider.enabled !== false &&
                hasProviderRouteCredential(provider, {
                  apiKeys,
                  verifyStatus: providerVerifyStatus,
                })
              : isProviderAvailable(provider, apiKeys, providerVerifyStatus),
        )
        .map((provider) => provider.id),
    [providerUiProviders, apiKeys, providerVerifyStatus],
  );
  const fallbackProvider = resolveProvider(
    effectiveSelectedProviderId,
    providerUiProviders,
    apiKeys,
    providerVerifyStatus,
  );
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
  const builtinSnapshotProviderHistoryUnknown =
    sessionSnapshotOwnsConfig &&
    sessionSnapshotRuntime === 'builtin' &&
    !!sessionMeta?.model &&
    !currentProviderForHistory;
  const builtinSnapshotProviderSelectionIncomplete =
    sessionSnapshotOwnsConfig &&
    sessionSnapshotRuntime === 'builtin' &&
    !!sessionMeta?.model &&
    !effectiveSelectedProviderId;
  const currentProviderAvailableForInput =
    builtinSnapshotProviderSelectionIncomplete ||
    (!!currentProvider &&
      availableProviderIdsForInput.includes(currentProvider.id));

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
    const aliases = getEffectiveModelAliases(
      provider,
      configRef.current.providerModelAliases,
    );
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
  // If workspace would render as an overlay at startup, keep it hidden so it
  // does not block the chat before the user explicitly opens it.
  const [workspacePanelDisclosure, dispatchWorkspacePanelDisclosure] =
    useReducer(reduceWorkspacePanelDisclosure, undefined, () =>
      createWorkspacePanelDisclosureState(false),
    );
  const {
    visible: showWorkspace,
    mounted: workspacePanelMounted,
    motion: workspacePanelMotion,
  } = workspacePanelDisclosure;
  const defaultWorkspacePendingRef = useRef(true);
  const workspacePanelMotionRef = useRef(workspacePanelMotion);
  useLayoutEffect(() => { workspacePanelMotionRef.current = workspacePanelMotion; }, [workspacePanelMotion]);
  const workspacePanelUnmountTimerRef = useRef<number | null>(null);
  const clearWorkspacePanelUnmountTimer = useCallback(() => {
    if (workspacePanelUnmountTimerRef.current === null) return;
    window.clearTimeout(workspacePanelUnmountTimerRef.current);
    workspacePanelUnmountTimerRef.current = null;
  }, []);
  const handleChatContainerResize = useCallback(() => {
    if (workspacePanelMotionRef.current === null) return;
    clearWorkspacePanelUnmountTimer();
    dispatchWorkspacePanelDisclosure({ type: 'settle-layout' });
  }, [clearWorkspacePanelUnmountTimer]);
  const handleExpandWorkspace = useCallback(() => {
    defaultWorkspacePendingRef.current = false;
    clearWorkspacePanelUnmountTimer();
    dispatchWorkspacePanelDisclosure({ type: 'open' });
  }, [clearWorkspacePanelUnmountTimer]);
  const handleCollapseWorkspace = useCallback(() => {
    defaultWorkspacePendingRef.current = false;
    clearWorkspacePanelUnmountTimer();
    dispatchWorkspacePanelDisclosure({ type: 'close' });
    workspacePanelUnmountTimerRef.current = window.setTimeout(() => {
      dispatchWorkspacePanelDisclosure({ type: 'settle-close' });
      workspacePanelUnmountTimerRef.current = null;
    }, WORKSPACE_PANEL_TRANSITION_MS);
  }, [clearWorkspacePanelUnmountTimer]);
  useEffect(
    () => clearWorkspacePanelUnmountTimer,
    [clearWorkspacePanelUnmountTimer],
  );
  const [showWorkspaceConfig, setShowWorkspaceConfig] = useState(false); // Workspace config panel
  // State to trigger workspace refresh
  const [workspaceRefreshTrigger, setWorkspaceRefreshTrigger] = useState(0);
  const [introductionRefreshTrigger, setIntroductionRefreshTrigger] =
    useState(0);
  const workspaceChangeSignal = useWorkspaceChangeSignal(
    agentDir || null,
    fileService.isAvailable,
  );
  // Introduction overlay: INTRODUCTION.md content for empty session welcome.
  // Workspace-scoped, not session-scoped: sidecar/session id transitions must not
  // unmount and replay the welcome page while a fresh workspace is booting.
  const readIntroductionContent = useCallback(
    async (path: string) => {
      if (!fileService.isAvailable) return null;
      try {
        const preview = await fileService.readPreview({ path });
        return preview.content;
      } catch (err) {
        if (isIntroductionAbsentError(err)) return null;
        throw err;
      }
    },
    [fileService],
  );
  const introductionContent = useIntroductionContent(
    agentDir,
    introductionRefreshTrigger + workspaceChangeSignal,
    readIntroductionContent,
  );

  // Split view: right-side file preview panel (experimental).
  // `initialEditMode` is set when a fresh `note-…md` is created via 「新建笔记」 —
  // FilePreviewModal opens directly in the editable Monaco view instead of the
  // markdown rendered preview.
  const splitViewRequested = config.experimentalSplitView ?? true;
  const [splitFile, setSplitFile] = useState<SplitPreviewFile | null>(null);
  const isSplitViewEnabled = splitViewRequested || !!splitFile;
  const splitFilePreviewRef = useRef<FilePreviewHandle>(null);
  const fullscreenFilePreviewRef = useRef<FilePreviewHandle>(null);
  const actionFilePreviewRef = useRef<FilePreviewHandle>(null);
  // Clear split panel when feature is turned off (prevents stale split state)
  useEffect(() => {
    if (splitViewRequested || !splitFile) return;
    let cancelled = false;
    void (
      splitFilePreviewRef.current?.prepareTransition() ?? Promise.resolve(true)
    ).then((saved) => {
      if (saved && !cancelled) setSplitFile(null);
    });
    return () => {
      cancelled = true;
    };
  }, [splitViewRequested, splitFile]);
  const [splitRatio, setSplitRatio] = useState(0.5); // 0-1, left panel fraction
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const [isSplitWidthTransitioning, setIsSplitWidthTransitioning] =
    useState(false);
  const isDraggingSplitRef = useRef(false);
  const splitRatioRef = useRef(splitRatio);
  splitRatioRef.current = splitRatio;
  const isWindowsPlatform = useMemo(
    () =>
      typeof navigator !== 'undefined' &&
      navigator.platform.toLowerCase().includes('win'),
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
  const [splitActiveView, setSplitActiveView] = useState<
    'file' | 'terminal' | 'browser'
  >('file');

  // ── Embedded browser state ──
  const [browserNavigation, setBrowserNavigation] = useState<{ readonly url: string } | null>(null);
  const browserUrl = browserNavigation?.url ?? null;
  const [browserAlive, setBrowserAlive] = useState(false);
  const [browserReloadSignal, setBrowserReloadSignal] = useState(0);
  // When browser is previewing a local file, store its metadata for editor toggle
  const [browserSourceFile, setBrowserSourceFile] = useState<FilePreviewTarget | null>(null);
  // Live URL surfaced from BrowserPanel (Rust `browser:url-changed`). Drives
  // the split-view tab label. The navigation request changes only on an
  // explicit open/address action, including a second request for the same URL.
  const [browserCurrentUrl, setBrowserCurrentUrl] = useState<string>('');
  const handleBrowserUrlChange = useCallback((u: string) => {
    setBrowserCurrentUrl(u);
  }, []);

  const splitPanelVisible =
    splitFile !== null ||
    (terminalPinned && (terminalAlive || splitActiveView === 'terminal')) ||
    browserUrl !== null;
  const { containerRef: chatLayoutRef, ready: chatLayoutReady, isNarrowLayout,
    browserUsesFullscreen, workspacePanelMode } = useChatWorkspaceLayout({
    splitViewEnabled: isSplitViewEnabled,
    splitPanelVisible, splitRatio,
    browserPresented: browserUrl !== null && splitActiveView === 'browser',
    onResize: handleChatContainerResize,
  });
  useLayoutEffect(() => {
    if (!chatLayoutReady || !defaultWorkspacePendingRef.current) return;
    defaultWorkspacePendingRef.current = false;
    dispatchWorkspacePanelDisclosure({ type: 'initialize', visible: workspacePanelMode === 'inline' });
  }, [chatLayoutReady, workspacePanelMode]);

  // Should the terminal component stay mounted? (for xterm.js state preservation)
  const terminalMounted =
    terminalAlive || (terminalPinned && splitActiveView === 'terminal');

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
  useEffect(
    () => () => {
      if (splitWidthTransitionTimerRef.current !== null) {
        window.clearTimeout(splitWidthTransitionTimerRef.current);
      }
    },
    [],
  );
  const startBrowserSplitTransitionIfNeeded = useCallback(() => {
    if (!splitPanelVisible) startSplitWidthTransitionSuspension();
  }, [splitPanelVisible, startSplitWidthTransitionSuspension]);

  // Fullscreen and split previews share Chat's navigation admission.
  const [fullscreenPreviewFile, setFullscreenPreviewFile] = useState<SplitPreviewFile | null>(null);
  const preferFullscreenPreview = !!fullscreenPreviewFile || !isSplitViewEnabled || isNarrowLayout;
  const prepareFilePreviewTransition = useCallback(async (path: string) => {
    const editor = preferFullscreenPreview ? fullscreenFilePreviewRef.current : splitFilePreviewRef.current;
    return editor ? editor.prepareTransition(path) : true;
  }, [preferFullscreenPreview]);
  const presentFilePreview = useCallback((resolved: ResolvedFilePreview) => {
    if (resolved.kind === 'browser') {
      setBrowserSourceFile(resolved.target.sourceScope === 'local' ? null : resolved.target);
      startBrowserSplitTransitionIfNeeded();
      setBrowserNavigation({ url: resolved.url });
      setSplitActiveView('browser');
    } else if (preferFullscreenPreview) {
      setFullscreenPreviewFile(resolved.file);
    } else {
      setSplitFile(resolved.file);
      setSplitActiveView('file');
    }
  }, [preferFullscreenPreview, startBrowserSplitTransitionIfNeeded]);
  const { open: handleSplitFilePreview, cancel: cancelFilePreview } = useChatFilePreviewNavigation({
    service: fileService, workspacePath: agentDir,
    browserEnabled: !preferFullscreenPreview,
    prepareTransition: prepareFilePreviewTransition, present: presentFilePreview,
  });
  const selectSplitView = useCallback((view: 'file' | 'terminal' | 'browser') => {
    cancelFilePreview();
    setSplitActiveView(view);
  }, [cancelFilePreview]);

  // Browser resource cleanup has one owner. Every close entry point delegates
  // here so a surviving terminal/file view always takes over consistently.
  const handleBrowserClose = useCallback(() => {
    cancelFilePreview();
    setBrowserNavigation(null);
    setBrowserAlive(false);
    setBrowserSourceFile(null);
    setBrowserCurrentUrl('');
    const nextView = nextSplitViewAfterBrowserClose({
      terminalVisible: terminalPinned && terminalAlive,
      fileVisible: splitFile !== null,
    });
    if (nextView) setSplitActiveView(nextView);
  }, [terminalPinned, terminalAlive, splitFile, cancelFilePreview]);

  const shouldUseWorkspaceOverlay = workspacePanelMode === 'overlay';

  // Cmd+W: split panel visible → always close the active view first (no focus detection).
  // Simpler mental model: Cmd+W closes from right to left, outside to inside.
  // Split panel acts as a buffer — absorbs Cmd+W before it reaches the tab.
  useCloseLayer(() => {
    if (!splitPanelVisible) return false;
    cancelFilePreview();
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
    if (
      !isActive ||
      !browserUsesFullscreen ||
      splitActiveView !== 'browser' ||
      !browserUrl
    )
      return false;
    handleBrowserClose();
    return true;
  }, 30);

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
        if (!richDocKind && !isPreviewable(fileName)) {
          toastRef.current.info(t('shell.toasts.previewUnsupportedType'));
          return;
        }
        const target: FilePreviewTarget = {
          name: fileName, path: intent.path, initialLineNumber: intent.initialLineNumber,
        };
        if (cancelled) return;
        await handleSplitFilePreview(target, { isCurrent: () => !cancelled });
      } catch (err) {
        if (!cancelled) {
          console.error('[Chat] Failed to open pending file preview:', err);
          toastRef.current.error(`${t('shell.toasts.previewOpenFailed')}: ${filePreviewErrorMessage(err)}`);
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
    cancelFilePreview();
    setTerminalPinned(true);
    setSplitActiveView('terminal');
    // If terminal was already created, just switch view; otherwise TerminalPanel will create it
  }, [cancelFilePreview]);

  // Open a URL in the embedded browser panel
  const handleOpenInBrowserPanel = useCallback(
    (url: string) => {
      cancelFilePreview();
      setBrowserSourceFile(null);
      if (isSplitViewEnabled && !isNarrowLayout)
        startBrowserSplitTransitionIfNeeded();
      setBrowserNavigation({ url });
      setSplitActiveView('browser');
    },
    [isNarrowLayout, isSplitViewEnabled, startBrowserSplitTransitionIfNeeded, cancelFilePreview],
  );

  // Open empty browser from toolbar button.
  // First click → create blank webview (BROWSER_BLANK_URL is a data: URL, not
  // about:blank — see browserConstants.ts for why). Subsequent clicks just
  // switch view (URL preserved).
  const handleOpenBrowser = useCallback(() => {
    cancelFilePreview();
    startBrowserSplitTransitionIfNeeded();
    setBrowserNavigation((prev) => prev ?? { url: BROWSER_BLANK_URL });
    setSplitActiveView('browser');
  }, [startBrowserSplitTransitionIfNeeded, cancelFilePreview]);

  const handleBrowserCreated = useCallback(() => setBrowserAlive(true), []);
  const handleBrowserCreateFailed = useCallback(() => {
    handleBrowserClose();
  }, [handleBrowserClose]);

  // Load the current source only when requested. A failed/oversized read leaves
  // the page visible; never substitute a stale or unloaded cached document.
  const handleBrowserSwitchToEditor = useCallback(async () => {
    if (!browserSourceFile) return;
    try {
      await handleSplitFilePreview(browserSourceFile, { initialEditMode: true });
    } catch (error) {
      toastRef.current.error(`${t('app:fileActions.previewLoadFailed')}: ${filePreviewErrorMessage(error)}`);
    }
  }, [browserSourceFile, handleSplitFilePreview, t]);

  // Switch from editor back to browser preview for an HTML file.
  // Reloads webview so it reflects any edits saved to disk.
  const handleEditorSwitchToBrowser = useCallback(() => {
    if (!browserUrl) return;
    selectSplitView('browser');
    // Give auto-save a moment to flush, then reload the webview
    setTimeout(() => {
      setBrowserReloadSignal((value) => value + 1);
    }, 300);
  }, [browserUrl, selectSplitView]);

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
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.OPEN_IN_BROWSER_PANEL, handler);
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
    const containerWidth = (
      e.currentTarget.parentElement as HTMLElement
    ).getBoundingClientRect().width;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingSplitRef.current) return;
      const dx = ev.clientX - startX;
      const newRatio = Math.max(
        0.35,
        Math.min(0.65, startRatio + dx / containerWidth),
      );
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
      if (dragMoveRef.current)
        document.removeEventListener('mousemove', dragMoveRef.current);
      if (dragUpRef.current)
        document.removeEventListener('mouseup', dragUpRef.current);
      isDraggingSplitRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  const [workspaceRefreshKey, _setWorkspaceRefreshKey] = useState(0); // Key to trigger workspace refresh
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    () => resolveBuiltinPermissionMode({
      projectSynced: false,
      statePermissionMode: 'auto',
      agentPermissionMode: currentAgent?.permissionMode,
      projectPermissionMode: currentProject?.permissionMode,
      defaultPermissionMode: config.defaultPermissionMode,
    }),
  );
  const [selectedModel, setSelectedModel] = useState<string | undefined>(
    currentAgent?.model ??
      currentProject?.model ??
      currentProvider?.primaryModel,
  );
  // The UI shows effort options for the same model transport that the
  // ProviderRoute will materialize on the server. Missing catalog metadata
  // hides protocol-specific options; execution reports the actionable error.
  const effectiveModelProvider = useMemo(() => {
    if (!currentProvider) return undefined;
    try {
      return resolveProviderForModel(
        currentProvider,
        selectedModel ?? currentProvider.primaryModel,
      );
    } catch {
      return undefined;
    }
  }, [currentProvider, selectedModel]);
  const currentProviderExecutionIntent = useMemo(
    () =>
      sessionMeta?.providerExecutionIdentity ??
      buildProviderExecutionIntent(currentProviderForHistory, selectedModel),
    [
      sessionMeta?.providerExecutionIdentity,
      currentProviderForHistory,
      selectedModel,
    ],
  );
  const currentRuntimeSource =
    sessionMeta?.runtimeSource ??
    sessionRuntimeSource ??
    (currentProviderExecutionIntent?.kind === 'runtime-backed-provider'
      ? currentProviderExecutionIntent.runtimeSource
      : undefined);
  const managedProviderRuntimeActive =
    currentRuntimeSource === 'managed-provider';
  // #324 — 推理强度 setting ('default' | level). ONE state for both runtimes
  // (the storage location splits on isExternalRuntime at persist time, like
  // model). Lifecycle mirrors selectedModel: seeded from agent, restored from
  // session snapshot, live-pushed to the sidecar via /api/reasoning-effort/set.
  const [reasoningEffort, setReasoningEffort] = useState<string>(() => {
    const rc = currentAgent?.runtimeConfig as
      | { reasoningEffort?: string }
      | undefined;
    const fromAgent =
      managedProviderRuntimeActive ||
      (currentAgent?.runtime && currentAgent.runtime !== 'builtin')
        ? rc?.reasoningEffort
        : currentAgent?.reasoningEffort;
    return fromAgent ?? 'default';
  });
  // Cron task state
  const [showCronSettings, setShowCronSettings] = useState(false);
  const [cronPrompt, setCronPrompt] = useState('');
  // Preset applied when Goal's draft bar opens the optional settings modal.
  // Cleared on open-via-定时-button / close / confirm so it never leaks.
  const [cronOpenPreset, setCronOpenPreset] =
    useState<CronInitialConfig | null>(null);
  const [goalDraftConfig, setGoalDraftConfig] =
    useState<SessionGoalDraftConfig | null>(null);
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

  const hadInitialMessage = useRef(!!initialMessage);
  const {
    showStartupOverlay,
    startupClientRequestId,
    dismissStartupOverlay,
    onStartupItemsRendered,
  } = useChatStartupOverlay({
    hasInitialMessage: hadInitialMessage.current,
    initialClientRequestId: initialMessage?.clientRequestId,
    startupError,
    isConnected,
    isSessionLoading,
    agentError,
    hasPendingInteraction: Boolean(
      pendingPermission || pendingAskUserQuestion ||
      (pendingExitPlanMode && pendingExitPlanMode.resolved === undefined),
    ),
  });

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
  const forkRequestRef = useRef<{ sourceId: string | null; messageId: string; targetSessionId: string } | null>(null);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // Refs for one-time project settings sync (see effect after provider change effect)
  // For a launcher-handoff tab (has initialMessage), autoSend owns the INITIAL
  // MCP push — it pushes the user's per-session launcher selection, which may
  // differ from the workspace default. The mount MCP effect skips its initial
  // push while this is true so the two pushers can't race and stomp the launcher
  // choice; autoSend clears it after its MCP block, handing later config-change
  // re-pushes back to the mount effect. (codex review: dual MCP-push race.)
  const launcherOwnsInitialMcpRef = useRef(hadInitialMessage.current);
  const launcherOwnsInitialOfficialToolsRef = useRef(hadInitialMessage.current);
  const [launcherMcpFallbackRevision, setLauncherMcpFallbackRevision] =
    useState(0);
  const projectSyncedRef = useRef(false);

  // Ref for input focus
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Ref for SimpleChatInput to call processDroppedFiles
  const chatInputRef = useRef<SimpleChatInputHandle>(null);
  useChatDraftScope(sessionId, discussionId, chatInputRef);

  // Ref for DirectoryPanel to trigger refresh
  const directoryPanelRef = useRef<DirectoryPanelHandle>(null);
  useEffect(
    () =>
      registerFileEditSubmitter?.(tabId, async () => {
        for (const preview of [
          splitFilePreviewRef.current,
          fullscreenFilePreviewRef.current,
          actionFilePreviewRef.current,
        ]) {
          if (preview && !(await preview.prepareTransition())) return false;
        }
        return directoryPanelRef.current?.preparePreviewTransition() ?? true;
      }),
    [registerFileEditSubmitter, tabId],
  );

  // "在文件目录中展示" from the chat path context menu. Opening the workspace
  // panel (if collapsed) mounts DirectoryPanel; the declarative request prop is
  // consumed there (its reveal helper polls for node meta, so it waits out the
  // initial tree load — no ref-timing race).
  const [treeExternalReveal, setTreeExternalReveal] = useState<{
    id: number;
    path: string;
  } | null>(null);
  const treeExternalRevealIdRef = useRef(0);
  const handleRevealInTree = useCallback(
    (path: string) => {
      // Opening is idempotent: a reveal into an already-visible tree must not
      // manufacture another panel/conversation entrance animation.
      handleExpandWorkspace();
      setTreeExternalReveal({ id: ++treeExternalRevealIdRef.current, path });
    },
    [handleExpandWorkspace],
  );
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
  const lastSessionConfigPushRef = useRef<
    Record<SessionConfigPushKind, string | null>
  >({
    mcp: null,
    agents: null,
  });
  const pushSessionConfig = useCallback(
    async (
      kind: SessionConfigPushKind,
      path: '/api/mcp/set' | '/api/agents/set',
      body: unknown,
      mode: SessionConfigPushMode,
    ): Promise<ExtensionUpdateResponse | null> => {
      const fingerprint = sessionConfigPushFingerprint(body);
      if (
        !shouldPushSessionConfig(
          lastSessionConfigPushRef.current[kind],
          fingerprint,
          mode,
        )
      ) {
        return null;
      }
      lastSessionConfigPushRef.current[kind] = fingerprint;
      try {
        const response = await apiPost<ExtensionUpdateResponse>(path, body);
        if (response.success === false) {
          throw new Error(
            response.error ?? `Failed to sync ${kind} configuration`,
          );
        }
        return response;
      } catch (error) {
        // Clear only if no newer payload superseded this attempt.
        if (lastSessionConfigPushRef.current[kind] === fingerprint) {
          lastSessionConfigPushRef.current[kind] = null;
        }
        throw error;
      }
    },
    [apiPost],
  );

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
  const [enabledAgents, setEnabledAgents] = useState<
    | Record<
        string,
        {
          description: string;
          prompt?: string;
          model?: string;
          scope?: 'user' | 'project';
          folderName?: string;
        }
      >
    | undefined
  >();
  const {
    enabledSkills,
    enabledCommands,
    globalSkillFolderNames,
    loadSkillsAndCommands,
  } = useProjectCapabilities(apiGet);
  // Initial tab for workspace config panel (set when opening from capabilities panel)
  const [workspaceConfigInitialTab, setWorkspaceConfigInitialTab] = useState<
    WorkspaceTab | undefined
  >();
  // Initial item selection — when set, WorkspaceConfigPanel opens already showing that item's detail.
  const [workspaceConfigInitialSelect, setWorkspaceConfigInitialSelect] =
    useState<CapabilityInitialSelect | undefined>();
  const workspaceCapabilitySlashCommands = useMemo<InputSlashCommand[]>(
    () => [
      ...enabledCommands.map((command) => ({
        name: command.name,
        invocationName: command.invocationName,
        description: command.description,
        source: 'custom' as const,
        scope: command.scope,
        fileName: command.fileName,
      })),
      ...enabledSkills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        source: 'skill' as const,
        scope: skill.scope,
        folderName: skill.folderName,
      })),
    ],
    [enabledCommands, enabledSkills],
  );

  // Agent Runtime detection (v0.1.59)
  const [runtimeDetectionPending, setRuntimeDetectionPending] = useState(true);
  const [runtimeDetections, setRuntimeDetections] = useState<RuntimeDetections>(
    {
      builtin: { installed: true },
      dsh: { installed: false },
      'claude-code': { installed: false },
      codex: { installed: false },
    },
  );
  // Resolve new Sessions through explicit Agent preference or the root default.
  // Existing Sessions keep their frozen Runtime identity.
  // Agent's currently-configured runtime — used as the default for NEW sessions.
  // Managed Codex is a provider default, not the legacy user-managed Codex CLI
  // runtime, so stale `agent.runtime=codex` must not leak into Chat chrome.
  const agentRuntime: RuntimeType = resolveEffectiveRuntime(
    currentAgent?.runtime,
    currentAgent?.runtimePreference,
    currentAgent?.runtimeConfig?.source,
    currentAgent?.providerId,
    undefined,
    config.defaultIntegratedRuntime,
  );
  // v0.1.69: session is self-contained — its frozen runtime is authoritative for
  // both display and message routing within this tab. Falls back to agentRuntime
  // only before the session has loaded (sessionRuntime===null) or for newly-created
  // sessions before TabProvider syncs metadata. Changing agent.runtime in another
  // tab does NOT change an existing session's display: the session's Sidecar was
  // spawned with its frozen runtime and the backend routes by sessionId.
  const currentRuntime: RuntimeType =
    (sessionRuntime as RuntimeType | null) ?? agentRuntime;
  const launchRuntimeSource = runtimeSourceForRuntimeType(
    agentRuntime,
    currentAgent?.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID ||
      currentAgent?.runtimeConfig?.source === 'managed-provider'
      ? 'managed-provider'
      : undefined,
  ) ?? null;
  const menuRuntimeIdentity = sessionId
    ? sessionMenuRuntimeIdentity({
        sessionId,
        metadata: sessionMeta,
        launchRuntime: agentRuntime,
        launchRuntimeSource,
        liveRuntime: sessionRuntime,
        liveRuntimeSource: sessionRuntimeSource,
        liveRuntimeSessionId: sessionRuntimeSessionId,
      })
    : null;
  const isExternalRuntime = currentRuntime !== 'builtin';
  const runtimeConversationBranchSupported = supportsRuntimeConversationBranches(
    currentRuntime, currentRuntimeSource, runtimeDetections.codex.version,
  );
  const handleDiagnoseAgentError = useCallback(
    (message: string) => {
      launchSupportDiagnostics({
        source: 'agent_error',
        message,
        terminalReason: lastTerminalReason,
        sessionId: sessionIdRef.current,
        workspacePath: agentDir,
        runtime: currentRuntime,
      });
    },
    [agentDir, currentRuntime, lastTerminalReason],
  );
  const handleDiagnoseTerminalReason = useCallback(
    (reason: string) => {
      launchSupportDiagnostics({
        source: 'terminal_reason',
        terminalReason: reason,
        sessionId: sessionIdRef.current,
        workspacePath: agentDir,
        runtime: currentRuntime,
      });
    },
    [agentDir, currentRuntime],
  );
  const handleDiagnoseRuntimeDiagnostics = useCallback(
    (diagnostics: RuntimeDiagnostics) => {
      launchSupportDiagnostics({
        source: 'runtime_diagnostics',
        runtimeDiagnostics: diagnostics,
        sessionId: sessionIdRef.current,
        workspacePath: agentDir,
        runtime: currentRuntime,
      });
    },
    [agentDir, currentRuntime],
  );
  const inputChromeRuntime = projectInputChromeRuntime({
    currentRuntime,
    managedProviderRuntimeActive,
  });
  const inputUsesExternalRuntimeControls =
    shouldUseExternalRuntimeInputControls({
      currentRuntime,
      managedProviderRuntimeActive,
    });
  const showBuiltinSdkSlashCommands =
    shouldShowBuiltinSdkSlashCommands(currentRuntime);
  const visibleSdkSlashCommands = useMemo(
    () => (showBuiltinSdkSlashCommands ? sdkSlashCommands : []),
    [showBuiltinSdkSlashCommands, sdkSlashCommands],
  );

  // Detect installed runtimes once on mount
  useEffect(() => {
    let cancelled = false;
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<RuntimeDetections>('cmd_detect_runtimes'))
      .then((detections) => {
        if (!cancelled) setRuntimeDetections(detections);
      })
      .catch(() => {
        /* A failed detection keeps the runtime unavailable. */
      })
      .finally(() => {
        if (!cancelled) setRuntimeDetectionPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [runtimeModel, setRuntimeModel] = useState<string | undefined>(
    (currentAgent?.runtimeConfig as { model?: string } | undefined)?.model,
  );
  const [runtimePermissionMode, setRuntimePermissionMode] = useState<string>(
    coerceExternalRuntimePermissionForUi(
      (currentAgent?.runtimeConfig as { permissionMode?: string } | undefined)
        ?.permissionMode,
      currentRuntime,
    ) ||
      getDefaultRuntimePermissionMode(currentRuntime) ||
      'default',
  );

  // Sync runtimePermissionMode + runtimeModel when currentRuntime transitions.
  //
  // Background: the useState initializers above run ONCE on mount. On the first
  // render `currentRuntime` may still be 'builtin' because useConfig is loading
  // asynchronously. More importantly, the agent's runtimeConfig may carry a stale
  // permissionMode value from a previous runtime (e.g. 'no-restrictions' left over
  // from a Codex session, confirmed in unified-2026-04-15.log:918). Reading that
  // value verbatim can show an unrelated permission mode first.
  //
  // Fix: on every currentRuntime transition, validate the persisted value against
  // the current runtime's allowed mode set and only honor it if it's legal; else
  // fall back to the runtime's default mode. This effect does not fire on every
  // re-render (deps are currentRuntime + isExternalRuntime), so in-session user
  // selections made via the dropdown are never overwritten.
  useEffect(() => {
    if (!isExternalRuntime) return;
    const cfg = currentAgent?.runtimeConfig as
      | { permissionMode?: string; model?: string }
      | undefined;
    const saved =
      currentRuntime === 'dsh'
        ? currentAgent?.permissionMode
        : managedProviderRuntimeActive
          ? currentAgent?.permissionMode
          : cfg?.permissionMode;
    const effective = managedProviderRuntimeActive
      ? (projectManagedCodexPermissionToRuntime(saved) ?? 'auto-edit')
      : (coerceExternalRuntimePermissionForUi(saved, currentRuntime) ??
        (getDefaultRuntimePermissionMode(currentRuntime) || 'default'));
    setRuntimePermissionMode(effective);
    setRuntimeModel(
      currentRuntime === 'dsh'
        ? undefined
        : coerceExternalRuntimeModelForUi(cfg?.model, currentRuntime),
    );
    // #324 — re-seed effort on runtime transition. RUNTIME_CONFIG_PER_RUNTIME_FIELDS
    // scrubs reasoningEffort on agent runtime change, so a leftover value from a
    // different runtime can't be read here; absent = 'default'.
    setReasoningEffort(
      currentRuntime === 'dsh'
        ? (currentAgent?.reasoningEffort ?? 'default')
        : (coerceReasoningEffortForUi(
            (cfg as { reasoningEffort?: string } | undefined)?.reasoningEffort,
            currentRuntime,
          ) ?? 'default'),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: only re-sync on runtime transitions, not on every currentAgent.runtimeConfig edit
  }, [currentRuntime, isExternalRuntime, managedProviderRuntimeActive]);

  // Runtime-specific models and permission modes
  const runtimePermissionModes =
    currentRuntime === 'dsh'
      ? DSH_PERMISSION_MODES
      : currentRuntime === 'claude-code'
        ? CC_PERMISSION_MODES
        : currentRuntime === 'codex'
          ? CODEX_PERMISSION_MODES
          : undefined;

  // Codex models are dynamic (fetched from the CLI); CC models are static
  const [codexModels, setCodexModels] = useState<typeof CC_MODELS>([]);
  useEffect(() => {
    if (currentRuntime !== 'codex' || !isConnected) return;
    let cancelled = false;
    // AbortController so a tab-close (effect cleanup) silences the
    // proxyFetch "Sidecar gone" warning that would otherwise fire when
    // this in-flight request lands on a sidecar port that just got
    // released. Tauri invoke can't be cancelled mid-flight, but the
    // post-hoc filter in proxyFetch turns the rejection into a silent
    // AbortError instead of a noisy lifecycle log line.
    const controller = new AbortController();
    apiGet(
      runtimeModelCatalogPath(
        'codex',
        managedProviderRuntimeActive ? 'managed-provider' : 'system-cli',
      ),
      { signal: controller.signal },
    )
      .then((res: unknown) => {
        const data = res as { models?: typeof CC_MODELS } | undefined;
        if (!cancelled && data?.models?.length) setCodexModels(data.models);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    managedProviderRuntimeActive,
    currentRuntime,
    apiGet,
    isConnected,
    configPending,
    workspaceRefreshTrigger,
  ]);
  // ─── External runtime pre-warm (v0.1.68) ───
  //
  // DSH and Codex run as persistent protocol processes. On a cold
  // start their first message otherwise pays process spawn + initialize /
  // Session creation before the Provider request begins. DSH only uses this
  // path to resume an existing native Session; a fresh DSH Session is created
  // with the first admitted Product turn after Product identity is stable.
  // Firing
  // /api/runtime/prewarm as soon as the tab is ready
  // overlaps that cost with the user still typing — by the time they hit
  // send, the process is already alive and the message goes straight to
  // stdin via sendExternalMessage Case 3.
  //
  // Only fires for persistent runtimes (backend no-ops for CC since `-p` mode exits
  // per turn) and only once per (tab, session, runtime) combo — a ref keyed
  // by sessionId+runtime guards against re-firing on model/permission changes
  // or mid-session SSE reconnects. If the user sends a message before the
  // pre-warm finishes, sendExternalMessage's `startingPromise` await safely
  // serializes the two calls.
  const prewarmedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!runtimeSupportsPrewarm(currentRuntime)) return;
    if (!isActive || !isConnected || !sessionId) return;
    // Only a 'push' tab prewarms the sidecar with ITS config (model/permission).
    // 'pending' waits for the post-ensure resolver; 'adopt' must not override the
    // live sidecar's config. (External-runtime sibling of the MCP/model push gates.)
    if (configDispositionRef.current !== 'push') return;
    // Prewarm only the frozen Session runtime after its identity is known.
    if (sessionRuntime !== null && sessionRuntime !== currentRuntime) return;
    // Do not gate on runtime-model list readiness. Codex model discovery can
    // start its own app-server process; serializing it with pre-warm delays
    // the first turn. An undefined model lets Codex use its default.
    const key = `${sessionId}::${currentRuntime}`;
    if (prewarmedKeyRef.current === key) return;
    prewarmedKeyRef.current = key;
    // AbortController so tab close (effect cleanup) silences the proxyFetch
    // lifecycle warning when this request lands on a just-released sidecar
    // port. The actual prewarm subprocess startup is fire-and-forget — if
    // the tab closes mid-prewarm we don't care about the result anyway.
    const controller = new AbortController();
    apiPost(
      '/api/runtime/prewarm',
      {
        sessionId,
        model: effectiveModel, // may be undefined — runtime falls back to its default
      },
      { signal: controller.signal },
    )
      .then((res) => {
        // Backend returns { success: true, prewarmed: false, reason: '...' } when
        // the endpoint short-circuits (already-active/starting, runtime mismatch,
        // non-persistent runtime). In those cases the subprocess is NOT warm, so
        // clear the ref to allow a retry when conditions change (e.g., sessionRuntime
        // populates later and matches currentRuntime).
        const data = res as { prewarmed?: boolean } | undefined;
        if (managedProviderRuntimeActive && !controller.signal.aborted) {
          void apiGet(runtimeModelCatalogPath('codex', 'managed-provider'), {
            signal: controller.signal,
          })
            .then((result: unknown) => {
              const models = (result as { models?: typeof CC_MODELS })?.models;
              if (!controller.signal.aborted && models?.length)
                setCodexModels(models);
            })
            .catch(() => {});
        }
        if (data && data.prewarmed === false) {
          prewarmedKeyRef.current = null;
        }
      })
      .catch((err: unknown) => {
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
    return () => {
      controller.abort();
    };
    // Intentionally omit effectiveModel from deps —
    // config changes kill the pre-warmed process via setExternalModel/
    // setExternalPermissionMode, and the next user message will resume with
    // the new settings. Re-firing pre-warm on every keystroke-driven option
    // change would thrash the subprocess.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    managedProviderRuntimeActive,
    currentRuntime,
    isActive,
    isConnected,
    sessionId,
    sessionRuntime,
    apiPost,
    configPending,
  ]);

  const runtimeModels =
    currentRuntime === 'claude-code'
      ? CC_MODELS
      : currentRuntime === 'codex'
        ? managedProviderRuntimeActive
          ? []
          : codexModels
        : undefined;

  // Effective model/permission based on runtime.
  // For external runtimes: if user hasn't explicitly selected a model (runtimeModel=undefined),
  // use the default model from the runtime's model list — this matches what the UI displays.
  const effectiveRuntimeModel = inputUsesExternalRuntimeControls
    ? coerceExternalRuntimeModelForUi(runtimeModel, currentRuntime)
    : undefined;
  const effectiveModel = inputUsesExternalRuntimeControls
    ? (effectiveRuntimeModel ?? runtimeModels?.find((m) => m.isDefault)?.value)
    : selectedModel;
  const runtimeProviderSelectionIncomplete =
    !isProviderModelCompatibleWithRuntime(
      currentRuntime,
      currentProvider,
      effectiveModel,
    );
  const runtimeExecutionUnavailable =
    currentRuntime === 'dsh' &&
    runtimeDetections.dsh.readiness !== 'ready' &&
    runtimeDetections.dsh.readiness !== 'unverified-dev-runtime';
  const effectiveRuntimePermissionMode = isExternalRuntime
    ? (coerceExternalRuntimePermissionForUi(
        runtimePermissionMode,
        currentRuntime,
      ) ??
      getDefaultRuntimePermissionMode(currentRuntime) ??
      'default')
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
    projectSyncedRef.current ||
    hadInitialMessage.current ||
    sessionSnapshotOwnsConfig;
  const effectivePermissionMode = isExternalRuntime
    ? (effectiveRuntimePermissionMode as PermissionMode)
    : resolveBuiltinPermissionMode({
        projectSynced: permissionStateAuthoritative,
        statePermissionMode: permissionMode,
        agentPermissionMode: currentAgent?.permissionMode as string | undefined,
        projectPermissionMode: currentProject?.permissionMode,
        defaultPermissionMode: config.defaultPermissionMode,
      });

  const buildCronRuntimeConfig = useCallback((): RuntimeConfig | undefined => {
    if (!inputUsesExternalRuntimeControls) return undefined;
    const base = {
      ...((currentAgent?.runtimeConfig as RuntimeConfig | undefined) ?? {}),
    };
    if (currentProviderExecutionIntent?.kind === 'runtime-backed-provider') {
      base.source = currentProviderExecutionIntent.runtimeSource;
      base.model = currentProviderExecutionIntent.model;
    }
    const persistedModel = coerceExternalRuntimeModelForUi(
      base.model,
      currentRuntime,
    );
    if (persistedModel) {
      base.model = persistedModel;
    } else {
      delete base.model;
    }
    const selectedRuntimeModel = coerceExternalRuntimeModelForUi(
      runtimeModel,
      currentRuntime,
    );
    if (selectedRuntimeModel !== undefined) {
      base.model = selectedRuntimeModel;
    }
    const persistedPermission = coerceExternalRuntimePermissionForUi(
      base.permissionMode,
      currentRuntime,
    );
    if (persistedPermission) {
      base.permissionMode = persistedPermission;
    } else {
      delete base.permissionMode;
    }
    const selectedPermission =
      effectiveRuntimePermissionMode ??
      getDefaultRuntimePermissionMode(currentRuntime);
    if (
      persistedPermission !== undefined ||
      selectedPermission !== getDefaultRuntimePermissionMode(currentRuntime)
    ) {
      base.permissionMode = selectedPermission;
    }
    return Object.keys(base).length > 0 ? base : undefined;
  }, [
    inputUsesExternalRuntimeControls,
    currentAgent?.runtimeConfig,
    currentProviderExecutionIntent,
    runtimeModel,
    effectiveRuntimePermissionMode,
    currentRuntime,
  ]);

  const buildCronExecutionOverrides = useCallback(
    (args: { providerId?: string; model?: string }) =>
      projectTaskExecutionOverrides({
        providers,
        runtime: currentRuntime,
        providerId: args.providerId,
        model: args.model,
        runtimeConfig: buildCronRuntimeConfig(),
      }),
    [providers, currentRuntime, buildCronRuntimeConfig],
  );

  // Callback to refresh workspace (exposed to SimpleChatInput)
  const triggerWorkspaceRefresh = useCallback(() => {
    setWorkspaceRefreshTrigger((prev) => prev + 1);
    setIntroductionRefreshTrigger((prev) => prev + 1);
  }, []);

  // Stable callbacks for DirectoryPanel → AgentCapabilitiesPanel
  const handleInsertReference = useCallback((paths: string[]) => {
    chatInputRef.current?.insertReferences(paths);
  }, []);

  const handleInsertSlashCommand = useCallback((command: string) => {
    chatInputRef.current?.insertSlashCommand(command);
  }, []);

  const handleOpenSettings = useCallback(
    (initialSelect?: CapabilityInitialSelect) => {
      // All three kinds (skill/command/agent) live under the 'skills' tab in the
      // project workspace — that tab renders SkillsCommandsList AND WorkspaceAgentsList.
      setWorkspaceConfigInitialTab('skills');
      setWorkspaceConfigInitialSelect(initialSelect);
      setShowWorkspaceConfig(true);
    },
    [],
  );

  // Auto-send initial message from Launcher
  const initialMessageConsumedRef = useRef(false);
  const currentLaunchMessageRef = useRef(initialMessage);
  useLayoutEffect(() => { currentLaunchMessageRef.current = initialMessage; }, [initialMessage]);
  const onInitialMessageConsumedRef = useRef(onInitialMessageConsumed);
  onInitialMessageConsumedRef.current = onInitialMessageConsumed;
  const initialMessageRuntimeReady = useMemo(() => {
    const identity = initialMessage?.providerExecutionIdentity;
    if (!identity) return true;
    if (currentRuntime !== identity.runtime) return false;
    return currentRuntimeSource === identity.runtimeSource;
  }, [
    initialMessage?.providerExecutionIdentity,
    currentRuntime,
    currentRuntimeSource,
  ]);

  useEffect(() => {
    if (!initialMessage) return;
    // Wait for SSE connection (sidecar reachable) instead of non-pending sessionId.
    // The sessionId upgrades from pending only after the first message is processed,
    // but the first message IS the auto-send — so checking isPendingSessionId would deadlock.
    if (
      !shouldAutoSendInitialMessage({
        hasInitialMessage: true,
        alreadyConsumed: initialMessageConsumedRef.current,
        hasSessionId: !!sessionId,
        isConnected,
        isActive,
        runtimeReady: initialMessageRuntimeReady,
      })
    )
      return;

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
    const effectivePermission = (
      isExternalRuntime
        ? (initialRuntimePermission ??
          effectiveRuntimePermissionMode ??
          getDefaultRuntimePermissionMode(currentRuntime) ??
          'default')
        : resolveBuiltinPermissionMode({
            projectSynced: projectPermissionModeForRuntime(launchMessage.permissionMode, 'builtin') !== undefined,
            statePermissionMode: launchMessage.permissionMode ?? permissionMode,
            agentPermissionMode: currentAgent?.permissionMode as
              | string
              | undefined,
            projectPermissionMode: currentProject?.permissionMode,
            defaultPermissionMode: config.defaultPermissionMode,
          })
    ) as PermissionMode;
    const effectiveModel = inputUsesExternalRuntimeControls
      ? (coerceExternalRuntimeModelForUi(
          launchMessage.runtimeModel,
          currentRuntime,
        ) ??
        effectiveRuntimeModel ??
        runtimeModels?.find((m) => m.isDefault)?.value)
      : (builtinSel?.model ?? selectedModel);
    const provider = builtinSel
      ? (providers.find((p) => p.id === builtinSel.providerId) ??
        currentProvider)
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
          const effective = allServers.filter(
            (s) =>
              globalEnabled.includes(s.id) &&
              launchMessage.mcpEnabledServers!.includes(s.id),
          );
          await pushSessionConfig(
            'mcp',
            '/api/mcp/set',
            { servers: effective },
            'explicit',
          );
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
          setWorkspaceOfficialToolEnabled(
            normalizeOfficialToolIds(launchMessage.enabledOfficialToolIds),
          );
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
              initialRuntimePermission ??
                getDefaultRuntimePermissionMode(currentRuntime) ??
                'default',
            );
            const providerPermission = launchMessage.providerExecutionIdentity
              ? managedCodexRuntimePermissionToProviderPermission(
                  launchMessage.permissionMode,
                )
              : undefined;
            if (providerPermission) {
              setPermissionMode(providerPermission);
            }
          } else {
            setPermissionMode(effectivePermission);
            // #244: the launcher choice is now the authoritative builtin mode —
            // mark synced so effectivePermissionMode trusts state and doesn't
            // re-derive from the agent default (the project-sync effect is
            // skipped on initialMessage tabs).
            projectSyncedRef.current = true;
          }
        }
        if (inputUsesExternalRuntimeControls) {
          if (launchMessage.runtimeModel) {
            setRuntimeModel(
              coerceExternalRuntimeModelForUi(
                launchMessage.runtimeModel,
                currentRuntime,
              ),
            );
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
          const launchReasoningEffort = inputUsesExternalRuntimeControls
            ? (coerceReasoningEffortForUi(
                launchMessage.reasoningEffort,
                currentRuntime,
              ) ?? 'default')
            : launchMessage.reasoningEffort;
          setReasoningEffort(launchReasoningEffort);
          if (configDispositionRef.current === 'pending') {
            deferredEffortPushRef.current = launchReasoningEffort;
          } else {
            pushReasoningEffort(launchReasoningEffort);
          }
        }

        // TabProvider marks execution active when the message is admitted.
        scrollToBottom();

        // 5a. Cron handoff (PRD 0.2.7): if launcher staged a cron config, switch
        //     from the normal send path to startCronTask. This both creates the
        //     CronTask via Rust and triggers the first execution — same as if the
        //     user had typed in the chat input and clicked send with cron enabled.
        if (launchMessage.cron) {
          const cronExecution = buildCronExecutionOverrides({
            providerId:
              !inputUsesExternalRuntimeControls && provider
                ? provider.id
                : undefined,
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
            notification: launchMessage.cron.notification,
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
            const admitted = await sendMessage(
              launchMessage.text,
              launchMessage.images,
              effectivePermission,
              effectiveModel,
              inputUsesExternalRuntimeControls || providerRoute
                ? undefined
                : providerEnv,
              undefined,
              inputUsesExternalRuntimeControls ? undefined : (launchMessage.reasoningEffort ?? reasoningEffort),
              inputUsesExternalRuntimeControls ? undefined : providerRoute, undefined, undefined, launchMessage.agentMentions, launchMessage.primaryContext,
              undefined, startupClientRequestId,
            );
            if (admitted === false) throw new Error(t("tabProvider.sendFailed", { ns: "app" }));
          } else {
            // Cron creation completes this handoff without a desktop query row.
            dismissStartupOverlay();
          }
        } else {
          // 5b. Normal send path.
          const admitted = await sendMessage(
            launchMessage.text,
            launchMessage.images,
            effectivePermission,
            effectiveModel,
            inputUsesExternalRuntimeControls || providerRoute
              ? undefined
              : providerEnv,
            undefined,
            // launch value directly — the setReasoningEffort above isn't
            // visible in this closure (same-render state), and the first
            // message must already carry the launcher's choice.
            inputUsesExternalRuntimeControls ? undefined : (launchMessage.reasoningEffort ?? reasoningEffort),
            inputUsesExternalRuntimeControls ? undefined : providerRoute,
            launchMessage.requiredSystemSkill, undefined, launchMessage.agentMentions, launchMessage.primaryContext,
            undefined, startupClientRequestId,
          );
          if (admitted === false) throw new Error(t("tabProvider.sendFailed", { ns: "app" }));
        }

        if (currentLaunchMessageRef.current !== launchMessage) return;
        // Retire the launch payload; the boot shell waits for MessageList to
        // commit the corresponding server user row, independently of this prop.
        onInitialMessageConsumedRef.current?.();
      } catch (err) {
        if (currentLaunchMessageRef.current !== launchMessage) return;
        console.error('[Chat] Auto-send failed:', err);
        if (launcherOwnsInitialMcpRef.current) {
          launcherOwnsInitialMcpRef.current = false;
          setLauncherMcpFallbackRevision((revision) => revision + 1);
        }
        dismissStartupOverlay();
        // PRD 0.2.7 §4.5 failure recovery: restore the launcher draft (text /
        // images / cron config) into the chat input so the user can retry
        // without losing what they typed. Pre-PRD-0.2.7 the toast just said
        // "请重试" while the textarea was empty, silently dropping the draft.
        try {
          chatInputRef.current?.setValue(launchMessage.text,{agentMentions:launchMessage.agentMentions, primaryContext:launchMessage.primaryContext, requiredSystemSkill:launchMessage.requiredSystemSkill});
          if (launchMessage.images && launchMessage.images.length > 0) {
            chatInputRef.current?.setImages(launchMessage.images);
          }
          if (launchMessage.cron) {
            const cronExecution = buildCronExecutionOverrides({
              providerId:
                !inputUsesExternalRuntimeControls && provider
                  ? provider.id
                  : undefined,
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
              notification: launchMessage.cron.notification,
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
  }, [
    initialMessage,
    isActive,
    sessionId,
    isConnected,
    initialMessageRuntimeReady,
  ]);

  const materializeScheduledOwner = useCallback(async () => {
    if (!sessionId) throw new Error('Goal requires a session identity.');
    if (!isPendingSessionId(sessionId))
      return { sessionId, workspacePath: agentDir };
    if (!agentDir)
      throw new Error('Cannot materialize Goal without workspace path.');

    const result = await materializePendingSessionConfig({
      pendingSessionId: sessionId,
      tabId,
      workspacePath: agentDir,
      snapshotPatch: {},
      transport: {
        postCurrent: (body) => apiPost('/api/session/materialize', body),
      },
    });
    const adopted = await adoptMigratedSession(result.sessionId, {
      sidecarAlreadyMigrated: true,
    });
    if (!adopted)
      throw new Error(`Failed to adopt Goal session ${result.sessionId}.`);
    setSessionMeta(result.metadata);
    return { sessionId: result.sessionId, workspacePath: agentDir };
  }, [
    sessionId,
    tabId,
    agentDir,
    apiPost,
    adoptMigratedSession,
    setSessionMeta,
  ]);

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
      console.log(
        '[Chat] Cron execution complete:',
        task.id,
        task.executionCount,
        'effectiveSessionId:',
        effectiveSessionId,
        'success:',
        success,
      );
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
  const startScheduledTask = useCallback(
    async (prompt: string): Promise<'goal' | 'cron' | null> => {
      const goalConfig = goalDraftConfigRef.current;
      if (goalConfig) {
        const goal = await startGoal(
          { ...goalConfig, taskKind: 'goal' },
          prompt,
        );
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
    },
    [disableCronMode, startCronTask, startGoal],
  );
  const activeCurrentSessionCronTask =
    cronState.task?.status === 'running' &&
    cronState.task.runMode !== 'new_session'
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
    return () => {
      canceled = true;
    };
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
    toastRef.current.error(
      t('shell.toasts.providerUnavailable', {
        providerId: effectiveSelectedProviderId,
      }),
    );
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
    () =>
      stoppedCronRecovery?.task && stoppedCronRecovery.sessionId === sessionId
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
  const handleTauriChatDrop = useCallback(
    async (paths: string[]) => {
      if (isDebugMode()) {
        console.log('[Chat] Tauri drop on chat area:', paths);
      }
      // Use the SimpleChatInput's method to process file paths
      await chatInputRef.current?.processDroppedFilePaths?.(paths);
      // Refresh workspace to show new files
      triggerWorkspaceRefresh();
    },
    [triggerWorkspaceRefresh],
  );

  // Handle Tauri file drop on directory panel. Forward the drop position so
  // the panel resolves the target folder from the tree row under the pointer
  // (instead of the current selection — see DirectoryPanelHandle.handleFileDrop).
  const handleTauriDirectoryDrop = useCallback(
    async (paths: string[], position?: { x: number; y: number }) => {
      if (isDebugMode()) {
        console.log('[Chat] Tauri drop on directory panel:', paths, position);
      }
      await directoryPanelRef.current?.handleFileDrop(paths, position);
    },
    [],
  );

  // Use refs to avoid recreating onDrop callback when handlers change
  const handleTauriChatDropRef = useRef(handleTauriChatDrop);
  const handleTauriDirectoryDropRef = useRef(handleTauriDirectoryDrop);
  useEffect(() => {
    handleTauriChatDropRef.current = handleTauriChatDrop;
    handleTauriDirectoryDropRef.current = handleTauriDirectoryDrop;
  }, [handleTauriChatDrop, handleTauriDirectoryDrop]);

  const {
    isDragging: isTauriDragging,
    activeZoneId,
    registerZone,
    unregisterZone,
  } = useTauriFileDrop({
    // Tauri drag events are window-global and fire on every mounted hook instance.
    // Without this gate, a single Finder drop (or image drag) lands in ALL open tabs'
    // attachment/workspace state because every hidden tab's zone still matches the
    // geometric check (absolute inset-0 overlap) AND the `zoneId === null` fallback
    // below defaults to chat-drop regardless. Gating at the hook ensures only the
    // visible tab reacts.
    enabled: isActive,
    onDrop: (paths, zoneId, position) => {
      if (isDebugMode()) {
        console.log(
          '[Chat] Tauri drop event - zoneId:',
          zoneId,
          'paths:',
          paths,
        );
      }
      if (zoneId === 'chat-content') {
        void handleTauriChatDropRef.current(paths);
      } else if (zoneId === 'directory-panel') {
        void handleTauriDirectoryDropRef.current(paths, position);
      }
    },
  });

  // Register drop zones for Tauri (only for position detection, handlers are in onDrop above)
  useEffect(() => {
    if (!isTauriEnvironment()) return;

    // Register chat content drop zone (empty callback - handled in global onDrop)
    registerZone('chat-content', chatContentRef.current, () => {});

    // Register directory panel drop zone (empty callback - handled in global onDrop)
    registerZone(
      'directory-panel',
      directoryPanelContainerRef.current,
      () => {},
    );

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
  const hasMcpDefaultAgent = currentAgent !== undefined;
  const agentMcpDefaults = currentAgent?.mcpEnabledServers;
  const projectMcpDefaults = currentProject?.mcpEnabledServers;
  const [workspaceMcpEnabled, setWorkspaceMcpEnabled] = useState<string[]>(
    resolveDefaultMcpSelection(currentAgent, currentProject),
  );
  const runtimeMcpTools = useMemo(
    () =>
      mcpEffectiveSnapshot?.tools ??
      (isExternalRuntime
        ? (systemInitInfo?.tools ?? []).filter((tool) =>
            tool.startsWith('mcp__'),
          )
        : []),
    [isExternalRuntime, mcpEffectiveSnapshot?.tools, systemInitInfo?.tools],
  );

  // PRD 0.2.17 — Claude plugin per-workspace enable state. Init from Agent
  // (preferred) or Project. Layer 1 (global visibility) is applied later
  // when computing the dropdown candidate list.
  const [workspaceEnabledPlugins, setWorkspaceEnabledPlugins] = useState<
    string[]
  >(currentAgent?.enabledPluginIds ?? currentProject?.enabledPluginIds ?? []);
  const [workspaceOfficialToolEnabled, setWorkspaceOfficialToolEnabled] =
    useState<OfficialToolId[]>(
      normalizeOfficialToolIds(
        currentAgent?.enabledOfficialToolIds ??
          currentProject?.enabledOfficialToolIds ??
          [],
      ),
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
    () => ({
      [IMAGE_UNDERSTANDING_TOOL_ID]: !imageUnderstandingConfiguredForInput,
    }),
    [imageUnderstandingConfiguredForInput],
  );

  // A running Task is restored from Rust's scheduler snapshot for this Session.
  const pendingCronLoadingRef = useRef(false);
  const prevMessagesRef = useRef(messages);
  const restoreSessionCronProjection = useCallback((task: CronTask, executing: boolean) => {
    restoreCronTask(task);
    setStoppedCronRecovery(null);
    if (executing) {
      pendingCronLoadingRef.current = true;
      setCronExecutionState(task.id, true, (task.executionCount ?? 0) + 1);
    }
  }, [restoreCronTask, setCronExecutionState]);

  useSessionCronRestore({
    sessionId,
    tabId,
    task: cronState.task,
    onRestore: restoreSessionCronProjection,
    onClear: disableCronMode,
  });

  // Set loading state after TabProvider's loadSession completes (for cron task executing scenario)
  // This effect watches for messages reference changes, which indicates loadSession has completed
  // Using reference comparison (not length) to handle edge case where message count stays the same
  useEffect(() => {
    // Only proceed if we have pending cron loading and messages array has changed
    if (pendingCronLoadingRef.current && messages !== prevMessagesRef.current) {
      console.log(
        '[Chat] loadSession completed, setting loading state for cron execution',
      );
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
        const snapshot = configRef.current;
        const servers = getAllMcpServersFromConfig(snapshot);
        const enabledIds = Array.isArray(snapshot.mcpEnabledServers) ? snapshot.mcpEnabledServers : [];
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
        const effectiveServers = servers.filter(
          (s) => enabledIds.includes(s.id) && workspaceEnabled.includes(s.id),
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
          console.log(
            '[Chat] Initial MCP sync:',
            effectiveServers.map((s) => s.id).join(', ') || 'none',
          );
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
      const response = await apiGet<{
        success: boolean;
        agents: Record<
          string,
          {
            description: string;
            prompt: string;
            model?: string;
            scope?: 'user' | 'project';
            folderName?: string;
          }
        >;
      }>('/api/agents/enabled');
      if (response.success && response.agents) {
        setEnabledAgents(response.agents);
        // Skip push when joining existing sidecar to avoid overwriting session config
        if (configDispositionRef.current !== 'push') {
          if (isDebugMode()) {
            console.log(
              '[Chat] Skipping agents push (joined existing sidecar)',
            );
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
          console.log(
            '[Chat] Agents synced:',
            Object.keys(response.agents).join(', ') || 'none',
          );
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

  const handleSyncSkillToGlobal = useCallback(
    async (folderName: string) => {
      try {
        const res = await apiPost<{ success: boolean; error?: string }>(
          '/api/skill/copy-to-global',
          { folderName },
        );
        if (res.success) {
          toastRef.current.success(t('shell.toasts.skillSyncedToGlobal'));
          loadSkillsAndCommandsRef.current();
          window.dispatchEvent(
            new CustomEvent(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED),
          );
        } else {
          toastRef.current.error(res.error || t('shell.toasts.syncFailed'));
        }
      } catch (err) {
        console.error('[Chat] Sync skill to global failed:', err);
        toastRef.current.error(t('shell.toasts.syncFailedRetry'));
      }
    },
    [apiPost, t],
  );

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

  // Future defaults follow their Agent owner until the Session freezes them.
  useEffect(() => {
    if (sessionMeta?.configSnapshotAt) return;
    setWorkspaceMcpEnabled(resolveDefaultMcpSelection(
      hasMcpDefaultAgent ? { mcpEnabledServers: agentMcpDefaults } : undefined,
      { mcpEnabledServers: projectMcpDefaults },
    ));
  }, [agentMcpDefaults, projectMcpDefaults, hasMcpDefaultAgent, sessionMeta?.configSnapshotAt]);

  useEffect(() => {
    if (sessionMeta?.configSnapshotAt) return;
    const next =
      currentAgent?.enabledOfficialToolIds ??
      currentProject?.enabledOfficialToolIds;
    if (next) setWorkspaceOfficialToolEnabled(normalizeOfficialToolIds(next));
  }, [
    currentAgent?.enabledOfficialToolIds,
    currentProject?.enabledOfficialToolIds,
    sessionMeta?.configSnapshotAt,
  ]);

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
    isExternalRuntime: inputUsesExternalRuntimeControls,
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
  const patchSnapshot = useCallback(
    async (patch: Parameters<typeof patchSessionMetadata>[1]) => {
      if (!sessionId) return;
      if (isPendingSessionId(sessionId)) {
        if (!agentDir) {
          throw new Error(
            'Cannot materialize pending session without workspace path.',
          );
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
        const adopted = await adoptMigratedSession(result.sessionId, {
          sidecarAlreadyMigrated: true,
        });
        if (!adopted) {
          throw new Error(
            `Failed to adopt materialized session ${result.sessionId}.`,
          );
        }
        setSessionMeta(result.metadata);
        return;
      }
      const updated = await patchSessionMetadata(sessionId, patch, {
        type: 'tab',
        id: tabId,
      });
      if (!updated) {
        throw new Error(`Session ${sessionId} not found.`);
      }
      setSessionMeta(updated);
    },
    [sessionId, tabId, agentDir, apiPost, adoptMigratedSession, setSessionMeta],
  );

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
  const persistTabConfigChange = useCallback(
    async (patch: {
      builtinSelection?: BuiltinModelSelection;
      builtinProviderEnvPolicy?: BuiltinProviderEnvPolicy;
      runtimeBackedProviderSelection?: RuntimeBackedProviderIdentity;
      runtimeBackedProviderContext?: RuntimeBackedProviderIdentity;
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
      // Team AI Agents are shared: a conversation never edits the Agent
      // defaults. A peer's current Session instead carries its peer profile.
      const teamAiWorkspace = currentProject.purpose === 'team-ai';
      const nextManagedModel = patch.runtimeBackedProviderSelection?.model;
      const nextEffort = nextManagedModel
        ? reasoningEffortAfterModelChange(
            patch.reasoningEffort ?? reasoningEffort,
            codexModels.find((model) => model.value === nextManagedModel),
          )
        : undefined;
      const effortReset =
        nextEffort === 'default' && reasoningEffort !== 'default';
      if (nextEffort !== undefined)
        patch = { ...patch, reasoningEffort: nextEffort };
      const handleExtensionUpdateResponse = (
        response: ExtensionUpdateResponse,
      ): void => {
        const status = response.extensionStatus;
        if (response.success === false || status?.state === 'failed') {
          throw new Error(
            response.error ?? 'Managed Codex extension update failed',
          );
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
        usesProductConfiguration: currentRuntime === 'dsh',
        currentRuntimeConfig: currentAgent?.runtimeConfig,
        currentRuntimePreference: currentAgent?.runtimePreference,
        currentProviderId:
          currentAgent?.providerId ?? currentProject.providerId,
        fields: {
          builtinSelection: patch.builtinSelection,
          builtinProviderEnvPolicy: patch.builtinProviderEnvPolicy,
          runtimeBackedProviderSelection: patch.runtimeBackedProviderSelection,
          runtimeBackedProviderContext: patch.runtimeBackedProviderContext,
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
        defaultsWriteMode: teamAiWorkspace ? 'disabled' : 'enabled',
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
          const response = await apiPost<ExtensionUpdateResponse>(
            '/api/cc-plugin/session-enable',
            { enabledIds },
          );
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
      if (teamAiWorkspace && !result.snapshotWriteFailed && !skipSnapshotWrite
        && currentProject.agentId && sessionId && !isPendingSessionId(sessionId)) {
        const warn = () => toastRef.current.warning(t('shell.toasts.teamAiPeerProfileFailed'));
        void syncTeamAiPeerProfile(currentProject.agentId, sessionId)
          .then((synced) => { if (synced.peerProfile === 'failed') warn(); })
          .catch(warn);
      }
      if (!result.snapshotWriteFailed && nextEffort !== undefined) {
        setReasoningEffort(nextEffort);
        if (effortReset) toastRef.current.info(t('input.reasoningModelReset'));
      }
      return !result.snapshotWriteFailed;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- narrowed deps; persistInputOptionChange is a pure import, runtimeConfig accessed via currentAgent ref, apiPost is stable from TabContext
    [
      reasoningEffort,
      codexModels,
      skipSnapshotWrite,
      currentProject?.id,
      currentProject?.agentId,
      currentProject?.purpose,
      sessionId,
      isExternalRuntime,
      currentRuntime,
      currentAgent?.runtimeConfig,
      patchSnapshot,
      patchProject,
      t,
    ],
  );

  const handleMcpRetry = useCallback(
    (serverId: string) =>
      apiPost<import('../../shared/mcpFailure').McpRetryResult>(
        '/api/mcp/retry',
        { serverId },
      ),
    [apiPost],
  );

  // Handle workspace MCP toggle — Tab UI edits dual-write:
  // (1) session snapshot so THIS session uses the new tool set immediately (owned sessions only
  //     — unlocked/IM have no snapshot);
  // (2) project + agent so FUTURE new sessions inherit the user's latest choice (PRD
  //     v0.1.69 §4.3 rule 2: "写 Session + 向上写 Agent"). For unlocked/IM this is also
  //     the live-follow source, so the single write covers both roles.
  const handleWorkspaceMcpToggle = useCallback(
    async (serverId: string, enabled: boolean) => {
      if (guardCronConfigMutation()) return;
      if (
        serverId === MANAGED_BROWSER_MCP_ID &&
        enabled &&
        !managedBrowserReady
      ) {
        toastRef.current.warning(
          tSettings('toolbox.browserResource.installFirst'),
        );
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
      const persisted = await persistTabConfigChange({
        mcpEnabledServers: newEnabled,
      });
      if (!persisted) {
        setWorkspaceMcpEnabled(workspaceMcpEnabled);
      }
    },
    [
      workspaceMcpEnabled,
      persistTabConfigChange,
      guardCronConfigMutation,
      managedBrowserReady,
      tSettings,
    ],
  );

  // PRD 0.2.17 — Claude plugin per-workspace toggle. Mirrors MCP exactly:
  // optimistic local update + dual-write via persistTabConfigChange (which
  // also pushes /api/cc-plugin/session-enable to the running sidecar so
  // the SDK options pick up the new plugin set on next pre-warm).
  const handleWorkspacePluginToggle = useCallback(
    async (pluginId: string, enabled: boolean) => {
      if (guardCronConfigMutation()) return;
      const newEnabled = enabled
        ? [...workspaceEnabledPlugins, pluginId]
        : workspaceEnabledPlugins.filter((id) => id !== pluginId);
      setWorkspaceEnabledPlugins(newEnabled);
      const persisted = await persistTabConfigChange({
        enabledPluginIds: newEnabled,
      });
      if (!persisted) {
        setWorkspaceEnabledPlugins(workspaceEnabledPlugins);
      }
    },
    [workspaceEnabledPlugins, persistTabConfigChange, guardCronConfigMutation],
  );

  const handleWorkspaceOfficialToolToggle = useCallback(
    async (toolId: OfficialToolId, enabled: boolean) => {
      if (guardCronConfigMutation()) return;
      const newEnabled = normalizeOfficialToolIds(
        enabled
          ? [...workspaceOfficialToolEnabled, toolId]
          : workspaceOfficialToolEnabled.filter((id) => id !== toolId),
      );
      setWorkspaceOfficialToolEnabled(newEnabled);
      const persisted = await persistTabConfigChange({
        enabledOfficialToolIds: newEnabled,
      });
      if (!persisted) {
        setWorkspaceOfficialToolEnabled(workspaceOfficialToolEnabled);
      }
    },
    [
      workspaceOfficialToolEnabled,
      persistTabConfigChange,
      guardCronConfigMutation,
    ],
  );

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
    if (
      !shouldResetModelOnProviderChange({
        providerType: currentProvider?.type,
        providerModels: currentProvider?.models?.map((m) => m.model),
        selectedModel,
      })
    )
      return;
    if (currentProvider?.primaryModel) {
      setSelectedModel(currentProvider.primaryModel);
    }
  }, [
    currentProvider?.id,
    currentProvider?.primaryModel,
    currentProvider?.models,
    currentProvider?.type,
    selectedModel,
    pinnedProviderUnavailable,
    sessionSnapshotOwnsConfig,
  ]);

  // One-time sync: apply project-stored settings after useConfig finishes async load.
  // useState initializers run with currentProject=undefined (useConfig loads asynchronously),
  // so project settings must be re-applied once currentProject becomes available.
  // Placed AFTER provider change effect so project model takes priority in same render cycle.
  // Skipped when initialMessage is provided (BrandSection path applies its own settings).
  useEffect(() => {
    // While 'pending' (instant flip pre-ensure), wait WITHOUT marking
    // projectSyncedRef — so this re-runs once the disposition resolves (configPending
    // is in deps). On 'adopt' the model seed below is gated to 'push' so adoption owns it.
    if (
      !currentProject ||
      projectSyncedRef.current ||
      hadInitialMessage.current ||
      configPending
    )
      return;
    if (waitingForExistingSessionMeta) return;
    if (sessionSnapshotOwnsConfig) {
      projectSyncedRef.current = true;
      return;
    }
    projectSyncedRef.current = true;
    // AgentConfig is source of truth, Project is fallback for non-agent workspaces
    const effectivePermission = resolveBuiltinPermissionMode({
      projectSynced: false,
      statePermissionMode: permissionMode,
      agentPermissionMode: currentAgent?.permissionMode,
      projectPermissionMode: currentProject.permissionMode,
      defaultPermissionMode: config.defaultPermissionMode,
    });
    setPermissionMode(effectivePermission);
    // Runtime-specific permission mode sync is handled by the `[currentRuntime, isExternalRuntime]`
    // effect higher up, which validates the persisted value against the current runtime's mode
    // set and falls back to the runtime default if stale. Don't override here without validation —
    // doing so reintroduces a cross-runtime permission-mode leak.
    // Sync provider (useState initializer runs when currentProject is still undefined).
    // Re-arm providerInitRef to suppress the deferred provider-change effect (fires next render)
    // that would otherwise override the project-stored model with provider's primaryModel.
    const effectiveProvider =
      currentAgent?.providerId ?? currentProject.providerId;
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
    if (
      !inputUsesExternalRuntimeControls &&
      configDispositionRef.current === 'push'
    ) {
      setReasoningEffort(currentAgent?.reasoningEffort ?? 'default');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time sync when project first loads
  }, [
    currentProject?.id,
    configPending,
    sessionId,
    sessionMeta,
    sessionSnapshotOwnsConfig,
  ]);

  // v0.1.69: session snapshot → local state (session-first per D7 Option C).
  // Also handles T11 reset-on-session-switch: when switching to an unlocked / IM session
  // (no snapshot), fall back to the agent's current config so stale local state from a
  // previously-loaded locked session doesn't bleed across. Runs on session load AND after
  // PATCH /sessions/:id. React bails on setState when target === current, so no render loop.
  useEffect(() => {
    if (!sessionMeta) return; // Not loaded yet — keep mount-time defaults
    if (configDispositionRef.current !== 'push' && !sessionMeta.configSnapshotAt) return;
    // Sticky guard: adoption may have already completed and cleared the flag
    // BEFORE this sessionMeta dispatch arrived (loadSession sets sessionMeta after
    // /api/session/config returns). Re-applying persisted snapshot here would
    // overwrite the just-adopted live sidecar config.
    if (
      adoptedSessionRef.current &&
      adoptedSessionRef.current === sessionMeta.id && !sessionMeta.configSnapshotAt
    )
      return;
    // Field-by-field merge remains for unlocked / live-follow sessions. Owned
    // sessions are source-owned by SessionMetadata: falling back to the current
    // Agent during the async metadata window reintroduces cross-session config
    // stomp (#395/#396).
    const snapshotRuntime =
      (sessionMeta.runtime as RuntimeType | undefined) ?? agentRuntime;
    const snapshotIsExternal = snapshotRuntime !== 'builtin';
    const snapshotIsManagedProvider =
      snapshotIsExternal && isManagedProviderSessionSnapshot(sessionMeta);
    const snapshotUsesProviderPicker = shouldSessionSnapshotUseProviderPicker({
      session: sessionMeta,
      runtime: snapshotRuntime,
    });
    const snapshotUsesExternalRuntimeControls = !snapshotUsesProviderPicker;
    const snapshotOwnsConfig = Boolean(sessionMeta.configSnapshotAt);
    const fallbackModel = snapshotUsesProviderPicker
      ? currentAgent?.model
      : (currentAgent?.runtimeConfig as RuntimeConfig | undefined)?.model;
    const rawModel = snapshotOwnsConfig
      ? sessionMeta.model
      : (sessionMeta.model ?? fallbackModel);
    const runtimeModelValue = snapshotUsesExternalRuntimeControls
      ? coerceExternalRuntimeModelForUi(rawModel, snapshotRuntime)
      : rawModel;
    const providerModelValue = snapshotIsManagedProvider
      ? managedProviderSnapshotModel(sessionMeta, rawModel)
      : rawModel;
    const fallbackMode = currentAgent?.permissionMode as string | undefined;
    const rawMode = snapshotUsesProviderPicker
      ? snapshotOwnsConfig
        ? sessionMeta.permissionMode
        : (sessionMeta.permissionMode ?? fallbackMode)
      : sessionMeta.permissionMode;
    const runtimePermissionValue = snapshotIsManagedProvider
      ? (projectManagedCodexPermissionToRuntime(rawMode) ?? 'auto-edit')
      : snapshotIsExternal
        ? coerceExternalRuntimePermissionForUi(rawMode, snapshotRuntime)
        : rawMode;
    const providerPermissionValue = snapshotIsManagedProvider
      ? managedCodexRuntimePermissionToProviderPermission(
          runtimePermissionValue ??
            getDefaultRuntimePermissionMode(snapshotRuntime),
        )
      : rawMode;
    const providerId = snapshotOwnsConfig
      ? snapshotIsManagedProvider
        ? managedProviderSnapshotProviderId(sessionMeta)
        : isConcreteProviderRoute(sessionMeta.providerRoute)
          ? sessionMeta.providerRoute.providerId
          : resolveLegacyBuiltinSnapshotProviderId({
              snapshotProviderId: sessionMeta.providerId,
              snapshotModel: sessionMeta.model,
              selectedProviderId,
              providers,
              apiKeys,
              providerVerifyStatus,
            })
      : (sessionMeta.providerId ?? currentAgent?.providerId);
    const mcp = snapshotOwnsConfig
      ? sessionMeta.mcpEnabledServers
      : (sessionMeta.mcpEnabledServers ?? resolveDefaultMcpSelection(currentAgent, currentProject));
    const plugins = snapshotOwnsConfig
      ? (sessionMeta.enabledPluginIds ?? [])
      : (sessionMeta.enabledPluginIds ??
        currentAgent?.enabledPluginIds ??
        currentProject?.enabledPluginIds ??
        []);
    const officialTools = snapshotOwnsConfig
      ? (sessionMeta.enabledOfficialToolIds ?? [])
      : normalizeOfficialToolIds(
          sessionMeta.enabledOfficialToolIds ??
            currentAgent?.enabledOfficialToolIds ??
            currentProject?.enabledOfficialToolIds ??
            [],
        );
    // #324 — snapshot effort wins over agent default; a persisted 'default'
    // is meaningful (session explicitly reverted) and flows through as-is.
    // UNCONDITIONAL set (`?? 'default'`, unlike model's `if (model)`): effort's
    // undefined has a defined meaning (= default), so a session without the
    // field must reset the picker — keeping the previous session's value here
    // is a cross-session leak (cross-review Critical).
    const fallbackEffort = snapshotUsesProviderPicker
      ? currentAgent?.reasoningEffort
      : (currentAgent?.runtimeConfig as RuntimeConfig | undefined)
          ?.reasoningEffort;
    const snapEffort = snapshotOwnsConfig
      ? sessionMeta.reasoningEffort
      : (sessionMeta.reasoningEffort ?? fallbackEffort);
    if (snapshotOwnsConfig) {
      projectSyncedRef.current = true;
    }
    if (snapshotUsesExternalRuntimeControls) {
      setRuntimeModel(runtimeModelValue);
    }
    if (
      snapshotUsesProviderPicker &&
      (snapshotOwnsConfig || providerModelValue)
    ) {
      setSelectedModel(providerModelValue);
    }
    setReasoningEffort(
      (snapshotUsesExternalRuntimeControls
        ? coerceReasoningEffortForUi(snapEffort, snapshotRuntime)
        : snapEffort) ?? 'default',
    );
    if (snapshotIsExternal) {
      setRuntimePermissionMode(
        runtimePermissionValue ??
          getDefaultRuntimePermissionMode(snapshotRuntime) ??
          'default',
      );
    }
    if (
      snapshotUsesProviderPicker &&
      (snapshotOwnsConfig || providerPermissionValue)
    ) {
      setPermissionMode(
        (providerPermissionValue as PermissionMode | undefined) ?? 'auto',
      );
    }
    if (snapshotUsesProviderPicker && providerId) {
      setSelectedProviderId(providerId);
    } else if (
      snapshotUsesProviderPicker &&
      snapshotOwnsConfig &&
      providers.length > 0
    ) {
      setSelectedProviderId(undefined);
    }
    setWorkspaceMcpEnabled(mcp ?? []);
    setWorkspaceEnabledPlugins(plugins);
    setWorkspaceOfficialToolEnabled(normalizeOfficialToolIds(officialTools));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- currentAgent derived from config, listening to its identity would re-fire on unrelated agent changes
  }, [sessionMeta, configPending, selectedProviderId, providers]);

  // 若 selectedModel 不在当前 provider 的 models 中（如模型已被删除），回退到 primaryModel 并更新项目
  useEffect(() => {
    if (
      !currentProject ||
      !currentProvider ||
      configDispositionRef.current !== 'push'
    )
      return;
    if (waitingForExistingSessionMeta) return;
    if (sessionSnapshotOwnsConfig) return;
    // #300: `currentProvider` here is the fallback provider, NOT the session's
    // pinned one — the pinned model legitimately isn't in its model list. Without
    // this guard the effect would "heal" the model to the fallback provider's
    // primaryModel AND persist it to project/agent, permanently corrupting the
    // user's choice. Leave it; the send guard surfaces the unavailability instead.
    if (pinnedProviderUnavailable) return;
    if (
      currentProvider.type === 'subscription' &&
      !isRuntimeBackedProvider(currentProvider)
    )
      return;
    if (
      !Array.isArray(currentProvider.models) ||
      currentProvider.models.length === 0
    )
      return;
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
        currentRuntimePreference: currentAgent?.runtimePreference,
        currentProviderId:
          currentAgent?.providerId ?? currentProject.providerId,
        fields: { builtinModel: fallback },
        snapshotWriteMode: 'disabled',
        // Team AI defaults change only from Agent settings.
        defaultsWriteMode: currentProject.purpose === 'team-ai' ? 'disabled' : 'enabled',
        patchProject,
        patchAgentConfig,
        patchAgentProjectConfig,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to specific sub-properties, not full object refs
  }, [
    currentProject?.id,
    currentProvider?.id,
    currentProvider?.models,
    currentProvider?.primaryModel,
    selectedModel,
    patchProject,
    pinnedProviderUnavailable,
    configPending,
    sessionSnapshotOwnsConfig,
    waitingForExistingSessionMeta,
    currentAgent?.runtimeConfig,
    currentAgent?.providerId,
    currentProject?.providerId,
  ]);

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
  //      Codex falls back to its own default
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
    const runtimeResolved =
      sessionRuntime !== null || currentAgent !== undefined;
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

    const modelToPush = inputUsesExternalRuntimeControls
      ? runtimeModel
      : selectedModel;
    if (sessionSnapshotOwnsConfig) {
      const snapshotModel = inputUsesExternalRuntimeControls
        ? coerceExternalRuntimeModelForUi(sessionMeta?.model, currentRuntime)
        : sessionMeta?.model;
      if (modelToPush !== snapshotModel) return;
    }
    // External + no explicit pick → defer to runtime's built-in default.
    if (!modelToPush) return;

    const dedupeKey = `${sessionId}::${modelToPush}`;
    if (lastPushedModelKeyRef.current === dedupeKey) return;
    lastPushedModelKeyRef.current = dedupeKey;

    apiPost('/api/model/set', { model: modelToPush }).catch((err) => {
      console.error('[Chat] sync model failed:', err);
      lastPushedModelKeyRef.current = null; // allow retry
    });
  }, [
    isConnected,
    sessionRuntime,
    currentAgent,
    inputUsesExternalRuntimeControls,
    runtimeModel,
    selectedModel,
    sessionId,
    apiPost,
    configPending,
    isSessionLoading,
    sessionSnapshotOwnsConfig,
    sessionMeta?.model,
    currentRuntime,
  ]);

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
      adoptingSessionId === sessionIdRef.current &&
      configDispositionRef.current === 'adopt';

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
          const sidecarUsesExternalRuntimeControls =
            sidecarRuntime !== 'builtin' && sidecarRuntime !== 'dsh';

          if (config.model) {
            if (sidecarUsesExternalRuntimeControls) {
              setRuntimeModel(config.model);
            } else {
              setSelectedModel(config.model);
            }
          }
          if (config.permissionMode) {
            if (sidecarUsesExternalRuntimeControls) {
              setRuntimePermissionMode(config.permissionMode);
            } else {
              setPermissionMode(config.permissionMode as PermissionMode);
            }
          }
          const adoptedProviderId = resolveAdoptedBuiltinProviderId(
            sidecarUsesExternalRuntimeControls,
            config.providerId,
          );
          if (adoptedProviderId !== undefined) {
            setSelectedProviderId(adoptedProviderId);
          }
          if (Array.isArray(config.mcpServerIds)) {
            setWorkspaceMcpEnabled(config.mcpServerIds);
          }
          if (Array.isArray(config.enabledOfficialToolIds)) {
            setWorkspaceOfficialToolEnabled(
              normalizeOfficialToolIds(config.enabledOfficialToolIds),
            );
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
      if (message.role === 'assistant' && rootUserMessageId)
        ids.add(rootUserMessageId);
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
    setInputOverlayHeight((prev) =>
      Math.abs(prev - height) < 1 ? prev : Math.ceil(height),
    );
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
    pauseAutoScroll,
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
    setWorkspaceRefreshTrigger((prev) => prev + 1);
  }, [isActive, refreshProviderData]);

  // Persisted capability mutations invalidate every mounted Tab snapshot.
  // Note: WorkspaceConfigPanel has its own event listener for internalRefreshKey
  useEffect(() => {
    const handleCapabilitiesChanged = () => {
      setWorkspaceRefreshTrigger((k) => k + 1);
    };
    window.addEventListener(
      CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED,
      handleCapabilitiesChanged,
    );
    return () =>
      window.removeEventListener(
        CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED,
        handleCapabilitiesChanged,
      );
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
      setWorkspaceRefreshTrigger((k) => k + 1);
    }
  }, [isConnected]);

  // Handle provider change with analytics tracking.
  // targetModel: when provided, use this model instead of the provider's primaryModel
  // (avoids useEffect race when user picks a specific model from a different provider).
  const handleProviderChange = useCallback(
    async (providerId: string, targetModel?: string) => {
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
          const nextIntent = buildProviderExecutionIntent(
            currentProviderForHistory,
            targetModel,
          );
          const canResumeProviderHistory = canResumeProviderHistoryForSwitch({
            currentIntent: currentProviderExecutionIntent,
            nextIntent,
            currentProviderEnv: currentProviderHistoryEnv,
            nextProviderEnv: currentProviderForHistory
              ? toProviderHistoryEnv(currentProviderForHistory, targetModel)
              : undefined,
            legacyCurrentProviderUnknown: builtinSnapshotProviderHistoryUnknown,
          });
          if (
            !canResumeProviderHistory &&
            (messagesRef.current.length > 0 ||
              isRuntimeBackedIntent(currentProviderExecutionIntent) ||
              isRuntimeBackedIntent(nextIntent))
          ) {
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
      track('provider_switch', {
        source: 'desktop',
        tab_id: tabId,
        session_id: sessionIdRef.current,
        runtime: currentRuntime,
        runtime_source: runtimeSourceForRuntimeType(currentRuntime, currentRuntimeSource) ?? null,
        provider_id: providerId,
      });

      const newProvider = providers.find((p) => p.id === providerId);
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
      if (
        !canResumeProviderHistory &&
        (messagesRef.current.length > 0 ||
          isRuntimeBackedIntent(currentProviderExecutionIntent) ||
          isRuntimeBackedIntent(nextIntent))
      ) {
        setPendingProviderSwitch({ providerId, model });
        return; // Don't update state — dialog will handle it
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
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- narrowed deps; messagesRef avoids dep on messages array
    [
      tabId,
      currentRuntime,
      currentRuntimeSource,
      effectiveSelectedProviderId,
      selectedModel,
      providers,
      currentProviderForHistory?.id,
      currentProviderForHistory?.type,
      currentProviderForHistory?.config.baseUrl,
      currentProviderForHistory?.apiProtocol,
      currentProviderForHistory?.subscriptionAuth,
      currentProviderExecutionIntent,
      builtinSnapshotProviderHistoryUnknown,
      effectivePermissionMode,
      persistTabConfigChange,
      guardCronConfigMutation,
    ],
  );

  const handleBuiltinModelSelect = useCallback(
    async (selection: BuiltinModelSelection) => {
      await handleProviderChange(selection.providerId, selection.model);
    },
    [handleProviderChange],
  );

  // Handle model change with analytics tracking.
  // Dual-write per PRD v0.1.69 §4.3 rule 2 "写 Session + 向上写 Agent": owned sessions
  // snapshot the new model locally so this session persists the choice; project + agent
  // also get written so FUTURE new sessions / Bots / Crons inherit the latest preference.
  const handleModelChange = useCallback(
    async (model: string) => {
      if (guardCronConfigMutation()) return;
      // Skip if selecting the same model
      if (selectedModel === model) {
        return;
      }

      // Track model_switch event
      track('model_switch', {
        source: 'desktop',
        tab_id: tabId,
        session_id: sessionIdRef.current,
        runtime: currentRuntime,
        runtime_source: runtimeSourceForRuntimeType(currentRuntime, currentRuntimeSource) ?? null,
        model,
      });

      const nextIntent = buildProviderExecutionIntent(
        currentProviderForHistory,
        model,
      );
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
      const currentProviderId =
        effectiveSelectedProviderId ?? currentProvider?.id;
      if (
        !canResumeProviderHistory &&
        (messagesRef.current.length > 0 ||
          isRuntimeBackedIntent(currentProviderExecutionIntent) ||
          isRuntimeBackedIntent(nextIntent)) &&
        currentProviderId
      ) {
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
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- narrowed deps; currentProvider fields cover toProviderHistoryEnv inputs
    [
      tabId,
      currentRuntime,
      currentRuntimeSource,
      selectedModel,
      currentProviderForHistory?.id,
      currentProviderForHistory?.type,
      currentProviderForHistory?.config.baseUrl,
      currentProviderForHistory?.apiProtocol,
      currentProviderForHistory?.subscriptionAuth,
      currentProviderExecutionIntent,
      effectiveSelectedProviderId,
      currentProvider?.id,
      builtinSnapshotProviderHistoryUnknown,
      effectivePermissionMode,
      persistTabConfigChange,
      guardCronConfigMutation,
    ],
  );

  // External-runtime model change. Same dual-write policy as builtin
  // `handleModelChange`, routed through `runtimeModel` so the helper writes
  // to `agent.runtimeConfig.model` rather than `agent.model`. Pre-PRD-0.2.7
  // chat would only call `setRuntimeModel` (UI state), so the user's choice
  // was lost on next session — matching launcher's persist behavior closes
  // that gap.
  const handleRuntimeModelChange = useCallback(
    async (model: string) => {
      if (guardCronConfigMutation()) return;
      if (runtimeModel === model) return;
      const persisted = await persistTabConfigChange({ runtimeModel: model });
      if (!persisted) return;
      setRuntimeModel(model);
    },
    [runtimeModel, persistTabConfigChange, guardCronConfigMutation],
  );

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
  const pushReasoningEffort = useCallback(
    (effort: string) => {
      apiPost('/api/reasoning-effort/set', { effort }).catch((err) => {
        console.error(
          '[Chat] push reasoning effort failed (send payload will correct at next message):',
          err,
        );
      });
    },
    [apiPost],
  );
  useEffect(() => {
    if (configPending) return;
    const deferred = deferredEffortPushRef.current;
    if (deferred === null) return;
    deferredEffortPushRef.current = null;
    pushReasoningEffort(deferred);
  }, [configPending, pushReasoningEffort]);

  const handleReasoningEffortChange = useCallback(
    async (effort: string) => {
      if (guardCronConfigMutation()) return;
      if (reasoningEffort === effort) return;
      track('reasoning_effort_switch', {
        source: 'desktop',
        tab_id: tabId,
        session_id: sessionIdRef.current,
        runtime: currentRuntime,
        runtime_source: runtimeSourceForRuntimeType(currentRuntime, currentRuntimeSource) ?? null,
        effort,
      });
      const persisted = await persistTabConfigChange({
        reasoningEffort: effort,
      });
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
    },
    [
      reasoningEffort,
      tabId,
      currentRuntime,
      currentRuntimeSource,
      persistTabConfigChange,
      pushReasoningEffort,
      guardCronConfigMutation,
    ],
  );

  // #324 — clamp effort on provider-protocol change. An OpenAI-only level
  // (e.g. 'minimal') left selected after switching to an Anthropic-protocol
  // provider would keep DISPLAYING as active while the wire silently sends
  // the SDK default 'high' (the query-time isSdkEffortLevel gate). Reset to
  // 'default' (persisted + pushed via the handler) so UI and wire agree.
  useEffect(() => {
    if (inputUsesExternalRuntimeControls || !effectiveModelProvider) return;
    if (configDispositionRef.current !== 'push') return;
    if (reasoningEffort === 'default') return;
    const choices = reasoningEffortChoices(
      currentRuntime === 'dsh' ? 'dsh' : 'builtin',
      effectiveModelProvider.apiProtocol,
      effectiveModelProvider.id,
      selectedModel,
      effectiveModelProvider.config.baseUrl,
    );
    if (
      (choices && !choices.includes(reasoningEffort)) ||
      (currentRuntime === 'dsh' && choices === null)
    ) {
      void handleReasoningEffortChange('default');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- narrowed to protocol-relevant provider fields
  }, [
    inputUsesExternalRuntimeControls,
    effectiveModelProvider?.id,
    effectiveModelProvider?.apiProtocol,
    effectiveModelProvider?.config.baseUrl,
    currentRuntime,
    selectedModel,
    reasoningEffort,
    handleReasoningEffortChange,
  ]);

  // Handle permission mode change — same dual-write policy as handleModelChange.
  const handlePermissionModeChange = useCallback(
    async (mode: PermissionMode) => {
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
    },
    [isExternalRuntime, persistTabConfigChange],
  );

  const handleInputPermissionModeChange = useCallback(
    async (mode: PermissionMode) => {
      if (guardCronConfigMutation()) return;
      if (!managedProviderRuntimeActive) {
        await handlePermissionModeChange(mode);
        return;
      }

      if (currentProviderExecutionIntent?.kind !== 'runtime-backed-provider')
        return;
      const runtimeMode =
        runtimeBackedProviderPermissionMode(
          currentProviderExecutionIntent,
          mode,
        ) ?? 'auto-edit';
      const persisted = await persistTabConfigChange({
        runtimeBackedProviderContext: currentProviderExecutionIntent,
        permissionMode: mode,
      });
      if (!persisted) return;
      projectSyncedRef.current = true;
      setPermissionMode(mode);
      setRuntimePermissionMode(runtimeMode);
    },
    [
      managedProviderRuntimeActive,
      handlePermissionModeChange,
      currentProviderExecutionIntent,
      persistTabConfigChange,
      guardCronConfigMutation,
    ],
  );

  const inputChromePermissionMode = managedProviderRuntimeActive
    ? permissionMode
    : effectivePermissionMode;

  const [questionDraft, setQuestionDraft] = useState<{
    sessionId: string | null;
    reply: AsyncQuestionReply;
    title: string;
  } | null>(null);
  const questionTarget =
    questionDraft?.sessionId === sessionId ? questionDraft : null;
  const questionTargetRef = useRef(questionTarget);
  questionTargetRef.current = questionTarget;

  // PERFORMANCE: text is now passed from SimpleChatInput (which manages its own state)
  // This avoids re-rendering Chat on every keystroke.
  // Returns false to signal SimpleChatInput NOT to clear the input (e.g., on rejection).
  const handleSendMessage = useCallback(
    async (
      text: string,
      images?: ImageAttachment[],
      _permissionMode?: PermissionMode,
      context?: import('../../shared/agentMentions').QueryMentionContext,
      explicitReply?: AsyncQuestionReply,
      retryFailedMessageId?: string,
    ): Promise<boolean | void> => {
      if (!retryFailedMessageId) {
        const uncertain = messagesRef.current.find(message => message.role === 'user' && message.deliveryUnconfirmed && typeof message.content === 'string' && message.content === text.trim());
        if (uncertain) { setUnconfirmedRetry(uncertain); return false; }
      }
      const draft = explicitReply ? null : questionTargetRef.current;
      const reply = explicitReply ?? draft?.reply;
      // Must have content and not be in stopping state
      if (
        isSessionLoading ||
        (!text && (!images || images.length === 0)) ||
        sessionState === 'stopping'
      ) {
        return false;
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
      if (runtimeExecutionUnavailable) {
        toastRef.current.warning(t(runtimeDetectionPending
          ? 'shell.sessionMenu.runtimeLoading'
          : 'shell.toasts.runtimeUnavailable'));
        return false;
      }
      if (runtimeProviderSelectionIncomplete) {
        toastRef.current.warning(t('shell.toasts.reselectModelFirst'));
        return false;
      }
      if (builtinSnapshotProviderSelectionIncomplete) {
        showSnapshotProviderIncompleteToast();
        return false;
      }

      // Queue limit: max 5 queued messages.
      // (issue #174) 'starting' is also busy — SDK subprocess is launching but
      // hasn't sent system_init yet. Including it prevents the queue cap from
      // being bypassed while the user keeps typing during the startup window.
      const isAiBusy =
        isLoading || sessionState === 'running' || sessionState === 'starting';
      if (isAiBusy && queuedMessages.length >= 5) {
        toastRef.current.warning(t('shell.toasts.queueLimit'));
        return false;
      }

      // Scroll to bottom immediately so user sees their query
      // This also re-enables auto-scroll if user had scrolled up
      scrollToBottom();

      // Scheduling a future Task does not start an AI turn. TabProvider owns
      // loading for ordinary sends and actual scheduled execution events.

      // TabProvider displays the send immediately, then adopts the server user
      // message by request identity without seeding canonical transcript text.

      try {
        // Build provider env from current provider config (read from refs for stability)
        // For subscription type, don't send providerEnv (use SDK's default auth)
        const providerRoute = buildBuiltinProviderRoute(
          currentProviderRef.current,
          effectiveModel,
        );
        const providerEnv = providerRoute
          ? undefined
          : buildProviderEnv(currentProviderRef.current);

        // If cron mode is enabled and task hasn't started yet, start the task
        const cron = cronStateRef.current;
        if (!reply && goalDraftConfigRef.current) {
          const startedKind = await startScheduledTask(text);
          if (startedKind !== 'goal') return;
        } else if (!reply && cron.isEnabled && !cron.task && cron.config) {
          setStoppedCronRecovery(null);
          if (
            cron.config.taskKind === 'cron' &&
            cron.config.executionTarget === 'new_task'
          ) {
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
              const created = await createAndStartCronTask({
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
                notification: cron.config.notification,
                delivery: cron.config.delivery,
              });
              setCronCardTask(created.task);
              disableCronMode();
              setIsLoading(false);
              if (created.error) toastRef.current?.error(created.error);
              else toastRef.current?.success(t('shell.toasts.cronTaskCreated'));
            } catch (err) {
              disableCronMode();
              setIsLoading(false);
              toastRef.current?.error(
                t('shell.toasts.createFailedWithError', {
                  error: err instanceof Error ? err.message : String(err),
                }),
              );
            }
            return;
          }
          // ── Current session: legacy cron behavior ──
          const startedKind = await startScheduledTask(text);
          if (startedKind !== 'goal') return;
          // A Goal is Session state. Its first user query still follows the
          // ordinary chat path so the visible tail produces the normal bubble
          // and all streaming blocks arrive live.
        }

        // Keep the submitted composer until the HTTP admission receipt.
        // Use effective model/permission (runtime-aware) — not the builtin values
        const admitted = await sendMessage(
          draft?.title ? `${draft.title}\n\n${text}` : text,
          images,
          effectivePermissionMode,
          effectiveModel,
          inputUsesExternalRuntimeControls ? undefined : providerEnv,
          undefined,
          // Product-configured runtimes carry provider effort through the Host path.
          inputUsesExternalRuntimeControls ? undefined : reasoningEffort,
          inputUsesExternalRuntimeControls ? undefined : providerRoute,
          context?.requiredSystemSkill,
          reply,
          context?.agentMentions,
          context?.primaryContext,
          retryFailedMessageId,
        );
        if (admitted && reply)
          setQuestionDraft((current) =>
            current && sameAsyncQuestionReply(current.reply, reply)
              ? null
              : current,
          );
        if (!admitted && !isAiBusy) setIsLoading(false);
        return admitted;
      } catch (error) {
        const errorMessage = {
          id: `error-${crypto.randomUUID()}`,
          role: 'assistant' as const,
          content: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, errorMessage]);
        // Reset both isLoading and sessionState to ensure UI recovers
        if (!isAiBusy) {
          setIsLoading(false);
          setSessionState('idle');
        }
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toastRef/currentProviderRef/apiKeysRef/cronStateRef are refs (stable); scrollToBottom/setMessages/setIsLoading/setSessionState are stable
    [
      sessionState,
      isSessionLoading,
      isLoading,
      queuedMessages.length,
      startScheduledTask,
      sendMessage,
      effectivePermissionMode,
      effectiveModel,
      reasoningEffort,
      inputUsesExternalRuntimeControls,
      scrollToBottom,
      pinnedProviderUnavailable,
      runtimeExecutionUnavailable,
      runtimeDetectionPending,
      runtimeProviderSelectionIncomplete,
      builtinSnapshotProviderSelectionIncomplete,
      showPinnedProviderUnavailableToast,
      showSnapshotProviderIncompleteToast,
      t,
    ],
  );

  // Ref-stabilize handleSendMessage for handleRetry (avoids frequent re-creation)
  const handleSendMessageRef = useRef(handleSendMessage);
  handleSendMessageRef.current = handleSendMessage;

  const questionActions = useMemo<AsyncQuestionActions>(() => ({
    answered: [...historyMessages, ...messages].flatMap(message => message.role === 'user' && message.asyncQuestionReply ? [message.asyncQuestionReply] : []),
    queued: queuedMessages.flatMap(message => message.asyncQuestionReply ? [message.asyncQuestionReply] : []),
    disabled: isSessionLoading || !isConnected || sessionState === 'stopping',
    onReply: async (reply, text) => (await handleSendMessageRef.current(text, undefined, undefined, undefined, reply)) === true,
    onCompose: (reply, title) => {
      setQuestionDraft({ sessionId, reply, title });
      inputRef.current?.focus();
    },
  }), [historyMessages, messages, queuedMessages, isSessionLoading, isConnected, sessionState, sessionId]);

  // Triggered from the SystemPromptsPanel empty state ("智能生成" card). Closes the
  // workspace settings overlay and dispatches `/init` to the current Tab so the user
  // sees the Claude Code SDK builtin slash command run in the chat surface.
  const handleRequestInitFromSettings = useCallback(() => {
    setShowWorkspaceConfig(false);
    setWorkspaceConfigInitialTab(undefined);
    void handleSendMessageRef.current('/init');
  }, []);

  // Cancel a queued message and restore its text (and images if any) to the input box
  const handleCancelQueued = useCallback(
    async (queueId: string) => {
      // Snapshot the queued message info before it's removed (for image restore)
      const queuedMsg = queuedMessages.find((q) => q.queueId === queueId);
      const cancelledSessionId = sessionId;
      const sourceContents = [
        ...historyMessages,
        ...messages,
        ...(streamingMessage ? [streamingMessage] : []),
      ]
        .filter((message) => message.role === 'assistant')
        .map((message) => message.content);
      const cancelledText = await cancelQueuedMessage(queueId);
      if (cancelledText && sessionIdRef.current === cancelledSessionId) {
        const restored = queuedMsg?.asyncQuestionReply
          ? restoreAsyncQuestionAnswerDraft(
              queuedMsg.asyncQuestionReply,
              cancelledText,
              sourceContents,
            )
          : null;
        setQuestionDraft(
          restored
            ? {
                sessionId: cancelledSessionId,
                reply: restored.reply,
                title: restored.title,
              }
            : null,
        );
        chatInputRef.current?.setValue(restored?.text ?? cancelledText, { agentMentions: queuedMsg?.agentMentions, primaryContext: queuedMsg?.primaryContext });
        // Restore images if the queued message had them
        // Note: We only have preview data URLs (not File blobs) to avoid memory leaks,
        // so we reconstruct ImageAttachment with a minimal placeholder File.
        if (queuedMsg?.images && queuedMsg.images.length > 0) {
          const restoredImages: ImageAttachment[] = queuedMsg.images.map(
            (img) => ({
              id: img.id,
              file: new File([], img.name, {
                type: img.mimeType || 'application/octet-stream',
              }), // Placeholder — original blob is gone
              preview: img.preview,
              source: img.source,
              name: img.name,
              mimeType: img.mimeType,
              sizeBytes: img.sizeBytes,
              relativePath: img.relativePath,
            }),
          );
          chatInputRef.current?.setImages(restoredImages);
        }
      }
    },
    [
      cancelQueuedMessage,
      queuedMessages,
      sessionId,
      historyMessages,
      messages,
      streamingMessage,
    ],
  );

  // Force-execute a queued message (interrupt current AI response)
  const handleForceExecuteQueued = useCallback(
    async (queueId: string) => {
      await forceExecuteQueuedMessage(queueId);
    },
    [forceExecuteQueuedMessage],
  );

  // Stable callbacks for SimpleChatInput (extracted from inline arrows to enable memo)
  const handleStop = useCallback(async () => {
    try {
      const goal = sessionGoalStateRef.current.goal;
      const pendingGoalDraft =
        !goal &&
        sessionGoalStateRef.current.isStarting &&
        (goalDraftConfigRef.current !== null ||
          cronStateRef.current.config?.taskKind === 'goal');
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
      if (
        stopped.success &&
        stopped.alreadyStopped &&
        goal?.status === 'active'
      ) {
        await pauseGoal();
      }
    } catch (error) {
      console.error('[Chat] Failed to stop message:', error);
    }
  }, [cancelPendingGoalStart, disableCronMode, pauseGoal, stopResponse]);

  const handleOpenAgentSettings = useCallback(
    () => setShowWorkspaceConfig(true),
    [],
  );

  // Provider switch on non-empty builtin history: keep the current tab unchanged,
  // save the new provider as workspace default, and open a fresh session in a new tab.
  const [pendingProviderSwitch, setPendingProviderSwitch] = useState<{
    providerId: string;
    model?: string;
  } | null>(null);

  const providerSwitchDialogCopy = useMemo(() => {
    if (!pendingProviderSwitch) return null;
    const targetProvider = providers.find(
      (p) => p.id === pendingProviderSwitch.providerId,
    );
    const targetModel =
      pendingProviderSwitch.model ?? targetProvider?.primaryModel;
    const targetIntent = buildProviderExecutionIntent(
      targetProvider,
      targetModel,
    );
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

  const transferBindingToForkedSession = useCallback(
    async (channel: ChannelSurface, targetSessionId: string) => {
      if (!agentDir) {
        throw new Error('Missing workspace path for channel binding transfer');
      }
      const { handoverSessionToChannel } = await import(
        '@/api/sessionHandoverClient'
      );
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
    },
    [agentDir, t],
  );

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
    const newProvider = providers.find((p) => p.id === pending.providerId);
    const targetModel = pending.model ?? newProvider?.primaryModel;
    const targetIntent = buildProviderExecutionIntent(newProvider, targetModel);

    if (!newProvider || !targetModel || !targetIntent) {
      toastRef.current.error(t('shell.toasts.providerSwitchTargetUnavailable'));
      return;
    }

    // A new Session uses the target installed catalog, not this old Session's process.
    const targetEffort =
      targetIntent.kind === 'runtime-backed-provider'
        ? reasoningEffortAfterModelChange(
            reasoningEffort,
            newProvider.models?.find((model) => model.model === targetModel),
          )
        : reasoningEffort;
    try {
      const sessionTitle = `${newProvider.name} 会话`;
      let openedSessionId: string;
      if (targetIntent.kind === 'runtime-backed-provider') {
        if (!currentProject || !onLaunchRuntimeBackedProviderSession) {
          throw new Error(
            'App runtime-backed provider launch owner is unavailable',
          );
        }
        const launchedSessionId = await onLaunchRuntimeBackedProviderSession(
          currentProject,
          {
            providerExecutionIdentity: targetIntent,
            // LaunchSessionBirthHint carries product-facing values. App is the
            // sole birth owner and converts them to runtime vocabulary once.
            permissionMode: inputChromePermissionMode,
            reasoningEffort: targetEffort,
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
          targetIntegratedRuntime: resolveProviderSwitchIntegratedRuntime({
            targetProvider: newProvider,
            currentSessionRuntime: currentRuntime,
            agentRuntimePreference: currentAgent?.runtimePreference,
            legacyAgentRuntime: currentAgent?.runtime,
            legacyAgentRuntimeSource: currentAgent?.runtimeConfig?.source,
            legacyAgentProviderId: currentAgent?.providerId,
            configuredDefaultIntegratedRuntime: config.defaultIntegratedRuntime,
          }),
        });
        const { createSession } = await import('@/api/sessionClient');
        const session = await createSession(agentDir, birth.runtime, {
          ...birth.opts,
          origin: DESKTOP_SESSION_FORK_ORIGIN,
        });
        const opened = await onForkSession(session.id, agentDir, sessionTitle);
        if (!opened) {
          throw new Error('Fork tab failed to open');
        }
        openedSessionId = session.id;
      }
      forkTabOpened = true;
      if (targetEffort !== reasoningEffort)
        toastRef.current.info(t('input.reasoningModelReset'));
      // Team AI defaults are edited only in Agent settings.
      if (currentProject && currentProject.purpose !== 'team-ai') {
        const defaultWriteResult = await persistInputOptionChange({
          workspaceId: currentProject.id,
          agentId: currentProject.agentId,
          isExternalRuntime: false,
          currentRuntimeConfig: currentAgent?.runtimeConfig as
            | RuntimeConfig
            | undefined,
          currentRuntimePreference: currentAgent?.runtimePreference,
          currentProviderId:
            currentAgent?.providerId ?? currentProject.providerId,
          fields: {
            ...(targetIntent.kind === 'runtime-backed-provider'
              ? {
                  runtimeBackedProviderSelection: targetIntent,
                  reasoningEffort: targetEffort,
                }
              : {
                  builtinSelection: {
                    providerId: pending.providerId,
                    model: targetModel,
                  },
                }),
            permissionMode: inputChromePermissionMode,
          },
          snapshotWriteMode: 'disabled',
          patchProject,
          patchAgentConfig,
          patchAgentProjectConfig,
        });
        if (!defaultWriteResult.ok) {
          console.error(
            '[chat] Provider switch default write failed:',
            defaultWriteResult.errors,
          );
          toastRef.current.warning(
            t('shell.toasts.providerSwitchDefaultSaveFailed'),
          );
        }
        try {
          await refreshConfig();
        } catch (refreshErr) {
          console.warn(
            '[chat] Provider switch config refresh failed:',
            refreshErr,
          );
        }
      }
      if (boundChannel) {
        await transferBindingToForkedSession(boundChannel, openedSessionId);
        // The new Session now serves this Team AI peer, so its choice becomes the peer profile.
        if (currentProject?.purpose === 'team-ai' && currentProject.agentId && openedSessionId) {
          const synced = await syncTeamAiPeerProfile(currentProject.agentId, openedSessionId).catch(() => null);
          if (synced?.peerProfile !== 'saved' && synced?.peerProfile !== null) {
            toastRef.current.warning(t('shell.toasts.teamAiPeerProfileFailed'));
          }
        }
      }
    } catch (err) {
      console.error('[chat] Failed to create cross-provider session:', err);
      toastRef.current.error(
        forkTabOpened
          ? t('shell.toasts.providerSwitchChannelTransferFailed')
          : t('shell.toasts.createNewSessionFailed'),
      );
    }
  }, [
    pendingProviderSwitch,
    agentDir,
    onForkSession,
    onLaunchRuntimeBackedProviderSession,
    providers,
    transferBindingToForkedSession,
    inputChromePermissionMode,
    reasoningEffort,
    workspaceMcpEnabled,
    workspaceEnabledPlugins,
    workspaceOfficialToolEnabled,
    currentProject,
    currentAgent,
    currentRuntime,
    config.defaultIntegratedRuntime,
    patchProject,
    refreshConfig,
    guardCronConfigMutation,
    t,
  ]);

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
    setCronOpenPreset(
      draft
        ? {
            ...GOAL_SLASH_PRESET,
            endConditions: draft.endConditions,
            notifyEnabled: draft.notifyEnabled,
          }
        : GOAL_SLASH_PRESET,
    );
    setShowCronSettings(true);
  }, []);

  const managedCodexCompactSupported =
    currentRuntime === 'codex' && managedProviderRuntimeActive;
  const nativeRuntimeCompactSupported =
    managedCodexCompactSupported || currentRuntime === 'dsh';
  const manualContextCompactSupported =
    currentRuntime === 'builtin' || nativeRuntimeCompactSupported;
  const runtimeClientActionSlashCommands = useMemo(
    () =>
      nativeRuntimeCompactSupported
        ? [MANAGED_CODEX_COMPACT_SLASH_COMMAND]
        : [],
    [nativeRuntimeCompactSupported],
  );

  // Both the context card and `/compact` dispatch this action. Builtin keeps
  // the Claude SDK command path; Managed Codex uses its native SessionEngine
  // control operation; DSH uses the same SessionEngine capability. Neither
  // path inserts a synthetic user message into the transcript.
  const handleCompactContext = useCallback(() => {
    if (nativeRuntimeCompactSupported) {
      void apiPost<{ success: boolean; error?: string }>(
        '/api/session/compact',
      ).catch((error) => {
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
    const providerRoute = buildBuiltinProviderRoute(
      currentProviderRef.current,
      effectiveModel,
    );
    const providerEnv = providerRoute
      ? undefined
      : buildProviderEnv(currentProviderRef.current);
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
    nativeRuntimeCompactSupported,
    pinnedProviderUnavailable,
    reasoningEffort,
    sendMessage,
    showPinnedProviderUnavailableToast,
    showSnapshotProviderIncompleteToast,
    t,
  ]);

  // `/goal` is a product action, not a Runtime command. Arm the lightweight
  // composer draft immediately; the bar's settings button owns optional tuning.
  const handleSlashAction = useCallback(
    (name: string) => {
      if (name === 'compact') {
        handleCompactContext();
        return;
      }
      if (name === 'goal' || name === 'loop') {
        setStoppedCronRecovery(null);
        if (!cronStateRef.current.task) disableCronMode();
        const goalExecution = buildCronExecutionOverrides({
          providerId:
            !inputUsesExternalRuntimeControls && currentProvider
              ? currentProvider.id
              : undefined,
          model: inputUsesExternalRuntimeControls ? undefined : selectedModel,
        });
        setGoalDraftConfig(
          createDefaultSessionGoalDraftConfig({
            permissionMode: isExternalRuntime
              ? effectiveRuntimePermissionMode
              : permissionMode,
            runtime: goalExecution.runtime,
          }),
        );
        setCronPrompt('');
        setCronOpenPreset(null);
        setShowCronSettings(false);
      }
    },
    [
      buildCronExecutionOverrides,
      currentProvider,
      disableCronMode,
      effectiveRuntimePermissionMode,
      handleCompactContext,
      inputUsesExternalRuntimeControls,
      isExternalRuntime,
      permissionMode,
      selectedModel,
    ],
  );

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
    if (
      isCurrentSessionGoal(currentGoal) &&
      !isTerminalGoalStatus(currentGoal.status)
    ) {
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
    if (!isCurrentSessionGoal(goal) || isTerminalGoalStatus(goal.status))
      return;
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
    if (
      !isCurrentSessionGoal(beforeGoal) ||
      isTerminalGoalStatus(beforeGoal.status)
    ) {
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
      const nextValue = appendCronPromptToDraft(
        currentValue,
        stoppedCronRecovery.prompt,
      );
      chatInputRef.current?.setValue(nextValue);
      chatInputRef.current?.focus();
    }
    setStoppedCronRecovery(null);
  }, [stoppedCronRecovery]);

  const handleGoalDismiss = useCallback(() => {
    dismissGoal();
  }, [dismissGoal]);

  const handleCancelQueuedVoid = useCallback(
    (queueId: string) => {
      void handleCancelQueued(queueId);
    },
    [handleCancelQueued],
  );

  const handleForceExecuteQueuedVoid = useCallback(
    (queueId: string) => {
      void handleForceExecuteQueued(queueId);
    },
    [handleForceExecuteQueued],
  );

  // Format selected text as Markdown blockquote
  const formatQuote = useCallback(
    (text: string) =>
      text
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n'),
    [],
  );

  // Quote selected text — append blockquote + placeholder for user to type over
  const handleQuoteSelection = useCallback(
    (selectedText: string) => {
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
    },
    [inputRef, formatQuote, t],
  );

  // Elaborate = quote + placeholder + "深入讲讲" then auto-send
  const handleElaborateSelection = useCallback(
    (selectedText: string) => {
      const prompt = `${formatQuote(selectedText)}\n${t('shell.selection.elaboratePrompt')}`;
      void handleSendMessageRef.current(prompt);
    },
    [formatQuote, t],
  );

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
  const handleQuoteFileSelection = useCallback(
    (path: string, startLine: number, endLine: number) => {
      const posix = path.replace(/\\/g, '/');
      const range =
        startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
      chatInputRef.current?.appendReferenceToken(`@${posix}#${range}`);
    },
    [],
  );

  // Navigate to a specific query message (used by QueryNavigator).
  // ChatScrollController owns virtualized message navigation.
  const handleNavigateToQuery = useCallback(
    (messageId: string) => {
      scrollToMessage(messageId, { behavior: 'smooth', align: 'start' });
    },
    [scrollToMessage],
  );

  // PRD 0.2.17 Agent Status Panel — 点击 SubAgent 行跳转到对话流中对应 TaskTool。
  // ChatScrollController owns host-message resolution and the two-stage
  // virtual-row mount + precise DOM scroll.
  const handleJumpToTool = useCallback(
    (toolId: string) => {
      scrollToTool(toolId);
    },
    [scrollToTool],
  );

  // PRD 0.2.17 / v0.2.19 — AgentStatusPanel 通过 slot 注入 SimpleChatInput，
  // 与 QueuedMessagesPanel 同居一个 flex 行（避免两者撞 z-20 / 同 Y 重叠）。
  // P3: slot 不再依赖高频的 messages —— AgentStatusPanel 自己从 TabContext
  // 订阅 messages（见该组件）。这样本 slot 的 useMemo 在流式期间 identity 保持
  // 稳定，SimpleChatInput 的 React.memo 不再被打穿，输入框在 AI 流式输出时不会
  // 每 token 重渲染。AgentStatusPanel 内部仍随 commit 重渲染，其 DOM 仅在
  // 派生 todos/subagents 变化时才改，成本由 React 协调器吸收。
  const supportsAgentStatusPanel =
    currentRuntime === 'builtin' ||
    currentRuntime === 'codex' ||
    currentRuntime === 'dsh';
  const agentStatusSlot = useMemo(
    () =>
      !supportsAgentStatusPanel ? undefined : (
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
        onCompact={
          manualContextCompactSupported ? handleCompactContext : undefined
        }
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
    () =>
      (config.plugins ?? [])
        .filter((p) => config.enabledPlugins?.[p.id] === true)
        .map((p) => ({ id: p.id, name: p.name, description: p.description })),
    [config.plugins, config.enabledPlugins],
  );

  const handleStartupItemsRendered = useCallback((rows: readonly MessageType[]) => {
    onItemsRendered();
    onStartupItemsRendered(rows);
  }, [onItemsRendered, onStartupItemsRendered]);

  // Stable callbacks for MessageList (extracted from inline arrows to enable memo)
  const handlePermissionDecision = useCallback(
    (requestId: string, decision: 'deny' | 'allow_once' | 'always_allow') => {
      return respondPermission(decision, requestId);
    },
    [respondPermission],
  );

  const handleAskUserQuestionSubmit = useCallback(
    (requestId: string, answers: AskUserQuestionAnswers) => {
      return respondAskUserQuestion(requestId, answers);
    },
    [respondAskUserQuestion],
  );

  const handleAskUserQuestionCancel = useCallback((requestId: string) => {
    return respondAskUserQuestion(requestId, null);
  }, [respondAskUserQuestion]);

  const handleExitPlanModeApprove = useCallback(async () => {
    const ok = await respondExitPlanMode(true);
    if (!ok) toastRef.current.error(t('shell.toasts.submitFailedRetry'));
    // Mode restore is handled by the useEffect below reacting to resolved='approved'
  }, [respondExitPlanMode, t]);

  const handleExitPlanModeReject = useCallback(
    async (feedback?: string) => {
      const ok = await respondExitPlanMode(false, feedback);
      if (!ok) toastRef.current.error(t('shell.toasts.submitFailedRetry'));
    },
    [respondExitPlanMode, t],
  );

  const handleDismissSystemNotice = useCallback(() => {
    setSystemNotice(null);
  }, [setSystemNotice]);

  // React to plan mode changes: auto-approved by SDK, or user-approved via card
  // Single source of truth for permission mode switch during plan mode
  useEffect(() => {
    if (
      pendingEnterPlanMode?.resolved === 'approved' &&
      permissionMode !== 'plan'
    ) {
      prePlanPermissionModeRef.current = permissionMode;
      setPermissionMode('plan');
    }
  }, [pendingEnterPlanMode?.resolved, pendingEnterPlanMode?.requestId]); // eslint-disable-line react-hooks/exhaustive-deps -- read permissionMode without dep to avoid loop

  useEffect(() => {
    if (
      pendingExitPlanMode?.resolved === 'approved' &&
      prePlanPermissionModeRef.current
    ) {
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

  const warnRewindFileOutcome = useCallback(
    (result: RewindResponse | undefined) => {
      showRewindFileOutcomeWarning(result, toastRef.current.warning, t);
    },
    [t],
  );

  // Stable callback for time rewind — uses ref for messages to keep reference stable
  const handleRewind = useCallback((messageId: string) => {
    const msgs = messagesRef.current;
    const msg = msgs.find((m) => m.id === messageId);
    if (!msg) return;
    setRewindTarget({
      messageId,
      content: typeof msg.content === 'string' ? msg.content : '',
      attachments: msg.attachments,
      replacesDraft: Boolean(
        chatInputRef.current?.getCurrentValue().trim() ||
          chatInputRef.current?.getImages().length,
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
      context: chatInputRef.current?.getQueryContext(),
      images: chatInputRef.current?.getImages() ?? [],
    };
    const rewindSessionId = sessionIdRef.current;
    const isCodexRewind = currentRuntime === 'codex';
    const hasRecoverableNativeRewind =
      isCodexRewind || currentRuntime === 'dsh';

    // 1. 乐观更新 UI（瞬时反馈）
    // Pause auto-scroll to prevent animated scrolling during rewind's DOM changes.
    // Without this, the smooth scroll animation fights with the browser's natural
    // scroll clamping (messages removed → scrollHeight shrinks → scrollTop adjusts).
    pauseAutoScroll();
    setRewindTarget(null);
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === messageId);
      return idx >= 0 ? prev.slice(0, idx) : prev;
    });
    chatInputRef.current?.setValue(content);
    chatInputRef.current?.setImages(restoreMessageImages(attachments));

    // 2. 后端回溯（rewindPromise 会阻塞 enqueueUserMessage 防止竞态）
    //    成功：丢弃快照；失败：从快照回滚 UI
    setIsLoading(true);
    setRewindStatus('rewinding');
    apiPost('/chat/rewind', { userMessageId: messageId })
      .then((res) => {
        if (sessionIdRef.current !== rewindSessionId) return;
        const r = res as RewindResponse | undefined;
        track('session_rewind', {
          source: 'desktop',
          tab_id: tabId,
          session_id: rewindSessionId,
          runtime: currentRuntime,
          runtime_source:
            runtimeSourceForRuntimeType(currentRuntime, currentRuntimeSource) ??
            null,
          result: r?.errorCode ?? (r?.success === false ? 'failed' : 'success'),
        });
        if (r && !r.success) {
          // 后端明确返回失败 → 回滚 UI
          setMessages(snapshot);
          chatInputRef.current?.setValue(composerSnapshot.value, composerSnapshot.context);
          chatInputRef.current?.setImages(composerSnapshot.images);
          const error = r.errorCode
            ? t(`shell.toasts.conversationError.${r.errorCode}`)
            : r.error || t('shell.toasts.unknownError');
          toastRef.current.error(
            t('shell.toasts.rewindFailedWithError', { error }),
          );
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
      .catch(async (err) => {
        if (sessionIdRef.current !== rewindSessionId) return;
        console.error('[Chat] Rewind failed:', err);
        const structured =
          err && typeof err === 'object'
            ? (err as { status?: unknown; errorCode?: unknown })
            : null;
        const errorCode =
          typeof structured?.errorCode === 'string'
            ? structured.errorCode
            : undefined;
        track('session_rewind', {
          source: 'desktop',
          tab_id: tabId,
          session_id: rewindSessionId,
          runtime: currentRuntime,
          runtime_source:
            runtimeSourceForRuntimeType(currentRuntime, currentRuntimeSource) ??
            null,
          result:
            errorCode ??
            (typeof structured?.status === 'number'
              ? 'failed'
              : 'transport_error'),
        });

        // A structured HTTP rejection proves the server did not commit. A
        // transport failure is ambiguous for a native conversation mutation,
        // so reload SessionStore authority instead of restoring a possibly
        // stale pre-rewind tail.
        const reconciliation =
          hasRecoverableNativeRewind && typeof structured?.status !== 'number'
            ? await retryCurrentSessionRestore(messageId)
            : null;
        if (sessionIdRef.current !== rewindSessionId) return;
        const transportOutcome =
          classifyRewindTransportOutcome(reconciliation);
        const recovery = projectRewindRecovery(transportOutcome);
        if (recovery.restoreMessageSnapshot) {
          setMessages(snapshot);
        }
        if (recovery.restoreComposerSnapshot) {
          chatInputRef.current?.setValue(composerSnapshot.value, composerSnapshot.context);
          chatInputRef.current?.setImages(composerSnapshot.images);
        }
        if (transportOutcome === 'committed') {
          toastRef.current.warning(t('shell.toasts.codexRewindReconciled'));
        } else if (errorCode) {
          toastRef.current.error(
            t('shell.toasts.rewindFailedWithError', {
              error: t(`shell.toasts.conversationError.${errorCode}`),
            }),
          );
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
  }, [
    tabId,
    rewindTarget,
    apiPost,
    setMessages,
    setIsLoading,
    pauseAutoScroll,
    t,
    warnRewindFileOutcome,
    currentRuntime,
    currentRuntimeSource,
    retryCurrentSessionRestore,
  ]);

  // SessionEngine owns rewind + replay admission as one operation.
  const performRetryFromUserMessage = useCallback((userMsg: typeof messagesRef.current[number]) => {
    if (conversationOperationPendingRef.current) return;
    conversationOperationPendingRef.current = true;
    const retrySessionId = sessionIdRef.current;
    pauseAutoScroll();
    setIsLoading(true);
    setRewindStatus('rewinding');
    let queued = false;
    apiPost('/chat/retry', { userMessageId: userMsg.id, model: effectiveModel, reasoningEffort })
      .then(async res => {
        if (sessionIdRef.current !== retrySessionId) return;
        const result = res as RewindResponse & { retryQueued?: boolean; conversationCommitted?: boolean };
        warnRewindFileOutcome(result);
        queued = result.retryQueued === true;
        if (!result.success) {
          if (result.conversationCommitted) await retryCurrentSessionRestore(userMsg.id);
          toastRef.current.error(t('shell.toasts.retryFailedWithError', { error: result.error || t('shell.toasts.unknownError') }));
        } else {
          track('message_retry', {
            source: 'desktop',
            tab_id: tabId,
            session_id: retrySessionId,
            runtime: currentRuntime,
            runtime_source: runtimeSourceForRuntimeType(currentRuntime, currentRuntimeSource) ?? null,
          });
        }
      })
      .catch(async error => {
        if (sessionIdRef.current !== retrySessionId) return;
        const rejection = getConversationRejectionMessage(error, t);
        if (rejection) {
          toastRef.current.error(t('shell.toasts.retryFailedWithError', { error: rejection }));
          return;
        }
        console.error('[Chat] Retry response unavailable:', error);
        await retryCurrentSessionRestore(userMsg.id);
        if (sessionIdRef.current === retrySessionId) toastRef.current.warning(t('shell.toasts.conversationResultUnknown'));
      })
      .finally(() => {
        conversationOperationPendingRef.current = false;
        if (sessionIdRef.current === retrySessionId) {
          setRewindStatus(null);
          if (!queued) setIsLoading(false);
        }
      });
  }, [apiPost, setIsLoading, pauseAutoScroll, t, warnRewindFileOutcome, retryCurrentSessionRestore, effectiveModel, reasoningEffort, currentRuntime, currentRuntimeSource, tabId]);

  // Uses refs for messagesRef/toastRef/handleSendMessageRef — deps are all stable → reference stable
  const handleRetry = useCallback(
    (assistantMessageId: string) => {
      const msgs = messagesRef.current;
      const aIdx = msgs.findIndex((m) => m.id === assistantMessageId);
      if (aIdx < 0) return;

      // Find the nearest real user message before this assistant message
      // (skip synthetic task-notification messages which are injected as role='user')
      let userMsg: (typeof msgs)[number] | null = null;
      for (let i = aIdx - 1; i >= 0; i--) {
        if (
          msgs[i].role === 'user' &&
          !msgs[i].id.startsWith('task-notification-')
        ) {
          userMsg = msgs[i];
          break;
        }
      }
      if (!userMsg) return;
      performRetryFromUserMessage(userMsg);
    },
    [performRetryFromUserMessage],
  );

  // Banner-level retry: find the last real user message in the session and rewind+resend it.
  // Used by the agentError banner's 「重新发送」 button (issue #183).
  const [unconfirmedRetry, setUnconfirmedRetry] = useState<Message | null>(null);
  const resendFailedMessage = useCallback(async (userMsg: Message) => {
    if (!messagesRef.current.some(message => message.id === userMsg.id)) return;
    // A lost response can be repaired by replay while the confirmation is open.
    // Recheck the current projection before issuing another request.
    if (userMsg.metadata?.clientRequestId && messagesRef.current.some(message =>
      message.role === 'user' && message.deliveryStatus === undefined &&
      message.metadata?.clientRequestId === userMsg.metadata?.clientRequestId)) return;
    const text = typeof userMsg.content === 'string' ? userMsg.content : '';
    const admitted = await handleSendMessageRef.current(text, restoreMessageImages(userMsg.attachments), undefined, { agentMentions: userMsg.desktopQuery?.agentMentions, primaryContext: desktopContextOf(userMsg.desktopQuery?.primaryContext), requiredSystemSkill: userMsg.desktopQuery?.requiredSystemSkill }, undefined, userMsg.id);
    if (admitted === true && chatInputRef.current?.getCurrentValue().trim() === text) chatInputRef.current.setValue('');
  }, []);
  const handleRetryLastUserMessage = useCallback(() => {
    const msgs = messagesRef.current;
    let userMsg: (typeof msgs)[number] | null = agentErrorUserMessageId
      ? (msgs.find(
          (message) =>
            message.id === agentErrorUserMessageId && message.role === 'user',
        ) ?? null)
      : null;
    if (!agentErrorUserMessageId) {
      for (let i = msgs.length - 1; !userMsg && i >= 0; i--) {
        if (
          msgs[i].role === 'user' &&
          !msgs[i].id.startsWith('task-notification-')
        ) {
          userMsg = msgs[i];
          break;
        }
      }
    }
    if (!userMsg) return;
    if (userMsg.deliveryStatus === 'failed') {
      if (userMsg.deliveryUnconfirmed) setUnconfirmedRetry(userMsg);
      else resendFailedMessage(userMsg);
      return;
    }
    setAgentError(null);
    performRetryFromUserMessage(userMsg);
  }, [agentErrorUserMessageId, performRetryFromUserMessage, setAgentError, resendFailedMessage]);

  // Fork = create a new independent session branch at a specific assistant message
  const handleFork = useCallback((assistantMessageId: string) => {
    setForkTarget(assistantMessageId);
  }, []);

  const handleForkConfirm = useCallback(() => {
    if (!forkTarget || forkPending || conversationOperationPendingRef.current) return;
    conversationOperationPendingRef.current = true;
    const messageId = forkTarget;
    const sourceId = sessionIdRef.current;
    if (forkRequestRef.current?.sourceId !== sourceId || forkRequestRef.current?.messageId !== messageId) {
      forkRequestRef.current = { sourceId, messageId, targetSessionId: crypto.randomUUID() };
    }
    const { targetSessionId } = forkRequestRef.current;
    setForkTarget(null);
    setForkPending(true);
    type ForkResult = { success?: boolean; newSessionId?: string; agentDir?: string; title?: string; error?: string; errorCode?: string };
    const openFork = async (result: ForkResult) => {
      if (!result.success || !result.newSessionId || !result.agentDir) return false;
      forkRequestRef.current = null;
      try {
        const opened = await onForkSession?.(result.newSessionId, result.agentDir, result.title || 'Fork');
        if (!opened) toastRef.current.warning(t('shell.toasts.forkOpenFailed'));
      } catch {
        toastRef.current.warning(t('shell.toasts.forkOpenFailed'));
      }
      return true;
    };
    apiPost('/sessions/fork', { messageId, targetSessionId })
      .then(async res => {
        const result = res as ForkResult;
        track('session_fork', {
          source: 'desktop',
          tab_id: tabId,
          session_id: sourceId,
          runtime: currentRuntime,
          runtime_source: runtimeSourceForRuntimeType(currentRuntime, currentRuntimeSource) ?? null,
          result: result.success ? 'success' : 'failed',
        });
        if (await openFork(result)) return;
        const error = result.errorCode ? t(`shell.toasts.conversationError.${result.errorCode}`)
          : result.error || t('shell.toasts.unknownError');
        toastRef.current.error(t('shell.toasts.forkFailedWithError', { error }));
      })
      .catch(async error => {
        const rejection = getConversationRejectionMessage(error, t);
        if (rejection) {
          toastRef.current.error(t('shell.toasts.forkFailedWithError', { error: rejection }));
          return;
        }
        console.error('[Chat] Fork response unavailable:', error);
        try {
          const result = await apiGet(`/sessions/fork?targetSessionId=${encodeURIComponent(targetSessionId)}`) as ForkResult;
          if (await openFork(result)) return;
        } catch { /* Retain this exact target identity for the user's next attempt. */ }
        toastRef.current.warning(t('shell.toasts.conversationResultUnknown'));
      })
      .finally(() => {
        conversationOperationPendingRef.current = false;
        setForkPending(false);
      });
  }, [forkTarget, forkPending, apiPost, apiGet, onForkSession, t, currentRuntime, currentRuntimeSource, tabId]);

  const handleSelectSession = useCallback(
    (
      id: string,
      title: string,
      historyEntrySource: HistoryEntrySource = 'chat_dropdown',
    ) => {
      if (!onOpenSession) {
        console.error(
          '[Chat] Cannot open history Session without the App navigation owner',
        );
        return;
      }
      onOpenSession(id, title, historyEntrySource);
    },
    [onOpenSession],
  );

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

  const showIntroductionOverlay = shouldShowIntroductionOverlay({
    content: introductionContent,
    historyMessageCount: historyMessages.length,
    hasStreamingMessage: !!streamingMessage,
    isSessionLoading,
    isLoading,
    sessionState,
    showStartupOverlay,
  });

  // Channel discovery and idle/reset admission belong to Rust. A display
  // snapshot may lag migration or startup and cannot select a mutation path.
  const handleNewSession = useCallback(
    () => resetSession({ onNewSidecar: onNewSession }),
    [onNewSession, resetSession],
  );

  return (
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
      <AsyncQuestionContext.Provider value={questionActions}>
        <FileActionProvider
          previewHandleRef={actionFilePreviewRef}
          workspacePath={agentDir}
          onInsertReference={handleInsertReference}
          refreshTrigger={workspaceRefreshTrigger + workspaceChangeSignal}
          onFilePreviewExternal={
            isSplitViewEnabled && !isNarrowLayout
              ? handleSplitFilePreview
              : undefined
          }
          onQuoteFile={handleQuoteFile}
          onQuoteSelection={handleQuoteFileSelection}
          onRevealInTree={handleRevealInTree}
        >
    <div ref={chatLayoutRef} data-chat-layout className="relative flex h-full flex-row overflow-hidden overscroll-none bg-[var(--paper-elevated)] text-[var(--ink)]">
      {/* Left side: chat area (+ side workspace when wide) */}
      <div
        className={`relative flex min-w-0 flex-row overflow-hidden ${!isDraggingSplit ? 'transition-[width] duration-300 ease-in-out' : ''}`}
        style={{
          width:
            splitPanelVisible && !browserUsesFullscreen
              ? `${splitRatio * 100}%`
              : '100%',
        }}
        data-chat-workspace-motion={
          shouldUseWorkspaceOverlay
            ? undefined
            : (workspacePanelMotion ?? undefined)
        }
      >
        <div
          className="flex min-w-0 flex-1 flex-col overflow-hidden"
          data-chat-conversation
        >
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
              {sessionTitle &&
                sessionTitle !== 'New Tab' &&
                sessionTitle !== 'New Chat' && (
                  <>
                    <span className="flex-shrink-0 text-[var(--ink-subtle)]">
                      /
                    </span>
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
                floatingBall={
                  !!sessionId &&
                  resolveFloatingBallBoundSession(config) === sessionId
                }
              />
              {/* Session ⋯ menu — frozen Runtime identity and session actions */}
              {sessionId && agentDir && (
                <SessionMenuButton
                  sessionId={sessionId}
                  runtime={menuRuntimeIdentity?.runtime ?? null}
                  runtimeSource={menuRuntimeIdentity?.runtimeSource ?? null}
                        sessionTitle={
                          sessionTitle ?? t('shell.currentChatFallback')
                        }
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
                  canRename={
                    !!sessionTitle &&
                    sessionTitle !== 'New Tab' &&
                    sessionTitle !== 'New Chat'
                  }
                  // `/context` is a builtin SDK slash command — external runtimes
                  // (Claude Code CLI / Codex) don't share this surface,
                  // so we omit the callback and let the menu hide the row entirely.
                  onShowContext={
                    isExternalRuntime
                      ? undefined
                      : () => {
                          void handleSendMessageRef.current('/context');
                        }
                  }
                        onOpenRename={() =>
                          titleEditorRef.current?.openRename()
                        }
                  onFavoriteChanged={(_, updated) => {
                    if (updated) setSessionMeta(updated);
                  }}
                  onSessionMetadataMutationStart={
                    taskCenterActions.beginSessionMetadataMutation
                  }
                        onSessionMetadataChanged={(
                          updated,
                          mutationSequence,
                        ) => {
                          const accepted =
                            taskCenterActions.applySessionMetadata(
                      updated,
                      mutationSequence,
                    );
                    if (accepted) setSessionMeta(updated);
                    return accepted;
                  }}
                        onGlobalTagChange={() =>
                          taskCenterActions.refreshSessions()
                        }
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
                <ComposeIcon className="h-3.5 w-3.5 flex-shrink-0" />
                      {!splitFile && (
                        <span>{t('shell.header.newChatShort')}</span>
                      )}
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
                    className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-sm font-medium transition-colors ${
                      showHistory
                        ? 'bg-[var(--paper-inset)] text-[var(--ink)]'
                        : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
                    }`}
                  >
                    <HistoryIcon className="h-3.5 w-3.5 flex-shrink-0" />
                          {!splitFile && (
                            <span>{t('shell.header.history')}</span>
                          )}
                  </button>
                  <SessionHistoryDropdown
                    agentDir={agentDir}
                    currentSessionId={sessionId}
                    onSelectSession={(id, title) =>
                      handleSelectSession(id, title, 'chat_dropdown')
                    }
                    onOpenInNewTab={onOpenSessionInNewTab}
                    isOpen={showHistory}
                    onClose={() => setShowHistory(false)}
                    triggerRef={historyBtnRef}
                    sessionNotificationBadgeCounts={
                      sessionNotificationBadgeCounts
                    }
                  />
                </>
              )}
              {/* Dev-only buttons - controlled by config.showDevTools */}
              {config.showDevTools && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowLogs((prev) => !prev)}
                    className={`rounded-lg px-2.5 py-1 text-sm font-medium transition-colors ${
                      showLogs
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
                <Tip
                  label={t('shell.header.expandWorkspace')}
                  position="bottom"
                  align="end"
                >
                  <button
                    type="button"
                    onClick={handleExpandWorkspace}
                    aria-label={t('shell.header.expandWorkspace')}
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                  >
                    <PanelRightIcon className="h-4 w-4" />
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
              <ChatSearchPanel
                controller={chatSearch}
                onClose={closeChatSearch}
              />
            )}
            {/* Drop zone overlay for file drag */}
            <DropZoneOverlay
              isVisible={
                isAnyDragActive &&
                (!isTauriDragging ||
                  activeZoneId === 'chat-content' ||
                  activeZoneId === null)
              }
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
              onRetry={
                sessionRestoreError && sessionId
                  ? () => {
                      void retryCurrentSessionRestore();
                    }
                  : undefined
              }
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

            {discussionId && <TaskDiscussionRecovery discussionId={discussionId} messages={historyMessages} active={!showStartupOverlay || !!agentError || !!startupError} onRetryStartup={startupError ? onRetryStartup : undefined} onRestore={input => {
              initialMessageConsumedRef.current = true;
              onInitialMessageConsumedRef.current?.();
              chatInputRef.current?.setValue(input.text, { primaryContext: input.primaryContext, requiredSystemSkill: input.requiredSystemSkill });
            }} />}

            {agentError &&
              (() => {
                // Find the last real user message — drives both the oversized-image
                // rewind hint and the banner-level "重新发送" button (issue #183).
                const msgs = messagesRef.current;
                let lastUserMsg: (typeof msgs)[number] | null =
                  agentErrorUserMessageId
                    ? (msgs.find(
                        (message) =>
                          message.id === agentErrorUserMessageId &&
                          message.role === 'user',
                      ) ?? null)
                    : null;
                if (!agentErrorUserMessageId) {
                  for (let i = msgs.length - 1; !lastUserMsg && i >= 0; i--) {
                    if (
                      msgs[i].role === 'user' &&
                      !msgs[i].id.startsWith('task-notification-')
                    ) {
                      lastUserMsg = msgs[i];
                      break;
                    }
                  }
                }
                const canRetry = !!lastUserMsg && !isLoading;
                return (
                  <div className="relative z-10 flex-shrink-0 border-b border-[var(--line)] bg-[var(--paper-inset)] px-4 py-2 text-xs text-[var(--ink)]">
                    <div className="mx-auto flex max-w-3xl items-start gap-2">
                      <WarningIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
                      <div className="flex-1">
                        <span className="font-semibold text-[var(--ink)]">
                          {t('shell.agentError.title')}
                        </span>
                        <span className="text-[var(--ink-muted)]">
                          {agentError}
                        </span>
                        {/* Oversized image hint: detect API 400 about image dimensions and offer rewind.
                      Pattern synced with backend (agent-session.ts shouldResetSessionAfterError).
                      Known API error: "...image dimensions exceed max allowed size: 8000 pixels" */}
                        {lastUserMsg &&
                          /image.*exceed.*max allowed size/i.test(
                            agentError,
                          ) && (
                            <div className="mt-1">
                              <span className="text-[var(--ink-muted)]">
                                      {t(
                                        'shell.agentError.imageTooLargePrefix',
                                      )}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  setAgentError(null);
                                  handleRewind(lastUserMsg!.id);
                                }}
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
                                onClick={() =>
                                  handleDiagnoseAgentError(agentError)
                                }
                          className="rounded p-0.5 text-[var(--ink-subtle)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--accent)]"
                          title={t('shell.diagnostics.askHelper')}
                          aria-label={t('shell.diagnostics.askHelper')}
                        >
                          <HelperIcon className="h-3.5 w-3.5" />
                        </button>
                        {canRetry && (
                          <button
                            type="button"
                            onClick={handleRetryLastUserMessage}
                            className="flex items-center gap-1 rounded-md px-2 py-0.5 text-sm font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-warm-subtle)]"
                          >
                            <UndoIcon className="h-3 w-3" />
                            {t('shell.agentError.resend')}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setAgentError(null)}
                          className="flex-shrink-0 rounded p-0.5 text-[var(--ink-subtle)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink-muted)]"
                          title={t('shell.common.close')}
                        >
                          <CloseIcon className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })()}
            {/* Unified Logs Panel - fullscreen modal displaying logs */}
            <UnifiedLogsPanel
              tabId={tabId}
              sessionId={sessionId}
              isVisible={showLogs}
              onClose={() => setShowLogs(false)}
            />

            {/* Query Navigator — floating right-side panel for quick session navigation */}
            <QueryNavigator
              messages={chatScrollModel.data}
              scrollContainerRef={
                scrollerRef as React.RefObject<HTMLDivElement | null>
              }
              pauseAutoScroll={pauseAutoScroll}
              onNavigateToQuery={handleNavigateToQuery}
            />

            {/* Message list with max-width */}
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
                  onItemsRendered={handleStartupItemsRendered}
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
                  isStreaming={
                    isLoading ||
                    sessionState === 'running' ||
                    sessionState === 'starting'
                  }
                  sessionState={sessionState}
                  onRewind={
                    isExternalRuntime
                      ? runtimeConversationBranchSupported &&
                        !isLoading &&
                        sessionState === 'idle' &&
                        queuedMessages.length === 0 &&
                        !forkPending &&
                        !rewindStatus
                        ? handleRewind
                        : undefined
                      : handleRewind
                  }
                  onRetry={handleRetry}
                  onFork={
                    isExternalRuntime
                      ? runtimeConversationBranchSupported &&
                        !isLoading &&
                        sessionState === 'idle' &&
                        queuedMessages.length === 0 &&
                        !forkPending &&
                        !rewindStatus
                        ? handleFork
                        : undefined
                      : handleFork
                  }
                  conversationOperations={
                    currentRuntime === 'codex' || currentRuntime === 'dsh'
                      ? currentRuntime : 'builtin'
                  }
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
                      name={
                        cronCardTask.name || cronCardTask.prompt.slice(0, 20)
                      }
                      scheduleDesc={formatCronScheduleDescription(
                        cronCardTask,
                        tTask,
                        taskLocale,
                      )}
                      onOpenDetail={(task) => {
                        setCronDetailTask(task);
                        setCronCardTask(null);
                      }}
                    />
                  </div>
                )}

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
                  {questionTarget && (
                    <AsyncQuestionComposerTarget
                      title={questionTarget.title}
                      onCancel={() => setQuestionDraft(null)}
                    />
                  )}
            <SimpleChatInput
              ref={chatInputRef}
              onSend={handleSendMessage}
              onStop={handleStop}
              active={isActive}
              sendBlocked={isSessionLoading}
              isLoading={
                isLoading ||
                sessionState === 'running' ||
                sessionState === 'starting'
              }
              sessionState={sessionState}
              systemStatus={systemStatus}
              agentDir={agentDir}
              workspacePath={agentDir}
              sessionId={sessionId}
              showBuiltinSdkSlashCommands={showBuiltinSdkSlashCommands}
              clientActionSlashCommands={runtimeClientActionSlashCommands}
              workspaceSlashCommands={workspaceCapabilitySlashCommands}
              sdkSlashCommands={visibleSdkSlashCommands}
              provider={effectiveModelProvider}
              providers={providerUiProviders}
              providerAvailable={
                currentProviderAvailableForInput &&
                !runtimeExecutionUnavailable &&
                !runtimeProviderSelectionIncomplete
              }
              availableProviderIds={availableProviderIdsForInput}
              providerUnavailableMessage={
                runtimeExecutionUnavailable
                  ? t(runtimeDetectionPending
                      ? 'shell.sessionMenu.runtimeLoading'
                      : 'shell.toasts.runtimeUnavailable')
                  : builtinSnapshotProviderSelectionIncomplete
                    ? t('shell.toasts.reselectModelFirst')
                    : undefined
              }
              onProviderChange={handleProviderChange}
              selectedModel={
                      inputUsesExternalRuntimeControls
                        ? runtimeModel
                        : selectedModel
              }
              onBuiltinModelSelect={
                inputUsesExternalRuntimeControls
                  ? undefined
                  : handleBuiltinModelSelect
              }
              onModelChange={
                inputUsesExternalRuntimeControls
                  ? handleRuntimeModelChange
                  : handleModelChange
              }
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
                    onMcpRetry={
                      !isExternalRuntime || managedProviderRuntimeActive
                        ? handleMcpRetry
                        : undefined
                    }
              officialTools={OFFICIAL_TOOLS}
              workspaceOfficialToolEnabled={workspaceOfficialToolEnabled}
              globalOfficialToolEnabled={globalOfficialToolEnabled}
              officialToolNeedsConfig={officialToolNeedsConfig}
                    onWorkspaceOfficialToolToggle={
                      handleWorkspaceOfficialToolToggle
                    }
              // PRD 0.2.17 — Claude plugins. globallyVisiblePlugins is the
              // Layer 1 (Settings 开关 ON) candidate list; workspaceEnabledPlugins
              // is the Layer 2 actually-enabled subset for this workspace.
              globallyVisiblePlugins={globallyVisiblePlugins}
              workspaceEnabledPlugins={workspaceEnabledPlugins}
              onWorkspacePluginToggle={handleWorkspacePluginToggle}
                    onRefreshProviders={async () => {
                      await refreshProviderData();
                      setWorkspaceRefreshTrigger((value) => value + 1);
                    }}
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
              onGoalResume={() => {
                void resumeGoal();
              }}
              onGoalCancel={handleGoalCancelOpen}
              onGoalDismiss={handleGoalDismiss}
              onSlashAction={handleSlashAction}
              runtime={inputChromeRuntime}
              usesExternalRuntimeControls={inputUsesExternalRuntimeControls}
                    managedReasoningModel={
                      managedProviderRuntimeActive
                        ? (codexModels.find(
                            (model) => model.value === selectedModel,
                          ) ?? null)
                        : undefined
              }
              runtimeModels={
                      inputUsesExternalRuntimeControls
                        ? runtimeModels
                        : undefined
              }
              runtimePermissionModes={
                currentRuntime === 'dsh' || inputUsesExternalRuntimeControls
                  ? runtimePermissionModes
                  : undefined
              }
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
              className={
                shouldUseWorkspaceOverlay
                  ? 'absolute bottom-0 right-0 top-0 z-50 flex w-[340px] max-w-[85%] flex-col bg-[var(--paper-elevated)] shadow-lg'
                  : showWorkspace
                    ? 'relative z-10 flex w-[var(--chat-workspace-panel-width)] shrink-0 flex-col'
                    : 'pointer-events-none absolute bottom-0 right-0 top-0 z-20 flex w-[var(--chat-workspace-panel-width)] flex-col'
              }
              aria-hidden={!showWorkspace}
              inert={!showWorkspace}
              data-chat-workspace-panel
              data-chat-workspace-panel-motion={
                workspacePanelMotion ?? undefined
              }
            >
              <span
                aria-hidden="true"
                className={`pointer-events-none absolute bottom-4 left-0 top-4 z-20 w-px ${
                  shouldUseWorkspaceOverlay
                    ? 'bg-[var(--line)]'
                    : 'bg-[var(--line-subtle)]'
                }`}
                data-chat-workspace-divider
              />
              <DirectoryPanel
                ref={directoryPanelRef}
                agentDir={agentDir}
                projectIcon={currentProject?.icon}
                projectDisplayName={currentProject?.displayName}
                provider={effectiveModelProvider}
                providers={providerUiProviders}
                onProviderChange={handleProviderChange}
                onCollapse={handleCollapseWorkspace}
                onOpenConfig={handleOpenAgentSettings}
                      refreshTrigger={
                        toolCompleteCount + workspaceRefreshTrigger
                      }
                persistedTreeStateRef={workspaceTreeStateRef}
                isTauriDragActive={
                  isTauriDragging && activeZoneId === 'directory-panel'
                }
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
                onFilePreviewExternal={
                  isSplitViewEnabled && !isNarrowLayout
                    ? handleSplitFilePreview
                    : undefined
                }
                onOpenTerminal={
                  isSplitViewEnabled && !isNarrowLayout
                    ? handleOpenTerminal
                    : undefined
                }
                terminalAlive={terminalAlive}
                onOpenBrowser={
                  isSplitViewEnabled && !isNarrowLayout
                    ? handleOpenBrowser
                    : undefined
                }
              />
            </div>
          </>
        )}
      </div>
      {/* End left-side wrapper */}

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
          <div
            className={
              browserUsesFullscreen
                ? 'absolute inset-0 z-30 flex min-w-0 flex-col overflow-hidden bg-[var(--paper)]'
                : `flex min-w-0 flex-1 flex-col overflow-hidden ${!splitPanelVisible ? 'hidden' : ''}`
            }
          >
            {/* Tab switcher — only when 2+ views are active */}
            {(() => {
              const activeViews = [
                splitFile,
                terminalPinned && terminalAlive,
                browserUrl,
              ].filter(Boolean).length;
              return activeViews >= 2;
            })() && (
              <div className="flex h-9 flex-shrink-0 items-center gap-0.5 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-2">
                {/* File tab + its own × */}
                {splitFile && (
                  <button
                    type="button"
                    onClick={() => selectSplitView('file')}
                    className={`group relative flex items-center gap-1 rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${
                      splitActiveView === 'file'
                        ? 'text-[var(--ink)]'
                        : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                    }`}
                  >
                    <span className="max-w-[120px] truncate">
                      {splitFile.name}
                    </span>
                    <span
                      role="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        cancelFilePreview();
                        splitFilePreviewRef.current?.close();
                      }}
                      className="ml-0.5 flex h-5 w-5 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--paper-inset)] group-hover:opacity-100"
                      title={t('shell.split.closeFile')}
                    >
                      <span className="text-sm leading-none text-[var(--ink-muted)]">
                        ×
                      </span>
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
                    onClick={() => selectSplitView('terminal')}
                    className={`group relative flex items-center gap-1 rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${
                      splitActiveView === 'terminal'
                        ? 'text-[var(--ink)]'
                        : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                    }`}
                  >
                    <TerminalIcon className="h-3 w-3" />
                    {t('shell.split.terminal')}
                    <span
                      role="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        cancelFilePreview();
                        setTerminalPinned(false);
                        if (browserUrl) setSplitActiveView('browser');
                        else if (splitFile) setSplitActiveView('file');
                      }}
                      className="ml-0.5 flex h-5 w-5 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--paper-inset)] group-hover:opacity-100"
                      title={t('shell.split.hideTerminal')}
                    >
                      <span className="text-sm leading-none text-[var(--ink-muted)]">
                        ×
                      </span>
                    </span>
                    {splitActiveView === 'terminal' && (
                      <div className="absolute inset-x-1 -bottom-[5px] h-[2px] rounded-full bg-[var(--accent-warm)]" />
                    )}
                  </button>
                )}
                {/* Browser tab + its own × */}
                {browserNavigation && (
                  <button
                    type="button"
                    onClick={() => selectSplitView('browser')}
                    className={`group relative flex items-center gap-1 rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${
                      splitActiveView === 'browser'
                        ? 'text-[var(--ink)]'
                        : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                    }`}
                  >
                    <GlobeIcon className="h-3 w-3" />
                    <span className="max-w-[120px] truncate">
                      {browserSourceFile
                        ? browserSourceFile.name
                        : (() => {
                            // Prefer the live URL surfaced from BrowserPanel — the
                            // navigation request changes only on explicit opens.
                            const liveUrl = browserCurrentUrl || browserNavigation.url;
                            try {
                              return (
                                new URL(liveUrl).hostname ||
                                t('shell.split.newTab')
                              );
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
                      <span className="text-sm leading-none text-[var(--ink-muted)]">
                        ×
                      </span>
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
              <div
                className={`flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--paper-elevated)] ${splitActiveView !== 'file' ? 'hidden' : ''}`}
              >
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center text-[var(--ink-muted)]">
                      <LoaderIcon className="h-5 w-5 animate-spin" />
                    </div>
                  }
                >
                  <FilePreviewModal
                    ref={splitFilePreviewRef}
                    name={splitFile.name}
                    content={splitFile.content}
                    size={splitFile.size}
                    path={splitFile.path}
                    localPath={splitFile.localPath}
                    richDocKind={splitFile.richDocKind}
                    workspacePath={
                      splitFile.sourceScope === 'local' ? null : agentDir
                    }
                    initialEditMode={splitFile.initialEditMode}
                    initialLineNumber={splitFile.initialLineNumber}
                    focusTarget={splitFile.focusTarget}
                    externalRefreshSignal={toolCompleteCount}
                    onExternalContentUpdated={(updated) => {
                      setSplitFile((prev) =>
                        prev && prev.path === updated.path
                          ? {
                              ...prev,
                              name: updated.name,
                              content: updated.content,
                              size: updated.size,
                              initialEditMode: undefined,
                            }
                          : prev,
                      );
                    }}
                    onClose={() => {
                      cancelFilePreview();
                      setSplitFile(null);
                      if (browserUrl) setSplitActiveView('browser');
                      else if (terminalPinned && terminalAlive)
                        setSplitActiveView('terminal');
                    }}
                    onSaved={() =>
                      setWorkspaceRefreshTrigger((prev) => prev + 1)
                    }
                    onRenamed={(newPath, newName) => {
                      setSplitFile((prev) =>
                        prev
                          ? {
                              ...prev,
                              path: newPath,
                              name: newName,
                              initialEditMode: undefined,
                            }
                          : prev,
                      );
                      setWorkspaceRefreshTrigger((prev) => prev + 1);
                    }}
                    embedded
                    onFullscreen={(currentContent) => {
                      cancelFilePreview();
                      const file =
                        currentContent !== undefined
                          ? { ...splitFile!, content: currentContent }
                          : splitFile!;
                      setSplitFile(null);
                      setFullscreenPreviewFile(file);
                    }}
                    onSwitchToBrowser={
                      browserUrl ? handleEditorSwitchToBrowser : undefined
                    }
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
              <div
                className={`flex min-w-0 flex-1 flex-col overflow-hidden ${splitActiveView !== 'terminal' ? 'hidden' : ''}`}
              >
                {/* Terminal header — only when tab switcher is NOT showing (single view) */}
                {[
                  splitFile,
                  terminalPinned && terminalAlive,
                  browserUrl,
                ].filter(Boolean).length < 2 && (
                  <div className="flex h-9 flex-shrink-0 items-center justify-between bg-[var(--paper)] px-3">
                    <div className="flex items-center gap-1.5">
                      <TerminalIcon className="h-3.5 w-3.5 text-[var(--ink)]" />
                      <span className="text-sm font-medium text-[var(--ink)]">
                        {t('shell.split.terminal')}
                      </span>
                      <span className="text-xs text-[var(--ink-muted)]">
                              {agentDir
                                ? `~/${agentDir.split(/[/\\]/).pop()}`
                                : ''}
                      </span>
                    </div>
                    <Tip
                      label={t('shell.split.hideTerminal')}
                      position="bottom"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          cancelFilePreview();
                        setTerminalPinned(false);
                          if (browserUrl) setSplitActiveView('browser');
                          else if (splitFile) setSplitActiveView('file');
                        }}
                        className="flex h-5 w-5 items-center justify-center rounded text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                      >
                        <CloseIcon className="h-3.5 w-3.5" />
                      </button>
                    </Tip>
                  </div>
                )}
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center bg-[var(--paper)]">
                      <LoaderIcon className="h-5 w-5 animate-spin text-[var(--ink-muted)]" />
                    </div>
                  }
                >
                  <LazyTerminalPanel
                    workspacePath={agentDir}
                    terminalId={terminalId}
                    sessionId={sessionId}
                    isVisible={
                      splitPanelVisible && splitActiveView === 'terminal'
                    }
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
                        import('@tauri-apps/api/core').then(
                          ({ invoke: inv }) => {
                            inv('cmd_terminal_close', {
                              terminalId: deadId,
                            }).catch(() => {});
                          },
                        );
                      }
                    }}
                  />
                </Suspense>
              </div>
            )}

            {/* Browser — embedded Tauri child Webview */}
            {browserNavigation && (
              <div
                className={`flex min-w-0 flex-1 flex-col overflow-hidden ${splitActiveView !== 'browser' ? 'hidden' : ''}`}
              >
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center bg-[var(--paper)]">
                      <LoaderIcon className="h-5 w-5 animate-spin text-[var(--ink-muted)]" />
                    </div>
                  }
                >
                  <LazyBrowserPanel
                    tabId={tabId}
                    navigationRequest={browserNavigation}
                    onNavigate={handleOpenInBrowserPanel}
                    isVisible={
                      isActive &&
                      splitPanelVisible &&
                      splitActiveView === 'browser'
                    }
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
                  ref={fullscreenFilePreviewRef}
            name={fullscreenPreviewFile.name}
            content={fullscreenPreviewFile.content}
            size={fullscreenPreviewFile.size}
            path={fullscreenPreviewFile.path}
            localPath={fullscreenPreviewFile.localPath}
            richDocKind={fullscreenPreviewFile.richDocKind}
            workspacePath={
                    fullscreenPreviewFile.sourceScope === 'local'
                      ? null
                      : agentDir
            }
            initialEditMode={fullscreenPreviewFile.initialEditMode}
            initialLineNumber={fullscreenPreviewFile.initialLineNumber}
            focusTarget={fullscreenPreviewFile.focusTarget}
            externalRefreshSignal={toolCompleteCount}
            onExternalContentUpdated={(updated) => {
              setFullscreenPreviewFile((prev) =>
                prev && prev.path === updated.path
                  ? {
                      ...prev,
                      name: updated.name,
                      content: updated.content,
                      size: updated.size,
                      initialEditMode: undefined,
                    }
                  : prev,
              );
            }}
            onClose={() => { cancelFilePreview(); setFullscreenPreviewFile(null); }}
            onSaved={() => setWorkspaceRefreshTrigger((prev) => prev + 1)}
            onRenamed={(newPath, newName) => {
              setFullscreenPreviewFile((prev) =>
                prev
                  ? {
                      ...prev,
                      path: newPath,
                      name: newName,
                      initialEditMode: undefined,
                    }
                  : prev,
              );
              setWorkspaceRefreshTrigger((prev) => prev + 1);
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
            setWorkspaceRefreshTrigger((prev) => prev + 1);
            setIntroductionRefreshTrigger((prev) => prev + 1);
          }}
          refreshKey={workspaceRefreshKey}
          initialTab={workspaceConfigInitialTab}
          initialSelect={workspaceConfigInitialSelect}
          onRequestInit={handleRequestInitFromSettings}
        />
      )}

      {/* Provider / Model History-Boundary Confirm Dialog */}
      {unconfirmedRetry && <ConfirmDialog title={t('discussionRecovery.resend')} message={t('discussionRecovery.resendConfirm')} disableEnterShortcut onCancel={() => setUnconfirmedRetry(null)} onConfirm={() => { const message = unconfirmedRetry; setUnconfirmedRetry(null); resendFailedMessage(message); }} />}
      {pendingProviderSwitch && (
        <ConfirmDialog
          title={
            providerSwitchDialogCopy?.title ??
            t('shell.providerSwitch.newSessionTitle')
          }
          message={
            (providerSwitchDialogCopy?.message ?? t('shell.providerSwitch.defaultMessage'))
            + (surfaces.channel ? `\n\n${t('shell.providerSwitch.channelTransferNotice')}` : '')
          }
          confirmText={
            providerSwitchDialogCopy?.confirmText ??
            t('shell.providerSwitch.createNewSession')
          }
          cancelText={t('shell.common.cancel')}
          onConfirm={confirmProviderSwitch}
          onCancel={() => setPendingProviderSwitch(null)}
        />
      )}

      {/* Time Rewind Confirm Dialog */}
      {rewindTarget && (
        <ConfirmDialog
          title={t(
            currentRuntime === 'codex'
              ? 'shell.dialogs.codexRewind.title'
              : 'shell.dialogs.rewind.title',
          )}
          message={t(
            currentRuntime === 'codex'
              ? rewindTarget.replacesDraft
                ? 'shell.dialogs.codexRewind.messageWithDraft'
                : 'shell.dialogs.codexRewind.message'
              : 'shell.dialogs.rewind.message',
          )}
          confirmText={t(
            currentRuntime === 'codex'
              ? 'shell.dialogs.codexRewind.confirm'
              : 'shell.dialogs.rewind.confirm',
          )}
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
          onClose={
            goalEditSubmitting ? undefined : () => setGoalEditOpen(false)
          }
          className="z-[200] px-4"
        >
          <div className="flex w-full max-w-lg flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-xl">
            <div className="flex items-center justify-between border-b border-[var(--line)] px-6 py-4">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-[var(--ink)]">
                  {t('goalEdit.title')}
                </h2>
                <p className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">
                  {t('goalEdit.subtitle')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setGoalEditOpen(false)}
                disabled={goalEditSubmitting}
                className="shrink-0 rounded-lg p-1 text-[var(--ink-muted)] transition hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CloseIcon className="h-4 w-4" />
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
                {goalEditSubmitting
                  ? t('goalEdit.updating')
                  : t('goalEdit.update')}
              </button>
            </div>
          </div>
        </OverlayBackdrop>
      )}

      {/* Cron Task Settings Modal */}
      <CronTaskSettingsModal
        isOpen={showCronSettings}
        onClose={() => {
          setShowCronSettings(false);
          setCronOpenPreset(null);
        }}
        initialPrompt={cronPrompt}
        // Editing a RUNNING task always wins (cronState.task). Otherwise the
        // Goal bar's optional settings preset applies over an armed-but-unsent
        // config. Plain 定时-button opens (no preset) fall back to
        // cronState.config either way.
        initialConfig={
          cronOpenPreset?.taskKind === 'goal'
            ? cronOpenPreset
            : cronState.task
              ? cronState.config
              : (cronOpenPreset ?? cronState.config)
        }
        workspacePath={agentDir}
        onConfirm={async (config: CronSettingsResult) => {
          if (composerConfigLockedReason && config.taskKind !== 'goal') {
            toastRef.current.warning(composerConfigLockedReason, 3500);
            setShowCronSettings(false);
            setCronOpenPreset(null);
            return;
          }
          const cronExecution = buildCronExecutionOverrides({
            providerId:
              !inputUsesExternalRuntimeControls && currentProvider
                ? currentProvider.id
                : undefined,
            model: inputUsesExternalRuntimeControls ? undefined : selectedModel,
          });
          const enrichedConfig = {
            ...config,
            model: cronExecution.model,
            permissionMode: isExternalRuntime
              ? config.taskKind === 'goal'
                ? effectiveRuntimePermissionMode
                : undefined
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
              has_count_limit: !!(
                config.endConditions.maxExecutions &&
                config.endConditions.maxExecutions > 0
              ),
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
                  const { deleteCronTask } = await import(
                    '@/api/cronTaskClient'
                  );
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
          onOpenSession={(id) =>
            handleSelectSession(id, '', 'task_run_history')
          }
        />
      )}
    </div>
        </FileActionProvider>
      </AsyncQuestionContext.Provider>
    </BrowserPanelContext.Provider>
  );
}
