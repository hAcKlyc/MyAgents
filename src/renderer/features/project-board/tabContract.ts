import type { TabBase } from '@/tab-workspace/contracts';

/** A scoped display surface, never a Session/Sidecar execution owner. */
export interface ProjectBoardTab extends TabBase<'projectboard'> {
  workspacePath: string;
}
