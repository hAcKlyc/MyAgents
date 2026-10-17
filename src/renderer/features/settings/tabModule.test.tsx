import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { settingsTabModule } from './tabModule';
import type { SettingsTab } from './tabContract';
import { capabilitiesTabModule } from '@/features/capabilities/tabModule';
import type { CapabilitiesTab } from '@/features/capabilities/tabContract';
import { useSettingsNavigation } from '@/pages/settings/hooks/useSettingsNavigation';

// Keep the actual tab renderers and navigation hook; replace only the heavy page body.
vi.mock('@/pages/Settings', () => ({
  default: function Probe(props: Parameters<typeof useSettingsNavigation>[0] & { mode: string }) {
    const { activeSection, setActiveSection } = useSettingsNavigation({
      ...props, defaultSection: props.mode === 'capabilities' ? 'skills' : 'providers',
    });
    return <>
      <output data-testid="section">{activeSection}</output>
      <button onClick={() => setActiveSection(props.mode === 'capabilities' ? 'skills' : 'proxy')}>manual</button>
    </>;
  },
}));

const updater = {
  updateReady: false, updateVersion: null, updateChecking: false, updateDownloading: false,
  updateInstalling: false, updatePreparing: false, onCheckForUpdate: async () => 'up-to-date' as const,
  onRestartAndUpdate: () => {},
};

function Harness({ kind, initialIntent = true }: { kind: 'settings' | 'capabilities'; initialIntent?: boolean }) {
  const [tab, setTab] = useState<SettingsTab | CapabilitiesTab>(() => kind === 'settings'
    ? { id: 'singleton', view: 'settings', title: 'Settings', ...(initialIntent ? { navigationIntent: { generation: 1, section: 'agent' } } : {}) }
    : { id: 'singleton', view: 'capabilities', title: 'Capabilities', ...(initialIntent ? { navigationIntent: { generation: 1, section: 'mcp' } } : {}) });
  const [consumed, setConsumed] = useState(0);
  const onNavigationConsumed = (_id: string, generation: number) => {
    setConsumed(generation);
    setTab(current => current.navigationIntent?.generation === generation ? { ...current, navigationIntent: undefined } : current);
  };
  const SettingsRenderer = settingsTabModule.render;
  const CapabilitiesRenderer = capabilitiesTabModule.render;
  return <>
    <button onClick={() => setTab(current => current.view === 'settings'
      ? settingsTabModule.open.reopen(current, { title: 'Settings', navigationIntent: { generation: consumed + 1, section: 'agent' } })
      : capabilitiesTabModule.open.reopen(current, { title: 'Capabilities', navigationIntent: { generation: consumed + 1, section: 'mcp' } }))}>shortcut</button>
    <button onClick={() => setTab(current => current.view === 'settings'
      ? settingsTabModule.open.reopen(current, { title: 'Settings', navigationIntent: { generation: consumed + 1 } })
      : capabilitiesTabModule.open.reopen(current, { title: 'Capabilities' }))}>default-open</button>
    <output data-testid="consumed">{consumed}</output>
    <output data-testid="intent">{tab.navigationIntent ? 'pending' : 'none'}</output>
    {tab.view === 'settings'
      ? <SettingsRenderer tab={tab} isActive isDeferred={false} binding={{ ...updater, onNavigationConsumed }} />
      : <CapabilitiesRenderer tab={tab} isActive isDeferred={false} binding={{ ...updater, onNavigationConsumed, onOpenToolMarket: () => {} }} />}
  </>;
}

async function settleConsumed(generation: number) {
  await waitFor(() => expect(screen.getByTestId('consumed')).toHaveTextContent(String(generation)));
  // Let the post-consumption props/effects settle, including the old erroneous default navigation.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(screen.getByTestId('intent')).toHaveTextContent('none');
}

describe.each(['settings', 'capabilities'] as const)('%s navigation intent lifecycle', kind => {
  const target = kind === 'settings' ? 'agent' : 'mcp';
  const fallback = kind === 'settings' ? 'providers' : 'skills';
  it('keeps the target after consumption and supports repeat navigation after a manual selection', async () => {
    render(<Harness kind={kind} />);
    await settleConsumed(1);
    expect(screen.getByTestId('section')).toHaveTextContent(target);
    fireEvent.click(screen.getByRole('button', { name: 'manual' }));
    expect(screen.getByTestId('section')).not.toHaveTextContent(target);
    fireEvent.click(screen.getByRole('button', { name: 'shortcut' }));
    await settleConsumed(2);
    expect(screen.getByTestId('section')).toHaveTextContent(target);
    fireEvent.click(screen.getByRole('button', { name: 'shortcut' }));
    await settleConsumed(3);
    expect(screen.getByTestId('section')).toHaveTextContent(target);
    fireEvent.click(screen.getByRole('button', { name: 'default-open' }));
    if (kind === 'settings') await settleConsumed(4);
    expect(screen.getByTestId('section')).toHaveTextContent(kind === 'settings' ? fallback : target);
  });
  it('uses the initial default for a new mount without an intent', async () => {
    render(<Harness kind={kind} initialIntent={false} />);
    await waitFor(() => expect(screen.getByTestId('section')).toHaveTextContent(fallback));
    expect(screen.getByTestId('consumed')).toHaveTextContent('0');
  });
});
