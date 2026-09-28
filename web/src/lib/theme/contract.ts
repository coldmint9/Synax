export const THEME_VERSION = 1 as const;

export type ThemeVersion = typeof THEME_VERSION;
export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type ThemeSource = "builtin" | "imported";

export const THEME_COLOR_KEYS = [
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
] as const;

export type ThemeColorTokenKey = (typeof THEME_COLOR_KEYS)[number];

export interface ThemeColorTokens {
  canvas: string;
  surface: string;
  surfaceSecondary: string;
  text: string;
  textMuted: string;
  textSubtle: string;
  border: string;
  borderStrong: string;
  accent: string;
  accentForeground: string;
  accentSoft: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  input: string;
  inputForeground: string;
  selection: string;
  focus: string;
  tooltip: string;
  tooltipForeground: string;
}

export type PartialThemeColorTokens = Partial<ThemeColorTokens>;

export interface ThemeShapeTokens {
  radiusSm: string;
  radiusMd: string;
  radiusLg: string;
  controlHeight: string;
}

export type PartialThemeShapeTokens = Partial<ThemeShapeTokens>;

export interface ThemeEffectTokens {
  controlShadow: string;
  insetShadow: string;
  floatingShadow: string;
}

export type PartialThemeEffectTokens = Partial<ThemeEffectTokens>;

export interface SynaxTheme {
  version: ThemeVersion;
  id: string;
  name: string;
  description?: string;
  colors?: {
    light?: PartialThemeColorTokens;
    dark?: PartialThemeColorTokens;
  };
  shape?: PartialThemeShapeTokens;
  effects?: PartialThemeEffectTokens;
}

/** A normalized theme has every token filled and is safe to project to a runtime. */
export interface NormalizedTheme extends SynaxTheme {
  colors: {
    light: ThemeColorTokens;
    dark: ThemeColorTokens;
  };
  shape: ThemeShapeTokens;
  effects: ThemeEffectTokens;
}

/** Top-level partial form accepted by mergeTheme before default filling. */
export interface ThemeOverride {
  version?: ThemeVersion;
  id?: string;
  name?: string;
  description?: string;
  colors?: {
    light?: PartialThemeColorTokens;
    dark?: PartialThemeColorTokens;
  };
  shape?: PartialThemeShapeTokens;
  effects?: PartialThemeEffectTokens;
}

export type PortableTheme = Omit<NormalizedTheme, "description"> & {
  description?: string;
};

export interface ThemeImportSuccess {
  ok: true;
  theme: NormalizedTheme;
}

export interface ThemeImportFailure {
  ok: false;
  error: Error;
}

export type ThemeImportResult = ThemeImportSuccess | ThemeImportFailure;
