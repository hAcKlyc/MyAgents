import { computePosition, type Platform } from "@floating-ui/core";
import { describe, expect, it, vi } from "vitest";
import { popoverPositioning } from "./popoverPositioning";

function geometry(
  viewportHeight: number,
  anchorTop: number,
  anchorHeight: number,
  naturalHeight: number,
  { viewportWidth = 900, anchorLeft = 100, anchorWidth = 540, popupWidth = 540 } = {},
) {
  const reference = {};
  const floating = { style: { maxHeight: "", width: "", setProperty: vi.fn() } };
  const measuredHeight = () => {
    const limit = /min\(([\d.]+)px, ([\d.]+)(px|vh)\)/.exec(
      floating.style.maxHeight,
    );
    return limit
      ? Math.min(naturalHeight, Number(limit[1]), Number(limit[2]) * (limit[3] === 'vh' ? viewportHeight / 100 : 1))
      : naturalHeight;
  };
  const platform = {
    getElementRects: async () => ({
      reference: { x: anchorLeft, y: anchorTop, width: anchorWidth, height: anchorHeight },
      floating: { x: 0, y: 0, width: popupWidth, height: measuredHeight() },
    }),
    getClippingRect: async () => ({
      x: 0,
      y: 0,
      width: viewportWidth,
      height: viewportHeight,
    }),
    getDimensions: async () => ({ width: popupWidth, height: measuredHeight() }),
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
      const [property, room] = fixture.floating.style.setProperty.mock.lastCall!;
      expect(property).toBe("--popover-available-height");
      expect(fixture.floating.style.maxHeight).toBe(`min(${room}, 512px)`);
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


describe("side submenu viewport containment", () => {
  it.each([
    ["right side", 900, 400, 40, 240, 290],
    ["left flip", 900, 400, 600, 240, 290],
    ["neither side fits", 380, 400, 40, 260, 290],
    ["short window with long choices", 380, 220, 40, 120, 700],
  ] as const)("%s keeps all choices reachable", async (label, width, height, left, top, contentHeight) => {
    const fixture = geometry(height, top, 40, contentHeight, {
      viewportWidth: width, anchorLeft: left, anchorWidth: 256, popupWidth: 224,
    });
    const result = await computePosition(fixture.reference, fixture.floating, {
      platform: fixture.platform,
      placement: "right-end",
      middleware: popoverPositioning(6, 8, false, "100vh", "start"),
    });
    expect(result.x).toBeGreaterThanOrEqual(8);
    expect(result.x + 224).toBeLessThanOrEqual(width - 8);
    expect(result.y).toBeGreaterThanOrEqual(8);
    expect(result.y + fixture.measuredHeight()).toBeLessThanOrEqual(height - 8);
    expect(fixture.measuredHeight()).toBeGreaterThan(0);
    if (label === "right side") expect(result.placement).toMatch(/^right/);
    if (label === "left flip") expect(result.placement).toMatch(/^left/);
    if (width === 380) expect(result.placement).toMatch(/^(top|bottom)/);
  });
});
