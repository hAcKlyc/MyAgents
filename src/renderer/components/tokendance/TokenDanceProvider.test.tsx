import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { DEFAULT_CONFIG, PRESET_PROVIDERS } from '../../../shared/config-types';
import type { TokenDanceAuthView } from '../../../shared/tokendance';
import TokenDanceProvider from './TokenDanceProvider';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  refresh: vi.fn(async () => {}),
  open: vi.fn(async () => {}),
  listeners: new Map<string, (e: { payload: TokenDanceAuthView }) => void>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/utils/tauriListen', () => ({
  listenWithCleanup: vi.fn(async (name, handler, signal) => {
    mocks.listeners.set(name, handler);
    signal.addEventListener('abort', () => mocks.listeners.delete(name));
  }),
}));
vi.mock('@/hooks/useCloseLayer', () => ({ useCloseLayer: vi.fn() }));
vi.mock('@/config/useConfigData', () => ({
  useConfigData: () => ({ config: DEFAULT_CONFIG, apiKeys: {} }),
}));
vi.mock('@/config/useConfigActions', () => ({
  useConfigActions: () => ({ refreshProviderData: mocks.refresh }),
}));
vi.mock('@/utils/openExternal', () => ({ openExternal: mocks.open }));

const provider = PRESET_PROVIDERS.find((p) => p.id === 'tokendance')!;
const view: TokenDanceAuthView = {
  id: 'flow-1',
  phase: 'waiting',
  authUrl: 'https://tokendance.space/auth?test=only',
};
const emit = (next: TokenDanceAuthView) =>
  act(() => mocks.listeners.get('tokendance:auth-changed')!({ payload: next }));

describe('Token Dance authorization panel', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
    vi.clearAllMocks();
    mocks.listeners.clear();
    let opened = false;
    mocks.invoke.mockImplementation(async (command) => {
      if (command === 'cmd_tokendance_auth_status') return null;
      if (command === 'cmd_tokendance_auth_open') {
        const isNew = !opened;
        opened = true;
        return { view, isNew };
      }
      return undefined;
    });
  });
  it('keeps a balance placeholder and login guidance in the logged-out provider details', async () => {
    render(<TokenDanceProvider provider={provider} />);
    fireEvent.click(screen.getByRole('button', { name: 'Provider details' }));
    expect(
      within(screen.getByRole('dialog')).getByText('Account balance —'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Log in to view your balance and top up.'),
    ).toBeInTheDocument();
  });
  it('closes only the panel, reuses authorization, and auto-dismisses when native saving succeeds', async () => {
    render(<TokenDanceProvider provider={provider} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(1));
    expect(
      screen.getByText('Log in and authorize on the webpage that opened'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith(
      'cmd_tokendance_auth_close',
      expect.objectContaining({ viewerId: expect.any(String) }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'View progress' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Open page' })).toBeEnabled(),
    );
    expect(mocks.open).toHaveBeenCalledTimes(1);
    emit({ ...view, phase: 'saving' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    emit({ ...view, phase: 'connected' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.refresh).toHaveBeenCalled();
  });
  it('keeps failures visible, retries saving without starting another authorization, and does not steal focus after close', async () => {
    render(<TokenDanceProvider provider={provider} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(1));
    emit({
      ...view,
      phase: 'save-failed',
      error: { code: 'save_failed', message: 'save_failed' },
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Retry saving',
      }),
    );
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        'cmd_tokendance_auth_retry_save',
        { id: view.id },
      ),
    );
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === 'cmd_tokendance_auth_open',
      ),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    emit({ ...view, phase: 'connected' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.refresh).toHaveBeenCalled();
  });
});
