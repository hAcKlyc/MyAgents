import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import {
  DEFAULT_CONFIG,
  PRESET_PROVIDERS,
  mergePresetCustomModels,
  type AppConfig,
} from '@/config/types';
import type { DiscoveredModel } from '@/config/services/modelDiscoveryService';
import { resolveProviderForModel } from '../../shared/tokendance';
import ModelManagementPanel from './ModelManagementPanel';

const mocks = vi.hoisted(() => ({
  config: {} as AppConfig,
  refresh: vi.fn(async () => {}),
}));
vi.mock('@/hooks/useCloseLayer', () => ({ useCloseLayer: vi.fn() }));
vi.mock('@/config/configService', () => ({
  atomicModifyConfig: vi.fn(async (updater: (c: AppConfig) => AppConfig) => {
    mocks.config = updater(mocks.config);
  }),
  rebuildAndPersistAvailableProviders: vi.fn(async () => {}),
}));
const provider = PRESET_PROVIDERS.find((p) => p.id === 'tokendance')!;
const discovered: DiscoveredModel = {
  id: 'future-chat',
  displayName: 'Future Chat',
  supportedProtocols: ['openai:chat-completions', 'openai:responses'],
};
function open(catalog = [discovered], onClose = vi.fn()) {
  return render(
    <ModelManagementPanel
      provider={provider}
      config={mocks.config}
      apiKey={undefined}
      onClose={onClose}
      onSaveCustomModels={vi.fn(async () => {})}
      onSetPrimaryModel={vi.fn(async () => {})}
      onRefresh={mocks.refresh}
      discoveryAction={async () => catalog}
    />,
  );
}

describe('Token Dance managed model additions', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.config = {
      ...DEFAULT_CONFIG,
      presetCustomModels: {},
      presetRemovedModels: {},
    };
    await i18n.changeLanguage('en-US');
  });
  it('adds a manual ID with catalog capabilities and executes the restored model using Responses', async () => {
    open();
    await screen.findByText('Future Chat');
    const input = screen.getByPlaceholderText(
      'Enter a model ID, press Enter to configure and add',
    );
    fireEvent.change(input, { target: { value: discovered.id } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mocks.config.presetCustomModels?.tokendance?.[0]?.model).toBe(
        discovered.id,
      ),
    );
    const saved = JSON.parse(JSON.stringify(mocks.config));
    const restored = mergePresetCustomModels(
      [provider],
      saved.presetCustomModels,
    )[0];
    expect(
      resolveProviderForModel(restored, discovered.id).upstreamFormat,
    ).toBe('responses');
  });
  it('blocks an unknown manual ID without manufacturing a protocol', async () => {
    open();
    await screen.findByText('Future Chat');
    const input = screen.getByPlaceholderText(
      'Enter a model ID, press Enter to configure and add',
    );
    fireEvent.change(input, { target: { value: 'unknown-id' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Cannot confirm this model’s supported protocols/);
    expect(mocks.config.presetCustomModels?.tokendance).toBeUndefined();
  });
  it('contains keyboard focus in the model panel and nested editor, with named row actions', async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const panel = open([discovered], close);
    await screen.findByText('Future Chat');
    const dialog = screen.getByRole('dialog');
    const closeButton = within(dialog).getByRole('button', { name: 'Close' });
    expect(closeButton).toHaveFocus();
    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.tab();
    expect(closeButton).toHaveFocus();
    const remove = within(dialog).getAllByRole('button', {
      name: /Remove model/,
    })[0];
    expect(remove.className).toContain('group-focus-within:opacity-100');
    const input = screen.getByPlaceholderText(
      'Enter a model ID, press Enter to configure and add',
    );
    await user.click(input);
    await user.type(input, 'future-chat{Enter}');
    const editor = screen.getAllByRole('dialog').find((el) => el !== dialog)!;
    const name = within(editor).getByRole('textbox', { name: 'Display name' });
    expect(name).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(editor).getByRole('button', { name: 'Save' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(close).not.toHaveBeenCalled();
    expect(input).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(close).toHaveBeenCalledTimes(1);
    panel.unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});
