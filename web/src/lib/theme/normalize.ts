import { DEFAULT_THEME } from "./defaults";
import {
  THEME_VERSION,
  type NormalizedTheme,
  type PartialThemeColorTokens,
  type PortableTheme,
  type SynaxTheme,
  type ThemeOverride,
  type ThemeColorTokens,
  type ResolvedTheme,
} from "./contract";
import {
  SynaxThemeSchema,
  ThemeOverrideSchema,
  isSafeCssColor,
  type ParsedSynaxTheme,
  type ParsedThemeOverride,
} from "./schema";

const DEFAULT_ACCENT = "#a1bba8";
const LIGHT_ACCENT_SOFT = "#edf4ef";

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

function rgbFromHex(hex: string): [number, number, number] | null {
  if (!/^#[\da-f]{6}$/i.test(hex)) return null;
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

function parseRgbChannel(value: string): number | null {
  const channel = value.trim();
  if (channel.endsWith("%")) {
    const percentage = Number.parseFloat(channel.slice(0, -1));
    return Number.isFinite(percentage)
      ? Math.min(100, Math.max(0, percentage)) / 100
      : null;
  }
  const number = Number.parseFloat(channel);
  return Number.isFinite(number) ? Math.min(255, Math.max(0, number)) / 255 : null;
}

function rgbFromCssColor(color: string): [number, number, number] | null {
  const normalized = color.trim();
  const hex = rgbFromHex(normalized);
  if (hex) return hex;

  const rgbMatch = normalized.match(/^rgba?\((.*)\)$/i);
  if (rgbMatch) {
    const channels = rgbMatch[1].split(/\s*[,/]\s*/).slice(0, 3);
    if (channels.length !== 3) return null;
    const values = channels.map(parseRgbChannel);
    return values.every((value): value is number => value !== null)
      ? (values as [number, number, number])
      : null;
  }

  const hslMatch = normalized.match(/^hsla?\((.*)\)$/i);
  if (hslMatch) {
    const channels = hslMatch[1].split(/\s*[,/]\s*/).slice(0, 3);
    if (channels.length !== 3 || !channels[1].endsWith("%") || !channels[2].endsWith("%"))
      return null;
    const hue = Number.parseFloat(channels[0]);
    const saturation = Number.parseFloat(channels[1]) / 100;
    const lightness = Number.parseFloat(channels[2]) / 100;
    if (![hue, saturation, lightness].every(Number.isFinite)) return null;
    const normalizedHue = ((hue % 360) + 360) % 360;
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const x = chroma * (1 - Math.abs(((normalizedHue / 60) % 2) - 1));
    const match = normalizedHue < 60
      ? [chroma, x, 0]
      : normalizedHue < 120
        ? [x, chroma, 0]
        : normalizedHue < 180
          ? [0, chroma, x]
          : normalizedHue < 240
            ? [0, x, chroma]
            : normalizedHue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];
    const lightnessOffset = lightness - chroma / 2;
    return match.map((channel) => channel + lightnessOffset) as [number, number, number];
  }

  return null;
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
  if (accent === DEFAULT_ACCENT && theme === "light") return LIGHT_ACCENT_SOFT;
  const background = theme === "dark" ? "#0f141d" : "#ffffff";
  return (
    mix(accent, background, theme === "dark" ? 0.8 : 0.87) ??
    `color-mix(in srgb, ${accent} ${theme === "dark" ? "20%" : "13%"}, ${background})`
  );
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
  if (accentChanged && normalizedOverride.accentForeground === undefined)
    colors.accentForeground = deriveAccentForeground(colors.accent);
  if (accentChanged && normalizedOverride.accentSoft === undefined)
    colors.accentSoft = deriveAccentSoft(colors.accent, theme);
  return colors;
}

function assertSafeThemeColors(theme: NormalizedTheme): void {
  for (const mode of ["light", "dark"] as const) {
    for (const value of Object.values(theme.colors[mode])) {
      if (!isSafeCssColor(value)) throw new Error(`Invalid theme color: ${value}`);
    }
  }
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
    effects: {
      ...base.effects,
      ...override.effects,
    },
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
    effects: theme.effects,
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
    effects: { ...normalized.effects },
  };
}
