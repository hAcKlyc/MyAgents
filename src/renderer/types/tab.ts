import type { ProjectBoardTab } from '@/features/project-board/tabContract';
import type { AgentNetworkTab } from '@/features/agent-network/tabContract';
// Builtin-edition Tab model and shared constructors.

import type { ChatTab, InitialMessage, SidecarConfigDisposition } from '@/features/chat/tabContract';
import type { LauncherTab } from '@/features/launcher/tabContract';
import type { SettingsTab } from '@/features/settings/tabContract';
import type { CapabilitiesTab } from '@/features/capabilities/tabContract';
import type { TaskCenterTab } from '@/features/task-center/tabContract';
import type { SpaceTab } from '@/features/space/tabContract';
import type { RecordTab } from '@/features/record/tabContract';

export type { TabBase } from '@/tab-workspace/contracts';
export type {
  ChatTab,
  FilePreviewIntent,
  InitialMessage,
  InitialMessageCron,
  LaunchSessionBirthHint,
  SidecarConfigDisposition,
} from '@/features/chat/tabContract';
export type { LauncherTab } from '@/features/launcher/tabContract';
export type { SettingsNavigationIntent, SettingsTab } from '@/features/settings/tabContract';
export type {
  CapabilitiesNavigationIntent,
  CapabilitiesTab,
  CapabilitySection,
} from '@/features/capabilities/tabContract';
export type { TaskCenterSearchIntent, TaskCenterTab } from '@/features/task-center/tabContract';
export type { SpaceTab } from '@/features/space/tabContract';
export type { RecordTab } from '@/features/record/tabContract';

/** Closed union for the builtin MyAgents edition. Downstream editions extend
 * their own closed union and composition explicitly. */
export type { ProjectBoardTab } from '@/features/project-board/tabContract';

export type Tab = ProjectBoardTab | LauncherTab | ChatTab | SettingsTab | CapabilitiesTab | TaskCenterTab | SpaceTab | RecordTab | AgentNetworkTab;

export type TabKind = Tab['view'];
export type TabOf<K extends TabKind> = Extract<Tab, { view: K }>;

export interface TabState {
  tabs: Tab[];
  activeTabId: string | null;
}

export const MAX_TABS = 12;

export function generateTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function generateSessionTitle(firstMessage: string): string {
  const maxLength = 20;
  const trimmed = firstMessage.trim();
  if (!trimmed) return 'New Chat';
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}

export function getFolderName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function createNewTab(): LauncherTab {
  return {
    id: generateTabId(),
    view: 'launcher',
    title: 'New Tab',
  };
}

/** Canonical, type-safe transition from an existing shell Tab to Chat. */
export function buildChatFlipPatch(
  tab: Tab,
  fields: {
    agentDir: string;
    sessionId: string;
    title: string;
    initialMessage?: InitialMessage;
    sidecarConfigDisposition: SidecarConfigDisposition;
  },
): ChatTab {
  if (!fields.sessionId) {
    throw new Error(
      'buildChatFlipPatch: sessionId must be a non-empty id (D1) — flipping to chat without one strands the tab',
    );
  }
  const initialMessage = fields.initialMessage ?? (tab.view === 'chat' ? tab.initialMessage : undefined);
  return {
    id: tab.id,
    agentDir: fields.agentDir,
    sessionId: fields.sessionId,
    view: 'chat',
    title: fields.title,
    ...(initialMessage ? { initialMessage } : {}),
    discussionId: initialMessage?.discussionId ?? (tab.view === 'chat' ? tab.discussionId : undefined),
    sidecarConfigDisposition: fields.sidecarConfigDisposition,
    ...(tab.view === 'chat'
      ? {
          isGenerating: tab.isGenerating,
          hasUnread: tab.hasUnread,
          pendingFilePreview: tab.pendingFilePreview,
        }
      : {}),
  };
}
