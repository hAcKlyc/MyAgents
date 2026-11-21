// Popover — the single anchored-popover primitive for the renderer.
//
// Wraps `@floating-ui/react` with project defaults so every call site gets
// identical positioning (auto-flip, viewport-shift), identical chrome (border,
// radius, shadow, background), identical dismiss semantics (outside-click +
// Escape), and identical layering (portal into <body> so parents' `overflow:
// hidden` never clips the content).
//
// Prior state: 13 files each re-implemented the pattern by hand —
// `absolute top-full` positioning, `document.addEventListener('mousedown')`
// outside-click, and a hodgepodge of `shadow-{sm,md,lg,xl}` / radii /
// z-indexes. Those copies had divergent bugs (ThoughtCard clipped on
// last-card menus, some missed Escape, some didn't flip on small
// viewports). This primitive replaces them.
//
// Non-goals: focus trapping (callers own focus if they need it — the tag
// autocomplete already has its own ↑↓/Enter/Tab handling and shouldn't
// have focus stolen from the textarea); transitions (kept lean for now).

import { useOverlayOwnerActive } from '@/context/OverlayOwnerActiveContext';
import { isImeComposingEvent } from "@/utils/imeKeyboard";
import {
  autoUpdate,
  FloatingPortal,
  useFloating,
  type Placement,
  type Padding,
  type FlipOptions,
} from "@floating-ui/react";
import { createContext, useEffect, useRef } from "react";
import { popoverPositioning } from "./popoverPositioning";

/** Keyboard actions in portaled menu content return focus to their own trigger. */
export const PopoverAnchorContext = createContext<React.RefObject<HTMLElement | null> | null>(null);

export type PopoverPlacement = Placement;

export interface PopoverProps {
  /** Controlled open state. */
  open: boolean;
  /** Fired when the user dismisses (outside-click, Escape, or caller action). */
  onClose: () => void;
  /** DOM ref of the trigger element. The popover anchors to its bounding rect. */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Preferred side/alignment. Floating-UI auto-flips if there isn't room. */
  placement?: PopoverPlacement;
  /** Allow perpendicular fallback when neither preferred nor opposite side fits. */
  fallbackAxisSideDirection?: FlipOptions['fallbackAxisSideDirection'];
  /** Gap (in px) between anchor edge and popover edge. Default 4. */
  offset?: number;
  /** Match the anchor's width — used for select-style dropdowns. */
  matchAnchorWidth?: boolean;
  /** Additional content height cap, combined with the available anchor-side room. */
  maxHeight?: string;
  /** Reserve UI chrome outside the popup boundary. Default 8px on every edge. */
  viewportPadding?: Padding;
  /** Dismiss on click outside the popover and outside the anchor. Default true. */
  closeOnOutsideClick?: boolean;
  /** Dismiss on Escape. Default true. */
  closeOnEscape?: boolean;
  /** Disable when the caller owns a modal focus trap inside this portal. */
  preserveTabOrder?: boolean;
  /**
   * Stacking layer. Default 260 — above every `<OverlayBackdrop>` in the app
   * (z-200/210/250) yet below the ConfirmDialog tier (z-300).
   *
   * Rationale: a Popover anchored to a button *inside* an overlay should float
   * above that overlay's panel, not disappear behind it. The earlier default
   * of 40 predated the OverlayBackdrop stacking hierarchy and caused
   * RuntimeSelector / SkillDetailPanel / AgentDetailPanel / BugReportOverlay
   * dropdowns to render behind their own host overlay — user visible as
   * "click the dropdown and nothing happens" (issue reported 2026-04-23).
   *
   * Callers only need to override when they specifically want the popover
   * stacked below a particular overlay, or above the ConfirmDialog tier.
   */
  zIndex?: number;
  /** Content styles — merged with the default chrome. */
  className?: string;
  style?: React.CSSProperties;
  /** When true, skip the default chrome (border + bg + shadow + rounded).
   *  Use when the caller wants a fully custom container (e.g. compound boxes
   *  that visually attach to their anchor). */
  unstyled?: boolean;
  /** Hover ownership includes the popup's border and native scrollbars. */
  onMouseEnter?: React.MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLDivElement>;
  /** Called once positioning is ready; callers may then move focus without scrolling. */
  onPositioned?: () => void;
  children: React.ReactNode;
}

const DEFAULT_CHROME =
  "overflow-auto rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl";

