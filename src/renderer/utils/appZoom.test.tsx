import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isTauri } from '@tauri-apps/api/core';
import { createAppZoomController } from './appZoom';

const { setZoom } = vi.hoisted(() => ({ setZoom: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ setZoom }) }));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
  setZoom.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
  document.documentElement.style.zoom = '';
  document.documentElement.style.removeProperty('--app-viewport-height');
});

describe('main-window interface zoom', () => {
  it('serializes rapid key presses and restores the successfully applied size on reopening', async () => {
    const zoom = createAppZoomController();
    const changes = [zoom.change('in'), zoom.change('in'), zoom.change('out')];
    await Promise.all(changes);
    expect(setZoom.mock.calls.map(([level]) => level)).toEqual([1.1, 1.25, 1.1]);
    setZoom.mockClear();
    await createAppZoomController().ready;
    expect(setZoom).toHaveBeenCalledWith(1.1);
    await zoom.change('reset');
    expect(setZoom).toHaveBeenLastCalledWith(1);
    expect(localStorage.getItem('myagents:ui-zoom')).toBeNull();
  });

  it('keeps repeated presses within usable limits and recovers to 100%', async () => {
    const zoom = createAppZoomController();
    for (let i = 0; i < 20; i++) await zoom.change('out');
    expect(setZoom).toHaveBeenLastCalledWith(0.75);
    for (let i = 0; i < 30; i++) await zoom.change('in');
    expect(setZoom).toHaveBeenLastCalledWith(2);
    await zoom.change('reset');
    expect(setZoom).toHaveBeenLastCalledWith(1);
  });

  it('does not remember a rejected native zoom and permits a retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const zoom = createAppZoomController();
    setZoom.mockRejectedValueOnce(new Error('native zoom unavailable'));
    await zoom.change('in');
    expect(localStorage.getItem('myagents:ui-zoom')).toBeNull();
    await zoom.change('in');
    expect(setZoom.mock.calls.map(([level]) => level)).toEqual([1.1, 1.1]);
    expect(localStorage.getItem('myagents:ui-zoom')).toBe('1.1');
  });

  it('ignores invalid saved sizes and still zooms when storage is denied', async () => {
    localStorage.setItem('myagents:ui-zoom', '10000');
    const zoom = createAppZoomController();
    await zoom.ready;
    expect(setZoom).not.toHaveBeenCalled();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    await createAppZoomController().change('in');
    expect(setZoom).toHaveBeenLastCalledWith(1.1);
  });

  it('applies browser-development zoom and notifies measured layouts', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    const resize = vi.fn();
    window.addEventListener('resize', resize);
    try {
      await createAppZoomController().change('in');
      expect(document.documentElement.style.zoom).toBe('1.1');
      expect(document.documentElement.style.getPropertyValue('--app-viewport-height')).toBe(`${100 / 1.1}vh`);
      expect(resize).toHaveBeenCalledOnce();
      expect(setZoom).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('resize', resize);
    }
  });
});
