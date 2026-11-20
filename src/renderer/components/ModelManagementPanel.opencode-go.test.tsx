import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { DEFAULT_CONFIG, PRESET_PROVIDERS, mergePresetCustomModels, type AppConfig } from '@/config/types';
import type { DiscoveredModel } from '@/config/services/modelDiscoveryService';
import { resolveProviderForModel } from '../../shared/provider-model-routing';
import ModelManagementPanel from './ModelManagementPanel';

const mocks = vi.hoisted(() => ({ config: {} as AppConfig, refresh: vi.fn(async () => {}) }));
vi.mock('@/hooks/useCloseLayer', () => ({ useCloseLayer: vi.fn() }));
vi.mock('@/config/configService', () => ({
  atomicModifyConfig: vi.fn(async (updater: (config: AppConfig) => AppConfig) => { mocks.config = updater(mocks.config); }),
  rebuildAndPersistAvailableProviders: vi.fn(async () => {}),
}));
const go = PRESET_PROVIDERS.find(provider => provider.id === 'opencode-go')!;
const unknown: DiscoveredModel = { id: 'future-go', displayName: 'Future Go' };

function open(catalog: DiscoveredModel[] = [unknown], provider = go) {
  return render(<ModelManagementPanel
    provider={provider} config={mocks.config} apiKey={undefined}
    onClose={vi.fn()} onRefresh={mocks.refresh} discoveryAction={async () => catalog}
    onSaveCustomModels={vi.fn(async (id, models) => {
      mocks.config = { ...mocks.config, presetCustomModels: { ...mocks.config.presetCustomModels, [id]: models } };
    })}
    onSetPrimaryModel={vi.fn(async () => {})}
  />);
}

