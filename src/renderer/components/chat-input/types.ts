import type React from 'react';

import type { SessionState } from '@/context/TabContext';
import type {
  PermissionMode,
  Provider,
  ProviderVerifyStatus,
} from '@/config/types';
import type { QueuedMessageInfo } from '@/types/queue';
import type { CronRunMode, CronSchedule, ScheduledTaskKind } from '@/types/cronTask';
import type { SessionGoal } from '@/types/sessionGoal';
import type { SlashCommand } from '../SlashCommandMenu';
import type { OfficialToolDefinition, OfficialToolId } from '../../../shared/official-tools';
import type {
  RuntimeModelInfo,
  RuntimePermissionMode,
  RuntimeType,
} from '../../../shared/types/runtime';
import type { McpEffectiveSnapshot } from '../../../shared/mcpEffectiveState';

export interface ImageAttachment {
  id: string;
  file: File;
  preview: string;
  source?: 'inline_base64' | 'attachment_ref';
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  relativePath?: string;
}

interface ScheduledTaskBarProjection {
  status?: 'running' | 'paused' | 'stopped' | 'completed';
  intervalMinutes: number;
  schedule?: CronSchedule;
  executionCount: number;
  lastExecutedAt?: string;
  nextExecutionAt?: string;
  prompt?: string;
  endConditions?: { maxExecutions?: number };
  runMode?: CronRunMode;
}

