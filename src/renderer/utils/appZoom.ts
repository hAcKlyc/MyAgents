import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';

export type AppZoomAction = 'in' | 'out' | 'reset';
const LEVELS = [0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const STORAGE_KEY = 'myagents:ui-zoom';

// Window-local view preference, like tab persistence; never writes config.json.
// Native page zoom keeps viewport units, fixed overlays and pointer coordinates
// in the same coordinate system, including editors with pixel-based typography.
export function createAppZoomController() {
  let desired = 1;
  try {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    if (LEVELS.includes(saved)) desired = saved;
  } catch { /* Storage denial must not prevent opening the app. */ }

  let applied = 1;
  let pending = Promise.resolve();
  const apply = (level: number) => {
    pending = pending.then(async () => {
      try {
        if (isTauri()) {
          await getCurrentWebview().setZoom(level);
        } else {
          // Browser development uses CSS zoom; desktop always uses WebView zoom.
          document.documentElement.style.zoom = String(level);
          // Unlike native page zoom, CSS zoom does not resize viewport units.
          document.documentElement.style.setProperty('--app-viewport-height', `${100 / level}vh`);
          window.dispatchEvent(new Event('resize'));
        }
        applied = level;
        try {
          if (level === 1) localStorage.removeItem(STORAGE_KEY);
          else localStorage.setItem(STORAGE_KEY, String(level));
        } catch { /* Zoom remains usable when storage is unavailable. */ }
      } catch (error) {
        if (desired === level) desired = applied;
        console.warn('[AppZoom] Could not change interface zoom', error);
      }
    });
    return pending;
  };

  const ready = desired === 1 ? pending : apply(desired);
  return {
    ready,
    change(action: AppZoomAction): Promise<void> {
      const index = LEVELS.indexOf(desired);
      const next = action === 'reset' ? 1
        : LEVELS[Math.max(0, Math.min(LEVELS.length - 1, index + (action === 'in' ? 1 : -1)))];
      if (next === desired) return pending;
      desired = next;
      return apply(next);
    },
  };
}

let controller: ReturnType<typeof createAppZoomController> | undefined;

/** Called only by the main window, never the fixed-size floating ball windows. */
export function initializeAppZoom() {
  controller ??= createAppZoomController();
  return controller;
}

export function changeAppZoom(action: AppZoomAction): void {
  void initializeAppZoom().change(action);
}