describe('OpenCode Go model setup', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.config = { ...DEFAULT_CONFIG, presetCustomModels: {}, presetRemovedModels: {} };
    await i18n.changeLanguage('en-US');
  });

  it('opens the existing editor for an ID-only discovery row and requires a protocol before Save', async () => {
    open();
    await screen.findByText('Future Go');
    const row = screen.getByText('Future Go').closest('.group')!;
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Add' }));
    const editor = await screen.findByRole('dialog', { name: 'Model Parameters' });
    const save = within(editor).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(within(editor).getAllByText('Choose a model protocol')).toHaveLength(2);
    fireEvent.click(within(editor).getByRole('button', { name: 'Request protocol' }));
    fireEvent.click(await screen.findByText('OpenAI Responses'));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(mocks.config.presetCustomModels?.['opencode-go']?.[0]?.executionProtocol).toBe('openai:responses'));
    expect(resolveProviderForModel(mergePresetCustomModels([go], mocks.config.presetCustomModels)[0], 'future-go').upstreamFormat).toBe('responses');
  });

  it('edits a bundled model, keeps its official protocol locked and inherits untouched catalog fields', async () => {
    const model = go.models[0];
    const view = open([]);
    fireEvent.click(screen.getByRole('button', { name: `Model parameter settings: ${model.modelName}` }));
    let editor = await screen.findByRole('dialog', { name: 'Model Parameters' });
    expect(within(editor).getByText('OpenAI Responses')).toBeInTheDocument();
    expect(within(editor).queryByRole('button', { name: 'Request protocol' })).not.toBeInTheDocument();
    fireEvent.change(within(editor).getByLabelText('Context window'), { target: { value: '128k' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.config.presetCustomModels?.[go.id]).toEqual([
      { model: model.model, source: 'preset', presetSettings: { contextLength: 128000 } },
    ]));
    view.unmount();

    const upgraded = { ...go, models: [{ ...model, modelName: 'Updated name', inputModalities: ['text', 'image'] }] };
    const [restored] = mergePresetCustomModels([upgraded], mocks.config.presetCustomModels);
    expect(restored.models[0]).toMatchObject({ modelName: 'Updated name', inputModalities: ['text', 'image'], contextLength: 128000 });
    expect(resolveProviderForModel(restored, model.model).upstreamFormat).toBe('responses');
    open([], restored);
    fireEvent.click(screen.getByRole('button', { name: 'Model parameter settings: Updated name' }));
    editor = await screen.findByRole('dialog', { name: 'Model Parameters' });
    const context = within(editor).getByLabelText('Context window');
    expect(context).toHaveValue('128000');
    fireEvent.change(context, { target: { value: '' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.config.presetCustomModels?.[go.id] ?? []).toEqual([]));
  });

  it('keeps discovery metadata separate when changing a bundled display name', async () => {
    const model = go.models[0];
    const discovered = { ...model, source: 'discovered' as const, modelName: 'Catalog name', contextLength: 64000 };
    mocks.config.presetCustomModels = { [go.id]: [discovered] };
    open([], mergePresetCustomModels([go], mocks.config.presetCustomModels)[0]);
    fireEvent.click(screen.getByRole('button', { name: `Model parameter settings: ${model.modelName}` }));
    const editor = await screen.findByRole('dialog', { name: 'Model Parameters' });
    fireEvent.change(within(editor).getByLabelText('Display name'), { target: { value: 'My model' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.config.presetCustomModels?.[go.id]).toEqual([
      { ...discovered, presetSettings: { modelName: 'My model' } },
    ]));
    const [updated] = mergePresetCustomModels([{ ...go, models: [{ ...model, contextLength: 256000 }] }], mocks.config.presetCustomModels);
    expect(updated.models[0]).toMatchObject({ modelName: 'My model', contextLength: 256000 });
  });

  it('lets a known official preset be re-added without a protocol prompt', async () => {
    const model = go.models[0];
    mocks.config.presetRemovedModels = { [go.id]: [model.model] };
    open([{ id: model.model }], mergePresetCustomModels([go], undefined, mocks.config.presetRemovedModels)[0]);
    await screen.findAllByText(model.model);
    const row = screen.getByText(model.model).closest('.group')!;
    const add = within(row as HTMLElement).getByRole('button', { name: 'Add' });
    fireEvent.click(add);
    await waitFor(() => expect(mocks.config.presetRemovedModels?.[go.id]).not.toContain(model.model));
    expect(screen.queryByRole('button', { name: 'Request protocol' })).not.toBeInTheDocument();
  });

  it('does not show protocol on a fixed provider model editor', async () => {
    const fixed = PRESET_PROVIDERS.find(provider => provider.id === 'anthropic-api')!;
    open([], fixed);
    const input = screen.getByPlaceholderText('Enter a model ID, press Enter to configure and add');
    fireEvent.change(input, { target: { value: 'new-model' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByRole('button', { name: 'Request protocol' })).not.toBeInTheDocument();
  });

  it('lets a saved manual route be changed without clearing its other settings', async () => {
    const manual = {
      model: 'future-go', modelName: 'Custom Future', modelSeries: 'other', source: 'manual' as const,
      contextLength: 64000, executionProtocol: 'anthropic:messages' as const,
    };
    mocks.config.presetCustomModels = { [go.id]: [manual] };
    open([], mergePresetCustomModels([go], mocks.config.presetCustomModels)[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Model parameter settings: Custom Future' }));
    const editor = await screen.findByRole('dialog', { name: 'Model Parameters' });
    fireEvent.click(within(editor).getByRole('button', { name: 'Request protocol' }));
    fireEvent.click(await screen.findByText('OpenAI Chat Completions'));
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.config.presetCustomModels?.[go.id]?.[0]?.executionProtocol).toBe('openai:chat-completions'));
    expect(mocks.config.presetCustomModels?.[go.id]?.[0]?.contextLength).toBe(64000);
  });

  it('lets Escape dismiss the protocol menu before the existing model editor', async () => {
    open();
    const row = (await screen.findByText('Future Go')).closest('.group')!;
    const add = within(row as HTMLElement).getByRole('button', { name: 'Add' });
    add.focus();
    fireEvent.click(add);
    const editor = await screen.findByRole('dialog', { name: 'Model Parameters' });
    const selector = within(editor).getByRole('button', { name: 'Request protocol' });
    fireEvent.click(selector);
    const option = await screen.findByText('OpenAI Responses');
    option.closest('button')!.focus();
    fireEvent.keyDown(option.closest('button')!, { key: 'Escape' });
    expect(screen.queryByText('OpenAI Responses')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-settings-popover')).toBeInTheDocument();
    expect(document.activeElement).toBe(selector);
    fireEvent.keyDown(selector, { key: 'Escape' });
    expect(screen.queryByTestId('model-settings-popover')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(add);
  });

  it('keeps a formerly discovered official ID editable when it has a user protocol', () => {
    const model = { ...go.models[0], source: 'discovered' as const, executionProtocol: 'anthropic:messages' as const };
    mocks.config.presetCustomModels = { [go.id]: [model] };
    open([], mergePresetCustomModels([go], mocks.config.presetCustomModels)[0]);
    fireEvent.click(screen.getByRole('button', { name: `Model parameter settings: ${model.modelName}` }));
    expect(screen.getByText("This differs from OpenCode Go's official route. Review before saving.")).toBeInTheDocument();
  });

  it('returns focus to the panel when saving removes the discovery row', async () => {
    function RefreshingPanel() {
      const [provider, setProvider] = useState(go);
      return <ModelManagementPanel
        provider={provider} config={mocks.config} apiKey={undefined}
        onClose={vi.fn()} onRefresh={async () => {
          setProvider(mergePresetCustomModels([go], mocks.config.presetCustomModels)[0]);
        }}
        discoveryAction={async () => [unknown]}
        onSaveCustomModels={vi.fn(async () => {})}
        onSetPrimaryModel={vi.fn(async () => {})}
      />;
    }
    render(<RefreshingPanel />);
    const row = (await screen.findByText('Future Go')).closest('.group')!;
    const add = within(row as HTMLElement).getByRole('button', { name: 'Add' });
    add.focus();
    fireEvent.click(add);
    const editor = await screen.findByRole('dialog', { name: 'Model Parameters' });
    fireEvent.click(within(editor).getByRole('button', { name: 'Request protocol' }));
    fireEvent.click(await screen.findByText('OpenAI Responses'));
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByTestId('model-settings-popover')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });
});
