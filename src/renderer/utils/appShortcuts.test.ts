import { describe, expect, it, vi } from 'vitest';

import { resources } from '@/i18n';
import {
  APP_SHORTCUTS,
  VISIBLE_APP_SHORTCUTS,
  dispatchAppShortcut,
  matchAppShortcut,
  type AppShortcutContext,
  type KeyboardEventLike,
} from './appShortcuts';

function ev(over: Partial<KeyboardEventLike> = {}): KeyboardEventLike {
  return {
    key: '',
    code: '',
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    preventDefault: () => {},
    ...over,
  };
}

const MAC = true;
const WIN = false;

function id(e: KeyboardEventLike, isMac: boolean): string | null {
  return matchAppShortcut(e, isMac)?.id ?? null;
}

describe('matchAppShortcut — characterization of every existing binding', () => {
  it('blocks reload: F5, ⌘/Ctrl+R, ⌘/Ctrl+Shift+R', () => {
    expect(id(ev({ key: 'F5' }), MAC)).toBe('block-reload');
    expect(id(ev({ key: 'F5' }), WIN)).toBe('block-reload');
    expect(id(ev({ metaKey: true, key: 'r' }), MAC)).toBe('block-reload');
    expect(id(ev({ ctrlKey: true, key: 'r' }), WIN)).toBe('block-reload');
    expect(id(ev({ metaKey: true, shiftKey: true, key: 'R' }), MAC)).toBe('block-reload');
    expect(id(ev({ metaKey: true, code: 'KeyR', key: 'Dead' }), MAC)).toBe('block-reload'); // non-Latin layout
    // ⌘+Alt+R is NOT blocked
    expect(id(ev({ metaKey: true, altKey: true, key: 'r' }), MAC)).toBeNull();
  });

  it('cycles tabs with Ctrl+Tab / Ctrl+Shift+Tab on both platforms', () => {
    expect(id(ev({ ctrlKey: true, key: 'Tab' }), MAC)).toBe('cycle-tab');
    expect(id(ev({ ctrlKey: true, key: 'Tab' }), WIN)).toBe('cycle-tab');
    expect(id(ev({ ctrlKey: true, shiftKey: true, key: 'Tab' }), MAC)).toBe('cycle-tab');
    // ⌘+Tab (mac system shortcut) is NOT ours
    expect(id(ev({ metaKey: true, key: 'Tab' }), MAC)).toBeNull();
  });

  it('jumps to tab on ⌘/Ctrl+1~9 (digit only, no shift)', () => {
    expect(id(ev({ metaKey: true, key: '1' }), MAC)).toBe('jump-to-tab');
    expect(id(ev({ ctrlKey: true, key: '9' }), WIN)).toBe('jump-to-tab');
    expect(id(ev({ metaKey: true, key: '0' }), MAC)).toBe('zoom-reset');
    expect(id(ev({ metaKey: true, shiftKey: true, key: '1' }), MAC)).toBeNull();
  });

  it('new-tab on ⌘/Ctrl+T but NOT ⌘+Shift+T (mode-toggle chord flows through)', () => {
    expect(id(ev({ metaKey: true, key: 't' }), MAC)).toBe('new-tab');
    expect(id(ev({ ctrlKey: true, key: 'T' }), WIN)).toBe('new-tab');
    expect(id(ev({ metaKey: true, shiftKey: true, key: 'T' }), MAC)).toBeNull();
  });

  it('task-center ⌘/Ctrl+Y, settings ⌘/Ctrl+U', () => {
    expect(id(ev({ metaKey: true, key: 'y' }), MAC)).toBe('open-task-center');
    expect(id(ev({ ctrlKey: true, key: 'u' }), WIN)).toBe('open-settings');
  });

  it('close-tab on ⌘/Ctrl+W (incl. with Shift, matching original)', () => {
    expect(id(ev({ metaKey: true, key: 'w' }), MAC)).toBe('close-tab');
    expect(id(ev({ ctrlKey: true, key: 'W' }), WIN)).toBe('close-tab');
    expect(id(ev({ metaKey: true, shiftKey: true, key: 'w' }), MAC)).toBe('close-tab');
  });

  it('bracket switch on ⌘/Ctrl+Shift+[ and ]', () => {
    expect(id(ev({ metaKey: true, shiftKey: true, code: 'BracketLeft' }), MAC)).toBe('switch-tab-bracket');
    expect(id(ev({ ctrlKey: true, shiftKey: true, code: 'BracketRight' }), WIN)).toBe('switch-tab-bracket');
    // without Shift → no match
    expect(id(ev({ metaKey: true, code: 'BracketLeft' }), MAC)).toBeNull();
  });

  it('platform isolation: the non-canonical modifier never triggers', () => {
    expect(id(ev({ ctrlKey: true, key: 't' }), MAC)).toBeNull(); // mac uses ⌘, not Ctrl
    expect(id(ev({ metaKey: true, key: 't' }), WIN)).toBeNull(); // win uses Ctrl, not ⌘
  });

  it('plain keys and unmatched combos return null', () => {
    expect(id(ev({ key: 't' }), MAC)).toBeNull();
    expect(id(ev({ key: 'a' }), MAC)).toBeNull();
    expect(id(ev({ metaKey: true, key: 'a' }), MAC)).toBeNull();
  });
});

