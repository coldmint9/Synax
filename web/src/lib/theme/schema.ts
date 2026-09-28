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

const forbiddenCssPattern = /(?:[\u0000-\u001f<>{};]|(?:javascript|vbscript|data):|(?:var|url|expression)\s*\()/i;
const hexPattern = /^#[\da-f]{3}(?:[\da-f]{3})?$/i;
const functionColorPattern = /^(?:rgb|rgba|hsl|hsla)\((?:[^()\s]+|[\s,./+%-]+)+\)$/i;

export function isSafeCssColor(value: string): boolean {
  const color = value.trim();
  if (!color || color.length > COLOR_MAX_LENGTH || forbiddenCssPattern.test(color))
    return false;
  if (hexPattern.test(color)) return true;
  if (/^(?:transparent|currentcolor)$/i.test(color)) return true;
  return functionColorPattern.test(color);
}

export function isSafeCssShadow(value: string): boolean {
  const shadow = value.trim();
  return (
    shadow.length > 0 &&
    shadow.length <= SHADOW_MAX_LENGTH &&
    !forbiddenCssPattern.test(shadow)
  );
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

const colorTokenShape: Record<ThemeColorTokenKey, z.ZodType<string>> = {
  canvas: colorToken,
  surface: colorToken,
  surfaceSecondary: colorToken,
  text: colorToken,
  textMuted: colorToken,
  textSubtle: colorToken,
  border: colorToken,
  borderStrong: colorToken,
  accent: colorToken,
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
  radiusSm: z.string().trim().min(1).max(64),
  radiusMd: z.string().trim().min(1).max(64),
  radiusLg: z.string().trim().min(1).max(64),
  controlHeight: z.string().trim().min(1).max(64),
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
  effects: PartialThemeEffectTokensSchema.optional(),
});

/**
 * The merge form is intentionally optional at the top level so callers can
 * apply a small override without restating the identity of a base theme.
 */
export const ThemeOverrideSchema = z.object({
  version: z.literal(THEME_VERSION).optional(),
  id: z.string().trim().min(1).max(IDENTIFIER_MAX_LENGTH).optional(),
  name: z.string().trim().min(1).max(NAME_MAX_LENGTH).optional(),
  description: z.string().trim().min(1).max(DESCRIPTION_MAX_LENGTH).optional(),
  colors: colorsSchema.optional(),
  shape: PartialThemeShapeTokensSchema.optional(),
  effects: PartialThemeEffectTokensSchema.optional(),
});

export type ParsedSynaxTheme = z.infer<typeof SynaxThemeSchema>;
export type ParsedThemeOverride = z.infer<typeof ThemeOverrideSchema>;
