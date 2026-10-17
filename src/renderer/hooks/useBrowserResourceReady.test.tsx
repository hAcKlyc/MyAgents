import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserResourceStatus } from '../../shared/browserTools';
import { useBrowserResourceStatus } from './useBrowserResourceReady';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listener: null as null | ((event: { payload: BrowserResourceStatus }) => void) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => true }));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: (_: string, fn: typeof mocks.listener) => { mocks.listener = fn; return Promise.resolve(); } }));

describe('browser resource query recovery', () => {
  beforeEach(() => { mocks.invoke.mockReset(); mocks.listener = null; });
  it('reports a failed initial read and recovers on an authoritative event', async () => {
    mocks.invoke.mockRejectedValue(new Error('native unavailable'));
    const { result } = renderHook(() => useBrowserResourceStatus());
    await waitFor(() => expect(result.current).toBeUndefined());
    const ready: BrowserResourceStatus = { state: 'ready', requiredRevision: 'r1', installedRevision: 'r1', installAuthorized: true,
      retryable: false, automaticRetryCount: 0, statusRevision: 7, updatedAt: '' };
    act(() => mocks.listener!({ payload: ready }));
    expect(result.current).toEqual(ready);
  });
});
