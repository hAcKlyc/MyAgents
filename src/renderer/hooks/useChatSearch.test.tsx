import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatSearch } from './useChatSearch';
import type { Message } from '@/types/chat';

class TestHighlight {
  private ranges: Range[];

  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }

  clear(): void {
    this.ranges = [];
  }

  add(range: Range): void {
    this.ranges.push(range);
  }

  get size(): number {
    return this.ranges.length;
  }
}

describe('useChatSearch', () => {
  const originalCss = globalThis.CSS;
  const originalHighlight = (globalThis as unknown as { Highlight?: unknown }).Highlight;
  const originalRangeGetBoundingClientRect = Range.prototype.getBoundingClientRect;
  const rect = {
    x: 0,
    y: 40,
    top: 40,
    right: 100,
    bottom: 60,
    left: 0,
    width: 100,
    height: 20,
    toJSON: () => ({}),
  } as DOMRect;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: vi.fn(() => rect),
    });
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: {
        escape: (value: string) => value.replace(/"/g, '\\"'),
        highlights: {
          set: vi.fn(),
          delete: vi.fn(),
        },
      },
    });
    Object.defineProperty(globalThis, 'Highlight', {
      configurable: true,
      value: TestHighlight,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalRangeGetBoundingClientRect) {
      Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
        configurable: true,
        value: originalRangeGetBoundingClientRect,
      });
    } else {
      Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
    }
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: originalCss,
    });
    Object.defineProperty(globalThis, 'Highlight', {
      configurable: true,
      value: originalHighlight,
    });
  });

  it('makes matches available during continuous output and preserves the selected message on prepend', () => {
    const base: Message = { id: 'first', role: 'assistant', timestamp: new Date(0), content: 'needle' };
    const scrollerRef = { current: document.createElement('div') };
    const { result, rerender } = renderHook(({ messages }: { messages: Message[] }) =>
      useChatSearch({ active: true, messages, scrollerRef, scrollToMessage: vi.fn(), pauseAutoScroll: vi.fn() }),
      { initialProps: { messages: [base] } });
    act(() => result.current.setQuery('needle'));
    const tail = { ...base, id: 'tail' };
    for (let i = 0; i < 5; i++) {
      act(() => vi.advanceTimersByTime(33));
      rerender({ messages: [base, { ...tail, content: 'needle'.slice(0, i + 2) }] });
    }
    expect(result.current.matchCount).toBe(1);
    act(() => vi.advanceTimersByTime(150));
    expect(result.current.matchCount).toBe(2);
    act(() => result.current.next());
    rerender({ messages: [{ ...base, id: 'older' }, base, tail] });
    act(() => vi.advanceTimersByTime(151));
    expect(result.current.currentIndex).toBe(2);
  });

  it('pauses following before scrolling an already-mounted match', () => {
    const pauseAutoScroll = vi.fn();
    const scrollToMessage = vi.fn(() => () => true);
    const scroller = document.createElement('div');
    const scope = document.createElement('div');
    scope.setAttribute('data-chat-search-scope', '');
    scope.setAttribute('data-message-id', 'm1');
    scope.textContent = 'mounted needle';
    scroller.appendChild(scope);
    Object.defineProperty(scroller, 'scrollBy', { value: vi.fn(() => {
      expect(pauseAutoScroll).toHaveBeenCalled();
    }) });
    const { result } = renderHook(() => useChatSearch({
      active: true,
      messages: [{ id: 'm1', role: 'assistant', content: 'mounted needle', timestamp: new Date(0) }],
      scrollerRef: { current: scroller },
      scrollToMessage,
      pauseAutoScroll,
    }));
    act(() => result.current.setQuery('needle'));
    act(() => vi.advanceTimersByTime(151));
    act(() => result.current.next());
    expect(pauseAutoScroll).toHaveBeenCalledTimes(1);
    expect(scrollToMessage).not.toHaveBeenCalled();
  });

  it('routes virtualized matches through the chat scroll controller', () => {
    const scrollToMessage = vi.fn(() => () => true);
    const scroller = document.createElement('div');
    const messages: Message[] = [
      { id: 'm1', role: 'user', content: 'first needle', timestamp: new Date(0) },
      { id: 'm2', role: 'assistant', content: 'second needle', timestamp: new Date(1) },
    ];

    const { result } = renderHook(() => useChatSearch({
      active: true,
      messages,
      scrollerRef: { current: scroller },
      scrollToMessage,
      pauseAutoScroll: vi.fn(),
    }));

    act(() => {
      result.current.setQuery('needle');
    });
    act(() => {
      vi.advanceTimersByTime(151);
    });

    expect(result.current.matchCount).toBe(2);

    act(() => {
      result.current.next();
    });

    expect(scrollToMessage).toHaveBeenCalledWith('m2', {
      behavior: 'auto',
      align: 'center',
    });
  });

  it.each([false, true])('refines a mounted virtualized match only while navigation is current (cancelled=%s)', (cancelled) => {
    let navigationCurrent = true;
    const scrollToMessage = vi.fn(() => () => navigationCurrent);
    const pauseAutoScroll = vi.fn();
    const scrollBy = vi.fn(() => {
      expect(pauseAutoScroll).toHaveBeenCalledTimes(1);
      expect(pauseAutoScroll.mock.invocationCallOrder[0]).toBeGreaterThan(scrollToMessage.mock.invocationCallOrder[0]);
    });
    const scroller = document.createElement('div');
    Object.defineProperty(scroller, 'scrollBy', {
      configurable: true,
      value: scrollBy,
    });
    Object.defineProperty(scroller, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        ...rect,
        top: 0,
        bottom: 200,
        height: 200,
      }),
    });
    const messages: Message[] = [
      { id: 'm1', role: 'user', content: 'first needle', timestamp: new Date(0) },
      { id: 'm2', role: 'assistant', content: 'second needle', timestamp: new Date(1) },
    ];

    const { result } = renderHook(() => useChatSearch({
      active: true,
      messages,
      scrollerRef: { current: scroller },
      scrollToMessage,
      pauseAutoScroll,
    }));

    act(() => {
      result.current.setQuery('needle');
    });
    act(() => {
      vi.advanceTimersByTime(151);
    });
    act(() => {
      result.current.next();
    });

    // Old behavior gave up after two rAFs. Keep the target unmounted long
    // enough to cross that boundary, then mount it inside the bounded retry
    // window.
    act(() => {
      vi.advanceTimersByTime(80);
    });
    if (cancelled) navigationCurrent = false;
    const scope = document.createElement('div');
    scope.setAttribute('data-chat-search-scope', '');
    scope.setAttribute('data-message-id', 'm2');
    scope.textContent = 'second needle';
    scroller.appendChild(scope);
    act(() => {
      vi.advanceTimersByTime(80);
    });

    expect(scrollToMessage).toHaveBeenCalledWith('m2', {
      behavior: 'auto',
      align: 'center',
    });
    expect(scrollBy.mock.calls.length > 0).toBe(!cancelled);
    expect(scope.classList.contains('chat-search-msg-pulse')).toBe(!cancelled);
  });
});
