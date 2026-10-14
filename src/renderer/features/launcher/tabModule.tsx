import { lazy, memo, Suspense } from 'react';

import type { Project } from '@/config/types';
import type { InitialMessage, LaunchSessionBirthHint } from '@/features/chat/tabContract';
import type { LauncherTab } from '@/features/launcher/tabContract';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import { PAGE_FALLBACK } from '@/tab-workspace/PageFallback';
import { createPendingSessionId } from '@/../shared/constants';
import type { RecordingSourceSelection } from '@/../shared/types/record';
import type { AssistantEntry, EntryIntent, Surface } from '@/analytics';

const Launcher = lazy(() => import('@/pages/Launcher'));

export interface LauncherOpenIntent {
  reuseExisting?: boolean;
}

export interface LauncherRenderBinding {
  isStarting: (tabId: string) => boolean;
  startError: (tabId: string) => string | null;
  onWorkspaceSelectionChange: (tabId: string, workspacePath: string | null) => void;
  onLaunchProject: (
    project: Project,
    initialMessage?: InitialMessage,
    analyticsContext?: {
      surface?: Surface;
      entryIntent?: EntryIntent;
      assistantEntry?: AssistantEntry;
    },
    sessionBirthHint?: LaunchSessionBirthHint,
  ) => Promise<boolean>;
  onStartRecording: (tabId: string, selection: RecordingSourceSelection) => Promise<void>;
  onOpenRecord: (recordId: string) => void;
  /** Opens the app-wide New Agent panel (the launcher's "add folder" entry). */
  onOpenNewAgentPanel: () => void;
}

const LauncherTabRenderer = memo(function LauncherTabRenderer({
  tab,
  isActive,
  isDeferred,
  binding,
}: {
  tab: LauncherTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: LauncherRenderBinding;
}) {
  if (isDeferred) {
    return <div className="h-full w-full bg-[var(--paper)]" />;
  }
  return (
    <Suspense fallback={PAGE_FALLBACK}>
      <Launcher
        composerTabId={tab.id}
        onLaunchProject={binding.onLaunchProject}
        isStarting={binding.isStarting(tab.id)}
        startError={binding.startError(tab.id)}
        isActive={isActive}
        attachmentSessionId={createPendingSessionId(tab.id)}
        selectedWorkspacePath={tab.launcherWorkspacePath}
        onWorkspaceSelectionChange={(workspacePath) => binding.onWorkspaceSelectionChange(tab.id, workspacePath)}
        onStartRecording={(selection) => binding.onStartRecording(tab.id, selection)}
        onOpenRecord={binding.onOpenRecord}
        onOpenNewAgentPanel={binding.onOpenNewAgentPanel}
        recordingBusy={binding.isStarting(tab.id)}
      />
    </Suspense>
  );
});

export const launcherTabModule = {
  kind: 'launcher',
  render: LauncherTabRenderer,
  chrome: (_tab, { t }) => ({
    title: t('tabs.launcher'),
    subtitle: t('tabs.launcher'),
  }),
  identity: (tab) => tab.id,
  open: {
    findExisting: (tabs, intent) => (intent.reuseExisting ? tabs[0] : undefined),
    create: (_intent, { id }) => ({
      id,
      view: 'launcher',
      title: 'New Tab',
    }),
    reopen: (tab) => tab,
  },
  initialMount: () => 'deferred-content',
} satisfies TabModuleDefinition<LauncherTab, LauncherOpenIntent, LauncherRenderBinding>;
