import { describe, expect, it } from "vitest";
import { ACCENT_PRESETS } from "../../../../../lib/appearance";
import { hexToHsv, hsvToHex, normalizeHex } from "../accentColor";

describe("normalizeHex", () => {
  it.each([
    ["#A1BbA8", "#a1bba8"],
    ["  abc  ", "#aabbcc"],
    ["#0Af", "#00aaff"],
    ["123456", "#123456"],
  ])("normalizes %s to opaque six-digit HEX", (input, expected) => {
    expect(normalizeHex(input)).toBe(expected);
  });

  it.each([
    "",
    "#",
    "#f",
    "#ff",
    "#ffff",
    "#fffff",
    "#ffffffff",
    "#gggggg",
    "##123456",
    "rgb(1,2,3)",
    "#12 3456",
  ])("rejects incomplete, invalid or non-opaque colors: %s", (input) =>
    expect(normalizeHex(input)).toBeNull(),
  );
});

describe("HSV conversion", () => {
  it.each([
    [0, "#ff0000"],
    [60, "#ffff00"],
    [120, "#00ff00"],
    [180, "#00ffff"],
    [240, "#0000ff"],
    [300, "#ff00ff"],
  ])("converts hue %s and round-trips its channels", (h, hex) => {
    expect(hsvToHex({ h, s: 1, v: 1 })).toBe(hex);
    expect(hexToHsv(hex)).toEqual({ h, s: 1, v: 1 });
  });

  it.each([
    "#000000",
    "#ffffff",
    "#808080",
    "#010101",
    "#010203",
    "#fefffe",
    "#7f80ff",
    "#ab12ce",
    ...ACCENT_PRESETS.map(({ color }) => color),
  ])("round-trips %s without changing an RGB channel", (hex) => {
    expect(hsvToHex(hexToHsv(hex))).toBe(hex);
  });

  it.each(["#000000", "#ffffff", "#808080"])(
    "preserves the previous hue at %s",
    (hex) => {
      expect(hexToHsv(hex, 210).h).toBe(210);
      expect(hexToHsv(hex, -30).h).toBe(330);
      expect(hexToHsv(hex).h).toBe(0);
    },
  );

  it("does not discard a low but nonzero saturation", () => {
    const hsv = hexToHsv("#fefeff", 120);
    expect(hsv.h).toBe(240);
    expect(hsv.s).toBeGreaterThan(0);
    expect(hsvToHex(hsv)).toBe("#fefeff");
  });

  it("wraps hue and clamps out-of-range channels", () => {
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe("#ff0000");
    expect(hsvToHex({ h: -60, s: 2, v: 2 })).toBe("#ff00ff");
    expect(hsvToHex({ h: 30, s: -1, v: 1 })).toBe("#ffffff");
    expect(hsvToHex({ h: 30, s: 1, v: -1 })).toBe("#000000");
  });

  it("rejects invalid HEX rather than producing NaN channels", () => {
    expect(() => hexToHsv("#nope")).toThrow();
  });
});
