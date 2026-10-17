import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NetworkRegistry } from '@/api/agentNetwork';

// setup-dom initializes the default profile; each case must import its own
// closed build identity before rendering either the header or the selector.
beforeEach(() => vi.resetModules());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const registry: NetworkRegistry = {
  revision: 1,
  selected: 'owned-fixture',
  selfhostEnabled: true,
  connections: [{
    id: 'owned-fixture', name: 'My actual network', official: false,
    url: 'https://network.example.test', removing: false,
    snapshot: {
      connectionId: 'owned-fixture', state: 'disconnected', principalId: null,
      networkId: null, error: null, revision: 1, authGeneration: 1,
    },
  }],
};

it.each(['zh-CN', 'en-US'] as const)('keeps the owned page heading separate from a real connection and unknown counts (%s)', async (lng) => {
  vi.stubGlobal('__MYAGENTS_BUILD_PROFILE__', 'moxbot');
  const { i18n } = await import('@/i18n');
  await i18n.changeLanguage(lng);
  const { NetworkHeader } = await import('./NetworkHeader');
  const { NetworkSelector } = await import('./NetworkSelector');
  render(<NetworkHeader selector={<NetworkSelector registry={registry} />} />);
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(lng === 'zh-CN' ? 'Bots 网络' : 'Bots Network');
  expect(screen.getByText('Your bots are ready.')).toBeInTheDocument();
  expect(screen.getByText('My actual network')).toBeInTheDocument();
  // Welcome copy never changes unavailable live data into a ready/zero claim.
  expect(screen.getAllByText('—')).toHaveLength(2);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: i18n.t('app:agentNetwork.networkInfo') }));
  expect(screen.getByText(i18n.t('app:agentNetwork.infoIntro'))).toBeInTheDocument();
});

it('retains the original upstream heading and no owned welcome outside the MoXBots profile', async () => {
  vi.stubGlobal('__MYAGENTS_BUILD_PROFILE__', 'myagents');
  const { i18n } = await import('@/i18n');
  await i18n.changeLanguage('zh-CN');
  const { NetworkHeader } = await import('./NetworkHeader');
  const { NetworkSelector } = await import('./NetworkSelector');
  render(<NetworkHeader selector={<NetworkSelector registry={{ ...registry, selfhostEnabled: false }} />} />);
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('AgentNet 局域网络');
  expect(screen.queryByText('Your bots are ready.')).not.toBeInTheDocument();
});
