import type {
  NormalizedTheme,
  ResolvedTheme,
  ThemeColorTokens,
  ThemeEffectTokens,
  ThemeShapeTokens,
} from "./contract";
import { accentPalette } from "../appearance";
import { parseSafeCssColor } from "./schema";

export interface ResolvedThemeTokens {
  colors: ThemeColorTokens;
  shape: ThemeShapeTokens;
  effects: ThemeEffectTokens;
}

export type ThemeCssVariables = Record<string, string>;

const LEGACY_RADIUS = "10px";

function cssColorToHex(value: string): string | null {
  const parsed = parseSafeCssColor(value);
  if (!parsed) return null;
  return `#${parsed.rgb
    .map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

const SURFACE_SHADOWS: Record<ResolvedTheme, string> = {
  light: "0 1px 2px rgb(26 34 48 / .03)",
  dark: "0 1px 2px rgb(0 0 0 / .10)",
};

const COLOR_HSL_KEYS = [
  "canvas",
  "surface",
  "surfaceSecondary",
  "text",
  "textMuted",
  "textSubtle",
  "border",
  "borderStrong",
  "accent",
  "accentForeground",
  "accentSoft",
  "success",
  "warning",
  "danger",
  "info",
  "input",
  "inputForeground",
  "selection",
  "focus",
  "tooltip",
  "tooltipForeground",
] as const satisfies readonly (keyof ThemeColorTokens)[];

function toHslChannels(value: string): string {
  const parsed = parseSafeCssColor(value);
  if (!parsed) {
    // `transparent` and `currentcolor` are valid portable values but cannot be
    // represented as standalone HSL channels. Keep the compatibility alias
    // valid and let the raw semantic variable carry the original value.
    return "0 0% 0%";
  }

  const [red, green, blue] = parsed.rgb;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const lightness = (max + min) / 2;
  let hue = 0;
  let saturation = 0;

  if (delta !== 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue = (hue * 60 + 360) % 360;
  }

  return `${hue.toFixed(2)} ${(saturation * 100).toFixed(2)}% ${(lightness * 100).toFixed(2)}%`;
}

/** Select the resolved color/effect set without reading from the DOM. */
export function resolveThemeTokens(
  theme: NormalizedTheme,
  resolvedTheme: ResolvedTheme,
): ResolvedThemeTokens {
  return {
    colors: { ...theme.colors[resolvedTheme] },
    shape: { ...theme.shape },
    effects: { ...theme.effects[resolvedTheme] },
  };
}

function buildThemeVariables(tokens: ResolvedThemeTokens, resolvedTheme: ResolvedTheme): ThemeCssVariables {
  const { colors, shape, effects } = tokens;
  const variables: ThemeCssVariables = {};
  const accentHex = cssColorToHex(colors.accent);
  const generatedAccent = accentHex ? accentPalette(accentHex, resolvedTheme) : null;
  const accent = {
    // Semantic tokens are authoritative for the selected accent and its
    // explicitly normalized foreground/soft values. The generated palette is
    // only used for the legacy top/strong/muted variants.
    top: generatedAccent?.top ?? colors.accent,
    bottom: colors.accent,
    strong: generatedAccent?.strong ?? colors.accent,
    ink: colors.accentForeground,
    soft: colors.accentSoft,
    muted: generatedAccent?.muted ?? colors.accent,
  };

  for (const key of COLOR_HSL_KEYS) {
    variables[`--theme-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`] = colors[key];
    variables[`--theme-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-hsl`] = toHslChannels(colors[key]);
  }

  variables["--theme-radius-sm"] = shape.radiusSm;
  variables["--theme-radius-md"] = shape.radiusMd;
  variables["--theme-radius-lg"] = shape.radiusLg;
  variables["--theme-control-height"] = shape.controlHeight;
  variables["--theme-radius-compat"] = LEGACY_RADIUS;
  variables["--theme-control-shadow"] = effects.controlShadow;
  variables["--theme-inset-shadow"] = effects.insetShadow;
  variables["--theme-floating-shadow"] = effects.floatingShadow;
  // Reversed names are retained for the migration window.
  variables["--theme-shadow-control"] = effects.controlShadow;
  variables["--theme-shadow-inset"] = effects.insetShadow;
  variables["--theme-shadow-floating"] = effects.floatingShadow;
  variables["--theme-surface-shadow"] = SURFACE_SHADOWS[resolvedTheme];

  const hsl = (key: keyof ThemeColorTokens) => variables[`--theme-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-hsl`];
  const raw = (key: keyof ThemeColorTokens) => variables[`--theme-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`];
  const foreground = raw("tooltipForeground");
  const foregroundHsl = hsl("tooltipForeground");

  // Core semantic aliases.
  Object.assign(variables, {
    "--background": raw("canvas"),
    "--foreground": raw("text"),
    "--border": raw("border"),
    "--surface": raw("surface"),
    "--surface-foreground": raw("text"),
    "--surface-secondary": raw("surfaceSecondary"),
    "--background-hsl": hsl("canvas"),
    "--foreground-hsl": hsl("text"),
    "--border-hsl": hsl("border"),
    "--muted-hsl": hsl("surfaceSecondary"),
    "--primary": hsl("accent"),
    "--primary-foreground": hsl("accentForeground"),
    "--accent": raw("accent"),
    "--accent-foreground": raw("accentForeground"),
    "--accent-hsl": hsl("accent"),
    "--accent-foreground-hsl": hsl("accentForeground"),
    "--secondary": hsl("surfaceSecondary"),
    "--secondary-foreground": hsl("text"),
    "--input": hsl("input"),
    "--ring": hsl("focus"),
    "--focus": raw("focus"),
    "--field-border-focus": raw("focus"),
    "--muted": raw("textMuted"),
    "--muted-foreground": hsl("textMuted"),
    "--card": hsl("surface"),
    "--card-foreground": hsl("text"),
    "--popover": hsl("surface"),
    "--popover-foreground": hsl("text"),
    "--destructive": hsl("danger"),
    "--destructive-foreground": foregroundHsl,
    "--success": raw("success"),
    "--success-foreground": foreground,
    "--success-hsl": hsl("success"),
    "--warning": raw("warning"),
    "--warning-foreground": foreground,
    "--warning-hsl": hsl("warning"),
    "--danger": raw("danger"),
    "--danger-foreground": foreground,
    "--danger-hsl": hsl("danger"),
    "--info": raw("info"),
    "--info-foreground": foreground,
    "--info-hsl": hsl("info"),
    "--success-foreground-hsl": foregroundHsl,
    "--warning-foreground-hsl": foregroundHsl,
    "--danger-foreground-hsl": foregroundHsl,
    "--info-foreground-hsl": foregroundHsl,
    "--surface-shadow": SURFACE_SHADOWS[resolvedTheme],
    "--overlay": raw("surface"),
    "--overlay-foreground": raw("text"),
    "--default": raw("surfaceSecondary"),
    "--default-hover": raw("border"),
    "--default-foreground": raw("text"),
    "--field-background": raw("input"),
    "--field-foreground": raw("inputForeground"),
    "--field-placeholder": raw("textMuted"),
    "--field-border": raw("border"),
    "--field-border-hover": raw("borderStrong"),
    "--field-hover": raw("surfaceSecondary"),
    "--field-focus": raw("surface"),
    "--separator": raw("border"),
    "--segment": raw("surface"),
    "--segment-foreground": raw("text"),
    "--scrollbar": raw("borderStrong"),
    "--radius": LEGACY_RADIUS,
  });

  // Existing --ui-* aliases remain valid for legacy component CSS.
  Object.assign(variables, {
    "--ui-canvas": raw("canvas"),
    "--ui-panel": raw("surface"),
    "--ui-panel-soft": raw("surfaceSecondary"),
    "--ui-text": raw("text"),
    "--ui-subtle": raw("textMuted"),
    "--ui-line": raw("border"),
    "--ui-line-strong": raw("borderStrong"),
    "--ui-signal": raw("accent"),
    "--ui-canvas-hsl": hsl("canvas"),
    "--ui-panel-hsl": hsl("surface"),
    "--ui-panel-soft-hsl": hsl("surfaceSecondary"),
    "--ui-text-hsl": hsl("text"),
    "--ui-subtle-hsl": hsl("textMuted"),
    "--ui-line-hsl": hsl("border"),
    "--ui-line-strong-hsl": hsl("borderStrong"),
    "--ui-signal-hsl": hsl("accent"),
    "--ui-accent": raw("accent"),
    "--ui-accent-soft": raw("accentSoft"),
    "--ui-shadow-control": effects.controlShadow,
    "--ui-shadow-inset": effects.insetShadow,
    "--ui-shadow-floating": effects.floatingShadow,
    "--ui-tooltip-background": raw("tooltip"),
    "--ui-tooltip-foreground": raw("tooltipForeground"),
    "--agent-glass-bg": raw("surface"),
    "--agent-glass-border": raw("border"),
    "--agent-glass-shadow": effects.controlShadow,
  });

  // The legacy accent aliases are still consumed by the settings and control
  // styles during the migration window.
  Object.assign(variables, {
    "--cx-accent-bottom": raw("accent"),
    "--cx-accent-bottom-hsl": hsl("accent"),
    "--cx-accent-top": accent.top,
    "--cx-accent-top-hsl": toHslChannels(accent.top),
    "--cx-accent-strong": accent.strong,
    "--cx-accent-strong-hsl": toHslChannels(accent.strong),
    "--cx-accent-ink": raw("accentForeground"),
    "--cx-accent-ink-hsl": hsl("accentForeground"),
    "--cx-accent-soft": raw("accentSoft"),
    "--cx-accent-soft-hsl": hsl("accentSoft"),
    "--cx-accent-muted": accent.muted,
    "--cx-accent-muted-hsl": toHslChannels(accent.muted),
    "--cx-success-hsl": hsl("success"),
    "--cx-warning-hsl": hsl("warning"),
    "--cx-danger-hsl": hsl("danger"),
    "--cx-info-hsl": hsl("info"),
    "--radio-accent-top": accent.top,
    "--radio-accent-bottom": raw("accent"),
    "--radio-accent-text": raw("accentForeground"),
    "--radio-idle-text": accent.muted,
  });

  return variables;
}

/** Project all resolved tokens and compatibility aliases onto the document root. */
export function applyThemeRuntime(theme: NormalizedTheme, resolvedTheme: ResolvedTheme): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  root.classList.toggle("dark", resolvedTheme === "dark");
  root.style.colorScheme = resolvedTheme;

  const variables = buildThemeVariables(resolveThemeTokens(theme, resolvedTheme), resolvedTheme);
  for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
}

/** Read inline CSS variables written by applyThemeRuntime for JS consumers/tests. */
export function readThemeCssVariables(): ThemeCssVariables {
  if (typeof document === "undefined") return {};

  const style = document.documentElement.style;
  const variables: ThemeCssVariables = {};
  for (let index = 0; index < style.length; index += 1) {
    const name = style.item(index);
    if (name?.startsWith("--")) variables[name] = style.getPropertyValue(name).trim();
  }
  return variables;
}
