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
    expect(theme.colors.light.accentSoft).toBe("#eceff3");
    expect(theme.colors.dark.canvas).toBe(DEFAULT_THEME.colors.dark.canvas);
    expect(DEFAULT_THEME.colors.light.borderStrong).toBe("#c7d0db");
    expect(DEFAULT_THEME.colors.dark.surfaceSecondary).toBe("#272c34");
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

    for (const malformed of [
      "rgb(1 2)",
      "rgb(1 2 3 4 5)",
      "rgba(1 2 3)",
      "rgb(1 2 300)",
      "rgb(1, 2, 3, 0.5, 0.2)",
      "hsl(361 50% 50%)",
      "hsl(120 101% 50%)",
      "hsla(120 50% 50% / 1.1)",
    ]) {
      expect(() =>
        normalizeTheme({
          ...baseInput,
          colors: { light: { accent: malformed } },
        }),
      ).toThrow(/accent|color/i);
    }
  });

  it("accepts only strict RGB and HSL channel forms", () => {
    const theme = normalizeTheme({
      ...baseInput,
      colors: {
        light: {
          canvas: "rgb(10 20 30 / 50%)",
          surface: "rgba(10, 20, 30, 0.5)",
          text: "hsl(120 50% 50% / 0.8)",
          textMuted: "hsla(120, 50%, 50%, 80%)",
        },
      },
    });

    expect(theme.colors.light.canvas).toBe("rgb(10 20 30 / 50%)");
    expect(theme.colors.light.surface).toBe("rgba(10, 20, 30, 0.5)");
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

  it("rejects unsafe or unconstrained shape dimensions", () => {
    for (const shape of [
      { radiusSm: "calc(4px + 2px)" },
      { radiusMd: "var(--radius)" },
      { radiusLg: "129px" },
      { radiusSm: "-1px" },
      { controlHeight: "1in" },
      { controlHeight: "129px" },
    ]) {
      expect(() => normalizeTheme({ ...baseInput, shape })).toThrow(/radius|height|shape/i);
    }
  });

  it("keeps distinct light and dark effects while accepting flat compatibility overrides", () => {
    const theme = normalizeTheme({
      ...baseInput,
      effects: {
        controlShadow: "0 0 1px #000",
        dark: { floatingShadow: "0 0 8px #000" },
      },
    });

    expect(theme.effects.controlShadow).toBe("0 0 1px #000");
    expect(theme.effects.light.controlShadow).toBe("0 0 1px #000");
    expect(theme.effects.dark.controlShadow).toBe("0 0 1px #000");
    expect(theme.effects.light.floatingShadow).not.toBe(theme.effects.dark.floatingShadow);
    expect(themeToExport(theme).effects).toEqual({
      light: theme.effects.light,
      dark: theme.effects.dark,
    });
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
