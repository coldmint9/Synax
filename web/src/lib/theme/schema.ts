import { z } from "zod";
import {
  THEME_VERSION,
  type ThemeColorTokenKey,
  type ThemeEffectTokens,
  type ThemeShapeTokens,
} from "./contract";

const IDENTIFIER_MAX_LENGTH = 64;
const NAME_MAX_LENGTH = 128;
const DESCRIPTION_MAX_LENGTH = 512;
const COLOR_MAX_LENGTH = 128;
const SHADOW_MAX_LENGTH = 512;
const DIMENSION_MAX_LENGTH = 32;

const forbiddenCssPattern = /(?:[\u0000-\u001f\u007f<>{};@\\]|\/\*|\*\/|(?:javascript|vbscript|data):|(?:var|url|expression)\s*\()/i;
const hexPattern = /^#[\da-f]{3}(?:[\da-f]{3})?$/i;
const cssNumberPattern = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const dimensionPattern = /^(?:0|(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|%))$/i;

function splitFunction(value: string): { name: string; body: string } | null {
  const match = value.trim().match(/^(rgb|rgba|hsl|hsla)\((.*)\)$/i);
  if (!match || /[()]/.test(match[2])) return null;
  return { name: match[1].toLowerCase(), body: match[2].trim() };
}

function splitColorChannels(body: string, requiresAlpha: boolean): { channels: string[]; alpha?: string } | null {
  if (!body) return null;

  if (body.includes(",")) {
    if (/\//.test(body)) return null;
    const parts = body.split(",").map((part) => part.trim());
    if (parts.some((part) => !part)) return null;
    if (parts.length !== (requiresAlpha ? 4 : 3)) return null;
    const [first, second, third, alpha] = parts;
    return { channels: [first, second, third], alpha };
  }

  const slashParts = body.split("/");
  if (slashParts.length > 2) return null;
  const channels = slashParts[0].trim().split(/\s+/).filter(Boolean);
  if (channels.length === 0) return null;
  if (slashParts.length === 1) return { channels };
  const alphaParts = slashParts[1].trim().split(/\s+/).filter(Boolean);
  return alphaParts.length === 1 ? { channels, alpha: alphaParts[0] } : null;
}

function parseRgbChannel(value: string): number | null {
  const channel = value.trim();
  const isPercent = channel.endsWith("%");
  const raw = isPercent ? channel.slice(0, -1) : channel;
  if (!cssNumberPattern.test(raw)) return null;
  const number = Number(raw);
  const max = isPercent ? 100 : 255;
  if (number < 0 || number > max) return null;
  return number / max;
}

function parseAlpha(value: string): number | null {
  const alpha = value.trim();
  const isPercent = alpha.endsWith("%");
  const raw = isPercent ? alpha.slice(0, -1) : alpha;
  if (!cssNumberPattern.test(raw)) return null;
  const number = Number(raw);
  const max = isPercent ? 100 : 1;
  if (number < 0 || number > max) return null;
  return number / max;
}

function parseHue(value: string): number | null {
  const hue = value.trim().replace(/deg$/i, "");
  if (!cssNumberPattern.test(hue)) return null;
  const number = Number(hue);
  return number >= 0 && number <= 360 ? number : null;
}

function parseHslPercentage(value: string): number | null {
  if (!value.trim().endsWith("%")) return null;
  const raw = value.trim().slice(0, -1);
  if (!cssNumberPattern.test(raw)) return null;
  const number = Number(raw);
  return number >= 0 && number <= 100 ? number / 100 : null;
}

export interface ParsedCssColor {
  rgb: [number, number, number];
  alpha: number;
}

/**
 * Portable v1 subset: 3/6-digit HEX, comma-separated RGB/HSL (RGBA/HSLA
 * require alpha), or space-separated channels with optional slash alpha.
 * Hue is 0..360 degrees; channels and alpha must be in range, not clamped.
 * RGBA/HSLA require alpha in both forms. No relative colors or CSS functions.
 */
export function parseSafeCssColor(value: string): ParsedCssColor | null {
  const color = value.trim();
  if (!color || color.length > COLOR_MAX_LENGTH || forbiddenCssPattern.test(color)) return null;
  if (hexPattern.test(color)) {
    const normalized = color.length === 4
      ? `#${[...color.slice(1)].map((digit) => digit + digit).join("")}`
      : color;
    return {
      rgb: [1, 3, 5].map((offset) => parseInt(normalized.slice(offset, offset + 2), 16) / 255) as [number, number, number],
      alpha: 1,
    };
  }

  const functionColor = splitFunction(color);
  if (!functionColor) return null;
  const isRgb = functionColor.name === "rgb" || functionColor.name === "rgba";
  const requiresAlpha = functionColor.name === "rgba" || functionColor.name === "hsla";
  const parsed = splitColorChannels(functionColor.body, requiresAlpha);
  if (!parsed || parsed.channels.length !== 3 || (requiresAlpha && parsed.alpha === undefined))
    return null;
  const alpha = parsed.alpha === undefined ? 1 : parseAlpha(parsed.alpha);
  if (alpha === null) return null;

  if (isRgb) {
    // Legacy comma syntax requires either all numbers or all percentages.
    if (functionColor.body.includes(",") &&
      parsed.channels.some((channel) => channel.endsWith("%") !== parsed.channels[0].endsWith("%")))
      return null;
    const channels = parsed.channels.map(parseRgbChannel);
    return channels.every((channel): channel is number => channel !== null)
      ? { rgb: channels as [number, number, number], alpha }
      : null;
  }

  const hue = parseHue(parsed.channels[0]);
  const saturation = parseHslPercentage(parsed.channels[1]);
  const lightness = parseHslPercentage(parsed.channels[2]);
  if (hue === null || saturation === null || lightness === null) return null;

  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const channels = hue < 60
    ? [chroma, x, 0]
    : hue < 120
      ? [x, chroma, 0]
      : hue < 180
        ? [0, chroma, x]
        : hue < 240
          ? [0, x, chroma]
          : hue < 300
            ? [x, 0, chroma]
            : [chroma, 0, x];
  const offset = lightness - chroma / 2;
  return { rgb: channels.map((channel) => channel + offset) as [number, number, number], alpha };
}

export function isSafeCssColor(value: string): boolean {
  const color = value.trim();
  if (!color || color.length > COLOR_MAX_LENGTH || forbiddenCssPattern.test(color)) return false;
  if (/^(?:transparent|currentcolor)$/i.test(color)) return true;
  return parseSafeCssColor(color) !== null;
}

export function isSafeCssShadow(value: string): boolean {
  const shadow = value.trim();
  return (
    shadow.length > 0 &&
    shadow.length <= SHADOW_MAX_LENGTH &&
    !forbiddenCssPattern.test(shadow)
  );
}

function isSafeDimension(value: string, max: number, allowPercent: boolean): boolean {
  const dimension = value.trim();
  if (
    !dimension ||
    dimension.length > DIMENSION_MAX_LENGTH ||
    forbiddenCssPattern.test(dimension) ||
    !dimensionPattern.test(dimension)
  )
    return false;
  if (dimension === "0") return true;
  const match = dimension.match(/^([\d.]+)(px|rem|em|%)$/i);
  if (!match || (!allowPercent && match[2] === "%")) return false;
  const amount = Number(match[1]);
  return Number.isFinite(amount) && amount >= 0 && amount <= (match[2] === "%" ? 100 : max);
}

// v1 accepts a single nonnegative px/rem/em dimension (0..128), or a
// radius percentage (0..100). No calc(), var(), shorthands or CSS-wide keywords.
export function isSafeRadius(value: string): boolean {
  return isSafeDimension(value, 128, true);
}

export function isSafeControlHeight(value: string): boolean {
  return isSafeDimension(value, 128, false);
}

const colorToken = z
  .string()
  .trim()
  .min(1)
  .max(COLOR_MAX_LENGTH)
  .refine(isSafeCssColor, "must be a safe CSS color");

const shadowToken = z
  .string()
  .trim()
  .min(1)
  .max(SHADOW_MAX_LENGTH)
  .refine(isSafeCssShadow, "must be a safe CSS shadow");

const radiusToken = z
  .string()
  .trim()
  .max(DIMENSION_MAX_LENGTH)
  .refine(isSafeRadius, "must be a safe CSS radius");

const controlHeightToken = z
  .string()
  .trim()
  .max(DIMENSION_MAX_LENGTH)
  .refine(isSafeControlHeight, "must be a safe CSS control height");

const colorTokenShape: Record<ThemeColorTokenKey, z.ZodType<string>> = {
  canvas: colorToken,
  surface: colorToken,
  surfaceSecondary: colorToken,
  text: colorToken,
  textMuted: colorToken,
  textSubtle: colorToken,
  border: colorToken,
  borderStrong: colorToken,
  // Accent must be numeric so derived values never depend on the DOM.
  accent: colorToken.refine((value) => parseSafeCssColor(value) !== null, "accent must be a numeric CSS color"),
  accentForeground: colorToken,
  accentSoft: colorToken,
  success: colorToken,
  warning: colorToken,
  danger: colorToken,
  info: colorToken,
  input: colorToken,
  inputForeground: colorToken,
  selection: colorToken,
  focus: colorToken,
  tooltip: colorToken,
  tooltipForeground: colorToken,
};

const shapeTokenShape: Record<keyof ThemeShapeTokens, z.ZodType<string>> = {
  radiusSm: radiusToken,
  radiusMd: radiusToken,
  radiusLg: radiusToken,
  controlHeight: controlHeightToken,
};

const effectTokenShape: Record<keyof ThemeEffectTokens, z.ZodType<string>> = {
  controlShadow: shadowToken,
  insetShadow: shadowToken,
  floatingShadow: shadowToken,
};

export const ThemeColorTokensSchema = z.object(colorTokenShape).strict();
export const PartialThemeColorTokensSchema = ThemeColorTokensSchema.partial().strict();
export const ThemeShapeTokensSchema = z.object(shapeTokenShape).strict();
export const PartialThemeShapeTokensSchema = ThemeShapeTokensSchema.partial().strict();
export const ThemeEffectTokensSchema = z.object(effectTokenShape).strict();
export const PartialThemeEffectTokensSchema = ThemeEffectTokensSchema.partial().strict();

const effectsSchema = z
  .object({
    ...effectTokenShape,
    light: PartialThemeEffectTokensSchema.optional(),
    dark: PartialThemeEffectTokensSchema.optional(),
  })
  .partial()
  .strict();

const colorsSchema = z
  .object({
    light: PartialThemeColorTokensSchema.optional(),
    dark: PartialThemeColorTokensSchema.optional(),
  })
  .strict();

export const SynaxThemeSchema = z.object({
  version: z.literal(THEME_VERSION),
  id: z.string().trim().min(1).max(IDENTIFIER_MAX_LENGTH),
  name: z.string().trim().min(1).max(NAME_MAX_LENGTH),
  description: z.string().trim().min(1).max(DESCRIPTION_MAX_LENGTH).optional(),
  colors: colorsSchema.optional(),
  shape: PartialThemeShapeTokensSchema.optional(),
  effects: effectsSchema.optional(),
});

export const ThemeOverrideSchema = z.object({
  version: z.literal(THEME_VERSION).optional(),
  id: z.string().trim().min(1).max(IDENTIFIER_MAX_LENGTH).optional(),
  name: z.string().trim().min(1).max(NAME_MAX_LENGTH).optional(),
  description: z.string().trim().min(1).max(DESCRIPTION_MAX_LENGTH).optional(),
  colors: colorsSchema.optional(),
  shape: PartialThemeShapeTokensSchema.optional(),
  effects: effectsSchema.optional(),
});

export type ParsedSynaxTheme = z.infer<typeof SynaxThemeSchema>;
export type ParsedThemeOverride = z.infer<typeof ThemeOverrideSchema>;
