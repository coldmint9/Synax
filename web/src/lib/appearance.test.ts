import { describe, expect, it } from "vitest";
import {
  ACCENT_PRESETS,
  accentPalette,
  contrastRatio,
  DEFAULT_ACCENT,
  normalizeAccent,
} from "./appearance";

describe("appearance palette", () => {
  it("accepts only opaque HEX colors and normalizes shorthand", () => {
    expect(normalizeAccent(" #ABC ")).toBe("#aabbcc");
    for (const invalid of [null, {}, "red", "#abcd", "#12345g", "var(--x)"])
      expect(normalizeAccent(invalid)).toBeNull();
    expect(accentPalette("invalid", "light").bottom).toBe(DEFAULT_ACCENT);
  });

  it.each(["light", "dark"] as const)(
    "keeps custom colors readable in %s mode",
    (theme) => {
      const colors = [
        ...ACCENT_PRESETS.map((p) => p.color),
        "#000000",
        "#ffffff",
        "#808080",
        "#777777",
        "#ff0000",
        "#0000ff",
        "#ffff00",
      ];
      // Exercise the grayscale boundary where near-black and white both fail.
      for (let value = 0; value <= 255; value++)
        colors.push(`#${value.toString(16).padStart(2, "0").repeat(3)}`);
      for (const color of colors) {
        const palette = accentPalette(color, theme);
        expect(palette.bottom).toBe(color);
        expect(
          contrastRatio(palette.bottom, palette.ink),
          color,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(palette.top, palette.ink),
          color,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(
            palette.strong,
            theme === "dark" ? "#181818" : "#f9f9f9",
          ),
          color,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );
});
