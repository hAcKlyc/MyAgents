import { APP_BUILD_PROFILE } from '@/../shared/appProfile';
import { registerComposerUpdateOwner, restoreComposerUpdateDraft, type ComposerSnapshot } from '@/utils/composerUpdateCheckpoint';
import { agentMentionToken, activeAgentSnapshots, type AgentMentionSnapshot, type QueryMentionContext } from '../../../shared/agentMentions';
import { isRuntimeBackedProvider } from '../../../shared/providerExecution';
import { isImeComposingEvent } from '@/utils/imeKeyboard';
import {
  AlertIcon,
  AtIcon,
  SlashCommandIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  GaugeIcon,
  LoaderIcon,
  AttachIcon,
  PlusIcon,
  SendIcon,
  SlidersIcon,
  StopIcon,
  TimerIcon,
  WrenchIcon,
  CloseIcon,
} from '@/components/icons';
import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, forwardRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import Tip from '@/components/Tip';
import { useToast } from '@/components/Toast';
import ConfirmDialog from '@/components/ConfirmDialog';
import { ModalityBadges } from '@/components/ModalityBadges';
import { useImagePreview } from '@/context/ImagePreviewContext';
import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import { type PermissionMode, PERMISSION_MODES, type Provider, type ProviderVerifyStatus, getModelDisplayName } from '@/config/types';
import { resolveAgentWorkspaceProjections } from '../../../shared/agentWorkspaceIdentity';
import { useConfigData } from '@/config/useConfigData';
import { resolveEnterKeyAction, sendKeyHint } from '@/utils/chatSendKey';
import SlashCommandMenu, {
  type SlashCommand,
  filterAndSortCommands,
  mergeLocalSlashCommands,
  mergeSdkSlashCommands,
} from '../SlashCommandMenu';
import {
  CLIENT_ACTION_SLASH_COMMANDS,
  isClientActionCommand,
  resolveClientActionName,
  withClientActionCommands,
} from '@/utils/slashActions';
import QueuedMessagesPanel from '../QueuedMessageBubble';
import CronTaskStatusBar from '../cron/CronTaskStatusBar';
import GoalStatusBar from '../goal/GoalStatusBar';
import { useUndoStack } from '@/hooks/useUndoStack';
import { mcpServerState, type McpEffectiveServerState } from '../../../shared/mcpEffectiveState';
import { hasUserEditableMcpSettings, MANAGED_BROWSER_MCP_ID } from '../../../shared/browserTools';
import { CUSTOM_EVENTS } from '../../../shared/constants';
import { IMAGE_UNDERSTANDING_TOOL_ID } from '../../../shared/official-tools';
import { reasoningEffortChoices, REASONING_EFFORT_DESCRIPTIONS, REASONING_EFFORT_DEFAULT } from '../../../shared/reasoningEffort';
import { retainFocusOnMouseDown } from '@/utils/focusRetention';
import { detectExcessiveRepetition } from '@/utils/excessiveRepetition';
import { isProviderAvailable } from '@/config/configService';
import { modelSupportsModality } from '@/config/services/providerService';
import { Popover } from '@/components/ui/Popover';
import type {
  ImageAttachment,
  SimpleChatInputHandle,
  SimpleChatInputProps,
} from './types';
import {
  BUILTIN_FALLBACK_SLASH_COMMANDS,
  LAUNCHER_MIN_LINES,
  LINE_HEIGHT,
  MAX_LINES,
} from './constants';
import { imageAttachmentName } from './attachmentNames';
import { MentionPicker } from './components/MentionPicker';
import { useMentionPicker, type MentionOption } from './hooks/useMentionPicker';
import { McpStatusNotice } from './components/McpStatusNotice';
import { BrowserToolEntry } from './components/BrowserToolEntry';
import { useAttachmentHandling } from './hooks/useAttachmentHandling';
import { PermissionModeIcon, PermissionModeMenuContent } from '../PermissionModeMenu';

// ===== Module-level pure helpers (extracted from render body) =====

/** Check if a provider has a warning (key set but verification failed) */
function isProviderWarning(
  p: Provider,
  apiKeys: Record<string, string>,
  verifyStatus: Record<string, ProviderVerifyStatus>,
): boolean {
  if (p.type === 'subscription') return false;
  return !!apiKeys[p.id] && verifyStatus[p.id]?.status === 'invalid';
}

function runtimeMcpServerId(toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return null;
  const remainder = toolName.slice('mcp__'.length);
  const separator = remainder.indexOf('__');
  return separator > 0 ? remainder.slice(0, separator) : null;
}

function hasMcpStatusNotice(
  state: McpEffectiveServerState,
): boolean {
  return state !== 'ready' && state !== 'disabled';
}

function ModelSelectionScrollSync({
  listRef,
  selectedRowRef,
  selectionKey,
  modelSource,
}: {
  listRef: RefObject<HTMLDivElement | null>;
  selectedRowRef: RefObject<HTMLButtonElement | null>;
  selectionKey: string;
  modelSource: readonly unknown[] | undefined;
}) {
  useLayoutEffect(() => {
    const list = listRef.current;
    const selectedRow = selectedRowRef.current;
    if (!list || !selectedRow) return;

    const centeredTop = selectedRow.offsetTop - ((list.clientHeight - selectedRow.offsetHeight) / 2);
    const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
    list.scrollTop = Math.min(maxScrollTop, Math.max(0, centeredTop));
  }, [listRef, modelSource, selectedRowRef, selectionKey]);

  return null;
}

