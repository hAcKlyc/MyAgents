import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { beginComposerUpdateCheckpoint, clearComposerUpdateHandoff, loadComposerUpdateHandoff } from '@/utils/composerUpdateCheckpoint';
import { serializeTabs, deserializeTabs } from '@/utils/tabPersistence';
import type { Tab } from '@/types/tab';
import CronTaskSettingsModal, { type CronInitialConfig } from './CronTaskSettingsModal';

vi.mock('@/../shared/appProfile', async original => ({ ...(await original<Record<string, unknown>>()), APP_BUILD_PROFILE: 'moxbot' }));
vi.mock('@/utils/browserMock', () => ({ isBrowserDevMode: () => false }));
vi.mock('@/config/services/configStore', () => ({ getConfigDir: async () => '/synthetic/qa', safeLoadJson: async () => null, safeWriteJson: vi.fn() }));
vi.mock('@tauri-apps/api/path', () => ({ join: async (...parts: string[]) => parts.join('/') }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: async () => false, remove: vi.fn() }));
vi.mock('@/hooks/useDeliveryChannels', () => ({ useDeliveryChannels: () => ({ options: [], hasChannels: false, resolveDelivery: vi.fn() }) }));

const tab = { id: 'tab-a', view: 'chat', agentDir: '/synthetic', sessionId: 'session-a', title: 'Synthetic' } as Tab;
const config: CronInitialConfig = { taskKind: 'cron', prompt: '', intervalMinutes: 5,
  endConditions: { aiCanExit: true }, runMode: 'single_session', notifyEnabled: true,
  schedule: { kind: 'every', minutes: 5 } };
let lease: ReturnType<typeof beginComposerUpdateCheckpoint> | undefined;
beforeEach(async () => { await i18n.changeLanguage('en-US'); await loadComposerUpdateHandoff(deserializeTabs); });
afterEach(async () => { lease?.release(); lease = undefined; await clearComposerUpdateHandoff(); });

it.each([null, config])('does not block an untouched settings window: %j', async initialConfig => {
  const onConfirm = vi.fn();
  render(<CronTaskSettingsModal isOpen initialConfig={initialConfig} onClose={vi.fn()} onConfirm={onConfirm} />);
  act(() => { lease = beginComposerUpdateCheckpoint(serializeTabs); });
  await lease!.persist([tab], tab.id); lease!.verify([tab], tab.id);
  expect(onConfirm).not.toHaveBeenCalled();
});

it('retains unconfirmed form edits and permits an update after the user confirms them', async () => {
  const onConfirm = vi.fn(), onClose = vi.fn();
  const view = render(<CronTaskSettingsModal isOpen initialConfig={config} onClose={onClose} onConfirm={onConfirm} />);
  fireEvent.click(screen.getByRole('switch'));
  expect(() => beginComposerUpdateCheckpoint(serializeTabs)).toThrow('unconfirmed changes');
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  expect(onConfirm).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ notifyEnabled: false }));
  view.rerender(<CronTaskSettingsModal isOpen={false} initialConfig={config} onClose={onClose} onConfirm={onConfirm} />);
  act(() => { lease = beginComposerUpdateCheckpoint(serializeTabs); });
  await lease!.persist([tab], tab.id);
});

it('detects form changes even after an initially clean checkpoint was captured', async () => {
  render(<CronTaskSettingsModal isOpen initialConfig={config} onClose={vi.fn()} onConfirm={vi.fn()} />);
  act(() => { lease = beginComposerUpdateCheckpoint(serializeTabs); });
  await lease!.persist([tab], tab.id);
  // Fault injection: native input is inert while frozen, but a programmatic
  // state change must still fail the final checkpoint instead of losing it.
  fireEvent.click(screen.getByRole('switch'));
  expect(() => lease!.verify([tab], tab.id)).toThrow('unconfirmed changes');
  await lease!.abort(); act(() => lease!.release());
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
});
