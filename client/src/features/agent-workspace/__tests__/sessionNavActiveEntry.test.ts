import { describe, expect, it } from "vitest";
import { resolveActiveEntryIndex } from "../SessionNavigationPanel";

// Four turns at 0 / 1000 / 2000 / 3000 with a 1000px scrollport: the probe line
// sits 350px below the top of the viewport.
const OFFSETS = [0, 1000, 2000, 3000];
const VIEWPORT = 1000;
const MAX_SCROLL = 3000;

describe("resolveActiveEntryIndex", () => {
  it("selects the first turn when scrolled to the very top", () => {
    expect(resolveActiveEntryIndex(OFFSETS, 0, VIEWPORT, MAX_SCROLL)).toBe(0);
  });

  it("selects the last turn when scrolled to the very bottom", () => {
    expect(
      resolveActiveEntryIndex(OFFSETS, MAX_SCROLL, VIEWPORT, MAX_SCROLL),
    ).toBe(3);
    expect(
      resolveActiveEntryIndex(OFFSETS, MAX_SCROLL - 1, VIEWPORT, MAX_SCROLL),
    ).toBe(3);
  });

  it("selects the turn under the probe line in between", () => {
    // probe = 1000 + 350 = 1350 -> inside the second turn
    expect(resolveActiveEntryIndex(OFFSETS, 1000, VIEWPORT, MAX_SCROLL)).toBe(
      1,
    );
    // probe = 2000 + 350 = 2350 -> inside the third turn
    expect(resolveActiveEntryIndex(OFFSETS, 2000, VIEWPORT, MAX_SCROLL)).toBe(
      2,
    );
  });

  it("stays on the first turn while the probe is still inside it", () => {
    // probe = 400 + 350 = 750, still before the second turn at 1000
    expect(resolveActiveEntryIndex(OFFSETS, 400, VIEWPORT, MAX_SCROLL)).toBe(0);
  });

  it("handles a single-entry transcript", () => {
    expect(resolveActiveEntryIndex([0], 0, VIEWPORT, 0)).toBe(0);
    expect(resolveActiveEntryIndex([0], 500, VIEWPORT, 500)).toBe(0);
  });

  it("reports no selection for an empty transcript", () => {
    expect(resolveActiveEntryIndex([], 0, VIEWPORT, 0)).toBe(-1);
  });
});