export function Popover({
  open: requestedOpen,
  onClose,
  anchorRef,
  placement = "bottom-start",
  fallbackAxisSideDirection = "none",
  offset: offsetValue = 4,
  matchAnchorWidth = false,
  maxHeight = "100vh",
  viewportPadding = 8,
  closeOnOutsideClick = true,
  closeOnEscape = true,
  preserveTabOrder = true,
  zIndex = 260,
  className = "",
  style,
  unstyled = false,
  onMouseEnter,
  onMouseLeave,
  children,
  onPositioned,
}: PopoverProps) {
  const ownerActive = useOverlayOwnerActive();
  const open = ownerActive && requestedOpen;
  const { refs, floatingStyles, isPositioned } = useFloating({
    placement,
    open,
    middleware: popoverPositioning(
      offsetValue,
      viewportPadding,
      matchAnchorWidth,
      typeof style?.maxHeight === "number"
        ? `${style.maxHeight}px`
        : (style?.maxHeight ?? maxHeight),
      fallbackAxisSideDirection,
    ),
    whileElementsMounted: autoUpdate,
  });

  // Bind the reference element — `anchorRef.current` is a ref, not a reactive
  // value, but the useEffect still re-runs every render which is what we want
  // (covers the case where the anchor remounts). Cheap, idempotent.
  useEffect(() => {
    refs.setReference(anchorRef.current ?? null);
  });

  const onPositionedRef = useRef(onPositioned);
  useEffect(() => { onPositionedRef.current = onPositioned; }, [onPositioned]);
  useEffect(() => {
    if (open && isPositioned) onPositionedRef.current?.();
  }, [open, isPositioned]);

  // Escape dismissal.
  useEffect(() => {
    if (!open || !closeOnEscape) return;
    const handler = (e: KeyboardEvent) => {
      if (isImeComposingEvent(e)) return;
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, closeOnEscape, onClose]);

  // Outside-click dismissal. Uses `mousedown` (not `click`) so dragging a
  // text selection ending outside doesn't accidentally fire.
  const floatingRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open || !closeOnOutsideClick) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (floatingRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      // Don't dismiss when the click landed in something layered above us
      // (e.g. a ConfirmDialog at z-[300] portaled to body by a child of the
      // Popover's owner). Without this, the document-level mousedown fires
      // before the dialog's own click handler, and a parent that resets
      // dialog state on close would unmount the dialog mid-click — issue
      // #178: confirm button visibly closes the dialog but the action never
      // ran. Walk ancestors and bail if any positioned ancestor's z-index
      // exceeds ours.
      let el: Element | null =
        t.nodeType === 1 ? (t as Element) : t.parentElement;
      while (el && el !== document.body) {
        const style = window.getComputedStyle(el);
        if (style.position !== "static") {
          const z = parseInt(style.zIndex, 10);
          if (!Number.isNaN(z) && z > zIndex) return;
        }
        el = el.parentElement;
      }
      onClose();
    };
    // A press on the owning modal's backdrop dismisses the popup first.
    // Handle that press before the backdrop can discard the modal's draft.
    const handleBackdrop = (event: MouseEvent) => {
      const backdrop = anchorRef.current?.closest('[data-overlay-backdrop]');
      if (backdrop && event.target === backdrop) {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", handleBackdrop, true);
    document.addEventListener("mousedown", handler);
    return () => {
      document.removeEventListener("mousedown", handleBackdrop, true);
      document.removeEventListener("mousedown", handler);
    };
  }, [open, closeOnOutsideClick, onClose, anchorRef, zIndex]);

  if (!open) return null;
  const { maxHeight: _heightCap, ...contentStyle } = style ?? {};
  void _heightCap;

  return (
    <FloatingPortal preserveTabOrder={preserveTabOrder}>
      <div
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        ref={(node) => {
          refs.setFloating(node);
          floatingRef.current = node;
        }}
        style={{
          ...floatingStyles,
          zIndex,
          overflowY: "auto",
          ...contentStyle,
          // Preserve existing caller autofocus while masking zero-coordinate paint.
          opacity: isPositioned ? contentStyle.opacity : 0,
          pointerEvents: isPositioned ? contentStyle.pointerEvents : "none",
        }}
        className={
          unstyled ? className : `${DEFAULT_CHROME} ${className}`.trim()
        }
      >
        <PopoverAnchorContext.Provider value={isPositioned ? anchorRef : null}>{children}</PopoverAnchorContext.Provider>
      </div>
    </FloatingPortal>
  );
}

export default Popover;
