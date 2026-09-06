import { act, renderHook, waitFor } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTokenDanceBalance } from './useTokenDanceBalance';
import type { TokenDanceBalance } from '../../../shared/tokendance';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

describe('Token Dance balance identity', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    Object.defineProperty(crypto, 'subtle', {
      configurable: true,
      value: webcrypto.subtle,
    });
  });
  it('coalesces refreshes, clears a previous account immediately and discards its late result', async () => {
    const pending: Array<{
      version: string;
      resolve: (value: TokenDanceBalance) => void;
    }> = [];
    mocks.invoke.mockImplementation(
      (_command, { accountVersion }) =>
        new Promise((resolve) =>
          pending.push({ version: accountVersion, resolve }),
        ),
    );
    const hook = renderHook(({ apiKey }) => useTokenDanceBalance(apiKey), {
      initialProps: { apiKey: 'first-test-key' },
    });
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => {
      void hook.result.current.refresh();
      void hook.result.current.refresh();
    });
    expect(pending).toHaveLength(1);
    hook.rerender({ apiKey: 'second-test-key' });
    expect(hook.result.current.data).toBeUndefined();
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () =>
      pending[0].resolve({
        accountVersion: pending[0].version,
        balance: 999000000,
        credits: 999000000,
        creditsUsed: 0,
      }),
    );
    expect(hook.result.current.data).toBeUndefined();
    await act(async () =>
      pending[1].resolve({
        accountVersion: pending[1].version,
        balance: 0,
        credits: 0,
        creditsUsed: 0,
      }),
    );
    expect(hook.result.current.data?.balance).toBe(0);
  });
  it('preserves a last known value on failure and does not infer invalid credentials from a generic error', async () => {
    mocks.invoke.mockImplementation(async (_command, { accountVersion }) => ({
      accountVersion,
      balance: 1,
      credits: 1,
      creditsUsed: 0,
    }));
    const hook = renderHook(() => useTokenDanceBalance('test-key'));
    await waitFor(() => expect(hook.result.current.data?.balance).toBe(1));
    mocks.invoke.mockRejectedValue({
      code: 'request_failed',
      message: 'request_failed',
    });
    await act(async () => hook.result.current.refresh());
    expect(hook.result.current.data?.balance).toBe(1);
    expect(hook.result.current.error?.recoveryAction).toBeUndefined();
    expect(hook.result.current.updatedAt).toBeTypeOf('number');
  });
  it('refreshes when a mounted Settings tab becomes active without polling while hidden', async () => {
    mocks.invoke.mockImplementation(async (_command, { accountVersion }) => ({
      accountVersion,
      balance: 100,
      credits: 100,
      creditsUsed: 0,
    }));
    const hook = renderHook(
      ({ active }) => useTokenDanceBalance('test-key', active),
      {
        initialProps: { active: false },
      },
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
    hook.rerender({ active: true });
    await waitFor(() => expect(hook.result.current.data?.balance).toBe(100));
    hook.rerender({ active: false });
    act(() => window.dispatchEvent(new Event('focus')));
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    hook.rerender({ active: true });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
  });
});
