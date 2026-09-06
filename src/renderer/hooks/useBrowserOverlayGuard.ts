/**
 * useBrowserOverlayGuard — Detects visible overlay backdrops that would
 * cover the native browser Webview.
 *
 * Returns `true` when a full-screen overlay backdrop is present, `false` otherwise.
 * The caller (BrowserPanel) uses this in a combined visibility effect to decide
 * whether to show/hide the native Webview.
 *
 * Modal backdrops are centrally owned per specs/DESIGN.md §5.5. The current
 * DOM detection contract is `backdrop-blur` + `position: fixed`; this
 * distinguishes full-screen overlays (modals, panels) from small fixed
 * elements (toasts, tooltips) which don't use backdrop-blur.
 *
 * Also checks `data-suppress-browser` attribute as a manual escape hatch.
 *
 * Scans only `document.body` direct children (overlays use `createPortal`
 * to body). MutationObserver on childList only + rAF debounce for minimal overhead.
 */

import { useEffect, useRef, useState } from 'react';

function checkOverlays(): boolean {
  // Manual escape hatch
  if (document.querySelector('[data-suppress-browser]')) return true;

  // Scan body's direct children for overlay backdrops.
  // Design system convention: overlays use position:fixed + backdrop-blur.
  // This skips toasts, tooltips, and other small fixed elements.
  for (const child of document.body.children) {
    if (!(child instanceof HTMLElement)) continue;
    const style = getComputedStyle(child);
    // Older WebKit only exposes the prefixed property. CSSOM returns an
    // empty string for unsupported properties; the JS accessor may be absent.
    if (
      style.position === 'fixed' &&
      (style.getPropertyValue('backdrop-filter').includes('blur') ||
        style.getPropertyValue('-webkit-backdrop-filter').includes('blur'))
    ) {
      return true;
    }
  }
  return false;
}

export function useBrowserOverlayGuard(active: boolean): boolean {
  const [overlayDetected, setOverlayDetected] = useState(false);
  const rafIdRef = useRef(0);

  useEffect(() => {
    if (!active) return;

    const sync = () => {
      setOverlayDetected(checkOverlays());
    };

    const debouncedSync = () => {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(sync);
    };

    // Only watch body's direct children (where createPortal mounts overlays)
    const observer = new MutationObserver(debouncedSync);
    observer.observe(document.body, { childList: true });

    // Initial check
    sync();

    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafIdRef.current);
      setOverlayDetected(false);
    };
  }, [active]);

  return overlayDetected;
}
