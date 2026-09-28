import { beforeEach, describe, expect, it } from "vitest";
import { accentPalette } from "../../appearance";
import { DEFAULT_THEME } from "../defaults";
import { mergeTheme } from "../normalize";
import {
  applyThemeRuntime,
  readThemeCssVariables,
  resolveThemeTokens,
} from "../runtime";

beforeEach(() => {
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
});

describe("theme runtime", () => {
  it("resolves colors, shape, and mode-specific effects", () => {
    const tokens = resolveThemeTokens(DEFAULT_THEME, "dark");

    expect(tokens.colors.surface).toBe(DEFAULT_THEME.colors.dark.surface);
    expect(tokens.shape).toEqual(DEFAULT_THEME.shape);
    expect(tokens.effects).toEqual(DEFAULT_THEME.effects.dark);
  });

  it("projects resolved light tokens to stable semantic CSS variables", () => {
    applyThemeRuntime(DEFAULT_THEME, "light");

    expect(document.documentElement.style.getPropertyValue("--theme-canvas")).toBe(
      DEFAULT_THEME.colors.light.canvas,
    );
    expect(document.documentElement.style.getPropertyValue("--theme-radius-md")).toBe(
      DEFAULT_THEME.shape.radiusMd,
    );
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("projects dark tokens and keeps compatibility aliases in sync", () => {
    applyThemeRuntime(DEFAULT_THEME, "dark");
    const root = document.documentElement.style;

    expect(root.getPropertyValue("--theme-surface")).toBe(DEFAULT_THEME.colors.dark.surface);
    expect(root.getPropertyValue("--background")).toBe(DEFAULT_THEME.colors.dark.canvas);
    expect(root.getPropertyValue("--foreground")).toBe(DEFAULT_THEME.colors.dark.text);
    expect(root.getPropertyValue("--border")).toBe(DEFAULT_THEME.colors.dark.border);
    expect(root.getPropertyValue("--surface")).toBe(DEFAULT_THEME.colors.dark.surface);
    expect(root.getPropertyValue("--primary")).toBeTruthy();
    expect(root.getPropertyValue("--primary-foreground")).toBeTruthy();
    expect(root.getPropertyValue("--success")).toBe(DEFAULT_THEME.colors.dark.success);
    expect(root.getPropertyValue("--warning")).toBe(DEFAULT_THEME.colors.dark.warning);
    expect(root.getPropertyValue("--danger")).toBe(DEFAULT_THEME.colors.dark.danger);
    expect(root.getPropertyValue("--info")).toBe(DEFAULT_THEME.colors.dark.info);
    expect(root.getPropertyValue("--ui-panel")).toBe(DEFAULT_THEME.colors.dark.surface);
    expect(root.getPropertyValue("--ui-line")).toBe(DEFAULT_THEME.colors.dark.border);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(root.colorScheme).toBe("dark");
  });

  it("uses exact public effect names while retaining reversed aliases", () => {
    applyThemeRuntime(DEFAULT_THEME, "dark");
    const root = document.documentElement.style;

    expect(root.getPropertyValue("--theme-control-shadow")).toBe(
      DEFAULT_THEME.effects.dark.controlShadow,
    );
    expect(root.getPropertyValue("--theme-inset-shadow")).toBe(
      DEFAULT_THEME.effects.dark.insetShadow,
    );
    expect(root.getPropertyValue("--theme-floating-shadow")).toBe(
      DEFAULT_THEME.effects.dark.floatingShadow,
    );
    expect(root.getPropertyValue("--theme-shadow-control")).toBe(
      DEFAULT_THEME.effects.dark.controlShadow,
    );
    expect(root.getPropertyValue("--ui-shadow-control")).toBe(
      DEFAULT_THEME.effects.dark.controlShadow,
    );
  });

  it("derives status foreground aliases from the resolved tooltip foreground", () => {
    const customTheme = mergeTheme(DEFAULT_THEME, {
      colors: {
        dark: {
          tooltipForeground: "#fef3c7",
        },
      },
    });
    applyThemeRuntime(customTheme, "dark");
    const root = document.documentElement.style;

    expect(root.getPropertyValue("--success-foreground")).toBe("#fef3c7");
    expect(root.getPropertyValue("--warning-foreground")).toBe("#fef3c7");
    expect(root.getPropertyValue("--danger-foreground")).toBe("#fef3c7");
    expect(root.getPropertyValue("--info-foreground")).toBe("#fef3c7");
    expect(root.getPropertyValue("--destructive-foreground")).toBe("48.00 96.49% 88.82%");
    expect(root.getPropertyValue("--success-foreground-hsl")).toBe("48.00 96.49% 88.82%");
  });

  it("preserves accent palette top/bottom/strong/muted/soft/ink semantics", () => {
    const customTheme = mergeTheme(DEFAULT_THEME, {
      colors: { light: { accent: "#98aecb" } },
    });
    const palette = accentPalette(customTheme.colors.light.accent, "light");
    applyThemeRuntime(customTheme, "light");
    const root = document.documentElement.style;

    expect(root.getPropertyValue("--cx-accent-top")).toBe(palette.top);
    expect(root.getPropertyValue("--cx-accent-bottom")).toBe(palette.bottom);
    expect(root.getPropertyValue("--cx-accent-strong")).toBe(palette.strong);
    expect(root.getPropertyValue("--cx-accent-muted")).toBe(palette.muted);
    expect(root.getPropertyValue("--cx-accent-soft")).toBe(customTheme.colors.light.accentSoft);
    expect(root.getPropertyValue("--cx-accent-ink")).toBe(palette.ink);
  });

  it.each([
    ["rgb(51 102 153)", "rgb(255 255 255)", "hsl(210 40% 95%)"],
    ["hsl(210 50% 40%)", "#ffffff", "rgb(235 242 250)"],
  ])("projects imported CSS accents through semantic and compatibility aliases", (accent, foreground, soft) => {
    const customTheme = mergeTheme(DEFAULT_THEME, {
      colors: {
        light: {
          accent,
          accentForeground: foreground,
          accentSoft: soft,
        },
      },
    });
    applyThemeRuntime(customTheme, "light");
    const root = document.documentElement.style;

    expect(root.getPropertyValue("--theme-accent")).toBe(accent);
    expect(root.getPropertyValue("--theme-accent-foreground")).toBe(foreground);
    expect(root.getPropertyValue("--theme-accent-soft")).toBe(soft);
    expect(root.getPropertyValue("--accent")).toBe(accent);
    expect(root.getPropertyValue("--primary")).toBe(root.getPropertyValue("--theme-accent-hsl"));
    expect(root.getPropertyValue("--ui-accent")).toBe(accent);
    expect(root.getPropertyValue("--cx-accent-bottom")).toBe(accent);
    expect(root.getPropertyValue("--cx-accent-ink")).toBe(foreground);
    expect(root.getPropertyValue("--cx-accent-soft")).toBe(soft);
    expect(root.getPropertyValue("--cx-accent-top")).not.toBe("#a1bba8");
    expect(root.getPropertyValue("--cx-accent-strong")).not.toBe("#a1bba8");
    expect(root.getPropertyValue("--cx-accent-muted")).not.toBe("#a1bba8");
  });

  it("keeps legacy radius and surface shadow compatibility semantics", () => {
    applyThemeRuntime(DEFAULT_THEME, "dark");
    const root = document.documentElement.style;

    expect(root.getPropertyValue("--theme-radius-md")).toBe("8px");
    expect(root.getPropertyValue("--radius")).toBe("10px");
    expect(root.getPropertyValue("--theme-surface-shadow")).toBe(
      "0 1px 2px rgb(0 0 0 / .10)",
    );
    expect(root.getPropertyValue("--surface-shadow")).toBe(
      "0 1px 2px rgb(0 0 0 / .10)",
    );
    expect(root.getPropertyValue("--surface-shadow")).not.toBe(
      root.getPropertyValue("--theme-control-shadow"),
    );
  });

  it("projects mode-specific effects and exposes the written variables", () => {
    applyThemeRuntime(DEFAULT_THEME, "dark");
    const variables = readThemeCssVariables();

    expect(variables["--theme-control-shadow"]).toBe(DEFAULT_THEME.effects.dark.controlShadow);
    expect(variables["--theme-inset-shadow"]).toBe(DEFAULT_THEME.effects.dark.insetShadow);
    expect(variables["--theme-floating-shadow"]).toBe(DEFAULT_THEME.effects.dark.floatingShadow);
    expect(variables["--surface-shadow"]).toBe("0 1px 2px rgb(0 0 0 / .10)");
  });
});
