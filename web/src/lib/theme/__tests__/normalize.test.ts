import { describe, expect, it } from "vitest";
import { DEFAULT_THEME } from "../defaults";
import { mergeTheme, normalizeTheme, themeToExport } from "../normalize";

const baseInput = {
  version: 1 as const,
  id: "mist-blue",
  name: "Mist Blue",
};

describe("theme normalization", () => {
  it("fills omitted light and dark tokens from the Synax defaults", () => {
    const theme = normalizeTheme({
      ...baseInput,
      colors: { light: { accent: "#98AEC B".replace(" ", "") } },
    });

    expect(theme.colors.light.accent).toBe("#98aecb");
    expect(theme.colors.light.accentForeground).toBe("#2f3d34");
    expect(theme.colors.light.accentSoft).toBe("#f2f4f8");
    expect(theme.colors.dark.canvas).toBe(DEFAULT_THEME.colors.dark.canvas);
    expect(theme.shape).toEqual(DEFAULT_THEME.shape);
    expect(theme.effects).toEqual(DEFAULT_THEME.effects);
  });

  it("normalizes six-digit and shorthand HEX values to lowercase", () => {
    const theme = normalizeTheme({
      ...baseInput,
      colors: {
        light: {
          accent: " #ABC ",
          focus: "#123456",
        },
      },
    });

    expect(theme.colors.light.accent).toBe("#aabbcc");
    expect(theme.colors.light.focus).toBe("#123456");
  });

  it("rejects unsupported versions and invalid color values", () => {
    expect(() => normalizeTheme({ version: 2, id: "x", name: "x" })).toThrow(/version/i);
    expect(() =>
      normalizeTheme({
        ...baseInput,
        colors: { light: { accent: "javascript:alert(1)" } },
      }),
    ).toThrow(/accent|color/i);
    expect(() =>
      normalizeTheme({
        ...baseInput,
        colors: { light: { accent: "var(--accent)" } },
      }),
    ).toThrow(/accent|color/i);
  });

  it("derives accent foreground and soft values when accent changes", () => {
    const dark = normalizeTheme({
      ...baseInput,
      colors: { dark: { accent: "#ffffff" } },
    });

    expect(dark.colors.dark.accentForeground).toBe("#2f3d34");
    expect(dark.colors.dark.accentSoft).toBe("#3f434a");
  });

  it("merges partial overrides without changing unrelated tokens", () => {
    const merged = mergeTheme(DEFAULT_THEME, {
      colors: { dark: { focus: "#ABC" } },
    });

    expect(merged.colors.dark.focus).toBe("#aabbcc");
    expect(merged.colors.dark.canvas).toBe(DEFAULT_THEME.colors.dark.canvas);
    expect(merged.colors.light).toEqual(DEFAULT_THEME.colors.light);
  });

  it("round-trips only portable theme fields", () => {
    const normalized = normalizeTheme({ version: 1, id: "x", name: "X" });
    const exported = themeToExport(normalized);

    expect(exported).toEqual(
      expect.objectContaining({
        version: 1,
        id: "x",
        name: "X",
      }),
    );
    expect(JSON.stringify(exported)).not.toContain("resolved");
    expect(Object.keys(exported)).toEqual([
      "version",
      "id",
      "name",
      "colors",
      "shape",
      "effects",
    ]);
    expect(themeToExport(normalizeTheme(exported))).toEqual(exported);
  });
});
