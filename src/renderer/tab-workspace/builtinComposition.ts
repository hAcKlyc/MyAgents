import { projectBoardTabModule } from '@/features/project-board/tabModule';
import { agentNetworkTabModule } from '@/features/agent-network/tabModule';
import { createNewTab, type Tab } from '@/types/tab';
import type { ModuleBinding, ModuleTab } from '@/tab-workspace/contracts';
import { defineTabModules } from '@/tab-workspace/registry';
import type { TabLifecycleAdapter } from '@/tab-workspace/useTabCloseController';
import { launcherTabModule } from '@/features/launcher/tabModule';
import { chatTabModule } from '@/features/chat/tabModule';
import { settingsTabModule } from '@/features/settings/tabModule';
import { capabilitiesTabModule } from '@/features/capabilities/tabModule';
import { taskCenterTabModule } from '@/features/task-center/tabModule';
import { spaceTabModule } from '@/features/space/tabModule';
import { recordTabModule } from '@/features/record/tabModule';
import type { RecordTabCloseReason } from '@/features/record/useRecordTabLifecycle';

/** The single composition root for the builtin MyAgents edition. */
export const builtinTabModules = defineTabModules<Tab>()({
  launcher: launcherTabModule,
  chat: chatTabModule,
  settings: settingsTabModule,
  capabilities: capabilitiesTabModule,
  taskcenter: taskCenterTabModule,
  projectboard: projectBoardTabModule,
  space: spaceTabModule,
  agentnetwork: agentNetworkTabModule,
  record: recordTabModule,
});

export type BuiltinTabModules = typeof builtinTabModules;

/** Runtime bindings are derived from the same closed definition map. App must
 * inject values through this composition boundary instead of declaring a
 * second hand-maintained kind/type map. */
export type BuiltinTabBindings = {
  readonly [K in keyof BuiltinTabModules]: ModuleBinding<BuiltinTabModules[K]>;
};

export function composeBuiltinTabBindings(bindings: BuiltinTabBindings): BuiltinTabBindings {
  return bindings;
}

export type BuiltinTabCloseReason = RecordTabCloseReason;

export type BuiltinTabLifecycle = {
  readonly [K in keyof BuiltinTabModules]?: TabLifecycleAdapter<
    ModuleTab<BuiltinTabModules[K]>,
    BuiltinTabCloseReason
  >;
};

export function composeBuiltinTabLifecycle(lifecycle: BuiltinTabLifecycle): BuiltinTabLifecycle {
  return lifecycle;
}

/** Edition-owned policy that the generic workspace deliberately cannot infer. */
export const builtinTabWorkspacePolicy = Object.freeze({
  createFallback: createNewTab,
  isLastTabProtected: (tab: Tab) => tab.view === 'launcher',
  defaultCloseReason: 'user' as BuiltinTabCloseReason,
});
