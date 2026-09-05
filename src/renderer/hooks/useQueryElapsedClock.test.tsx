import { act, renderHook } from '@testing-library/react';
import { StrictMode, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useQueryElapsedClock } from './useQueryElapsedClock';

describe('Tab query elapsed clock', () => {
  let now = 0;
  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });
  afterEach(() => vi.restoreAllMocks());

  function setup() {
    return renderHook(({ active, paused, sessionId }) => useQueryElapsedClock(active, paused, sessionId), {
      initialProps: { active: false, paused: false, sessionId: 'pending-tab' as string | null },
      wrapper: ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode>,
    });
  }

  it('starts on query activity, keeps subsecond active time across multiple human waits, and resets on completion', () => {
    const { result, rerender } = setup();
    now = 5000;
    expect(result.current()).toBe(0);
    rerender({ active: true, paused: false, sessionId: 'pending-tab' });
    const read = result.current;
    now = 6600;
    expect(read()).toBe(1);
    rerender({ active: true, paused: true, sessionId: 'pending-tab' });
    now = 36600;
    expect(read()).toBe(1);
    rerender({ active: true, paused: false, sessionId: 'pending-tab' });
    now = 37200;
    rerender({ active: true, paused: true, sessionId: 'pending-tab' });
    now = 67200;
    expect(read()).toBe(2); // 1.6 + 0.6, not two separately rounded fragments.
    rerender({ active: true, paused: false, sessionId: 'pending-tab' });
    now = 68000;
    expect(read()).toBe(3);
    expect(result.current).toBe(read);
    rerender({ active: false, paused: false, sessionId: 'pending-tab' });
    now = 78000;
    expect(read()).toBe(0);
    rerender({ active: true, paused: false, sessionId: 'pending-tab' });
    now = 80000;
    expect(read()).toBe(2);
  });

  it('preserves first-query materialization but isolates a different Session', () => {
    const { result, rerender } = setup();
    rerender({ active: true, paused: false, sessionId: null });
    now = 2000;
    rerender({ active: true, paused: false, sessionId: 'pending-tab' });
    now = 3000;
    rerender({ active: true, paused: false, sessionId: 'real-a' });
    now = 5000;
    expect(result.current()).toBe(5);
    rerender({ active: true, paused: false, sessionId: 'real-b' });
    expect(result.current()).toBe(0);
    now = 6000;
    expect(result.current()).toBe(1);
    rerender({ active: false, paused: false, sessionId: null });
    expect(result.current()).toBe(0);
  });

  it('can attach while waiting and never counts time before the user responds', () => {
    const { result, rerender } = setup();
    rerender({ active: true, paused: true, sessionId: 'real-a' });
    now = 60000;
    expect(result.current()).toBe(0);
    rerender({ active: true, paused: false, sessionId: 'real-a' });
    now = 62500;
    expect(result.current()).toBe(2);
  });

  it('samples continuously without scheduling Tab-wide timer renders', () => {
    const schedule = vi.spyOn(globalThis, 'setInterval');
    const { result, rerender } = setup();
    rerender({ active: true, paused: false, sessionId: 'real-a' });
    expect(schedule).not.toHaveBeenCalled();
    act(() => { now = 120000; });
    expect(result.current()).toBe(120);
  });
});
