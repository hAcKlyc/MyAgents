import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StrictMode } from 'react';

import { i18n } from '@/i18n';
import { DEFAULT_CONFIG, type AppConfig, type Provider } from '@/config/types';
import type { DiscoveredModel } from '@/config/services/modelDiscoveryService';
import ModelManagementPanel from './ModelManagementPanel';

vi.mock('@/hooks/useCloseLayer', () => ({
  useCloseLayer: vi.fn(),
}));

vi.mock('@/config/configService', () => ({
  atomicModifyConfig: vi.fn(async updater => updater({})),
  rebuildAndPersistAvailableProviders: vi.fn(async () => undefined),
}));

const baseConfig: AppConfig = DEFAULT_CONFIG;

function customProvider(models: Provider['models'] = []): Provider {
  return {
    id: 'fox',
    name: 'fox',
    vendor: 'Fox',
    cloudProvider: 'Custom',
    type: 'api',
    primaryModel: models[0]?.model ?? '',
    isBuiltin: false,
    config: { baseUrl: 'https://example.test' },
    models,
  };
}

function renderPanel(overrides: Partial<{
  provider: Provider;
  onUpdateCustomProvider: (provider: Provider, discoveredModels?: DiscoveredModel[]) => Promise<void>;
  onRefresh: () => Promise<void>;
  discoveryAction: () => Promise<DiscoveredModel[]>;
  discoveryUnavailableMessage: string;
}> = {}) {
  const onUpdateCustomProvider = overrides.onUpdateCustomProvider ?? vi.fn(async () => undefined);
  const onRefresh = overrides.onRefresh ?? vi.fn(async () => undefined);

  render(
    <ModelManagementPanel
      provider={overrides.provider ?? customProvider()}
      apiKey={undefined}
      config={baseConfig}
      onClose={vi.fn()}
      onSaveCustomModels={vi.fn(async () => undefined)}
      onUpdateCustomProvider={onUpdateCustomProvider}
      onSetPrimaryModel={vi.fn(async () => undefined)}
      onRefresh={onRefresh}
      discoveryAction={overrides.discoveryAction}
      discoveryUnavailableMessage={overrides.discoveryUnavailableMessage}
    />,
  );

  return { onUpdateCustomProvider, onRefresh };
}

