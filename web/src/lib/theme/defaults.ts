import type {
  NormalizedTheme,
  ThemeColorTokens,
  ThemeEffectTokens,
  ThemeShapeTokens,
} from "./contract";

// Light neutrals keep the previous lightness steps but carry a very faint warm
// cast, so the app canvas and the panels floating above it read as paper.
const lightColors: ThemeColorTokens = {
  canvas: "#f9f6f5",
  surface: "#fcf9f8",
  surfaceSecondary: "rgb(243 238 235 / 1)",
  text: "#242932",
  textMuted: "#626a76",
  textSubtle: "#8f96a1",
  border: "#e8dfda",
  borderStrong: "#d8cdc7",
  accent: "#a1bba8",
  accentForeground: "#2f3d34",
  accentSoft: "#edf4ef",
  success: "#00a240",
  warning: "#e25507",
  danger: "#e02e2a",
  info: "#0169cc",
  input: "#fcf9f8",
  inputForeground: "#242932",
  selection: "#d9e9dc",
  focus: "#3f6956",
  tooltip: "#272c34",
  tooltipForeground: "#f9f6f5",
};

const darkColors: ThemeColorTokens = {
  canvas: "#10141c",
  surface: "#171b23",
  surfaceSecondary: "#272c34",
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

const lightEffects: ThemeEffectTokens = {
  controlShadow:
    "0 1px 2px rgb(26 34 48 / .04), inset 0 1px rgb(255 255 255 / .7)",
  insetShadow: "inset 0 1px 2px rgb(26 34 48 / .04)",
  floatingShadow:
    "0 8px 24px rgb(26 34 48 / .08), 0 1px 3px rgb(26 34 48 / .045)",
};

const darkEffects: ThemeEffectTokens = {
  controlShadow:
    "0 1px 2px rgb(0 0 0 / .14), inset 0 1px rgb(255 255 255 / .035)",
  insetShadow: "inset 0 1px 2px rgb(0 0 0 / .14)",
  floatingShadow:
    "0 10px 28px rgb(0 0 0 / .20), 0 1px 3px rgb(0 0 0 / .14)",
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
  effects: {
    ...lightEffects,
    light: lightEffects,
    dark: darkEffects,
  },
};
