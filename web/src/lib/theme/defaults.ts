import type {
  NormalizedTheme,
  ThemeColorTokens,
  ThemeEffectTokens,
  ThemeShapeTokens,
} from "./contract";

const lightColors: ThemeColorTokens = {
  canvas: "#f7f8fa",
  surface: "#ffffff",
  surfaceSecondary: "rgb(237 240 244 / 1)",
  text: "#242932",
  textMuted: "#626a76",
  textSubtle: "#8f96a1",
  border: "#dce2ea",
  borderStrong: "#c7dbd0",
  accent: "#a1bba8",
  accentForeground: "#2f3d34",
  accentSoft: "#edf4ef",
  success: "#00a240",
  warning: "#e25507",
  danger: "#e02e2a",
  info: "#0169cc",
  input: "#ffffff",
  inputForeground: "#242932",
  selection: "#d9e9dc",
  focus: "#3f6956",
  tooltip: "#272c34",
  tooltipForeground: "#f7f8fa",
};

const darkColors: ThemeColorTokens = {
  canvas: "#10141c",
  surface: "#171b23",
  surfaceSecondary: "rgb(39 44 52 / 0.7)",
  text: "#bfbdb6",
  textMuted: "#a6a59f",
  textSubtle: "#85847f",
  border: "#2d323b",
  borderStrong: "#4c535e",
  accent: "#a1bba8",
  accentForeground: "#2f3d34",
  accentSoft: "#2d3c34",
  success: "hsl(104.04 43.43% 50.78%)",
  warning: "hsl(27 100% 64%)",
  danger: "#ef6375",
  info: "#66b4ff",
  input: "#171b23",
  inputForeground: "#bfbdb6",
  selection: "#324638",
  focus: "#a1bba8",
  tooltip: "#f7f8fa",
  tooltipForeground: "#10141c",
};

const shape: ThemeShapeTokens = {
  radiusSm: "6px",
  radiusMd: "8px",
  radiusLg: "10px",
  controlHeight: "32px",
};

const effects: ThemeEffectTokens = {
  controlShadow:
    "0 1px 2px rgb(26 34 48 / .04), inset 0 1px rgb(255 255 255 / .7)",
  insetShadow: "inset 0 1px 2px rgb(26 34 48 / .04)",
  floatingShadow:
    "0 8px 24px rgb(26 34 48 / .08), 0 1px 3px rgb(26 34 48 / .045)",
};

/** The complete built-in theme used as the normalization base. */
export const DEFAULT_THEME: NormalizedTheme = {
  version: 1,
  id: "synax-default",
  name: "Synax Default",
  colors: {
    light: lightColors,
    dark: darkColors,
  },
  shape,
  effects,
};
