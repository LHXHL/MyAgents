import { flip, offset, shift, size, type Padding } from "@floating-ui/react";

/** Placement and size share one boundary: flipping alone cannot fit an
 * oversized menu on either side of its anchor. autoUpdate reuses this policy. */
export function popoverPositioning(
  gap: number,
  padding: Padding,
  matchAnchorWidth: boolean,
  maxHeight: string,
) {
  return [
    offset(gap),
    flip({ padding }),
    shift({ padding }),
    size({
      padding,
      apply({ availableHeight, rects, elements }) {
        elements.floating.style.maxHeight = `min(${Math.max(0, availableHeight)}px, ${maxHeight})`;
        if (matchAnchorWidth)
          elements.floating.style.width = `${rects.reference.width}px`;
      },
    }),
  ];
}
