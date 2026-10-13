import type { Tab } from '@/types/tab';

/**
 * Project the active Tab into the workspace context shown by the global shell.
 * Function tabs deliberately return null so they never inherit stale context.
 */
export function resolveGlobalSidebarWorkspace(
  activeTab: Tab | undefined,
): string | null {
  if (!activeTab) return null;
  if (activeTab.view === 'projectboard') return activeTab.workspacePath;
  if (activeTab.view === 'chat') return activeTab.agentDir;
  if (activeTab.view === 'launcher') return activeTab.launcherWorkspacePath ?? null;
  return null;
}
