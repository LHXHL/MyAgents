import { computePosition, type Platform } from "@floating-ui/core";
import { describe, expect, it } from "vitest";
import { popoverPositioning } from "./popoverPositioning";

function geometry(
  viewportHeight: number,
  anchorTop: number,
  anchorHeight: number,
  naturalHeight: number,
) {
  const reference = {};
  const floating = { style: { maxHeight: "", width: "" } };
  const measuredHeight = () => {
    const limit = /min\(([\d.]+)px, ([\d.]+)px\)/.exec(
      floating.style.maxHeight,
    );
    return limit
      ? Math.min(naturalHeight, Number(limit[1]), Number(limit[2]))
      : naturalHeight;
  };
  const platform = {
    getElementRects: async () => ({
      reference: { x: 100, y: anchorTop, width: 540, height: anchorHeight },
      floating: { x: 0, y: 0, width: 540, height: measuredHeight() },
    }),
    getClippingRect: async () => ({
      x: 0,
      y: 0,
      width: 900,
      height: viewportHeight,
    }),
    getDimensions: async () => ({ width: 540, height: measuredHeight() }),
    isElement: async () => false,
    getOffsetParent: async () => undefined,
  } as unknown as Platform;
  return { reference, floating, platform, measuredHeight };
}

describe("anchored popover available space", () => {
  it.each([
    ["Launcher centered composer", 1024, 512, 96, 512],
    ["Chat tall composer", 600, 270, 180, 390],
    ["Chat bottom composer", 1024, 850, 80, 512],
    ["short window", 400, 170, 120, 512],
  ] as const)(
    "%s stays below the titlebar and within the window",
    async (_name, height, top, anchorHeight, contentHeight) => {
      const fixture = geometry(height, top, anchorHeight, contentHeight);
      const result = await computePosition(
        fixture.reference,
        fixture.floating,
        {
          platform: fixture.platform,
          placement: "top-start",
          middleware: popoverPositioning(
            8,
            { top: 52, bottom: 8, left: 8, right: 8 },
            false,
            "512px",
          ),
        },
      );
      expect(result.y).toBeGreaterThanOrEqual(52);
      expect(result.y + fixture.measuredHeight()).toBeLessThanOrEqual(
        height - 8,
      );
      // Popup must remain on the chosen side, never cover its anchor.
      if (result.placement.startsWith("top"))
        expect(result.y + fixture.measuredHeight()).toBeLessThanOrEqual(
          top - 8,
        );
      else expect(result.y).toBeGreaterThanOrEqual(top + anchorHeight + 8);
    },
  );
});
