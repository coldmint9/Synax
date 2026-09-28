import { describe, expect, it } from "vitest";
import { DEFAULT_THEME } from "../../../../lib/theme/defaults";
import { resolveThemeTokens } from "../../../../lib/theme/runtime";
import { terminalTheme } from "../TerminalViewport";

describe("terminalTheme", () => {
  it("maps normalized resolved semantic tokens to xterm colors", () => {
    const tokens = resolveThemeTokens(DEFAULT_THEME, "dark");
    expect(terminalTheme(tokens)).toEqual({
      background: tokens.colors.canvas,
      foreground: tokens.colors.text,
      cursor: tokens.colors.accent,
      selectionBackground: tokens.colors.selection,
      black: tokens.colors.surfaceSecondary,
      brightBlack: tokens.colors.textMuted,
    });
  });

  it("uses updated token values without relying on a legacy shell accent", () => {
    const tokens = resolveThemeTokens(
      {
        ...DEFAULT_THEME,
        colors: {
          ...DEFAULT_THEME.colors,
          dark: {
            ...DEFAULT_THEME.colors.dark,
            canvas: "#010203",
            text: "#040506",
            accent: "#070809",
            selection: "#0a0b0c",
            surfaceSecondary: "#0d0e0f",
            textMuted: "#101112",
          },
        },
      },
      "dark",
    );

    expect(terminalTheme(tokens)).toMatchObject({
      background: "#010203",
      foreground: "#040506",
      cursor: "#070809",
      selectionBackground: "#0a0b0c",
      black: "#0d0e0f",
      brightBlack: "#101112",
    });
  });
});