function mkCtx(over: Partial<AppShortcutContext> = {}): AppShortcutContext {
  return {
    tabs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    activeTabId: 'a',
    setActiveTabId: vi.fn(),
    newTab: vi.fn(),
    closeCurrentTab: vi.fn(),
    dismissTopmost: vi.fn(() => false),
    hasBlockingBackdrop: vi.fn(() => false),
    openTaskCenter: vi.fn(),
    openSettings: vi.fn(),
    changeZoom: vi.fn(),
    ...over,
  };
}

describe('shortcut run() side effects', () => {
  it('handles zoom on both modifiers on Mac, including the unshifted + key and keypad', () => {
    const ctx = mkCtx();
    for (const isMac of [MAC, WIN]) {
      for (const modifier of isMac ? [{ metaKey: true }, { ctrlKey: true }] : [{ ctrlKey: true }]) {
        for (const combo of [{ key: '+' }, { key: '=', code: 'Equal' }, { code: 'NumpadAdd', key: '+' }]) {
          const preventDefault = vi.fn();
          const stopPropagation = vi.fn();
          expect(dispatchAppShortcut(ev({ ...modifier, ...combo, preventDefault, stopPropagation }), isMac, ctx)).toBe(true);
          expect(preventDefault).toHaveBeenCalledOnce();
          expect(stopPropagation).toHaveBeenCalledOnce();
          expect(ctx.changeZoom).toHaveBeenLastCalledWith('in');
        }
        dispatchAppShortcut(ev({ ...modifier, key: '-' }), isMac, ctx);
        expect(ctx.changeZoom).toHaveBeenLastCalledWith('out');
        dispatchAppShortcut(ev({ ...modifier, key: '0' }), isMac, ctx);
        expect(ctx.changeZoom).toHaveBeenLastCalledWith('reset');
      }
    }
  });

  it('leaves typing, IME composition, AltGr and unrelated shifted chords alone', () => {
    for (const combo of [
      { key: '+' },
      { key: '+', ctrlKey: true, altKey: true },
      { key: '+', metaKey: true, isComposing: true },
      { key: '=', ctrlKey: true, keyCode: 229 },
      { key: '_', ctrlKey: true, shiftKey: true },
      { key: '0', ctrlKey: true, shiftKey: true },
    ]) expect(id(ev(combo), MAC)).toBeNull();
  });

  it('jump-to-tab: 9 → last, N → Nth, out-of-range → no-op', () => {
    const ctx = mkCtx();
    dispatchAppShortcut(ev({ metaKey: true, key: '9' }), MAC, ctx);
    expect(ctx.setActiveTabId).toHaveBeenCalledWith('c');
    dispatchAppShortcut(ev({ metaKey: true, key: '2' }), MAC, ctx);
    expect(ctx.setActiveTabId).toHaveBeenCalledWith('b');
    (ctx.setActiveTabId as ReturnType<typeof vi.fn>).mockClear();
    dispatchAppShortcut(ev({ metaKey: true, key: '5' }), MAC, ctx); // idx 4 ≥ len → no-op
    expect(ctx.setActiveTabId).not.toHaveBeenCalled();
  });

  it('cycle-tab wraps; bracket does not', () => {
    const fwd = mkCtx();
    dispatchAppShortcut(ev({ ctrlKey: true, key: 'Tab' }), MAC, fwd);
    expect(fwd.setActiveTabId).toHaveBeenCalledWith('b'); // a → b

    const back = mkCtx({ activeTabId: 'a' });
    dispatchAppShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'Tab' }), MAC, back);
    expect(back.setActiveTabId).toHaveBeenCalledWith('c'); // a → wrap → c

    const bl = mkCtx({ activeTabId: 'a' });
    dispatchAppShortcut(ev({ metaKey: true, shiftKey: true, code: 'BracketLeft' }), MAC, bl);
    expect(bl.setActiveTabId).not.toHaveBeenCalled(); // no wrap at the edge

    const br = mkCtx({ activeTabId: 'a' });
    dispatchAppShortcut(ev({ metaKey: true, shiftKey: true, code: 'BracketRight' }), MAC, br);
    expect(br.setActiveTabId).toHaveBeenCalledWith('b');
  });

  it('close-tab: dismiss overlay first, then guard on backdrop', () => {
    const dismissed = mkCtx({ dismissTopmost: vi.fn(() => true) });
    dispatchAppShortcut(ev({ metaKey: true, key: 'w' }), MAC, dismissed);
    expect(dismissed.closeCurrentTab).not.toHaveBeenCalled();

    const blocked = mkCtx({ dismissTopmost: vi.fn(() => false), hasBlockingBackdrop: vi.fn(() => true) });
    dispatchAppShortcut(ev({ metaKey: true, key: 'w' }), MAC, blocked);
    expect(blocked.closeCurrentTab).not.toHaveBeenCalled();

    const closes = mkCtx({ dismissTopmost: vi.fn(() => false), hasBlockingBackdrop: vi.fn(() => false) });
    dispatchAppShortcut(ev({ metaKey: true, key: 'w' }), MAC, closes);
    expect(closes.closeCurrentTab).toHaveBeenCalledTimes(1);
  });

  it('jump-to-tab also works on Windows (Ctrl modifier)', () => {
    const ctx = mkCtx();
    dispatchAppShortcut(ev({ ctrlKey: true, key: '9' }), WIN, ctx);
    expect(ctx.setActiveTabId).toHaveBeenCalledWith('c');
  });

  it('tab-switch is a no-op when the active tab is missing from the list', () => {
    const ctx = mkCtx({ activeTabId: 'gone' });
    dispatchAppShortcut(ev({ ctrlKey: true, key: 'Tab' }), MAC, ctx);
    dispatchAppShortcut(ev({ metaKey: true, shiftKey: true, code: 'BracketRight' }), MAC, ctx);
    expect(ctx.setActiveTabId).not.toHaveBeenCalled();
  });

  it('new-tab / task-center / settings delegate to ctx', () => {
    const ctx = mkCtx();
    dispatchAppShortcut(ev({ metaKey: true, key: 't' }), MAC, ctx);
    dispatchAppShortcut(ev({ metaKey: true, key: 'y' }), MAC, ctx);
    dispatchAppShortcut(ev({ metaKey: true, key: 'u' }), MAC, ctx);
    expect(ctx.newTab).toHaveBeenCalledTimes(1);
    expect(ctx.openTaskCenter).toHaveBeenCalledTimes(1);
    expect(ctx.openSettings).toHaveBeenCalledTimes(1);
  });
});

