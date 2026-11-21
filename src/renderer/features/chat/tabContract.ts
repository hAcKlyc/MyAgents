import type { ImageAttachment } from '@/components/chat-input/types';
import type { PermissionMode } from '@/config/types';
import type { TabBase } from '@/tab-workspace/contracts';
import type { CronDelivery, CronEndConditions, CronSchedule, ScheduledTaskKind } from '@/types/cronTask';
import type { OfficialToolId } from '@/../shared/official-tools';
import type { RuntimeBackedProviderIdentity } from '@/../shared/providerExecution';
import type { SessionOrigin } from '@/../shared/session-origin';
import type { ProductSystemSkillRequirement } from '@/../shared/systemSkills';

/** Cron settings drafted before Chat owns the first turn. */
export interface InitialMessageCron {
  notification?: import('@/../shared/types/task').NotificationConfig;
  taskKind: ScheduledTaskKind;
  schedule: CronSchedule;
  runMode: 'single_session' | 'new_session';
  endConditions: CronEndConditions;
  notifyEnabled: boolean;
  delivery?: CronDelivery;
  name?: string;
  intervalMinutes: number;
  executionTarget?: 'current_session' | 'new_task';
}

/** Launcher-to-Chat first-turn handoff. Security: provider ids only, no keys. */
export interface InitialMessage {
  clientRequestId?: string;
  discussionId?: string;
  primaryContext?: import("../../../shared/agentMentions").DesktopPrimaryContext;
  text: string;
  agentMentions?: import("../../../shared/agentMentions").AgentMentionSnapshot[];
  images?: ImageAttachment[];
  permissionMode?: PermissionMode;
  mcpEnabledServers?: string[];
  enabledPluginIds?: string[];
  enabledOfficialToolIds?: OfficialToolId[];
  builtinSelection?: { providerId: string; model: string };
  systemCliRuntime?: import('@/../shared/integrated-runtimes/identity').ExternalRuntimeId;
  runtimeModel?: string;
  providerExecutionIdentity?: RuntimeBackedProviderIdentity;
  reasoningEffort?: string;
  requiredSystemSkill?: ProductSystemSkillRequirement;
  cron?: InitialMessageCron;
}

/** Execution identity carried into Session birth even without a first message. */
export interface LaunchSessionBirthHint {
  permissionMode?: PermissionMode;
  mcpEnabledServers?: string[];
  enabledPluginIds?: string[];
  enabledOfficialToolIds?: OfficialToolId[];
  builtinSelection?: { providerId: string; model: string };
  runtimeModel?: string;
  providerExecutionIdentity?: RuntimeBackedProviderIdentity;
  reasoningEffort?: string;
  origin?: SessionOrigin;
}

export type SidecarConfigDisposition = 'pending' | 'push' | 'adopt';

export interface FilePreviewIntent {
  id: string;
  path: string;
  initialLineNumber?: number;
}

export interface ChatTab extends TabBase<'chat'> {
  agentDir: string;
  sessionId: string | null;
  isGenerating?: boolean;
  hasUnread?: boolean;
  initialMessage?: InitialMessage;
  /** Locator only: original input belongs to the Rust discussion artifact. */
  discussionId?: string;
  sidecarConfigDisposition: SidecarConfigDisposition;
  pendingFilePreview?: FilePreviewIntent;
}
