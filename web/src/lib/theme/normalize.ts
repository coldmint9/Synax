import { DEFAULT_THEME } from "./defaults";
import {
  THEME_VERSION,
  type NormalizedTheme,
  type PartialThemeColorTokens,
  type PortableTheme,
  type ThemeOverride,
  type ThemeColorTokens,
  type ThemeEffectTokens,
  type NormalizedThemeEffects,
  type ResolvedTheme,
} from "./contract";
import {
  SynaxThemeSchema,
  ThemeOverrideSchema,
  isSafeCssColor,
  parseSafeCssColor,
  type ParsedSynaxTheme,
  type ParsedThemeOverride,
} from "./schema";

const LIGHT_ACCENT_MIX_TARGET = "#f9f9f9";

function normalizeColor(value: string): string {
  const color = value.trim();
  if (/^#[\da-f]{3}$/i.test(color)) {
    return `#${[...color.slice(1)].map((digit) => digit + digit).join("")}`.toLowerCase();
  }
  if (/^#[\da-f]{6}$/i.test(color)) return color.toLowerCase();
  return color;
}

function normalizeTokenMap<T extends object>(tokens: Partial<T> | undefined): Partial<T> {
  if (!tokens) return {};
  return Object.fromEntries(
    Object.entries(tokens).map(([key, value]) => [key, normalizeColor(value as string)]),
  ) as Partial<T>;
}

function rgbFromCssColor(color: string): [number, number, number] | null {
  return parseSafeCssColor(color)?.rgb ?? null;
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function relativeLuminance(color: string): number | null {
  const rgb = rgbFromCssColor(color);
  if (!rgb) return null;
  return rgb
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    )
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  if (firstLuminance === null || secondLuminance === null) return 1;
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

function mix(color: string, target: string, amount: number): string | null {
  const sourceRgb = rgbFromCssColor(color);
  const targetRgb = rgbFromCssColor(target);
  if (!sourceRgb || !targetRgb) return null;
  return toHex(sourceRgb.map((channel, index) => channel + (targetRgb[index] - channel) * amount) as [
    number,
    number,
    number,
  ]);
}

function deriveAccentForeground(accent: string): string {
  const candidates = ["#2f3d34", "#181818", "#ffffff", "#000000"];
  return candidates.find((candidate) => contrastRatio(accent, candidate) >= 4.5) ?? "#000000";
}

function deriveAccentSoft(accent: string, theme: ResolvedTheme): string {
  const background = theme === "dark" ? "#0f141d" : LIGHT_ACCENT_MIX_TARGET;
  const soft = mix(accent, background, theme === "dark" ? 0.8 : 0.87);
  if (soft === null) throw new Error("Accent must be a numeric CSS color");
  return soft;
}

/** Composite translucent accents over the mode's canvas before deriving colors. */
function opaqueAccent(accent: string, canvas: string): string {
  const parsed = parseSafeCssColor(accent);
  if (!parsed) throw new Error("Accent must be a numeric CSS color");
  if (parsed.alpha === 1) return accent;
  const background = parseSafeCssColor(canvas);
  if (!background || background.alpha !== 1)
    throw new Error("A translucent accent requires an opaque numeric canvas color");
  return toHex(parsed.rgb.map((channel, index) =>
    channel * parsed.alpha + background.rgb[index] * (1 - parsed.alpha),
  ) as [number, number, number]);
}

function normalizeColors(
  base: ThemeColorTokens,
  override: PartialThemeColorTokens | undefined,
  theme: ResolvedTheme,
): ThemeColorTokens {
  const normalizedOverride = normalizeTokenMap<ThemeColorTokens>(override);
  const colors = {
    ...base,
    ...normalizedOverride,
  };
  const accentChanged = normalizedOverride.accent !== undefined;
  if (accentChanged && (normalizedOverride.accentForeground === undefined || normalizedOverride.accentSoft === undefined)) {
    const accent = opaqueAccent(colors.accent, colors.canvas);
    if (normalizedOverride.accentForeground === undefined)
      colors.accentForeground = deriveAccentForeground(accent);
    if (normalizedOverride.accentSoft === undefined)
      colors.accentSoft = deriveAccentSoft(accent, theme);
  }
  return colors;
}

function assertSafeThemeColors(theme: NormalizedTheme): void {
  for (const mode of ["light", "dark"] as const) {
    for (const value of Object.values(theme.colors[mode])) {
      if (!isSafeCssColor(value)) throw new Error(`Invalid theme color: ${value}`);
    }
  }
}

function mergeEffects(
  base: NormalizedTheme["effects"],
  override: ParsedThemeOverride["effects"],
): NormalizedThemeEffects {
  const { light: lightOverride, dark: darkOverride, ...flatOverride } = override ?? {};
  const light: ThemeEffectTokens = {
    ...base.light,
    ...flatOverride,
    ...lightOverride,
  };
  const dark: ThemeEffectTokens = {
    ...base.dark,
    ...flatOverride,
    ...darkOverride,
  };
  return {
    ...light,
    light,
    dark,
  };
}

function mergeParsedTheme(base: NormalizedTheme, override: ParsedThemeOverride): NormalizedTheme {
  const light = normalizeColors(base.colors.light, override.colors?.light, "light");
  const dark = normalizeColors(base.colors.dark, override.colors?.dark, "dark");
  const merged: NormalizedTheme = {
    version: THEME_VERSION,
    id: override.id ?? base.id,
    name: override.name ?? base.name,
    ...(override.description !== undefined
      ? { description: override.description }
      : base.description !== undefined
        ? { description: base.description }
        : {}),
    colors: { light, dark },
    shape: {
      ...base.shape,
      ...override.shape,
    },
    effects: mergeEffects(base.effects, override.effects),
  };
  assertSafeThemeColors(merged);
  return merged;
}

/** Validate, normalize, and fill a complete portable theme from untrusted input. */
export function normalizeTheme(input: unknown): NormalizedTheme {
  const parsed: ParsedSynaxTheme = SynaxThemeSchema.parse(input);
  return mergeParsedTheme(DEFAULT_THEME, parsed);
}

/** Merge a partial override onto an already-normalized theme. */
export function mergeTheme(base: NormalizedTheme, override: ThemeOverride): NormalizedTheme {
  const parsed = ThemeOverrideSchema.parse(override);
  return mergeParsedTheme(base, parsed);
}

/** Return a stable, JSON-safe export without runtime-only fields. */
export function themeToExport(theme: NormalizedTheme): PortableTheme {
  const normalized = normalizeTheme({
    version: THEME_VERSION,
    id: theme.id,
    name: theme.name,
    ...(theme.description ? { description: theme.description } : {}),
    colors: {
      light: theme.colors.light,
      dark: theme.colors.dark,
    },
    shape: theme.shape,
    effects: {
      light: theme.effects.light,
      dark: theme.effects.dark,
    },
  });

  return {
    version: THEME_VERSION,
    id: normalized.id,
    name: normalized.name,
    ...(normalized.description ? { description: normalized.description } : {}),
    colors: {
      light: { ...normalized.colors.light },
      dark: { ...normalized.colors.dark },
    },
    shape: { ...normalized.shape },
    effects: {
      light: { ...normalized.effects.light },
      dark: { ...normalized.effects.dark },
    },
  };
}
