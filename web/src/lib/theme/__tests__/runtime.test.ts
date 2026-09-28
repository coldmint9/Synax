import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_THEME } from "../defaults";
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

  it("projects mode-specific effects and exposes the written variables", () => {
    applyThemeRuntime(DEFAULT_THEME, "dark");
    const variables = readThemeCssVariables();

    expect(variables["--theme-shadow-control"]).toBe(DEFAULT_THEME.effects.dark.controlShadow);
    expect(variables["--theme-shadow-inset"]).toBe(DEFAULT_THEME.effects.dark.insetShadow);
    expect(variables["--theme-shadow-floating"]).toBe(DEFAULT_THEME.effects.dark.floatingShadow);
    expect(variables["--ui-shadow-control"]).toBe(DEFAULT_THEME.effects.dark.controlShadow);
    expect(variables["--surface-shadow"]).toBe(DEFAULT_THEME.effects.dark.controlShadow);
  });
});