describe('dispatchAppShortcut', () => {
  it('preventDefault + returns true on match', () => {
    const preventDefault = vi.fn();
    const handled = dispatchAppShortcut(ev({ metaKey: true, key: 't', preventDefault }), MAC, mkCtx());
    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });
  it('no preventDefault + returns false on miss (normal typing flows through)', () => {
    const preventDefault = vi.fn();
    const handled = dispatchAppShortcut(ev({ key: 'a', preventDefault }), MAC, mkCtx());
    expect(handled).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe('reference table metadata', () => {
  it('reload-block is hidden; all visible shortcuts have a key label on both platforms', () => {
    const enItems = resources['en-US'].settings.shortcuts.app.items as Record<string, string>;
    const zhItems = resources['zh-CN'].settings.shortcuts.app.items as Record<string, string>;
    expect(VISIBLE_APP_SHORTCUTS.some((s) => s.id === 'block-reload')).toBe(false);
    expect(VISIBLE_APP_SHORTCUTS.length).toBe(APP_SHORTCUTS.length - 1);
    for (const s of VISIBLE_APP_SHORTCUTS) {
      expect(s.keys?.(true)).toBeTruthy();
      expect(s.keys?.(false)).toBeTruthy();
      expect(enItems[s.id]).toBeTruthy();
      expect(zhItems[s.id]).toBeTruthy();
    }
  });
});