const SimpleChatInput = memo(forwardRef<SimpleChatInputHandle, SimpleChatInputProps>(function SimpleChatInput({
  composerTabId,
  composerDiscussionId,
  value: externalValue,
  onChange: _externalOnChange,
  onSend,
  onStop,
  sendBlocked = false,
  nextPromptSuggestion,
  isLoading,
  sessionState,
  systemStatus,
  agentDir: _agentDir,
  provider,
  providers = [],
  providerAvailable,
  availableProviderIds,
  providerUnavailableMessage,
  onProviderChange,
  selectedModel,
  onBuiltinModelSelect,
  onModelChange,
  reasoningEffort = 'default',
  onReasoningEffortChange,
  permissionMode = 'auto',
  onPermissionModeChange,
  apiKeys = {},
  providerVerifyStatus = {},
  inputRef,
  workspaceMcpEnabled = [],
  globalMcpEnabled = [],
  officialTools = [],
  workspaceOfficialToolEnabled = [],
  globalOfficialToolEnabled = [],
  officialToolNeedsConfig = {},
  onWorkspaceOfficialToolToggle,
  globallyVisiblePlugins = [],
  workspaceEnabledPlugins = [],
  onWorkspacePluginToggle,
  mcpServers = [],
  runtimeMcpTools = [],
  mcpEffectiveSnapshot = null,
  onWorkspaceMcpToggle,
  onMcpRetry,
  onRefreshProviders,
  onOpenAgentSettings,
  onWorkspaceRefresh,
  cronModeEnabled = false,
  cronConfig,
  goalDraftActive = false,
  workflowDraft,
  onRestoreWorkflowDraft,
  cronTask,
  sessionGoal,
  stoppedCronTask,
  cronIsExecuting = false,
  cronExecutionNumber,
  goalIsExecuting = false,
  goalExecutionNumber,
  composerConfigLockedReason,
  onCronButtonClick,
  onCronSettings,
  onCronCancel,
  onGoalDraftSettings,
  onGoalDraftCancel,
  onCronStop,
  onCronDismissStopped,
  onGoalEdit,
  onGoalResume,
  onGoalCancel,
  onGoalDismiss,
  onSlashAction,
  clientActionSlashCommands,
  showBuiltinSdkSlashCommands = true,
  workspaceSlashCommands,
  sdkSlashCommands = [],
  mode = 'chat',
  toolbarPrefix,
  contextIndicator,
  // Whether this input belongs to the currently active tab. Used to gate document-level
  // listeners (Shift+Tab permission-mode cycle below) so background tabs don't also fire.
  active = true,
  runtime = 'builtin',
  usesExternalRuntimeControls = runtime !== 'builtin' && runtime !== 'dsh',
  runtimeModels,
  managedReasoningModel,
  runtimePermissionModes,
  queuedMessages = [],
  onCancelQueued,
  onForceExecuteQueued,
  agentStatusSlot,
  onOverlayHeightChange,
  workspacePath = null,
  sessionId = null,
}, ref) {
  const { t } = useTranslation('chat');
  const isLauncherMode = mode === 'launcher';
  // Launcher-vs-Chat minimum row count, referenced by both the auto-resize
  // effect and the textarea `rows` / min/max style props. Keep as a single
  // derived constant so a later tweak (e.g. bump to 4) propagates everywhere
  // without the three-site scan the prior duplicated ternary required.
  const effectiveMinLines = isLauncherMode ? LAUNCHER_MIN_LINES : 2;
  const isExternalRuntime = usesExternalRuntimeControls;
  const overlayRootRef = useRef<HTMLDivElement>(null);
  const attachmentSessionId = sessionId;

  // Compute display modes and model name based on runtime
  const displayPermissionModes = runtimePermissionModes
    ? runtimePermissionModes.map(m => ({
      value: m.value as PermissionMode,
      label: t(`input.permissionModes.${m.value}.label`, { defaultValue: m.label }),
      icon: m.icon,
      description: t(`input.permissionModes.${m.value}.description`, { defaultValue: m.description }),
      sdkValue: m.value,
      hidden: m.hidden,
    }))
    : PERMISSION_MODES.map(m => ({
      ...m,
      label: t(`input.permissionModes.${m.value}.label`, { defaultValue: m.label }),
      description: t(`input.permissionModes.${m.value === 'auto' && isRuntimeBackedProvider(provider) ? 'full-auto' : m.value}.description`, { defaultValue: m.description }),
      hidden: false,
    }));
  const currentModeDisplay = displayPermissionModes.find(m => m.value === permissionMode)
    // Historical Codex read-only sessions remain read-only, but are no longer
    // offered as a new native preset. Never display a writable fallback for them.
    ?? (runtime === 'codex' && String(permissionMode) === 'suggest' ? {
      value: permissionMode,
      label: t('input.permissionModes.suggest.label'),
      icon: '🔍',
    } : displayPermissionModes[0]);

  useEffect(() => {
    if (isLauncherMode || !onOverlayHeightChange) return;
    const root = overlayRootRef.current;
    if (!root) return;

    let rafId = 0;
    const emitHeight = () => {
      rafId = 0;
      onOverlayHeightChange(root.getBoundingClientRect().height);
    };
    const schedule = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(emitHeight);
    };

    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    return () => {
      observer.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [isLauncherMode, onOverlayHeightChange]);

  // PERFORMANCE FIX: Use internal state to avoid parent re-renders on every keystroke
  // This prevents MessageList from re-rendering when typing in long conversations
  const [inputValue, setInputValueState] = useState(externalValue ?? '');
  const inputValueRef = useRef(inputValue);
  const updateLockedRef = useRef(false);
  const updatePriorReadOnlyRef = useRef(false);
  const isDraftLocked = useCallback(() => updateLockedRef.current, []);
  const setInputValue = useCallback<React.Dispatch<React.SetStateAction<string>>>((next) => {
    if (updateLockedRef.current) return;
    setInputValueState(previous => {
      const value = typeof next === 'function' ? next(previous) : next;
      inputValueRef.current = value;
      return value;
    });
  }, []);
  const [agentMentions,setAgentMentions]=useState<AgentMentionSnapshot[]>([]);
  const [requiredSystemSkill, setRequiredSystemSkill] = useState<QueryMentionContext["requiredSystemSkill"]>();
  const [primaryContext, setPrimaryContext] = useState<QueryMentionContext["primaryContext"]>();

  // Sync with external value when it changes (e.g., after send clears input)
  // NOTE: Intentionally only depend on externalValue - we only want to sync when
  // external value changes, not when internal inputValue changes (would cause loop)
  useEffect(() => {
    if (externalValue !== undefined && externalValue !== inputValue) {
      setInputValue(externalValue);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalValue]);

  // Issue #231: previously a useEffect on `[inputValue]` pushed every change
  // back to the parent Chat page via `onInputChange?.(inputValue)` so the
  // cron-prompt state stayed live. For 500KB+ paste, that fanned out a
  // setCronPrompt(huge) into Chat.tsx (3.8k LOC: MessageList virtuoso,
  // panels, runtime selector …) on every paste, freezing macOS WebKit.
  // Pulled the value lazily via SimpleChatInputHandle.getCurrentValue() at
  // cron-modal open time instead — see Chat.tsx::handleOpenCronSettings.

  // Ref for current provider availability — used in handleKeyDown without adding deps
  const isCurrentProviderAvailable = providerAvailable ?? (provider ? isProviderAvailable(provider, apiKeys, providerVerifyStatus) : false);
  // External runtimes (Claude Code / Codex) authenticate via their own CLI — no MyAgents provider required.
  const canSendMessage = !sendBlocked && (isExternalRuntime || isCurrentProviderAvailable);
  const canSendMessageRef = useRef(canSendMessage);
  canSendMessageRef.current = canSendMessage;
  const availableProviderIdSet = useMemo(
    () => availableProviderIds ? new Set(availableProviderIds) : null,
    [availableProviderIds],
  );

  // Send-key preference (Enter vs ⌘/Ctrl+Enter). Shared with AI 小助理 / 问题反馈
  // via @/utils/chatSendKey. Mirrored to a ref so the big handleKeyDown callback
  // reads the latest value without re-binding (its deps are intentionally pinned).
  const { config, projects } = useConfigData();
  const localWorkspaceIcons = useMemo(() => Object.fromEntries(
    resolveAgentWorkspaceProjections(projects, config.agents ?? []).agentProjections
      .map(identity => [identity.agentId, identity.project?.icon]),
  ), [projects, config.agents]);
  const sendShortcut = config.chatSendShortcut ?? 'enter';
  const sendShortcutRef = useRef(sendShortcut);
  sendShortcutRef.current = sendShortcut;
  const isMac = useMemo(() => navigator.platform.toLowerCase().includes('mac'), []);

  // PRD 0.2.7: input no longer touches sidecar HTTP directly — workspace file
  // IO and slash command listing all go through `useWorkspaceFileService`
  // (Rust invokes), and option-change persistence goes through
  // `persistInputOptionChange` at the parent (Chat / Launcher) level. The
  // tab API context import is therefore intentionally unused now; kept as a
  // stub here for future analytics / sidecar pings if they materialize.

  // PRD 0.2.7: workspace file IO is now Rust-side, not sidecar HTTP. The
  // hook is identical for launcher and chat-tab — both pass workspacePath in.
  // Where chat-tab previously relied on `apiPost` / `apiGet` to reach the
  // session sidecar's `/api/files/*` and `/agent/search-files`, we now invoke
  // `cmd_workspace_*` directly. Pre-PRD-0.2.7 the launcher's missing tab API
  // was the source of "API 未就绪" toast — gone now because the hook works
  // off `workspacePath` only and doesn't care if a Sidecar is running.
  const fileService = useWorkspaceFileService(workspacePath);

  const toast = useToast();
  // Stabilize toast reference to avoid unnecessary effect re-runs
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const configControlsLocked = !!composerConfigLockedReason;
  const configControlLockTitle = composerConfigLockedReason ?? undefined;
  const showConfigLockedReason = useCallback(() => {
    if (!composerConfigLockedReason) return false;
    toastRef.current.warning(composerConfigLockedReason, 3500);
    return true;
  }, [composerConfigLockedReason]);

  const { openPreview } = useImagePreview();
  // Use external ref if provided, otherwise use internal ref
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = inputRef ?? internalRef;
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Anchor refs for Popover-based dropdowns. The textarea wrapper anchors
  // the @file and /slash menus (both sit at the bottom of the textarea
  // area); the four toolbar menus anchor to their own trigger buttons.
  const textareaWrapperRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const modeBtnRef = useRef<HTMLButtonElement>(null);
  const toolBtnRef = useRef<HTMLButtonElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);

  // Undo stack for file reference insertions
  const undoStack = useUndoStack({ maxSize: 20 });

  // Ref for latest inputValue (for stable insertReferences callback)
  inputValueRef.current = inputValue;

  // Plus menu
  const [showPlusMenu, setShowPlusMenu] = useState(false);


  // Mode and Model dropdown menus
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showToolMenu, setShowToolMenu] = useState(false);
  const modelListRef = useRef<HTMLDivElement | null>(null);
  const selectedModelRowRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!configControlsLocked || (!showModeMenu && !showModelMenu && !showToolMenu)) return;
    const timer = window.setTimeout(() => {
      setShowModeMenu(false);
      setShowModelMenu(false);
      setShowToolMenu(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [configControlsLocked, showModeMenu, showModelMenu, showToolMenu]);
  const modeMenuOpen = showModeMenu && !configControlsLocked;
  const modelMenuOpen = showModelMenu && !configControlsLocked;
  const toolMenuOpen = showToolMenu && !configControlsLocked;
  const visibleOfficialTools = useMemo(
    () => officialTools.filter(
      tool =>
        globalOfficialToolEnabled.includes(tool.id) &&
        !officialToolNeedsConfig[tool.id],
    ),
    [globalOfficialToolEnabled, officialToolNeedsConfig, officialTools],
  );
  const imageUnderstandingReady =
    visibleOfficialTools.some(tool => tool.id === IMAGE_UNDERSTANDING_TOOL_ID) &&
    workspaceOfficialToolEnabled.includes(IMAGE_UNDERSTANDING_TOOL_ID);
  const notifyUnsupportedImageFallback = useCallback(() => {
    if (imageUnderstandingReady) return;
    toastRef.current.warning(t('input.attachments.imageUnderstandingNotReady'));
  }, [imageUnderstandingReady, t]);
  const runtimeMcpServers = useMemo(() => {
    const configuredServers = new Map(mcpServers.map(server => [server.id, server]));
    const ids = [...new Set(runtimeMcpTools.map(runtimeMcpServerId).filter((id): id is string => id !== null))];
    return ids.map(id => configuredServers.get(id) ?? { id, name: id });
  }, [mcpServers, runtimeMcpTools]);
  const externalMcpServers = useMemo(() => {
    if (!isExternalRuntime || !mcpEffectiveSnapshot) return runtimeMcpServers;
    const configuredServers = new Map(mcpServers.map(server => [server.id, server]));
    return mcpEffectiveSnapshot.servers
      .filter(server => server.desired)
      .map(server => configuredServers.get(server.id) ?? { id: server.id, name: server.id });
  }, [isExternalRuntime, mcpEffectiveSnapshot, mcpServers, runtimeMcpServers]);
  const enabledToolEntryCount = useMemo(() => {
    const enabledMcpEntryCount = isExternalRuntime
      ? externalMcpServers.length
      : new Set(mcpServers
        .filter(server => globalMcpEnabled.includes(server.id) && workspaceMcpEnabled.includes(server.id))
        .map(server => server.id)).size;
    const enabledOfficialEntryCount = visibleOfficialTools.filter(
      tool => workspaceOfficialToolEnabled.includes(tool.id),
    ).length;
    return enabledMcpEntryCount + enabledOfficialEntryCount;
  }, [externalMcpServers.length, globalMcpEnabled, isExternalRuntime, mcpServers, visibleOfficialTools, workspaceMcpEnabled, workspaceOfficialToolEnabled]);

  // #324 — 推理强度 submenu (fixed bottom row of the model menu). Opens on
  // hover/click of the row; share the 120ms close delay with the portaled
  // flyout so the pointer can cross its 6px gap without closing it.
  const [showEffortSubmenu, setShowEffortSubmenu] = useState(false);
  const effortRowWrapRef = useRef<HTMLDivElement | null>(null);
  const effortCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // null = this surface has no reasoning-effort knob (unknown) → row hidden.
  const managedEffort = isRuntimeBackedProvider(provider);
  const effortModel = managedReasoningModel !== undefined
    ? managedReasoningModel
    : provider?.models?.find(model => model.model === (selectedModel ?? provider.primaryModel));
  const defaultEffortLabel = managedEffort && effortModel?.defaultReasoningEffort
    ? `${t('input.reasoningDefault')} (${effortModel.defaultReasoningEffort})`
    : t('input.reasoningDefault');
  const effortChoices = onReasoningEffortChange
    ? managedEffort
      ? (effortModel?.supportedReasoningEfforts?.map(option => option.reasoningEffort) ?? [])
      : reasoningEffortChoices(
        runtime === 'dsh' ? 'dsh' : isExternalRuntime ? (runtime ?? 'builtin') : 'builtin',
        provider?.apiProtocol,
        provider?.id,
        selectedModel ?? provider?.primaryModel,
        provider?.config.baseUrl,
      )
    : null;
  const openEffortSubmenu = useCallback(() => {
    if (effortCloseTimerRef.current) {
      clearTimeout(effortCloseTimerRef.current);
      effortCloseTimerRef.current = null;
    }
    setShowEffortSubmenu(true);
  }, []);
  const scheduleCloseEffortSubmenu = useCallback(() => {
    if (effortCloseTimerRef.current) clearTimeout(effortCloseTimerRef.current);
    effortCloseTimerRef.current = setTimeout(() => setShowEffortSubmenu(false), 120);
  }, []);
  // Reset submenu state whenever the model menu closes (incl. outside-click).
  useEffect(() => {
    if (!modelMenuOpen) {
      setShowEffortSubmenu(false);
      if (effortCloseTimerRef.current) {
        clearTimeout(effortCloseTimerRef.current);
        effortCloseTimerRef.current = null;
      }
    }
  }, [modelMenuOpen]);
  useEffect(() => () => {
    if (effortCloseTimerRef.current) clearTimeout(effortCloseTimerRef.current);
  }, []);
  // Derive current model ID from prop or provider default — no hardcoded fallback
  const currentModelId = selectedModel ?? provider?.primaryModel;
  // Get display name for current model (runtime-aware)
  const currentModelName = isExternalRuntime
    ? (runtimeModels?.find(m => m.value === selectedModel)?.displayName
      ?? runtimeModels?.find(m => m.isDefault)?.displayName
      ?? t('input.modelDefault'))
    : (currentModelId
      ? (provider ? getModelDisplayName(provider, currentModelId) : currentModelId)
      : t('input.selectModel'));

  const [showFileSearch, setShowFileSearch] = useState(false);
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [atPosition, setAtPosition] = useState<number | null>(null);
  const mentionPicker = useMentionPicker(showFileSearch, fileSearchQuery, workspacePath, fileService);
  const chooseMention = (option: MentionOption) => {
    if (option.kind !== 'agent' && option.kind !== 'thought' && option.kind !== 'file') {
      mentionPicker.activateControl(option);
      return;
    }
    const text = inputValueRef.current;
    const end = textareaRef.current?.selectionStart ?? (atPosition ?? 0) + 1 + fileSearchQuery.length;
    if (atPosition === null || text[atPosition] !== '@' || end < atPosition + 1) return;
    const token = option.kind === 'agent' ? agentMentionToken(option.value.agent.selector)
      : option.kind === 'file' ? `@${option.value.path}` : option.value.content;
    const next = `${text.slice(0, atPosition)}${token} ${text.slice(end)}`;
    if (option.kind === 'agent') setAgentMentions(previous => [...previous.filter(item => item.agent.selector !== option.value.agent.selector), option.value]);
    setInputValue(next); setShowFileSearch(false); setAtPosition(null);
    const caret = atPosition + token.length + 1;
    requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(caret, caret); });
  };

  // /slash command search
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashSearchQuery, setSlashSearchQuery] = useState('');
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const slashCommandLoadIdRef = useRef(0);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [slashPosition, setSlashPosition] = useState<number | null>(null);

  const clientActionsEnabled = !!onSlashAction;
  const enabledClientActionCommands = useMemo(
    () => clientActionsEnabled
      ? [...CLIENT_ACTION_SLASH_COMMANDS, ...(clientActionSlashCommands ?? [])]
      : [],
    [clientActionSlashCommands, clientActionsEnabled],
  );
  const localizedFallbackSlashCommands = useMemo(
    () => showBuiltinSdkSlashCommands
      ? BUILTIN_FALLBACK_SLASH_COMMANDS.map(cmd => ({
        ...cmd,
        description: t(`input.slashCommands.${cmd.name}`, { defaultValue: cmd.description }),
      }))
      : [],
    [showBuiltinSdkSlashCommands, t],
  );
  // Launcher receives a runtime-neutral filesystem inventory whose Rust
  // scanner includes Claude SDK builtins. Project that raw inventory at render
  // time so provider/runtime changes cannot be overwritten by a late scan from
  // the previous selection. Chat's injected capability snapshot passes through
  // the same boundary for one consistent composer invariant.
  const runtimeVisibleSlashCommands = useMemo(
    () => showBuiltinSdkSlashCommands
      ? slashCommands
      : slashCommands.filter(command => command.source !== 'builtin'),
    [showBuiltinSdkSlashCommands, slashCommands],
  );
  const runtimeVisibleSdkSlashCommands = useMemo(
    () => showBuiltinSdkSlashCommands ? sdkSlashCommands : [],
    [showBuiltinSdkSlashCommands, sdkSlashCommands],
  );
  const mergedSlashCommands = useMemo(
    () => withClientActionCommands(
      mergeSdkSlashCommands(runtimeVisibleSlashCommands, runtimeVisibleSdkSlashCommands),
      clientActionsEnabled,
      clientActionSlashCommands ?? [],
    ),
    [runtimeVisibleSlashCommands, runtimeVisibleSdkSlashCommands, clientActionsEnabled, clientActionSlashCommands],
  );

  // Compute filtered slash commands once per render (used in both handleKeyDown and JSX)
  const filteredSlashCommands = useMemo(
    () => filterAndSortCommands(mergedSlashCommands, slashSearchQuery),
    [mergedSlashCommands, slashSearchQuery]
  );

  // Guard against double-fire of handleSend (e.g. rapid Enter + click)
  const sendingRef = useRef(false);

  // Bug #123: track IME composition so the auto-resize effect can skip
  // textarea.style.height writes during composition. Style recalculation
  // during composition is the historical WebKit trigger (Bug 46868 class)
  // for "IME candidate text leaks into committed value" — observed on
  // macOS Tauri WebView with WeChat IME voice input duplicating recognized
  // text dozens of times. Resize once after compositionend via resizeBump.
  const isComposingRef = useRef(false);
  const [isComposing, setIsComposing] = useState(false);
  const [dismissedSuggestionKey, setDismissedSuggestionKey] = useState<string | null>(null);
  const [resizeBump, setResizeBump] = useState(0);

  // Bug #123: pending excessive-repetition confirmation. When non-null, a
  // ConfirmDialog is shown with the repeat count; the user can cancel
  // (input is preserved for editing) or confirm (send proceeds, bypassing
  // the repetition guard once).
  const [repetitionWarning, setRepetitionWarning] = useState<{
    text: string;
    images: ImageAttachment[];
    count: number;
  } | null>(null);

  // Close all dropdown menus (plus, mode, model, provider)
  const closeAllMenus = useCallback(() => {
    setShowPlusMenu(false);
    setShowModeMenu(false);
    setShowModelMenu(false);
    setShowToolMenu(false);
  }, []);

  // Close all menus when clicking outside (toolbar buttons use stopPropagation to prevent this)
  useEffect(() => {
    const handleClickOutside = () => {
      closeAllMenus();
      setShowSlashMenu(false);
      setSlashPosition(null);
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [closeAllMenus]);

  useEffect(() => {
    textareaRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- textareaRef is stable
  }, []);

  // Auto-resize textarea based on content. Grows from `effectiveMinLines`
  // up to `MAX_LINES`; past the ceiling the textarea scrolls internally.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Bug #123: don't touch textarea.style during IME composition. Style
    // recalculation while the IME holds marked text is the historical
    // WebKit trigger for candidate-text duplication (macOS WebView +
    // WeChat IME voice input). The post-compositionend handler will run
    // resize once after commit.
    if (isComposingRef.current) return;

    // Skip when the textarea is in a `display:none` subtree (Launcher hides
    // the inactive 对话/想法 mode this way). `scrollHeight` reads as 0 there
    // and would clamp `style.height` to `minHeight`, then no later effect
    // would re-fire on reveal — so the user would see the wrong height
    // until the next keystroke. Leaving the previously-correct height
    // untouched preserves it across the hidden interval.
    if (textarea.offsetParent === null) return;

    const minHeight = LINE_HEIGHT * effectiveMinLines;
    const maxHeight = LINE_HEIGHT * MAX_LINES;
    textarea.style.height = 'auto';
    const scrollHeight = textarea.scrollHeight;
    textarea.style.height = `${Math.max(minHeight, Math.min(scrollHeight, maxHeight))}px`;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- textareaRef is stable
  }, [inputValue, resizeBump]);

  // IME composition handlers (Bug #123). Set the ref BEFORE the auto-resize
  // effect can run for the in-progress composition, and bump `resizeBump`
  // after commit so the textarea catches up to its final size even if the
  // IME doesn't emit a follow-up input event.
  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
    setIsComposing(true);
  }, []);
  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false;
    setIsComposing(false);
    setResizeBump((b) => b + 1);
    const textarea = textareaRef.current;
    if (textarea && showFileSearch && atPosition !== null && textarea.value[atPosition] === '@') {
      const query = textarea.value.slice(atPosition + 1, textarea.selectionStart);
      if (!/[\s]/u.test(query)) setFileSearchQuery(query);
    }
  }, [showFileSearch, atPosition, textareaRef]);

  // Fetch slash commands function (extracted for reuse).
  // Chat tabs inject the same effective capability winners used by their
  // sidebar and Runtime. Launcher has no Sidecar and retains the read-only
  // workspace scan fallback.
  const fetchCommands = useCallback(async () => {
    const requestId = ++slashCommandLoadIdRef.current;
    const apply = (list: SlashCommand[]) =>
      requestId === slashCommandLoadIdRef.current && setSlashCommands(list);
    if (workspaceSlashCommands !== undefined) {
      // Product builtins own their reserved names; disk-backed capabilities
      // fill only the remaining namespace.
      apply(mergeLocalSlashCommands(localizedFallbackSlashCommands, workspaceSlashCommands));
      return;
    }
    if (!fileService.isAvailable) {
      // Fall back to builtins so the menu isn't empty in browser dev mode.
      apply(localizedFallbackSlashCommands);
      return;
    }
    try {
      const response = await fileService.listSlashCommands();
      if (response.success && response.commands.length > 0) {
        apply(response.commands);
      } else {
        console.warn('[slash-commands] Rust returned empty, using builtin fallback');
        apply(localizedFallbackSlashCommands);
      }
    } catch (err) {
      if (requestId === slashCommandLoadIdRef.current) {
        console.error('Failed to fetch slash commands, using fallback:', err);
        apply(localizedFallbackSlashCommands);
      }
    }
  }, [fileService, localizedFallbackSlashCommands, workspaceSlashCommands]);

  // Fetch slash commands on mount or when workspacePath changes (so launcher
  // workspace switching reloads project-level skills).
  useEffect(() => {
    fetchCommands();
  }, [workspacePath, fetchCommands]);

  // Launcher has no Sidecar snapshot, so capability mutations refresh its
  // read-only filesystem inventory through the same invalidation event.
  useEffect(() => {
    const handleCapabilitiesChanged = () => {
      // Delay slightly to ensure file system is updated
      setTimeout(() => {
        fetchCommands();
      }, 100);
    };
    window.addEventListener(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED, handleCapabilitiesChanged);
    return () => window.removeEventListener(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED, handleCapabilitiesChanged);
  }, [fetchCommands]);

  // Selection is already represented by the injected effective snapshot (or
  // the Launcher's read-only inventory); no per-invocation file copy is needed.
  const handleSkillSelect = useCallback((_cmd: SlashCommand) => {}, []);

  const {
    images,
    setImages,
    removeImage,
    processDroppedFiles,
    processDroppedFilePaths,
    handleUploadButtonClick,
    handleFileChange,
    handlePaste,
    hasPendingAttachments,
    getImageCount,
  } = useAttachmentHandling({
    fileService,
    workspacePath,
    provider,
    currentModelId,
    isExternalRuntime,
    attachmentSessionId,
    inputValueRef,
    textareaRef,
    fileInputRef,
    toastRef,
    undoStack,
    setInputValue,
    setShowPlusMenu,
    notifyUnsupportedImageFallback,
    onWorkspaceRefresh,
    isDraftLocked,
  });

  // Insert @references at cursor position or end of input
  // Uses inputValueRef for stable callback (avoids rebuilding on every input change)
  const insertReferences = useCallback((paths: string[]) => {
    if (paths.length === 0) return;

    const currentInput = inputValueRef.current;

    // Build reference string with @paths separated by spaces
    const references = paths.map(p => `@${p}`).join(' ');

    // Get cursor position (or end if no focus)
    const cursorPos = textareaRef.current?.selectionStart ?? currentInput.length;
    const before = currentInput.slice(0, cursorPos);
    const after = currentInput.slice(cursorPos);

    // Add space before if needed (not at start, not after space/newline)
    const needsSpaceBefore = before.length > 0 && !/[\s]$/.test(before);
    // Add space after if needed (not at end, not before space/newline)
    const needsSpaceAfter = after.length > 0 && !/^[\s]/.test(after);

    const newValue = `${before}${needsSpaceBefore ? ' ' : ''}${references}${needsSpaceAfter ? ' ' : ''}${after}`;
    setInputValue(newValue);

    // Focus textarea and set cursor after the inserted references
    const newCursorPos = cursorPos + (needsSpaceBefore ? 1 : 0) + references.length + (needsSpaceAfter ? 1 : 0);
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  }, [textareaRef, setInputValue]);

  // Append a reference token to the END of input with leading-space padding and
  // guaranteed trailing space. Used by file-preview 「引用文件」/ 「引用」 selection.
  // Distinct from `insertReferences` (insert at cursor, no trailing space) — appending
  // and trailing-space matter for the file-preview UX where the user always wants a
  // ready-to-type position right after the token.
  const appendReferenceToken = useCallback((token: string) => {
    if (!token) return;
    const currentInput = inputValueRef.current;
    const needsSpaceBefore = currentInput.length > 0 && !/\s$/.test(currentInput);
    const newValue = `${currentInput}${needsSpaceBefore ? ' ' : ''}${token} `;
    setInputValue(newValue);
    setTimeout(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(newValue.length, newValue.length);
      ta.scrollTop = ta.scrollHeight;
    }, 0);
  }, [textareaRef, setInputValue]);

  // Insert /slash-command at cursor position or end of input
  const insertSlashCommand = useCallback((command: string) => {
    if (!command.trim()) return;
    const currentInput = inputValueRef.current;
    const slashCmd = `/${command}`;
    const cursorPos = textareaRef.current?.selectionStart ?? currentInput.length;
    const before = currentInput.slice(0, cursorPos);
    const after = currentInput.slice(cursorPos);
    const needsSpaceBefore = before.length > 0 && !/[\s]$/.test(before);
    const needsSpaceAfter = after.length > 0 && !/^[\s]/.test(after);
    const newValue = `${before}${needsSpaceBefore ? ' ' : ''}${slashCmd}${needsSpaceAfter ? ' ' : ''}${after}`;
    setInputValue(newValue);
    const newCursorPos = cursorPos + (needsSpaceBefore ? 1 : 0) + slashCmd.length + (needsSpaceAfter ? 1 : 0);
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  }, [textareaRef, setInputValue]);

  // Set input value directly (for restoring content after cron stop)
  const setValue = useCallback((value: string, context?: QueryMentionContext) => {
    if (updateLockedRef.current) return;
    setAgentMentions(context?.agentMentions ?? []);
    setPrimaryContext(context?.primaryContext);
    setRequiredSystemSkill(context?.requiredSystemSkill);
    setInputValue(value);
    // Also focus the textarea
    textareaRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- textareaRef is stable
  }, []);

  // Expose methods to parent via ref
  useImperativeHandle(ref, () => ({
    processDroppedFiles,
    processDroppedFilePaths,
    insertReferences,
    appendReferenceToken,
    insertSlashCommand,
    setValue,
    setImages,
    focus: () => textareaRef.current?.focus(),
    getCurrentValue: () => inputValueRef.current,
    clearQueryContext: () => { setAgentMentions([]); setPrimaryContext(undefined); setRequiredSystemSkill(undefined); },
    getQueryContext: () => ({ agentMentions: activeAgentSnapshots(inputValueRef.current, agentMentions), primaryContext, requiredSystemSkill }),
    getImages: () => [...images],
    clearWorkspaceBoundDraft: () => {
      // Match `@<path>` tokens that target the workspace-managed `myagents_files/`
      // upload directory. Plain typed `@something` (not workspace-tied) survives.
      // Trailing whitespace after the token is also consumed (`\s*`) so a
      // sequence like "@myagents_files/foo.pdf  " collapses fully — the
      // earlier `\s?` left a stray space behind in the multi-space case.
      const current = inputValueRef.current;
      const pattern = /@myagents_files\/[^\s]+\s*/g;
      const stripped = current.replace(pattern, '');
      const strippedCount = (current.match(pattern) ?? []).length;
      if (strippedCount > 0) {
        setInputValue(stripped);
      }
      const clearedImages = images.length;
      if (clearedImages > 0) {
        setImages([]);
      }
      return { strippedReferences: strippedCount, clearedImages };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- textareaRef is stable
  }), [processDroppedFiles, processDroppedFilePaths, insertReferences, appendReferenceToken, insertSlashCommand, setValue, images.length, agentMentions, primaryContext, requiredSystemSkill]);

  const checkpointSnapshotRef = useRef<ComposerSnapshot | null>(null);
  useLayoutEffect(() => {
    checkpointSnapshotRef.current = {
      scope: { tabId: composerTabId ?? '', sessionId, workspacePath, mode: isLauncherMode ? 'launcher' : 'chat',
        ...(composerDiscussionId ? { discussionId: composerDiscussionId } : {}) },
      text: inputValue,
      context: { agentMentions: activeAgentSnapshots(inputValue, agentMentions), primaryContext, requiredSystemSkill },
      imageCount: images.length, pendingAttachments: false, composing: false, sending: false,
      stagedWorkflow: !!goalDraftActive || (cronModeEnabled && !cronTask && !!cronConfig),
      ...(workflowDraft && onRestoreWorkflowDraft ? { workflowDraft } : {}),
    };
  });
  useLayoutEffect(() => {
    if (APP_BUILD_PROFILE !== 'moxbot') return;
    const scope = { tabId: composerTabId ?? '', sessionId, workspacePath, mode: isLauncherMode ? 'launcher' as const : 'chat' as const,
      ...(composerDiscussionId ? { discussionId: composerDiscussionId } : {}) };
    const current = checkpointSnapshotRef.current!;
    const restored = restoreComposerUpdateDraft(scope, !inputValueRef.current && !getImageCount()
      && !current.stagedWorkflow && !current.workflowDraft
      && !current.context.primaryContext && !current.context.requiredSystemSkill && !current.context.agentMentions?.length, onRestoreWorkflowDraft);
    if (restored) {
      setInputValue(restored.text);
      setAgentMentions(restored.context.agentMentions ?? []);
      setPrimaryContext(restored.context.primaryContext);
      setRequiredSystemSkill(restored.context.requiredSystemSkill);
    }
  }, [composerTabId, composerDiscussionId, sessionId, workspacePath, isLauncherMode, setInputValue,
    getImageCount, goalDraftActive, cronModeEnabled, cronTask, onRestoreWorkflowDraft]);
  useLayoutEffect(() => {
    if (APP_BUILD_PROFILE !== 'moxbot') return;
    return registerComposerUpdateOwner({
      snapshot: () => ({ ...checkpointSnapshotRef.current!,
        text: textareaRef.current?.value ?? inputValueRef.current,
        imageCount: getImageCount(), pendingAttachments: hasPendingAttachments(),
        composing: isComposingRef.current, sending: sendingRef.current,
      }),
      freeze: locked => {
        const wasLocked = updateLockedRef.current;
        updateLockedRef.current = locked;
        if (overlayRootRef.current) overlayRootRef.current.inert = locked;
        if (textareaRef.current) {
          if (locked && !wasLocked) updatePriorReadOnlyRef.current = textareaRef.current.readOnly;
          textareaRef.current.readOnly = locked || updatePriorReadOnlyRef.current;
        }
      },
    });
  }, [composerTabId, composerDiscussionId, sessionId, workspacePath, isLauncherMode, setInputValue, textareaRef, getImageCount, hasPendingAttachments]);

  // Handle text input change (detect @ and / and backspace)
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (updateLockedRef.current) { e.target.value = inputValueRef.current; return; }
    if (nextPromptSuggestion) setDismissedSuggestionKey(nextPromptSuggestion.key);
    const newValue = e.target.value;
    const cursorPos = e.target.selectionStart;

    // Track current state locally to avoid stale closure issues
    let currentShowFileSearch = showFileSearch;
    let currentAtPosition = atPosition;
    let currentShowSlashMenu = showSlashMenu;
    let currentSlashPosition = slashPosition;

    // Detect new @ or / character (only when adding).
    // PRD 0.2.7: previously gated by `!isLauncherMode` because launcher had no
    // sidecar HTTP, so `@`/`/` would silently do nothing. Now both pickers run
    // off the workspace_files Rust commands and work in either mode.
    if (newValue.length > inputValue.length) {
      const addedChar = newValue[cursorPos - 1];
      if (addedChar === '@') {
        currentShowFileSearch = true;
        currentAtPosition = cursorPos - 1;
        setShowFileSearch(true);
        setAtPosition(cursorPos - 1);
        setFileSearchQuery('');
        // Close slash menu if open
        currentShowSlashMenu = false;
        currentSlashPosition = null;
        setShowSlashMenu(false);
        setSlashPosition(null);
      } else if (addedChar === '/') {
        currentShowSlashMenu = true;
        currentSlashPosition = cursorPos - 1;
        setShowSlashMenu(true);
        setSlashPosition(cursorPos - 1);
        setSlashSearchQuery('');
        setSelectedSlashIndex(0);
        // Close file search if open
        currentShowFileSearch = false;
        currentAtPosition = null;
        setShowFileSearch(false);
        setAtPosition(null);
      }
    }

    // Update file search query if @ is active (handles both add and delete)
    if (currentShowFileSearch && currentAtPosition !== null && !isComposingRef.current) {
      // Check if @ was deleted
      if (currentAtPosition >= newValue.length || newValue[currentAtPosition] !== '@') {
        setShowFileSearch(false);
        setAtPosition(null);
      } else {
        const textAfterAt = newValue.slice(currentAtPosition + 1, cursorPos);
        // If there's a space or newline after @, close search
        if (textAfterAt.includes(' ') || textAfterAt.includes('\n')) {
          setShowFileSearch(false);
          setAtPosition(null);
        } else {
          setFileSearchQuery(textAfterAt);
        }
      }
    }

    // Update slash search query if / is active (handles both add and delete)
    if (currentShowSlashMenu && currentSlashPosition !== null) {
      // Check if / was deleted
      if (currentSlashPosition >= newValue.length || newValue[currentSlashPosition] !== '/') {
        setShowSlashMenu(false);
        setSlashPosition(null);
      } else {
        const textAfterSlash = newValue.slice(currentSlashPosition + 1, cursorPos);
        // If there's a space or newline after /, close menu
        if (textAfterSlash.includes(' ') || textAfterSlash.includes('\n')) {
          setShowSlashMenu(false);
          setSlashPosition(null);
        } else {
          setSlashSearchQuery(textAfterSlash);
          setSelectedSlashIndex(0);
        }
      }
    }

    setInputValue(newValue);
  }, [inputValue, showFileSearch, atPosition, showSlashMenu, slashPosition, nextPromptSuggestion, setInputValue]);

  // Cycle permission mode — runtime-aware:
  // Builtin: auto → plan → fullAgency → auto
  // External: cycle through runtimePermissionModes (CC or Codex specific modes)
  const cyclePermissionMode = useCallback(() => {
    if (showConfigLockedReason()) return;
    const modeOrder: string[] = runtimePermissionModes?.length
      ? runtimePermissionModes.filter(m => !m.hidden).map(m => m.value)
      : ['auto', 'plan', 'fullAgency'];
    const currentIndex = modeOrder.indexOf(permissionMode);
    // If current mode not in list (e.g., mode from a different runtime), start from first
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % modeOrder.length;
    const nextMode = modeOrder[nextIndex] as PermissionMode;

    // Show warning toast for dangerous modes (runtime-agnostic string check)
    const dangerousModes = new Set(['fullAgency', 'bypassPermissions', 'no-restrictions', 'full-autonomous']);
    if (dangerousModes.has(nextMode)) {
      toastRef.current.warning(t(runtime === 'dsh' ? 'input.dshAutonomyWarning' : 'input.autonomyWarning'), 5000);
    }
    onPermissionModeChange?.(nextMode);
  }, [permissionMode, onPermissionModeChange, runtime, runtimePermissionModes, showConfigLockedReason, t]);

  // Global Shift+Tab handler with capture phase to prevent default Tab behavior.
  // Gated by `active` so pressing Shift+Tab doesn't cycle permission-mode on every
  // mounted tab simultaneously (document-level listener otherwise fans out to all
  // N tabs, each calling its own cyclePermissionMode).
  useEffect(() => {
    if (!active) return;
    const handleShiftTab = (e: KeyboardEvent) => {
      if (isComposingRef.current || isImeComposingEvent(e)) return;
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        cyclePermissionMode();
      }
    };
    // Use capture phase to intercept before default Tab behavior
    document.addEventListener('keydown', handleShiftTab, { capture: true });
    return () => document.removeEventListener('keydown', handleShiftTab, { capture: true });
  }, [active, cyclePermissionMode]);

  // Send message - defined before handleKeyDown to avoid circular dependency
  // Note: isLoading guard removed to allow queuing messages while AI is responding
  const bypassRepetitionRef = useRef(false);
  const handleSend = useCallback(async () => {
    // IME composition can lag behind React's KeyboardEvent flags on macOS
    // WebView. Do not let button-click or stale-keydown paths submit while
    // the textarea is still in an active composition.
    if (updateLockedRef.current || isComposingRef.current) return;

    const text = inputValue.trim();
    if (!text && images.length === 0) return;
    if (onSlashAction && images.length === 0 && text.startsWith('/')) {
      const actionName = resolveClientActionName(text, enabledClientActionCommands);
      if (actionName) {
        if (showConfigLockedReason()) return;
        setInputValue('');
        setShowSlashMenu(false);
        setSlashPosition(null);
        onSlashAction(actionName);
        return;
      }
    }

    // Prevent double-fire (rapid Enter + click, or concurrent async sends).
    // Must run BEFORE consuming `bypassRepetitionRef` so a confirm-during-
    // in-flight-send doesn't silently swallow the bypass and force the user
    // to re-confirm on retry.
    if (sendingRef.current) return;

    // Bug #123: gate dramatic IME-style content duplication behind a
    // ConfirmDialog. The textarea-side mitigation (skip resize during
    // composition) reduces the trigger but can't deterministically prevent
    // the WebKit/IME bug, so the input layer also catches the symptom
    // before a 77K-char message goes out.
    if (!bypassRepetitionRef.current) {
      const repeatCount = detectExcessiveRepetition(text);
      if (repeatCount > 0) {
        setRepetitionWarning({ text, images: [...images], count: repeatCount });
        return;
      }
    }
    bypassRepetitionRef.current = false;

    sendingRef.current = true;

    // The user may switch to a text-only model after attaching an image.
    // Sidecar owns conversion; this surface only reports when the effective
    // image-understanding fallback is unavailable.
    if (
      images.length > 0 &&
      !isExternalRuntime &&
      !modelSupportsModality(provider, currentModelId, 'image')
    ) {
      notifyUnsupportedImageFallback();
    }

    try {
      // Delegate thought-mode persistence to the caller (Launcher
      // BrandSection owns `thoughtCreate` + refresh-key bump). The
      // boolean-return protocol (`return true` = saved, clear textarea)
      // lets the parent signal when to reset input state here.
      const mentions = activeAgentSnapshots(text, agentMentions);
      const result = mentions.length || primaryContext || requiredSystemSkill
        ? onSend(text, images.length > 0 ? images : undefined, undefined, { agentMentions: mentions, primaryContext, requiredSystemSkill })
        : onSend(text, images.length > 0 ? images : undefined);
      // If onSend returns a promise, await it; if sync, use directly
      const accepted = result instanceof Promise ? await result : result;
      // Only clear input if not explicitly rejected (false)
      if (accepted !== false) {
        // Admission may take time. Clear the submitted draft only if the user
        // has not started the next one while awaiting the response.
        if (inputValueRef.current === inputValue) {
          setInputValue('');
          setAgentMentions([]);
          setPrimaryContext(undefined);
          setRequiredSystemSkill(undefined);
        }
        const submitted = new Set(images.map(image => image.id));
        setImages(current => current.filter(image => !submitted.has(image.id)));
      }
    } finally {
      sendingRef.current = false;
    }
  }, [onSend, images, inputValue, agentMentions, primaryContext, requiredSystemSkill, provider, currentModelId, isExternalRuntime, setImages, onSlashAction, enabledClientActionCommands, showConfigLockedReason, notifyUnsupportedImageFallback, setInputValue]);

  // Handle keyboard navigation in file search and slash menu
  // Handler for selecting a slash command — shared by the click path
  // (`onSelect`) and the keyboard path (Enter/Tab in `handleKeyDown`). Defined
  // above `handleKeyDown` so the latter can reference it without a TDZ.
  //