export interface SimpleChatInputProps {
  /** Exact main-window Tab owner for MoxBots update draft handoff. */
  composerTabId?: string;
  composerDiscussionId?: string;
  value?: string;
  onChange?: (value: string) => void;
  onSend: (
    text: string,
    images?: ImageAttachment[],
    permissionMode?: PermissionMode,
    context?: import("../../../shared/agentMentions").QueryMentionContext,
  ) => boolean | void | Promise<boolean | void>;
  active?: boolean;
  /** Blocks both keyboard and button send while the owning Session is not authoritative. */
  sendBlocked?: boolean;
  /** Optional, conversation-bound ghost text. It is never sent before acceptance. */
  nextPromptSuggestion?: import('@/hooks/useNextPromptSuggestion').NextPromptDraft;
  onStop?: () => void;
  isLoading: boolean;
  workspacePath?: string | null;
  sessionId?: string | null;
  sessionState?: SessionState;
  systemStatus?: string | null;
  agentDir?: string;
  provider?: Provider | null;
  providers?: Provider[];
  providerAvailable?: boolean;
  availableProviderIds?: string[];
  providerUnavailableMessage?: string;
  onProviderChange?: (providerId: string, targetModel?: string) => void;
  selectedModel?: string;
  onBuiltinModelSelect?: (selection: { providerId: string; model: string }) => void;
  onModelChange?: (modelId: string) => void;
  reasoningEffort?: string;
  onReasoningEffortChange?: (effort: string) => void;
  permissionMode?: PermissionMode;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  apiKeys?: Record<string, string>;
  providerVerifyStatus?: Record<string, ProviderVerifyStatus>;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  workspaceMcpEnabled?: string[];
  globalMcpEnabled?: string[];
  mcpServers?: Array<{ id: string; name: string; description?: string }>;
  /** MCP tools reported ready by the active external runtime. Read-only in this UI. */
  runtimeMcpTools?: string[];
  /** Runtime-owned MCP readiness; desired selection remains controlled separately. */
  mcpEffectiveSnapshot?: McpEffectiveSnapshot | null;
  onWorkspaceMcpToggle?: (serverId: string, enabled: boolean) => void;
  onMcpRetry?: (serverId: string) => Promise<import('../../../shared/mcpFailure').McpRetryResult>;
  officialTools?: readonly OfficialToolDefinition[];
  workspaceOfficialToolEnabled?: OfficialToolId[];
  globalOfficialToolEnabled?: OfficialToolId[];
  officialToolNeedsConfig?: Partial<Record<OfficialToolId, boolean>>;
  onWorkspaceOfficialToolToggle?: (toolId: OfficialToolId, enabled: boolean) => void;
  globallyVisiblePlugins?: Array<{
    id: string;
    name: string;
    description?: string;
    mcpServerNames?: string[];
  }>;
  workspaceEnabledPlugins?: string[];
  onWorkspacePluginToggle?: (pluginId: string, enabled: boolean) => void;
  onRefreshProviders?: () => void;
  onOpenAgentSettings?: () => void;
  /** Open the active Runtime's authoritative exact permission-rule inspector. */
  onWorkspaceRefresh?: () => void;
  cronModeEnabled?: boolean;
  cronConfig?: {
    taskKind: ScheduledTaskKind;
    intervalMinutes: number;
    schedule?: CronSchedule;
  } | null;
  goalDraftActive?: boolean;
  cronTask?: ScheduledTaskBarProjection | null;
  /** Current Session Goal. */
  sessionGoal?: SessionGoal | null;
  stoppedCronTask?: ScheduledTaskBarProjection | null;
  cronIsExecuting?: boolean;
  cronExecutionNumber?: number;
  goalIsExecuting?: boolean;
  goalExecutionNumber?: number;
  composerConfigLockedReason?: string;
  onCronButtonClick?: () => void;
  onCronSettings?: () => void;
  onCronCancel?: () => void;
  onGoalDraftSettings?: () => void;
  onGoalDraftCancel?: () => void;
  onCronStop?: () => void;
  onCronDismissStopped?: () => void;
  onGoalEdit?: () => void;
  onGoalResume?: () => void;
  onGoalCancel?: () => void;
  onGoalDismiss?: () => void;
  onSlashAction?: (name: string) => void;
  /** Additional runtime-specific renderer actions to inject into the slash menu. */
  clientActionSlashCommands?: SlashCommand[];
  /** Whether Claude Agent SDK system slash commands belong to this Session. */
  showBuiltinSdkSlashCommands?: boolean;
  /** Effective project Skill/Command winners supplied by the owning Chat tab. */
  workspaceSlashCommands?: SlashCommand[];
  sdkSlashCommands?: SlashCommand[];
  mode?: 'chat' | 'launcher';
  toolbarPrefix?: React.ReactNode;
  contextIndicator?: React.ReactNode;
  runtime?: RuntimeType;
  /** True only for user-managed CLI controls; Integrated DSH keeps Product provider/tool controls. */
  usesExternalRuntimeControls?: boolean;
  runtimeModels?: RuntimeModelInfo[];
  /** Session-scoped capability; null means still unknown (do not use Global catalog). */
  managedReasoningModel?: Pick<RuntimeModelInfo, 'supportedReasoningEfforts' | 'defaultReasoningEffort'> | null;
  runtimePermissionModes?: RuntimePermissionMode[];
  queuedMessages?: QueuedMessageInfo[];
  onCancelQueued?: (queueId: string) => void;
  onForceExecuteQueued?: (queueId: string) => void;
  agentStatusSlot?: React.ReactNode;
  onOverlayHeightChange?: (height: number) => void;
}

export interface SimpleChatInputHandle {
  processDroppedFiles: (files: File[]) => Promise<void>;
  processDroppedFilePaths?: (paths: string[]) => Promise<void>;
  insertReferences: (paths: string[]) => void;
  appendReferenceToken: (token: string) => void;
  insertSlashCommand: (command: string) => void;
  setValue: (value: string, context?: import("../../../shared/agentMentions").QueryMentionContext) => void;
  setImages: (images: ImageAttachment[]) => void;
  focus: () => void;
  clearWorkspaceBoundDraft: () => { strippedReferences: number; clearedImages: number };
  getCurrentValue: () => string;
  clearQueryContext: () => void;
  getQueryContext: () => import("../../../shared/agentMentions").QueryMentionContext;
  getImages: () => ImageAttachment[];
}
