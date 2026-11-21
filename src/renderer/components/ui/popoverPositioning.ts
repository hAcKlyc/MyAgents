import { flip, offset, shift, size, type FlipOptions, type Padding } from "@floating-ui/react";

/** Placement and size share one boundary: flipping alone cannot fit an
 * oversized menu on either side of its anchor. autoUpdate reuses this policy. */
export function popoverPositioning(
  gap: number,
  padding: Padding,
  matchAnchorWidth: boolean,
  maxHeight: string,
  fallbackAxisSideDirection: FlipOptions['fallbackAxisSideDirection'] = "none",
) {
  return [
    offset(gap),
    flip({ padding, fallbackAxisSideDirection }),
    shift({ padding }),
    size({
      padding,
      apply({ availableHeight, rects, elements }) {
        const room = `${Math.max(0, availableHeight)}px`;
        elements.floating.style.setProperty('--popover-available-height', room);
        elements.floating.style.maxHeight = `min(${room}, ${maxHeight})`;
        if (matchAnchorWidth)
          elements.floating.style.width = `${rects.reference.width}px`;
      },
    }),
  ];
}