// Client-action builtins (e.g. /goal) strip the typed `/fragment` and
// dispatch a renderer-side action via `onSlashAction` instead of inserting
// text — the action (opening the Goal panel) owns what happens next, and the
  // task content is entered into the input afterwards. Everything else inserts
  // `/name ` as before.
  const handleSlashSelect = useCallback((cmd: SlashCommand) => {
    if (slashPosition === null) return;
    if (onSlashAction && isClientActionCommand(cmd) && showConfigLockedReason()) {
      setShowSlashMenu(false);
      setSlashPosition(null);
      return;
    }
    const before = inputValue.slice(0, slashPosition);
    const after = inputValue.slice(textareaRef.current?.selectionStart || slashPosition + slashSearchQuery.length + 1);

    if (onSlashAction && isClientActionCommand(cmd)) {
      setInputValue(`${before}${after}`);
      setShowSlashMenu(false);
      setSlashPosition(null);
      onSlashAction(resolveClientActionName(cmd.name, enabledClientActionCommands) ?? cmd.name);
      return;
    }

    handleSkillSelect(cmd);
    setInputValue(`${before}/${cmd.invocationName ?? cmd.name} ${after}`);
    setShowSlashMenu(false);
    setSlashPosition(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- textareaRef is a stable ref
  }, [slashPosition, inputValue, slashSearchQuery, handleSkillSelect, onSlashAction, enabledClientActionCommands, showConfigLockedReason]);

  const visibleSuggestion = !isLauncherMode && active && canSendMessage && !isLoading
    && sessionState !== 'starting' && sessionState !== 'running' && sessionState !== 'stopping' && sessionState !== 'error'
    && !isComposing && !inputValue && !images.length && !showSlashMenu && !showFileSearch && !repetitionWarning
    && nextPromptSuggestion?.sessionId === sessionId && nextPromptSuggestion.key !== dismissedSuggestionKey
    ? nextPromptSuggestion.text : null;

  const handleKeyDown = useCallback(async (event: React.KeyboardEvent<HTMLElement>) => {
    // Candidate confirmation/navigation belongs to IME before slash/@ menus,
    // permission shortcuts, or message sending can interpret the same key.
    if (isComposingRef.current || isImeComposingEvent(event)) return;
    // A held acceptance key must never turn the accepted draft into a send.
    if (event.key === 'Enter' && event.repeat) { event.preventDefault(); return; }
    if (visibleSuggestion && event.key === 'Escape') {
      event.preventDefault();
      setDismissedSuggestionKey(nextPromptSuggestion!.key);
      return;
    }
    if (visibleSuggestion && event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      setDismissedSuggestionKey(nextPromptSuggestion!.key);
      setInputValue(visibleSuggestion);
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        textarea?.focus();
        textarea?.setSelectionRange(visibleSuggestion.length, visibleSuggestion.length);
      });
      return;
    }
    // Shift+Tab to cycle permission mode
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault();
      cyclePermissionMode();
      return;
    }

    // Cmd+Z (Mac) or Ctrl+Z (Windows) to undo file reference insertion
    if ((event.metaKey || event.ctrlKey) && event.key === 'z' && !event.shiftKey) {
      const action = undoStack.peek();
      if (action?.type === 'file-reference') {
        event.preventDefault();

        // Pop all actions in the same batch (multi-file drop)
        const batchActions = undoStack.popBatch();
        if (batchActions.length === 0) return;

        // Remove all @references from input
        let newInputValue = inputValue;
        for (const a of batchActions) {
          if (newInputValue.includes(a.insertedText)) {
            newInputValue = newInputValue.replace(a.insertedText, '');
          }
        }
        setInputValue(newInputValue);

        // Delete all copied files (PRD 0.2.7: Rust cmd_workspace_delete).
        if (fileService.isAvailable) {
          let successCount = 0;
          let failCount = 0;

          for (const a of batchActions) {
            try {
              // permanent: scratch cleanup of a file WE just copied in — the
              // user never saw it as workspace content; routing it through
              // the OS trash (the new default) would just pollute the trash.
              await fileService.deleteFile({
                path: a.copiedFilePath,
                permanent: true,
              });
              successCount++;
            } catch {
              failCount++;
            }
          }

          // Show appropriate message
          if (failCount === 0) {
            toastRef.current.success(t('input.undoFilesAdded', { count: successCount }));
          } else if (successCount > 0) {
            toastRef.current.warning(t('input.undoFilesPartial', { successCount, failCount }));
          } else {
            toastRef.current.warning(t('input.undoReferenceOnly'));
          }
        }
        return;
      }
      // If no file reference in undo stack, let browser handle default undo
    }

    // Slash menu navigation (filteredSlashCommands computed via useMemo at component level)
    if (showSlashMenu && filteredSlashCommands.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedSlashIndex((i) => Math.min(i + 1, filteredSlashCommands.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedSlashIndex((i) => Math.max(i - 1, 0));
        return;
      }
      // Tab or Enter to select
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        // `stopPropagation` — when the slash menu consumes Tab for
        // autocomplete, prevent the event from reaching window-level
        // handlers (e.g. the Launcher `BrandSection`'s mode toggle).
        // Without this, Tab would both autocomplete AND toggle the
        // segment, a double-effect. React's `stopPropagation` also
        // stops the underlying native bubble, so the window listener
        // truly won't fire.
        event.stopPropagation();
        const selected = filteredSlashCommands[selectedSlashIndex];
        if (selected) {
          // Single dispatch point shared with the click path — also handles
          // client-action commands (e.g. /goal) vs plain text insertion.
          handleSlashSelect(selected);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowSlashMenu(false);
        setSlashPosition(null);
        return;
      }
    }

    if (showFileSearch) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); mentionPicker.move(event.key === 'ArrowDown' ? 1 : -1); return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault(); event.stopPropagation();
        const option = mentionPicker.allOptions.find(item => item.key === mentionPicker.selectedKey);
        if (option) chooseMention(option);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault(); setShowFileSearch(false); setAtPosition(null); textareaRef.current?.focus(); return;
      }
    }

    // Chat-mode keyboard contract is now user-configurable via the
    // chatSendShortcut preference (resolveEnterKeyAction, shared with AI 小助理 /
    // 问题反馈). 'enter' → bare Enter sends; 'modEnter' → ⌘/Ctrl+Enter sends.
    if (event.key === 'Enter') {
      if (resolveEnterKeyAction(event, sendShortcutRef.current) === 'send') {
        event.preventDefault();
        if ((inputValue.trim() || images.length > 0) && canSendMessageRef.current) {
          handleSend();
        }
      }
      // 'newline' → fall through, the browser inserts the newline.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- textareaRef is stable
  }, [cyclePermissionMode, undoStack, fileService, showSlashMenu, filteredSlashCommands, slashSearchQuery, selectedSlashIndex, slashPosition, showFileSearch, mentionPicker, chooseMention, inputValue, atPosition, fileSearchQuery, images.length, handleSend, handleSkillSelect, handleSlashSelect, visibleSuggestion, nextPromptSuggestion]);

  const visibleGoal = !isLauncherMode ? sessionGoal : null;
  const goalDraftFromCronConfig = cronModeEnabled
    && !cronTask
    && cronConfig?.taskKind === 'goal';
  const showDraftGoalBar = (goalDraftActive || goalDraftFromCronConfig) && !visibleGoal;
  const showDraftCronBar = cronModeEnabled
    && !cronTask
    && cronConfig?.taskKind === 'cron'
    && !visibleGoal
    && !showDraftGoalBar;
  const activeCronTask = !isLauncherMode && cronTask?.status === 'running' && cronTask.runMode !== 'new_session'
    ? cronTask
    : null;
  const visibleStoppedCronTask = !isLauncherMode
    ? stoppedCronTask
    : null;
  const hasStatusBar = showDraftGoalBar || showDraftCronBar || !!visibleGoal || !!activeCronTask || !!visibleStoppedCronTask;

  return (
    <>
    <div ref={overlayRootRef} className={isLauncherMode
      ? 'relative flex w-full justify-center'
      : 'pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center px-4 pb-4'
    }>
      {/* Gradient fade overlay (chat mode only) */}
      {!isLauncherMode && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-32"
          style={{
            // #333: same-color 0-alpha endpoint, never the `transparent` keyword (see index.css --*-a0)
            background: 'linear-gradient(to bottom, var(--paper-elevated-a0), var(--paper-elevated) 60%)'
          }}
        />
      )}

      {/* Floating panel row above the input — hosts AgentStatusPanel (Todo
          badge) on the left and QueuedMessagesPanel on the right. They used
          to render independently with overlapping z-20 / similar Y, which
          let the queue paint over the Todo badge. Now they're siblings in
          one flex row: the Todo card carries `[&:not(:only-child)]:mr-auto`
          so it self-pushes left when queue is present, and stays right
          (justify-end) when alone. `items-end` bottom-aligns the two cards
          (a single-row Todo bar sits slightly higher than the queue card —
          natural heights kept so an expanded AgentStatusPanel doesn't
          stretch the queue card into a mostly-empty tall panel). `empty:hidden`
          collapses the row + mb-2 gap when both children render null (no
          agent activity + no queue).
          The row sits OUTSIDE the input container (sibling, not child) so
          its `pointer-events-none` lets empty space fall all the way through
          to chatContentRef where the message list lives — otherwise the
          ancestor `pointer-events-auto` input container would catch the
          click and block message selection (Codex review). Cards themselves
          override with `pointer-events-auto`. */}
      {!isLauncherMode && (
        <div className="pointer-events-none mb-2 flex w-full max-w-3xl items-end justify-end gap-2 empty:hidden">
          {agentStatusSlot}
          {queuedMessages.length > 0 && (
            <QueuedMessagesPanel
              messages={queuedMessages}
              onCancel={(queueId) => onCancelQueued?.(queueId)}
              onForceExecute={(queueId) => onForceExecuteQueued?.(queueId)}
            />
          )}
        </div>
      )}

      {/* Input container */}
      <div className={isLauncherMode
        ? 'relative w-full'
        : 'pointer-events-auto relative w-full max-w-3xl'
      }>
        {/* Cron task status bar — shown when cron mode is enabled but the task
         *  hasn't started yet. PRD 0.2.7 D1: launcher SHOULD show this so the
         *  user sees their staged cron config; the actual cron creation happens
         *  after handoff to chat. Running current-session cron also stays here
         *  as a non-blocking bar so the composer remains usable. */}
        {showDraftCronBar && cronConfig && (
          <CronTaskStatusBar
            mode="draft"
            intervalMinutes={cronConfig.intervalMinutes}
            schedule={cronConfig.schedule}
            onSettings={() => onCronSettings?.()}
            onCancel={() => onCronCancel?.()}
          />
        )}
        {showDraftGoalBar && (
          <GoalStatusBar
            mode="draft"
            onSettings={() => goalDraftActive ? onGoalDraftSettings?.() : onCronSettings?.()}
            onCancel={() => goalDraftActive ? onGoalDraftCancel?.() : onCronCancel?.()}
          />
        )}
        {visibleGoal && (
          <GoalStatusBar
            goal={visibleGoal}
            isExecuting={goalIsExecuting}
            executionNumber={goalExecutionNumber}
            onEdit={onGoalEdit}
            onResume={onGoalResume}
            onCancel={onGoalCancel}
            onDismiss={onGoalDismiss}
          />
        )}
        {activeCronTask && (
          <CronTaskStatusBar
            mode={cronIsExecuting ? 'executing' : 'running'}
            intervalMinutes={activeCronTask.intervalMinutes}
            schedule={activeCronTask.schedule}
            executionCount={activeCronTask.executionCount}
            maxExecutions={activeCronTask.endConditions?.maxExecutions}
            nextExecutionAt={activeCronTask.nextExecutionAt}
            executionNumber={cronExecutionNumber}
            onStop={() => onCronStop?.()}
          />
        )}
        {visibleStoppedCronTask && (
          <CronTaskStatusBar
            mode="stopped"
            intervalMinutes={visibleStoppedCronTask.intervalMinutes}
            schedule={visibleStoppedCronTask.schedule}
            executionCount={visibleStoppedCronTask.executionCount}
            maxExecutions={visibleStoppedCronTask.endConditions?.maxExecutions}
            onDismissStopped={() => onCronDismissStopped?.()}
          />
        )}

        <div className={`relative border border-[var(--line)] bg-[var(--paper-elevated)] shadow-md ${
          hasStatusBar
            ? 'rounded-b-2xl rounded-t-none border-t-0'  // StatusBar visible: no top rounded, no top border
            : 'rounded-2xl'  // Normal: fully rounded
        }`}>
          {/* Clickable area for focus - covers input area but not toolbar */}
          <div
            className="cursor-text"
            onClick={(e) => {
              // Only focus if not clicking on a button or interactive element
              const target = e.target as HTMLElement;
              if (!target.closest('button') && !target.closest('input') && target.tagName !== 'TEXTAREA') {
                textareaRef.current?.focus();
              }
            }}
          >
          {/* Image attachments preview */}
          {images.length > 0 && (
            <div className="flex gap-2 px-4 pt-3 pb-1 overflow-x-auto">
              {images.map((img) => (
                <div key={img.id} className="relative group flex-shrink-0">
                  <button
                    type="button"
                    aria-label={imageAttachmentName(img)}
                    title={imageAttachmentName(img)}
                    onClick={() => openPreview(img.preview, imageAttachmentName(img))}
                    className="block h-16 w-16 cursor-pointer overflow-hidden rounded-lg border border-[var(--line)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2"
                  >
                    <img
                      src={img.preview}
                      alt="attachment"
                      className="h-full w-full object-cover"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeImage(img.id)}
                    className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-[var(--error)] text-[var(--on-error)] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    title={t('input.deleteImage')}
                  >
                    <CloseIcon className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Textarea area */}
          <div ref={textareaWrapperRef} className="relative px-4 pt-3">
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)]">
            {visibleSuggestion && (
              <div aria-hidden="true" data-testid="next-prompt-ghost" onMouseDown={event => { event.preventDefault(); textareaRef.current?.focus(); }} className="pointer-events-auto relative z-[1] col-start-1 row-start-1 min-w-0 whitespace-pre-wrap break-words text-base leading-relaxed text-[var(--ink-muted)]" style={{ maxHeight: `${LINE_HEIGHT * MAX_LINES}px`, overflowX: 'hidden', overflowY: 'auto', overscrollBehaviorY: 'contain' }}>
                {visibleSuggestion}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={inputValue}
              // Bug #123: lock the textarea while the repetition-warning
              // dialog is open. Without this, an IME composition during the
              // dialog window could mutate inputValue between detection and
              // the user's confirm click — the dialog would describe content
              // that no longer matches what handleSend reads.
              readOnly={!!repetitionWarning || updateLockedRef.current}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              aria-label={isLauncherMode ? t('input.launcherPlaceholder') : t('input.placeholder')}
              aria-describedby={visibleSuggestion ? 'next-prompt-hint-' + sessionId : undefined}
              placeholder={visibleSuggestion ? '' :
                isLauncherMode
                  ? t('input.launcherPlaceholder')
                  : t('input.placeholder')
              }
              rows={effectiveMinLines}
              className="col-start-1 row-start-1 block min-w-0 w-full resize-none bg-transparent text-base leading-relaxed text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)]"
              style={{
                minHeight: `${LINE_HEIGHT * effectiveMinLines}px`,
                maxHeight: `${LINE_HEIGHT * MAX_LINES}px`,
                // Wrapped prose never scrolls sideways. WebView page zoom can
                // leave a horizontal scrollbar when the implicit axis is auto.
                overflowX: 'hidden',
                overflowY: 'auto',
                // The auto-resize effect imperatively writes `style.height`
                // each keystroke; this transition smooths the visible
                // growth/shrink. List both `height` and `min-height` so
                // shrink animates symmetrically to grow (WebKit textareas
                // can drop the transition on shrink when only `height` is
                // listed).
                transitionProperty: 'height, min-height',
                transitionDuration: '220ms',
                transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
                willChange: 'height',
              }}
            />
            </div>
            {visibleSuggestion && <div id={'next-prompt-hint-' + sessionId} className="pt-1 text-xs text-[var(--ink-muted)]">{t('input.nextPrompt.acceptHint')}<span className="sr-only">{visibleSuggestion}</span></div>}
            {!isLauncherMode && active && nextPromptSuggestion?.unavailable && !inputValue && !isLoading && <div className="pt-1 text-xs text-[var(--ink-muted)]" title={t('input.nextPrompt.unavailableReason')}>{t('input.nextPrompt.unavailable')}</div>}

            <Popover open={showFileSearch} onClose={() => setShowFileSearch(false)} anchorRef={textareaWrapperRef}
              placement="top-start" offset={8} closeOnEscape={false}
              style={{ height: 'min(32rem, 65vh)', boxShadow: 'var(--shadow-md)' }}
              maxHeight="min(32rem, 65vh)" viewportPadding={{ top: 52, bottom: 8, left: 8, right: 8 }}
              className="flex w-[25.5rem] max-w-[calc(100vw-2rem)] flex-col">
              <MentionPicker localWorkspaceIcons={localWorkspaceIcons} picker={mentionPicker} query={fileSearchQuery} onChoose={chooseMention} onKeyDown={handleKeyDown} />
            </Popover>

            {/* /slash command popup. Same ownership pattern — textarea owns
                the keyboard (↑↓/Enter/Tab/Esc); the primitive just positions
                the content above the input.
                PRD 0.2.7: previously `!isLauncherMode && showSlashMenu` so the
                launcher could never open the menu. Now we rely on `showSlashMenu`
                — the typing handler controls when it opens, and it opens in
                both launcher and chat modes (workspace_files Rust commands
                power both). */}
            <Popover
              maxHeight="min(32rem, 65vh)"
              viewportPadding={{ top: 52, bottom: 8, left: 8, right: 8 }}
              className="overflow-y-auto"
              open={showSlashMenu}
              onClose={() => setShowSlashMenu(false)}
              anchorRef={textareaWrapperRef}
              placement="top-start"
              offset={8}
              closeOnEscape={false}
              style={{ boxShadow: 'var(--shadow-md)' }}
            >
              <SlashCommandMenu
                commands={filteredSlashCommands}
                selectedIndex={selectedSlashIndex}
                isEmpty={slashSearchQuery.length > 0 && filteredSlashCommands.length === 0}
                onSelect={handleSlashSelect}
              />
            </Popover>
          </div>
          </div>

          {/* Toolbar row — container query: hides text labels when narrow.
              In thought mode (PRD §4.2) the left-side action strip collapses so
              the input reads as a pure note-taking box; the right-side send
              button remains so users can commit the thought with a click. */}
          <div className="toolbar-menus flex items-center px-3 pb-2 pt-1 flex-nowrap min-w-0" style={{ containerType: 'inline-size' }}>
            {/* Left side - action buttons (hidden in thought mode). Uses
                `ml-auto` on the right group instead of `justify-between` so
                the send button stays right-aligned even when the left strip
                is removed from the flex flow. */}
            <div className="flex items-center gap-1 min-w-0 flex-nowrap">
              {/* Optional prefix (e.g., workspace selector in launcher mode) */}
              {toolbarPrefix}

              {/* Plus menu */}
              <button
                ref={plusBtnRef}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  // Close other menus first
                  setShowModeMenu(false);
                  setShowModelMenu(false);
                  setShowToolMenu(false);
                  setShowPlusMenu(!showPlusMenu);
                }}
                className="rounded-lg p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                title={t('input.addContext')}
              >
                <PlusIcon className="h-4 w-4" />
              </button>
              <Popover
                open={showPlusMenu}
                onClose={() => setShowPlusMenu(false)}
                anchorRef={plusBtnRef}
                placement="top-start"
                className="composer-toolbar-menu-enter w-48 py-1"
              >
                {/* PRD 0.2.7: previously gated by `!isLauncherMode`; both
                 *  launcher and chat-tab now route file ops through the
                 *  workspace_files Rust commands, so the launcher's plus menu
                 *  can offer 引用文件 / 使用技能 the same way. */}
                <button
                  type="button"
                  // This item moves focus to the textarea; preventDefault on mousedown stops
                  // the item itself from grabbing focus during the tap, which avoids the
                  // macOS WebKit focus-steal that drops the click (matching the menu-item /
                  // toolbar-button convention elsewhere).
                  onMouseDown={retainFocusOnMouseDown}
                  onClick={(e) => {
                    e.stopPropagation();
                    // Insert @ at cursor position and trigger file search
                    const textarea = textareaRef.current;
                    if (textarea) {
                      const cursorPos = textarea.selectionStart;
                      const before = inputValue.slice(0, cursorPos);
                      const after = inputValue.slice(cursorPos);
                      setInputValue(`${before}@${after}`);
                      setShowFileSearch(true);
                      setAtPosition(cursorPos);
                      setFileSearchQuery('');
                      textarea.focus();
                    }
                    setShowPlusMenu(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                >
                  <AtIcon className="h-4 w-4" />
                  {t('input.referenceFile')}
                </button>
                <button
                  type="button"
                  // Same focus-steal guard as 引用文件 above.
                  onMouseDown={retainFocusOnMouseDown}
                  onClick={(e) => {
                    e.stopPropagation();
                    // Insert / at cursor position and trigger slash menu
                    const textarea = textareaRef.current;
                    if (textarea) {
                      const cursorPos = textarea.selectionStart;
                      const before = inputValue.slice(0, cursorPos);
                      const after = inputValue.slice(cursorPos);
                      setInputValue(`${before}/${after}`);
                      setShowSlashMenu(true);
                      setSlashPosition(cursorPos);
                      setSlashSearchQuery('');
                      setSelectedSlashIndex(0);
                      textarea.focus();
                    }
                    setShowPlusMenu(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                >
                  <SlashCommandIcon className="h-4 w-4" />
                  {t('input.useSkill')}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleUploadButtonClick();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                >
                  <AttachIcon className="h-4 w-4" />
                  {t('input.uploadFile')}
                </button>
                {onCronButtonClick && (
                  <button
                    type="button"
                    aria-disabled={configControlsLocked}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (showConfigLockedReason()) return;
                      setShowPlusMenu(false);
                      onCronButtonClick();
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors ${
                      cronModeEnabled && !configControlsLocked
                        ? 'bg-[var(--heartbeat-bg)] text-[var(--heartbeat)] hover:bg-[var(--heartbeat)]/20'
                        : configControlsLocked
                          ? 'cursor-not-allowed text-[var(--ink-muted)] opacity-50 hover:bg-transparent'
                          : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
                    }`}
                    title={configControlLockTitle ?? (cronModeEnabled ? t('input.cronEnabled') : t('input.cron'))}
                  >
                    <TimerIcon className="h-4 w-4" />
                    {t('input.cron')}
                  </button>
                )}
              </Popover>

              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileChange}
              />

              {/* Mode Dropdown */}
              <button
                ref={modeBtnRef}
                type="button"
                aria-disabled={configControlsLocked}
                onClick={(e) => {
                  e.stopPropagation();
                  if (showConfigLockedReason()) return;
                  setShowModeMenu(!modeMenuOpen);
                  setShowModelMenu(false);
                  setShowPlusMenu(false);
                  setShowToolMenu(false);
                }}
                className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] ${
                  configControlsLocked ? 'cursor-not-allowed opacity-50 hover:bg-transparent hover:text-[var(--ink-muted)]' : ''
                }`}
                title={configControlLockTitle ?? t('input.permissionModeTitle')}
              >
                <PermissionModeIcon
                  value={currentModeDisplay?.value}
                  fallback={currentModeDisplay?.icon}
                  className="h-3.5 w-3.5 shrink-0"
                />
                <span className="toolbar-label">{currentModeDisplay?.label}</span>
                <ChevronUpIcon className="h-3 w-3" />
              </button>
              <Popover
                open={modeMenuOpen}
                onClose={() => setShowModeMenu(false)}
                anchorRef={modeBtnRef}
                placement="top-start"
                className="composer-toolbar-menu-enter w-72 py-1"
              >
                <PermissionModeMenuContent
                  items={displayPermissionModes.filter(m => !m.hidden)}
                  selectedValue={permissionMode}
                  header={t('input.permissionModeHeader')}
                  headerAction={onOpenAgentSettings ? {
                    label: t('input.agentSettings'),
                    onClick: () => {
                      setShowModeMenu(false);
                      onOpenAgentSettings();
                    },
                  } : undefined}
                  onSelect={(value) => {
                    if (value === 'fullAgency' || value === 'bypassPermissions' || value === 'full-autonomous') {
                      toastRef.current.warning(t(runtime === 'dsh' ? 'input.dshAutonomyWarning' : 'input.autonomyWarning'), 5000);
                    }
                    onPermissionModeChange?.(value as PermissionMode);
                    setShowModeMenu(false);
                  }}
                />
              </Popover>

              {/* Tool/MCP Dropdown */}
              <>
              <button
                ref={toolBtnRef}
                type="button"
                aria-disabled={configControlsLocked}
                onClick={(e) => {
                  e.stopPropagation();
                  if (showConfigLockedReason()) return;
                  setShowToolMenu(!toolMenuOpen);
                  setShowModeMenu(false);
                  setShowModelMenu(false);
                  setShowPlusMenu(false);
                }}
                className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] ${
                  configControlsLocked ? 'cursor-not-allowed opacity-50 hover:bg-transparent hover:text-[var(--ink-muted)]' : ''
                }`}
                title={configControlLockTitle ?? t('input.toolsTitle')}
              >
                <WrenchIcon className="h-3.5 w-3.5" />
                <span className="toolbar-label">{t('input.toolsLabel')}</span>
                {enabledToolEntryCount > 0 && (
                  <span className="text-xs text-[var(--ink-muted)]">
                    {enabledToolEntryCount}
                  </span>
                )}
              </button>
              <Popover
                open={toolMenuOpen}
                onClose={() => setShowToolMenu(false)}
                anchorRef={toolBtnRef}
                placement="top-start"
                // max-h + overflow-y-auto so a workspace with 13+ enabled
                // plugins (anthropics/claude-for-legal etc.) doesn't blow
                // past the viewport top. 50vh shows ~6 full rows AND
                // half-clips the next one — the partial row is the
                // affordance that tells the user "scroll for more".
                maxHeight="50vh" className="composer-toolbar-menu-enter w-64 overflow-y-auto py-1"
              >
                    <div className="px-3 py-2 text-xs font-medium text-[var(--ink-muted)] border-b border-[var(--line)]">
                      {t('input.toolsHeader')}
                    </div>
                    {!isExternalRuntime && <BrowserToolEntry
                      available={globalMcpEnabled.includes(MANAGED_BROWSER_MCP_ID)}
                      selected={workspaceMcpEnabled.includes(MANAGED_BROWSER_MCP_ID)}
                      effective={mcpServerState(mcpEffectiveSnapshot, MANAGED_BROWSER_MCP_ID)}
                      stale={mcpEffectiveSnapshot?.observationStale}
                      busy={isLoading}
                      onToggle={onWorkspaceMcpToggle}
                      onRetry={onMcpRetry}
                      onSetup={() => {
                        setShowToolMenu(false);
                        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, { detail: { section: 'mcp', mcpServerId: MANAGED_BROWSER_MCP_ID } }));
                      }}
                    />}
                    {visibleOfficialTools.length > 0 || externalMcpServers.length > 0 || (!isExternalRuntime && mcpServers.some(s => globalMcpEnabled.includes(s.id))) ? (
                      <>
                      {visibleOfficialTools.map((tool) => {
                        const isEnabled = workspaceOfficialToolEnabled.includes(tool.id);
                        return (
                          <div
                            key={tool.id}
                            className="flex items-center justify-between px-3 py-2"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-[var(--ink)] truncate">
                                {tool.name}
                              </div>
                              {tool.description && (
                                <div className="text-xs text-[var(--ink-muted)] truncate">
                                  {tool.description}
                                </div>
                              )}
                            </div>
                            <button
                              type="button"
                              title={t('input.settings')}
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowToolMenu(false);
                                window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
                                  detail: { section: 'mcp', officialToolId: tool.id },
                                }));
                              }}
                              className="ml-2 shrink-0 rounded p-0.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                            >
                              <SlidersIcon className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onWorkspaceOfficialToolToggle?.(tool.id, !isEnabled);
                              }}
                              className={`relative ml-2 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors hover:opacity-80 focus:outline-none ${isEnabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
                                }`}
                            >
                              <span
                                className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm ring-0 transition-transform ${isEnabled ? 'translate-x-4' : 'translate-x-0.5'
                                  }`}
                              />
                            </button>
                          </div>
                        );
                      })}
                      {isExternalRuntime && externalMcpServers.map((server) => (
                        <div
                          key={server.id}
                          className="px-3 py-2"
                        >
                          <div className="text-sm font-medium text-[var(--ink)] truncate">
                            {server.name}
                          </div>
                          {server.description && (
                            <div className="text-xs text-[var(--ink-muted)] truncate">
                              {server.description}
                            </div>
                          )}
                          {mcpEffectiveSnapshot && (() => {
                            const effective = mcpServerState(mcpEffectiveSnapshot, server.id);
                            if (!effective || !hasMcpStatusNotice(effective.state)) return null;
                            return (
                              <McpStatusNotice server={effective} stale={mcpEffectiveSnapshot.observationStale} busy={isLoading} onRetry={onMcpRetry} />
                            );
                          })()}
                        </div>
                      ))}
                      {mcpServers
                        .filter(s => !isExternalRuntime && s.id !== MANAGED_BROWSER_MCP_ID && globalMcpEnabled.includes(s.id))
                        .map((server) => {
                          const isEnabled = workspaceMcpEnabled.includes(server.id);
                          const effective = mcpServerState(mcpEffectiveSnapshot, server.id);
                          return (
                            <div
                              key={server.id}
                              className="flex items-center justify-between px-3 py-2"
                            >
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium text-[var(--ink)] truncate">
                                  {server.name}
                                </div>
                                {server.description && (
                                  <div className="text-xs text-[var(--ink-muted)] truncate">
                                    {server.description}
                                  </div>
                                )}
                                {isEnabled && effective && hasMcpStatusNotice(effective.state) && (
                                  <McpStatusNotice server={effective} stale={mcpEffectiveSnapshot?.observationStale} busy={isLoading} onRetry={onMcpRetry} />
                                )}
                              </div>
                              {hasUserEditableMcpSettings(server.id) && (
                                <button
                                  type="button"
                                  title={t('input.settings')}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setShowToolMenu(false);
                                    window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, { detail: { section: 'mcp', mcpServerId: server.id } }));
                                  }}
                                  className="ml-2 shrink-0 rounded p-0.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                >
                                  <SlidersIcon className="h-3.5 w-3.5" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onWorkspaceMcpToggle?.(server.id, !isEnabled);
                                }}
                                className={`relative ml-2 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors hover:opacity-80 focus:outline-none ${isEnabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
                                  }`}
                              >
                                <span
                                  className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm ring-0 transition-transform ${isEnabled ? 'translate-x-4' : 'translate-x-0.5'
                                    }`}
                                />
                              </button>
                            </div>
                          );
                        })}
                      </>
                    ) : (
                      <div className="px-3 py-3 text-sm text-[var(--ink-muted)]">
                        {t('input.toolsEmptyPrefix')}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowToolMenu(false);
                            // Dispatch custom event to open Settings with MCP section
                            window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, { detail: { section: 'mcp' } }));
                          }}
                          className="mx-1 text-[var(--accent)] hover:underline"
                        >
                          {t('input.settingsPage')}
                        </button>
                        {isExternalRuntime
                          ? t('input.toolsEmptyExternal')
                          : t('input.toolsEmptyBuiltin')}
                      </div>
                    )}

                    {!isExternalRuntime && (
                    <>
                    {/* PRD 0.2.17 — Claude Plugins section. Mirrors the MCP
                     *  block above (same toggle UI, same per-workspace
                     *  semantics). Only globally-visible plugins appear here
                     *  (AppConfig.enabledPlugins gate done server-side via
                     *  the globallyVisiblePlugins prop). Toggling calls
                     *  onWorkspacePluginToggle which writes to the Agent +
                     *  pushes a session override to the sidecar. */}
                    {/* Plugin section header always renders (even when zero
                     *  plugins installed) so the feature is discoverable —
                     *  the empty-state hint doubles as onboarding pointing
                     *  to Settings → Plugins. Matches the MCP empty-state
                     *  pattern above for visual symmetry. */}
                    <div className="px-3 py-2 mt-1 text-xs font-medium text-[var(--ink-muted)] border-t border-[var(--line)] border-b border-[var(--line)] bg-[var(--paper-inset)]/40">
                      {t('input.pluginsHeader')}
                    </div>
                    {globallyVisiblePlugins.length > 0 ? (
                      globallyVisiblePlugins.map((plugin) => {
                        const isEnabled = workspaceEnabledPlugins.includes(plugin.id);
                        return (
                          <div
                            key={plugin.id}
                            className="flex items-center justify-between px-3 py-2"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-[var(--ink)] truncate">
                                {plugin.name}
                              </div>
                              {plugin.description && (
                                <div className="text-xs text-[var(--ink-muted)] truncate">
                                  {plugin.description}
                                </div>
                              )}
                              {plugin.mcpServerNames && plugin.mcpServerNames.length > 0 && (
                                <div
                                  className="mt-0.5 text-xs text-[var(--ink-muted)] truncate"
                                  title={t('input.pluginLoadsMcpTitle', { names: plugin.mcpServerNames.join(', ') })}
                                >
                                  🔌 {t('input.pluginLoadsMcp', { count: plugin.mcpServerNames.length, names: plugin.mcpServerNames.join(', ') })}
                                </div>
                              )}
                            </div>
                            <button
                              type="button"
                              title={t('input.managePlugins')}
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowToolMenu(false);
                                window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, { detail: { section: 'plugins' } }));
                              }}
                              className="ml-2 shrink-0 rounded p-0.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                            >
                              <SlidersIcon className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onWorkspacePluginToggle?.(plugin.id, !isEnabled);
                              }}
                              className={`relative ml-2 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors hover:opacity-80 focus:outline-none ${isEnabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
                                }`}
                            >
                              <span
                                className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm ring-0 transition-transform ${isEnabled ? 'translate-x-4' : 'translate-x-0.5'
                                  }`}
                              />
                            </button>
                          </div>
                        );
                      })
                    ) : (
                      <div className="px-3 py-3 text-sm text-[var(--ink-muted)]">
                        {t('input.noPluginsPrefix')}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowToolMenu(false);
                            window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, { detail: { section: 'plugins' } }));
                          }}
                          className="mx-1 text-[var(--accent)] hover:underline"
                        >
                          {t('input.pluginsSettings')}
                        </button>
                        {t('input.noPluginsSuffix')}
                      </div>
                    )}
                    </>
                    )}
              </Popover>
              </>

            </div>

            {/* Right side - model selector + send/stop button */}
            <div className="ml-auto flex items-center gap-2 shrink-0">
              {/* PRD 0.2.32 — context 用量指示器（自取数 slot，model 按钮左侧） */}
              {contextIndicator}
              {/* Model Dropdown with Provider Selector */}
              <button
                ref={modelBtnRef}
                type="button"
                aria-disabled={configControlsLocked}
                onClick={(e) => {
                  e.stopPropagation();
                  if (showConfigLockedReason()) return;
                  const willOpen = !modelMenuOpen;
                  setShowModelMenu(willOpen);
                  setShowModeMenu(false);
                  setShowPlusMenu(false);
                  setShowToolMenu(false);
                  // Refresh providers data when opening menu
                  if (willOpen && onRefreshProviders) {
                    onRefreshProviders();
                  }
                }}
                className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] ${
                  configControlsLocked ? 'cursor-not-allowed opacity-50 hover:bg-transparent hover:text-[var(--ink-muted)]' : ''
                }`}
                title={configControlLockTitle ?? t('input.switchModel')}
              >
                <span className="max-w-[140px] truncate">{currentModelName}</span>
                <ChevronUpIcon className="h-3 w-3 shrink-0" />
              </button>
              {/* The model list scrolls independently; the effort flyout uses
                  its own Popover to escape this menu's overflow boundary. */}
              <Popover
                open={modelMenuOpen}
                onClose={() => setShowModelMenu(false)}
                anchorRef={modelBtnRef}
                placement="top-end"
                className="w-64"
              >
                <div
                  ref={modelListRef}
                  data-model-list
                  className="relative max-h-[260px] overflow-y-auto py-1"
                >
                {isExternalRuntime && runtimeModels ? (
                  <>
                    <div className="px-3 pb-0.5 pt-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60">
                      {t('input.runtimeModelHeader', {
                        runtime: runtime === 'claude-code' ? 'CLAUDE CODE' : runtime?.toUpperCase(),
                      })}
                    </div>
                    {runtimeModels.map(model => {
                      const isSelected = selectedModel === model.value || (!selectedModel && model.isDefault);
                      return (
                        <button
                          ref={isSelected ? selectedModelRowRef : undefined}
                          data-selected-model-row={isSelected ? '' : undefined}
                          key={model.value}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onModelChange?.(model.value);
                            setShowModelMenu(false);
                          }}
                          className={`w-full rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
                            isSelected
                              ? 'bg-[var(--accent)]/10 font-medium text-[var(--accent)]'
                              : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]'
                          }`}
                        >
                          {model.displayName}
                        </button>
                      );
                    })}
                  </>
                ) : (() => {
                  const availableProviders = availableProviderIdSet
                    ? (providers ?? []).filter(p => availableProviderIdSet.has(p.id))
                    : (providers ?? []).filter(p => isProviderAvailable(p, apiKeys, providerVerifyStatus));
                  if (availableProviders.length === 0) {
                    return (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowModelMenu(false);
                          window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
                            detail: { section: 'providers' }
                          }));
                        }}
                        className="w-full px-3 py-2.5 text-left text-sm text-[var(--accent)] transition-colors hover:bg-[var(--hover-bg)]"
                      >
                        {t('input.setupModelProvider')}
                      </button>
                    );
                  }
                  return availableProviders.map((p, idx) => (
                    <div key={p.id}>
                      {idx > 0 && <div className="mx-2 my-1 border-t border-[var(--line)]" />}
                      <div className="group/provider relative flex items-center gap-1 px-3 pb-0.5 pt-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60">
                        {p.name}
                        {isProviderWarning(p, apiKeys, providerVerifyStatus) && (
                          <Tip label={t('input.providerWarning')} position="bottom">
                            <AlertIcon className="h-3 w-3 shrink-0 text-[var(--warning)]" />
                          </Tip>
                        )}
                      </div>
                      {p.models.map(model => {
                        const isSelected = provider?.id === p.id && currentModelId === model.model;
                        return (
                          <button
                            ref={isSelected ? selectedModelRowRef : undefined}
                            data-selected-model-row={isSelected ? '' : undefined}
                            key={model.model}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (onBuiltinModelSelect) {
                                onBuiltinModelSelect({ providerId: p.id, model: model.model });
                              } else if (provider?.id !== p.id) {
                                onProviderChange?.(p.id, model.model);
                              } else {
                                onModelChange?.(model.model);
                              }
                              setShowModelMenu(false);
                            }}
                            className={`flex w-full items-center rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
                              isSelected
                                ? 'bg-[var(--accent)]/10 font-medium text-[var(--accent)]'
                                : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]'
                            }`}
                          >
                            <span className="truncate">{model.modelName}</span>
                            <ModalityBadges modalities={model.inputModalities} className="ml-2" />
                          </button>
                        );
                      })}
                    </div>
                  ));
                })()}
                </div>
                <ModelSelectionScrollSync
                  listRef={modelListRef}
                  selectedRowRef={selectedModelRowRef}
                  selectionKey={isExternalRuntime
                    ? `${runtime ?? 'external'}:${selectedModel ?? 'default'}`
                    : `${provider?.id ?? 'none'}:${currentModelId ?? 'none'}`}
                  modelSource={isExternalRuntime ? runtimeModels : providers}
                />

                {/* #324 — fixed bottom row: 推理强度. Hidden when the surface has
                    no effort knob (unknown runtime). Hover or click
                    opens the flyout; selection closes the whole menu. */}
                {effortChoices && (
                  <div
                    ref={effortRowWrapRef}
                    className="relative border-t border-[var(--line)] p-1"
                    onMouseEnter={openEffortSubmenu}
                    onMouseLeave={scheduleCloseEffortSubmenu}
                  >
                    <button
                      type="button"
                      aria-expanded={showEffortSubmenu}
                      onClick={(e) => {
                        e.stopPropagation();
                        // Pointer entry may already have opened the flyout.
                        openEffortSubmenu();
                      }}
                      className={`flex w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-left text-sm text-[var(--ink)] transition-colors ${
                        showEffortSubmenu ? 'bg-[var(--hover-bg)]' : 'hover:bg-[var(--hover-bg)]'
                      }`}
                    >
                      <GaugeIcon className="h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]" />
                      <span className="flex-1">{t('input.reasoningEffort')}</span>
                      <span className={`text-xs ${
                        reasoningEffort !== REASONING_EFFORT_DEFAULT
                          ? 'font-medium text-[var(--accent)]'
                          : 'text-[var(--ink-muted)]'
                      }`}>
                        {reasoningEffort === REASONING_EFFORT_DEFAULT ? defaultEffortLabel : reasoningEffort}
                      </span>
                      <ChevronRightIcon className="h-3 w-3 shrink-0 text-[var(--ink-muted)]" />
                    </button>

                    <Popover
                      open={modelMenuOpen && showEffortSubmenu}
                      onClose={() => setShowEffortSubmenu(false)}
                      anchorRef={effortRowWrapRef}
                      placement="right-end"
                      fallbackAxisSideDirection="start"
                      offset={6}
                      // Parent Popover must not dismiss on option mousedown.
                      zIndex={261}
                      className="w-56 max-w-[calc(100vw-16px)]"
                      onMouseEnter={openEffortSubmenu}
                      onMouseLeave={scheduleCloseEffortSubmenu}
                    >
                      <div
                        role="group"
                        aria-label={t('input.reasoningEffort')}
                        className="p-1"
                      >
                        {[REASONING_EFFORT_DEFAULT, ...effortChoices].map(level => {
                          const isSelected = reasoningEffort === level;
                          const description = managedEffort
                            ? effortModel?.supportedReasoningEfforts?.find(option => option.reasoningEffort === level)?.description ?? ''
                            : REASONING_EFFORT_DESCRIPTIONS[level] ?? '';
                          return (
                            <button
                              key={level}
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onReasoningEffortChange?.(level);
                                setShowEffortSubmenu(false);
                                setShowModelMenu(false);
                              }}
                              className={`flex w-full items-center justify-between rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
                                isSelected
                                  ? 'bg-[var(--accent)]/10 font-medium text-[var(--accent)]'
                                  : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]'
                              }`}
                            >
                              <span className="shrink-0">{level === REASONING_EFFORT_DEFAULT ? defaultEffortLabel : level}</span>
                              <span title={description} className={`ml-3 min-w-0 truncate text-xs font-normal ${isSelected ? 'text-[var(--accent)]/70' : 'text-[var(--ink-muted)]'}`}>
                                {description}
                              </span>
                            </button>
                          );
                        })}
                        <div hidden={managedEffort} className="mt-1 border-t border-[var(--line)] px-3 pb-1 pt-1.5 text-xs text-[var(--ink-muted)]/60">
                          {t('input.reasoningRequirement')}
                        </div>
                      </div>
                    </Popover>
                  </div>
                )}

                {!isExternalRuntime && (
                  <div className="border-t border-[var(--line)] p-1">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowModelMenu(false);
                        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
                          detail: { section: 'providers' },
                        }));
                      }}
                      className="flex w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-left text-sm text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)]"
                    >
                      <SlidersIcon className="h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]" />
                      <span className="flex-1">{t('input.customModelService')}</span>
                      <ChevronRightIcon className="h-3 w-3 shrink-0 text-[var(--ink-muted)]" />
                    </button>
                  </div>
                )}
              </Popover>

              {/* Button states:
                  - genuinely-uninterruptible system task (compacting…) → disabled Send
                  - stop in progress → disabled spinner
                  - AI responding OR api_retry backoff → Stop (interruptible — abort
                    wakes the SDK from its retry sleep cleanly; user shouldn't be
                    forced to wait through up to 10 exponentially-spaced retries)
                  - idle → Send
                  api_retry is split out of the systemStatus branch deliberately:
                  the original "any systemStatus → not interruptible" lumped retry
                  in with compacting, but unlike compacting, retry has no in-flight
                  SDK state to corrupt. */}
              {systemStatus && !systemStatus.startsWith('api_retry:') ? (
                // System task running (e.g., compacting) - not interruptible
                <button
                  type="button"
                  disabled
                  className="rounded-lg bg-[var(--ink-muted)]/15 p-2 text-[var(--ink-muted)]/60"
                  title={t('input.systemBusy')}
                >
                  <SendIcon className="h-4 w-4" />
                </button>
              ) : isLoading && sessionState === 'stopping' ? (
                // Stop in progress - waiting for confirmation
                <button
                  type="button"
                  disabled
                  className="rounded-lg bg-[var(--ink-muted)]/15 p-2 text-[var(--ink-muted)]"
                  title={t('input.stopping')}
                >
                  <LoaderIcon className="h-4 w-4 animate-spin" />
                </button>
              ) : isLoading || systemStatus?.startsWith('api_retry:') ? (
                // AI responding OR api_retry backoff - both can be stopped.
                // The `||` is double-coverage: in normal flow isLoading stays
                // true throughout the retry loop (no message-complete fires
                // until the turn ends), but if some future state machine path
                // flips isLoading false during retry, the systemStatus check
                // still keeps the stop button reachable.
                <button
                  type="button"
                  onClick={onStop}
                  className="rounded-lg bg-[var(--error)] p-2 text-[var(--on-error)] transition-colors hover:brightness-110"
                  title={systemStatus?.startsWith('api_retry:') ? t('input.stopRetry') : t('input.stop')}
                >
                  <StopIcon className="h-4 w-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!canSendMessage || (!inputValue.trim() && images.length === 0)}
                  className="rounded-lg bg-[var(--button-primary-bg)] p-2 text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:bg-[var(--ink-muted)]/15 disabled:text-[var(--ink-muted)]/60"
                  title={!canSendMessage
                    ? (providerUnavailableMessage ?? t('input.providerUnavailableDefault'))
                    : `${t('input.send')} (${sendKeyHint(sendShortcut, isMac).shortcut})`}
                >
                  <SendIcon className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
    {repetitionWarning && (
      <ConfirmDialog
        title={t('input.repetition.title')}
        message={t('input.repetition.message', {
          count: repetitionWarning.count,
          chars: repetitionWarning.text.length.toLocaleString(),
        })}
        confirmText={t('input.repetition.confirm')}
        cancelText={t('input.repetition.cancel')}
        confirmVariant="danger"
        // Bug #123: don't bind Enter to confirm — the user just pressed Enter
        // to trigger send, and a reflexive second Enter must not silently
        // confirm sending the duplicated payload. Click is required.
        disableEnterShortcut
        onConfirm={() => {
          setRepetitionWarning(null);
          bypassRepetitionRef.current = true;
          handleSend();
        }}
        onCancel={() => setRepetitionWarning(null)}
      />
    )}
    </>
  );
}));

export default SimpleChatInput;
