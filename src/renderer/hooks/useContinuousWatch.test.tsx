import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useContinuousWatch } from './useContinuousWatch';

afterEach(() => vi.unstubAllGlobals());

it('updates rendered subscription state after registration and unsubscribe', async () => {
  const fetch = vi.fn(async () => ({ json: async () => ({ accepted: true }) }));
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useContinuousWatch({ sessionId: 'synthetic-session', handlers: {} }));
  await waitFor(() => expect(result.current.isSubscribed).toBe(true));
  expect(result.current.watchId).toMatch(/^watch-/);
  await act(() => result.current.unsubscribe());
  expect(result.current.isSubscribed).toBe(false);
  expect(result.current.watchId).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
});
