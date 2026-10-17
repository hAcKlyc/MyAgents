import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

export interface PanelWidthConfig {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}

function clampWidth(config: PanelWidthConfig, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return config.defaultWidth;
  return Math.min(config.maxWidth, Math.max(config.minWidth, Math.round(value)));
}

function readStoredWidth(config: PanelWidthConfig): number {
  if (typeof window === 'undefined') return config.defaultWidth;
  try {
    const raw = window.localStorage.getItem(config.storageKey);
    return raw === null ? config.defaultWidth : clampWidth(config, Number(raw));
  } catch {
    return config.defaultWidth;
  }
}

/** Width that survives reloads; failures to persist degrade to session-only. */
export function usePanelWidth(config: PanelWidthConfig) {
  const [width, setWidth] = useState(() => readStoredWidth(config));
  const commit = useCallback((next: number) => {
    const clamped = clampWidth(config, next);
    setWidth(clamped);
    try {
      window.localStorage.setItem(config.storageKey, String(clamped));
    } catch (error) {
      console.warn('[PanelResizeHandle] Failed to persist panel width:', error);
    }
  }, [config]);
  return { width, setWidth, commit, clamp: (value: number) => clampWidth(config, value) };
}

interface PanelResizeHandleProps {
  config: PanelWidthConfig;
  width: number;
  onPreview: (width: number) => void;
  onCommit: (width: number) => void;
  /** Side of the panel the handle sits on; a left-edge handle grows the panel when dragged left. */
  edge: 'left' | 'right';
  label: string;
}

/** Thin draggable separator, positioned on the panel's own edge (panel must be `relative`). */
export default function PanelResizeHandle({ config, width, onPreview, onCommit, edge, label }: PanelResizeHandleProps) {
  const dragRef = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const direction = edge === 'right' ? 1 : -1;
  const clamp = (value: number) => clampWidth(config, value);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { startX: event.clientX, startWidth: width, width };
    setDragging(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    drag.width = clamp(drag.startWidth + (event.clientX - drag.startX) * direction);
    onPreview(drag.width);
  };

  const endDrag = (commit: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDragging(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (commit) onCommit(drag.width);
    else onPreview(drag.startWidth);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 8;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = width - step * direction;
    else if (event.key === 'ArrowRight') next = width + step * direction;
    else if (event.key === 'Home') next = config.minWidth;
    else if (event.key === 'End') next = config.maxWidth;
    if (next === null) return;
    event.preventDefault();
    onCommit(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={config.minWidth}
      aria-valuemax={config.maxWidth}
      aria-valuenow={width}
      tabIndex={0}
      data-panel-resize-handle
      data-resizing={dragging ? 'true' : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={() => endDrag(true)}
      onPointerCancel={() => endDrag(false)}
      onDoubleClick={() => onCommit(config.defaultWidth)}
      onKeyDown={handleKeyDown}
      className={`group/resize absolute inset-y-0 z-30 flex w-2 cursor-col-resize justify-center focus-visible:outline-none ${
        edge === 'right' ? '-right-1' : '-left-1'
      }`}
    >
      <span className="h-full w-px bg-transparent transition-colors group-hover/resize:bg-[var(--accent)] group-focus-visible/resize:bg-[var(--accent)] group-data-[resizing=true]/resize:bg-[var(--accent)]" />
    </div>
  );
}
