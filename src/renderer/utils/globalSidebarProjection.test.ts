import { describe, expect, it } from 'vitest';

import type { ChatTab, LauncherTab, Tab } from '@/types/tab';
import { resolveGlobalSidebarWorkspace } from './globalSidebarProjection';

const launcher = (workspacePath?: string): LauncherTab => ({
  id: 'tab-1',
  view: 'launcher',
  title: 'Tab',
  launcherWorkspacePath: workspacePath,
});

const chat = (agentDir: string): ChatTab => ({
  id: 'tab-1',
  view: 'chat',
  title: 'Chat',
  agentDir,
  sessionId: 'session-1',
  sidecarConfigDisposition: 'push',
});

describe('resolveGlobalSidebarWorkspace', () => {
  it('projects the scoped board workspace without inheriting a Chat', () => {
    expect(resolveGlobalSidebarWorkspace({id:'board',view:'projectboard',title:'Board',workspacePath:'/work/p'})).toBe('/work/p');
  });
  it('projects the workspace selected by the active Launcher', () => {
    expect(resolveGlobalSidebarWorkspace(launcher('/work/mino'))).toBe('/work/mino');
  });

  it('projects the active Chat workspace directly from Tab authority', () => {
    expect(resolveGlobalSidebarWorkspace(chat('/work/project'))).toBe('/work/project');
  });

  it.each(['settings', 'capabilities', 'taskcenter', 'space'] as const)(
    'does not leak stale workspace context into a %s tab',
    (view) => {
      const tab: Tab = { id: 'tab-1', view, title: 'Tab' };
      expect(resolveGlobalSidebarWorkspace(tab)).toBeNull();
    },
  );
});