describe('ModelManagementPanel custom model add flow', () => {
  beforeEach(async () => {
    document.body.innerHTML = '';
    await i18n.changeLanguage('en-US');
  });

  it('opens the model settings popover instead of saving immediately', async () => {
    const user = userEvent.setup();
    const { onUpdateCustomProvider } = renderPanel();

    await user.type(
      screen.getByPlaceholderText('Enter a model ID, press Enter to configure and add'),
      'gpt-5.5{enter}',
    );

    expect(screen.getByText('Model Parameters')).toBeInTheDocument();
    expect(screen.getByText('gpt-5.5')).toBeInTheDocument();
    expect(onUpdateCustomProvider).not.toHaveBeenCalled();
  });

  it('portals the model settings popover outside the model panel shell', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.type(
      screen.getByPlaceholderText('Enter a model ID, press Enter to configure and add'),
      'gpt-5.5{enter}',
    );

    expect(screen.getByTestId('model-settings-popover').closest('[data-model-management-panel]')).toBeNull();
  });

  it('does not let a second Enter replace the pending model editor', async () => {
    const user = userEvent.setup();
    renderPanel();

    const input = screen.getByPlaceholderText('Enter a model ID, press Enter to configure and add');
    await user.type(input, 'model-a{enter}');
    fireEvent.change(input, { target: { value: 'model-b' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByText('model-a')).toBeInTheDocument();
    expect(screen.queryByText('model-b')).not.toBeInTheDocument();
  });

  it('persists the model only after the settings form is saved', async () => {
    const user = userEvent.setup();
    const onUpdateCustomProvider = vi.fn(async () => undefined);
    const onRefresh = vi.fn(async () => undefined);
    renderPanel({ onUpdateCustomProvider, onRefresh });

    await user.type(
      screen.getByPlaceholderText('Enter a model ID, press Enter to configure and add'),
      'gpt-5.5',
    );
    await user.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(screen.getByLabelText('Context window'), { target: { value: '1m' } });
    await user.click(screen.getByRole('button', { name: 'Image' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onUpdateCustomProvider).toHaveBeenCalledTimes(1));
    expect(onUpdateCustomProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: 'fox',
      models: [expect.objectContaining({
        model: 'gpt-5.5',
        modelName: 'gpt-5.5',
        contextLength: 1_000_000,
        inputModalities: ['text', 'image'],
        source: 'manual',
      })],
    }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('ModelManagementPanel managed discovery', () => {
  beforeEach(async () => {
    document.body.innerHTML = '';
    await i18n.changeLanguage('en-US');
  });

  it('discovers models through a host-managed action without an API key', async () => {
    const discoveryAction = vi.fn(async () => [
      { id: 'grok-next', displayName: 'Grok Next' },
    ]);

    renderPanel({ discoveryAction });

    await waitFor(() => expect(discoveryAction).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Grok Next')).toBeInTheDocument();
    expect(screen.queryByText('Configure an API Key first')).not.toBeInTheDocument();
  });

  it('shows an actionable managed-auth message instead of asking for an API key', () => {
    renderPanel({ discoveryUnavailableMessage: 'Log in to Grok first' });
    expect(screen.getByText('Log in to Grok first')).toBeInTheDocument();
    expect(screen.queryByText('Configure an API Key first')).not.toBeInTheDocument();
  });

  it('fills missing capabilities on an already-active custom-provider model from discovery (#516)', async () => {
    const onUpdateCustomProvider = vi.fn(async () => undefined);
    const discoveryAction = vi.fn(async () => [
      { id: 'DeepSeek-V4-Flash', contextLength: 1_048_576 },
    ]);
    renderPanel({
      provider: customProvider([
        {
          model: 'DeepSeek-V4-Flash',
          modelName: 'DeepSeek V4 Flash',
          modelSeries: 'custom',
        },
      ]),
      onUpdateCustomProvider,
      discoveryAction,
    });

    await waitFor(() => expect(onUpdateCustomProvider).toHaveBeenCalledTimes(1));
    expect(onUpdateCustomProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'fox',
        models: [expect.objectContaining({
          model: 'DeepSeek-V4-Flash',
          contextLength: 1_048_576,
        })],
      }),
      [{ id: 'DeepSeek-V4-Flash', contextLength: 1_048_576 }],
    );
  });

  it('does not replace an explicit capability with a discovery value', async () => {
    const onUpdateCustomProvider = vi.fn(async () => undefined);
    renderPanel({
      provider: customProvider([{
        model: 'DeepSeek-V4-Flash',
        modelName: 'DeepSeek V4 Flash',
        modelSeries: 'custom',
        contextLength: 262_144,
      }]),
      onUpdateCustomProvider,
      discoveryAction: vi.fn(async () => [
        { id: 'DeepSeek-V4-Flash', contextLength: 1_048_576 },
      ]),
    });

    await waitFor(() => expect(screen.queryByText('Loading models...')).not.toBeInTheDocument());
    expect(onUpdateCustomProvider).not.toHaveBeenCalled();
  });
});

describe('ModelManagementPanel discovery scheduling (#582)', () => {
  beforeEach(async () => {
    document.body.innerHTML = '';
    await i18n.changeLanguage('en-US');
  });

  function panelElement(props: {
    provider?: Provider;
    discoveryAction: () => Promise<DiscoveredModel[]>;
  }) {
    // Inline callbacks on purpose: this is how SettingsPage renders the panel,
    // so every host render hands the panel new function identities.
    return (
      <ModelManagementPanel
        provider={props.provider ?? customProvider()}
        apiKey={undefined}
        config={baseConfig}
        onClose={() => undefined}
        onSaveCustomModels={async () => undefined}
        onUpdateCustomProvider={async () => undefined}
        onSetPrimaryModel={async () => undefined}
        onRefresh={async () => undefined}
        discoveryAction={props.discoveryAction}
      />
    );
  }

  it('discovers once per endpoint, not once per host render', async () => {
    const discoveryAction = vi.fn(async () => [{ id: 'm1', displayName: 'Model One' }]);
    const { rerender } = render(panelElement({ discoveryAction }));
    expect(await screen.findByText('Model One')).toBeInTheDocument();
    expect(discoveryAction).toHaveBeenCalledTimes(1);

    // New callback identities and a freshly built (but equal) provider object
    // are what a host re-render produces; none of it is a reason to refetch.
    for (let i = 0; i < 3; i += 1) {
      rerender(panelElement({ provider: customProvider(), discoveryAction }));
    }
    await act(async () => { await Promise.resolve(); });
    expect(discoveryAction).toHaveBeenCalledTimes(1);

    // A different endpoint is a reason to refetch.
    rerender(panelElement({
      provider: { ...customProvider(), config: { baseUrl: 'https://other.example.test' } },
      discoveryAction,
    }));
    await waitFor(() => expect(discoveryAction).toHaveBeenCalledTimes(2));
  });

  it('coalesces overlapping requests for the same endpoint into one', async () => {
    let resolveFirst: (models: DiscoveredModel[]) => void = () => undefined;
    const discoveryAction = vi.fn<() => Promise<DiscoveredModel[]>>()
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockResolvedValue([{ id: 'm2', displayName: 'Model Two' }]);

    // StrictMode mounts effects twice; without the in-flight guard the second
    // run opened a second connection to the provider while the first was pending.
    render(<StrictMode>{panelElement({ discoveryAction })}</StrictMode>);
    expect(discoveryAction).toHaveBeenCalledTimes(1);

    await act(async () => { resolveFirst([{ id: 'm1', displayName: 'Model One' }]); });
    expect(await screen.findByText('Model One')).toBeInTheDocument();

    // Once the request has settled, a manual refresh is allowed again.
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Model Two')).toBeInTheDocument();
    expect(discoveryAction).toHaveBeenCalledTimes(2);
  });
});
