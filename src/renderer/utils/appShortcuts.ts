/**
 * appShortcuts — the single declarative source of truth for application-level
 * keyboard shortcuts (new tab, close tab, switch tab, open task-center/settings,
 * reload-block).
 *
 * Previously these lived as a scattered if/else ladder inside App.tsx's global
 * keydown handler, with no way to surface them to the user. This table centralizes:
 *   1. `match`   — a pure predicate (what key combo triggers it),
 *   2. `run`     — the side effect, taking a context of primitives so the table
 *                  stays free of App.tsx internals (no closures captured here),
 *   3. `keys`    — a platform-aware display string for the Settings reference
 *                  (omitted ⇒ hidden, e.g. the reload-block).
 *
 * App.tsx builds the context and dispatches via {@link dispatchAppShortcut};
 * Settings renders the visible rows from {@link APP_SHORTCUTS}. Changing a
 * binding or its label is a one-line edit here that both consumers pick up —
 * no drift. (User-rebindable shortcuts are intentionally out of scope; this is
 * the structure they would grow from.)
 */

import { isImeComposingEvent } from './imeKeyboard';
import type { AppZoomAction } from './appZoom';

/** Structural subset of a keyboard event — satisfied by the native KeyboardEvent. */
export interface KeyboardEventLike {
  isComposing?: boolean;
  keyCode?: number;
  key: string;
  code: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  preventDefault: () => void;
  stopPropagation?: () => void;
}

/** Primitives a shortcut's `run` may use — supplied by App.tsx at dispatch time. */
export interface AppShortcutContext {
  tabs: readonly { id: string }[];
  activeTabId: string | null;
  setActiveTabId: (id: string) => void;
  newTab: () => void;
  closeCurrentTab: () => void;
  /** Dismiss the topmost overlay layer; returns true if one was dismissed. */
  dismissTopmost: () => boolean;
  /** True when a full-screen blocking backdrop (modal) is mounted. */
  hasBlockingBackdrop: () => boolean;
  openTaskCenter: () => void;
  openSettings: () => void;
  changeZoom: (action: AppZoomAction) => void;
}

export interface AppShortcut {
  id: string;
  /** Platform-aware key-combo display. Omitted ⇒ hidden from the reference. */
  keys?: (isMac: boolean) => string;
  /** Pure predicate — does this event trigger the shortcut? */
  match: (e: KeyboardEventLike, isMac: boolean) => boolean;
  /** Side effect on match. */
  run: (ctx: AppShortcutContext, e: KeyboardEventLike) => void;
}

/** The platform-canonical "command" modifier (⌘ on macOS, Ctrl elsewhere). */
const modHeld = (e: KeyboardEventLike, isMac: boolean): boolean => (isMac ? e.metaKey : e.ctrlKey);
const modLabel = (isMac: boolean): string => (isMac ? '⌘' : 'Ctrl');

/** Move the active tab by `delta`, optionally wrapping. Shared by cycle + bracket. */
function shiftActiveTab(ctx: AppShortcutContext, delta: number, wrap: boolean): void {
  const { tabs, activeTabId } = ctx;
  if (tabs.length <= 1 || !activeTabId) return;
  const idx = tabs.findIndex((t) => t.id === activeTabId);
  if (idx === -1) return;
  const next = wrap
    ? (idx + delta + tabs.length) % tabs.length
    : idx + delta;
  if (next >= 0 && next < tabs.length) ctx.setActiveTabId(tabs[next].id);
}

/**
 * Ordered shortcut table. Dispatch tries each in order and stops at the first
 * match, mirroring the original handler's precedence (reload-block and Ctrl+Tab
 * are evaluated before the ⌘-gated entries).
 */
