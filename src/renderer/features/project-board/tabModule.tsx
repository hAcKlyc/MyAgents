import { lazy, memo, Suspense } from 'react';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import { PAGE_FALLBACK } from '@/tab-workspace/PageFallback';
import { normalizeWorkspacePathIdentity, workspacePathsEqual } from '@/../shared/workspacePath';
import type { ProjectBoardTab } from './tabContract';

const ProjectBoard = lazy(() => import('@/pages/ProjectBoard'));
export interface ProjectBoardOpenIntent { title: string; workspacePath: string }

const Renderer = memo(function ProjectBoardTabRenderer({ tab, isActive, isDeferred }: {
  tab: ProjectBoardTab; isActive: boolean; isDeferred: boolean; binding: null;
}) {
  if (isDeferred) return PAGE_FALLBACK;
  return <Suspense fallback={PAGE_FALLBACK}><ProjectBoard workspacePath={tab.workspacePath} isActive={isActive} /></Suspense>;
});

export const projectBoardTabModule = {
  kind: 'projectboard', render: Renderer,
  chrome: tab => ({ title: tab.title, subtitle: tab.workspacePath }),
  identity: tab => normalizeWorkspacePathIdentity(tab.workspacePath),
  open: {
    findExisting: (tabs, intent) => tabs.find(tab => workspacePathsEqual(tab.workspacePath, intent.workspacePath)),
    create: (intent, { id }) => ({ id, view: 'projectboard', title: intent.title, workspacePath: intent.workspacePath }),
    reopen: (tab, intent) => ({ ...tab, title: intent.title }),
  },
  initialMount: () => 'deferred-content',
} satisfies TabModuleDefinition<ProjectBoardTab, ProjectBoardOpenIntent, null>;
