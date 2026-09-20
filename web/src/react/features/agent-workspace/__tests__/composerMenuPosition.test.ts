import { describe, expect, it } from "vitest";
import { composerMenuPosition } from "../composerMenuPosition";

describe("composer menu positioning", () => {
  it("anchors above the editor, independently of a tall request panel", () => {
    expect(
      composerMenuPosition(
        { left: 280, top: 620, bottom: 730, width: 720 },
        { width: 1280, height: 760, layoutHeight: 760 },
      ),
    ).toEqual({ left: 280, width: 384, bottom: 148, maxHeight: 360 });
  });
  it("fits the narrow viewport without horizontal overflow", () => {
    const result = composerMenuPosition(
      { left: 8, top: 500, bottom: 650, width: 374 },
      { width: 390, height: 844, layoutHeight: 844 },
    );
    expect(result).toMatchObject({ left: 16, width: 358, maxHeight: 360 });
  });
  it("flips below a centered editor when there is not enough room above", () => {
    expect(
      composerMenuPosition(
        { left: 24, top: 80, bottom: 180, width: 340 },
        { width: 390, height: 700, layoutHeight: 700 },
      ),
    ).toEqual({ left: 24, width: 340, top: 188, maxHeight: 360 });
  });
  it("respects the visible viewport when the software keyboard pans the page", () => {
    const result = composerMenuPosition(
      { left: 20, top: 320, bottom: 450, width: 350 },
      { width: 390, height: 400, layoutHeight: 844, top: 180 },
    );
    expect(result).toMatchObject({ bottom: 532, maxHeight: 116 });
  });
});