export const APP_SHORTCUTS: AppShortcut[] = [
  ...(['in', 'out', 'reset'] as const).map((action): AppShortcut => ({
    id: `zoom-${action}`,
    keys: (isMac) => `${isMac ? '⌘ / Ctrl' : 'Ctrl'} + ${action === 'in' ? '+' : action === 'out' ? '−' : '0'}`,
    match: (e, isMac) => {
      if (!(e.ctrlKey || (isMac && e.metaKey)) || e.altKey) return false;
      if (action === 'in') return e.key === '+' || e.key === '=' || e.code === 'NumpadAdd';
      if (action === 'out') return !e.shiftKey && (e.key === '-' || e.code === 'NumpadSubtract');
      return !e.shiftKey && e.key === '0';
    },
    run: (ctx, e) => {
      // Capture owner: embedded editors must not also apply their own font zoom.
      e.stopPropagation?.();
      ctx.changeZoom(action);
    },
  })),
  {
    // Block reload (F5 / ⌘|Ctrl+R / ⌘|Ctrl+Shift+R). Reload wipes in-memory tab
    // state and tears down every Sidecar (~30s cold-start) — never allowed.
    // Hidden from the reference (it's a block, not a user action).
    id: 'block-reload',
    match: (e, isMac) =>
      e.key === 'F5'
      || (modHeld(e, isMac) && !e.altKey && (e.key === 'r' || e.key === 'R' || e.code === 'KeyR')),
    run: () => { /* no-op: matched purely to preventDefault */ },
  },
  {
    // Ctrl+Tab / Ctrl+Shift+Tab — cycle tabs (Ctrl on BOTH platforms by convention).
    id: 'cycle-tab',
    keys: () => 'Ctrl + Tab',
    match: (e) => e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab',
    run: (ctx, e) => shiftActiveTab(ctx, e.shiftKey ? -1 : 1, true),
  },
  {
    // ⌘/Ctrl + 1~9 — jump to the Nth tab (9 always = last).
    id: 'jump-to-tab',
    keys: (isMac) => `${modLabel(isMac)} + 1~9`,
    match: (e, isMac) => modHeld(e, isMac) && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key),
    run: (ctx, e) => {
      const { tabs } = ctx;
      if (tabs.length === 0) return;
      const digit = Number(e.key);
      const targetIdx = digit === 9 ? tabs.length - 1 : digit - 1;
      if (targetIdx < tabs.length) ctx.setActiveTabId(tabs[targetIdx].id);
    },
  },
  {
    // ⌘/Ctrl+T — new tab. `!shiftKey` lets ⌘+Shift+T flow through to the
    // Launcher's 任务/想法 mode-toggle chord.
    id: 'new-tab',
    keys: (isMac) => `${modLabel(isMac)} + T`,
    match: (e, isMac) => modHeld(e, isMac) && !e.shiftKey && !e.altKey && (e.key === 't' || e.key === 'T'),
    run: (ctx) => ctx.newTab(),
  },
  {
    // ⌘/Ctrl+Y — open Task Center (singleton tab).
    id: 'open-task-center',
    keys: (isMac) => `${modLabel(isMac)} + Y`,
    match: (e, isMac) => modHeld(e, isMac) && !e.shiftKey && !e.altKey && (e.key === 'y' || e.key === 'Y'),
    run: (ctx) => ctx.openTaskCenter(),
  },
  {
    // ⌘/Ctrl+U — open Settings.
    id: 'open-settings',
    keys: (isMac) => `${modLabel(isMac)} + U`,
    match: (e, isMac) => modHeld(e, isMac) && !e.shiftKey && !e.altKey && (e.key === 'u' || e.key === 'U'),
    run: (ctx) => ctx.openSettings(),
  },
  {
    // ⌘/Ctrl+W — dismiss topmost overlay, else close the current tab (unless a
    // blocking modal backdrop is up). On macOS the native menu usually emits
    // this; kept as the primary path on Windows/Linux and a defensive fallback.
    id: 'close-tab',
    keys: (isMac) => `${modLabel(isMac)} + W`,
    match: (e, isMac) => modHeld(e, isMac) && (e.key === 'w' || e.key === 'W'),
    run: (ctx) => {
      if (!ctx.dismissTopmost() && !ctx.hasBlockingBackdrop()) ctx.closeCurrentTab();
    },
  },
  {
    // ⌘/Ctrl+Shift+[ / ] — previous / next tab (no wrap).
    id: 'switch-tab-bracket',
    keys: (isMac) => `${modLabel(isMac)} + Shift + [ / ]`,
    match: (e, isMac) =>
      modHeld(e, isMac) && e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight'),
    run: (ctx, e) => shiftActiveTab(ctx, e.code === 'BracketLeft' ? -1 : 1, false),
  },
];

/** Shortcuts that should appear in the user-facing reference table (have `keys`). */
export const VISIBLE_APP_SHORTCUTS = APP_SHORTCUTS.filter((s) => s.keys);

/** First shortcut whose predicate matches this event, or null. Pure. */
export function matchAppShortcut(e: KeyboardEventLike, isMac: boolean): AppShortcut | null {
  if (isImeComposingEvent(e)) return null;
  for (const s of APP_SHORTCUTS) {
    if (s.match(e, isMac)) return s;
  }
  return null;
}

/**
 * Match + execute: on a hit, preventDefault and run the side effect. Returns
 * true if a shortcut handled the event. This is the entire App.tsx keydown body.
 */
export function dispatchAppShortcut(e: KeyboardEventLike, isMac: boolean, ctx: AppShortcutContext): boolean {
  const hit = matchAppShortcut(e, isMac);
  if (!hit) return false;
  e.preventDefault();
  hit.run(ctx, e);
  return true;
}
