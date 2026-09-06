import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBrowserOverlayGuard } from './useBrowserOverlayGuard';

// Model the host CSSOM, including old WebKit where the standard JS property
// is absent. Existing BrowserPanel tests mock this hook and miss that boundary.
function appendFixedElement(standard?: string, webkit = '', position = 'fixed') {
  const element = document.createElement('div');
  document.body.append(element);
  const original = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation(target => {
    if (target !== element) return original(target);
    const style = original(target);
    Object.defineProperties(style, {
      position: { value: position },
      backdropFilter: { value: standard },
      webkitBackdropFilter: { value: webkit },
    });
    vi.spyOn(style, 'getPropertyValue').mockImplementation(property => {
      if (property === 'backdrop-filter') return standard ?? '';
      if (property === '-webkit-backdrop-filter') return webkit;
      return '';
    });
    return style;
  });
  return element;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('native browser overlay detection across WebView CSS capabilities', () => {
  it.each([
    { name: 'old WebKit fixed toast', standard: undefined, webkit: 'none', expected: false },
    { name: 'old WebKit modal', standard: undefined, webkit: 'blur(4px)', expected: true },
    { name: 'unsupported backdrop filters', standard: undefined, webkit: '', expected: false },
    { name: 'standard modal', standard: 'blur(4px)', webkit: '', expected: true },
    { name: 'standard fixed toast', standard: 'none', webkit: '', expected: false },
    { name: 'unrelated filter', standard: 'brightness(0.5)', webkit: '', expected: false },
  ])('$name', ({ standard, webkit, expected }) => {
    appendFixedElement(standard, webkit);
    const { result } = renderHook(() => useBrowserOverlayGuard(true));
    expect(result.current).toBe(expected);
  });

  it('ignores non-fixed blurred content', () => {
    appendFixedElement(undefined, 'blur(4px)', 'relative');
    const { result } = renderHook(() => useBrowserOverlayGuard(true));
    expect(result.current).toBe(false);
  });

  it('checks again when a native browser becomes alive', () => {
    appendFixedElement(undefined, 'blur(4px)');
    const { result, rerender } = renderHook(
      ({ active }) => useBrowserOverlayGuard(active),
      { initialProps: { active: false } },
    );
    expect(result.current).toBe(false);
    rerender({ active: true });
    expect(result.current).toBe(true);
    rerender({ active: false });
    expect(result.current).toBe(false);
  });

  it('tracks prefixed modal insertion and removal after mount', async () => {
    const { result } = renderHook(() => useBrowserOverlayGuard(true));
    expect(result.current).toBe(false);
    let modal!: HTMLElement;
    await act(async () => { modal = appendFixedElement(undefined, 'blur(4px)'); });
    act(() => { vi.advanceTimersToNextFrame(); });
    expect(result.current).toBe(true);
    await act(async () => { modal.remove(); });
    act(() => { vi.advanceTimersToNextFrame(); });
    expect(result.current).toBe(false);
  });

  it('keeps explicit browser suppression independent of CSS support', () => {
    const element = appendFixedElement();
    element.setAttribute('data-suppress-browser', '');
    const { result } = renderHook(() => useBrowserOverlayGuard(true));
    expect(result.current).toBe(true);
  });
});
