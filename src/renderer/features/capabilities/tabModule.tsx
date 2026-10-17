import { lazy, memo, Suspense } from 'react';

import type { CapabilitiesNavigationIntent, CapabilitiesTab } from '@/features/capabilities/tabContract';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import { PAGE_FALLBACK } from '@/tab-workspace/PageFallback';
import type { SettingsUpdaterBinding } from '@/features/settings/tabBinding';

const Settings = lazy(() => import('@/pages/Settings'));

export interface CapabilitiesOpenIntent {
  title: string;
  navigationIntent?: CapabilitiesNavigationIntent;
}

export interface CapabilitiesRenderBinding extends SettingsUpdaterBinding {
  onNavigationConsumed: (tabId: string, generation: number) => void;
  onOpenToolMarket: () => void;
}

const CapabilitiesTabRenderer = memo(function CapabilitiesTabRenderer({
  tab,
  isActive,
  isDeferred,
  binding,
}: {
  tab: CapabilitiesTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: CapabilitiesRenderBinding;
}) {
  if (isDeferred) return PAGE_FALLBACK;
  const intent = tab.navigationIntent;
  return (
    <Suspense fallback={PAGE_FALLBACK}>
      <Settings
        mode="capabilities"
        initialSection={intent?.section}
        navigationNonce={intent?.generation}
        initialMcpId={intent?.mcpServerId}
        initialOfficialToolId={intent?.officialToolId}
        initialSelect={intent?.select}
        onSectionChange={intent ? () => binding.onNavigationConsumed(tab.id, intent.generation) : undefined}
        isActive={isActive}
        {...binding}
      />
    </Suspense>
  );
});

export const capabilitiesTabModule = {
  kind: 'capabilities',
  render: CapabilitiesTabRenderer,
  chrome: (_tab, { t }) => ({
    title: t('tabs.capabilities'),
    subtitle: t('tabs.capabilities'),
  }),
  identity: () => 'capabilities',
  open: {
    findExisting: (tabs) => tabs[0],
    create: (intent, { id }) => ({
      id,
      view: 'capabilities',
      title: intent.title,
      ...(intent.navigationIntent ? { navigationIntent: intent.navigationIntent } : {}),
    }),
    reopen: (tab, intent) => (intent.navigationIntent ? { ...tab, navigationIntent: intent.navigationIntent } : tab),
  },
  initialMount: () => 'deferred-content',
} satisfies TabModuleDefinition<CapabilitiesTab, CapabilitiesOpenIntent, CapabilitiesRenderBinding>;
