import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PanelResizeHandle, { usePanelWidth, type PanelWidthConfig } from './PanelResizeHandle';

const CONFIG: PanelWidthConfig = { storageKey: 'test.panelWidth', defaultWidth: 300, minWidth: 200, maxWidth: 500 };

function Harness({ edge }: { edge: 'left' | 'right' }) {
  const panel = usePanelWidth(CONFIG);
  return (
    <div style={{ width: panel.width }} data-testid="panel">
      <PanelResizeHandle config={CONFIG} width={panel.width} edge={edge} label="resize" onPreview={panel.setWidth} onCommit={panel.commit} />
    </div>
  );
}

describe('PanelResizeHandle', () => {
  beforeEach(() => window.localStorage.clear());

  it('grows a right-edge panel when dragged right and persists on release', () => {
    render(<Harness edge="right" />);
    const handle = screen.getByRole('separator', { name: 'resize' });
    (handle as HTMLElement).setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 360, pointerId: 1 });
    expect(screen.getByTestId('panel').style.width).toBe('360px');
    expect(window.localStorage.getItem(CONFIG.storageKey)).toBeNull();
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(window.localStorage.getItem(CONFIG.storageKey)).toBe('360');
  });

  it('grows a left-edge panel when dragged left and clamps to the bounds', () => {
    render(<Harness edge="left" />);
    const handle = screen.getByRole('separator');
    (handle as HTMLElement).setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { button: 0, clientX: 800, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 700, pointerId: 1 });
    expect(screen.getByTestId('panel').style.width).toBe('400px');
    fireEvent.pointerMove(handle, { clientX: 0, pointerId: 1 });
    expect(screen.getByTestId('panel').style.width).toBe('500px');
  });

  it('cancelling a drag restores the previous width without persisting', () => {
    render(<Harness edge="right" />);
    const handle = screen.getByRole('separator');
    (handle as HTMLElement).setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { button: 0, clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    expect(screen.getByTestId('panel').style.width).toBe('300px');
    expect(window.localStorage.getItem(CONFIG.storageKey)).toBeNull();
  });

  it('restores a stored width, ignores garbage, and supports keyboard + double-click reset', () => {
    window.localStorage.setItem(CONFIG.storageKey, '420');
    const { unmount } = render(<Harness edge="right" />);
    expect(screen.getByTestId('panel').style.width).toBe('420px');
    const handle = screen.getByRole('separator');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(screen.getByTestId('panel').style.width).toBe('412px');
    fireEvent.keyDown(handle, { key: 'End' });
    expect(screen.getByTestId('panel').style.width).toBe('500px');
    fireEvent.doubleClick(handle);
    expect(screen.getByTestId('panel').style.width).toBe('300px');
    unmount();
    window.localStorage.setItem(CONFIG.storageKey, 'abc');
    render(<Harness edge="right" />);
    expect(screen.getByTestId('panel').style.width).toBe('300px');
  });
});
