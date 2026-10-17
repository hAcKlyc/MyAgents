import { lazy, memo, Suspense } from 'react';

import type { SettingsNavigationIntent, SettingsTab } from '@/features/settings/tabContract';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import { PAGE_FALLBACK } from '@/tab-workspace/PageFallback';
import type { SettingsUpdaterBinding } from '@/features/settings/tabBinding';

const Settings = lazy(() => import('@/pages/Settings'));

export interface SettingsOpenIntent {
  title: string;
  navigationIntent: SettingsNavigationIntent;
}

export interface SettingsRenderBinding extends SettingsUpdaterBinding {
  onNavigationConsumed: (tabId: string, generation: number) => void;
}

const SettingsTabRenderer = memo(function SettingsTabRenderer({
  tab,
  isActive,
  isDeferred,
  binding,
}: {
  tab: SettingsTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: SettingsRenderBinding;
}) {
  if (isDeferred) return PAGE_FALLBACK;
  const generation = tab.navigationIntent?.generation;
  return (
    <Suspense fallback={PAGE_FALLBACK}>
      <Settings
        mode="settings"
        // A consumed intent is no navigation; an explicit untargeted open still selects the default.
        initialSection={tab.navigationIntent ? (tab.navigationIntent.section ?? 'providers') : undefined}
        navigationNonce={generation}
        onSectionChange={generation === undefined ? undefined : () => binding.onNavigationConsumed(tab.id, generation)}
        isActive={isActive}
        {...binding}
      />
    </Suspense>
  );
});

export const settingsTabModule = {
  kind: 'settings',
  render: SettingsTabRenderer,
  chrome: (_tab, { t }) => ({
    title: t('tabs.settings'),
    subtitle: t('tabs.settings'),
  }),
  identity: () => 'settings',
  open: {
    findExisting: (tabs) => tabs[0],
    create: (intent, { id }) => ({
      id,
      view: 'settings',
      title: intent.title,
      navigationIntent: intent.navigationIntent,
    }),
    reopen: (tab, intent) => ({
      ...tab,
      navigationIntent: intent.navigationIntent,
    }),
  },
  initialMount: () => 'deferred-content',
} satisfies TabModuleDefinition<SettingsTab, SettingsOpenIntent, SettingsRenderBinding>;
