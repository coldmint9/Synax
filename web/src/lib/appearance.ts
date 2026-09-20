export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const DEFAULT_ACCENT = "#a1bba8";
export const ACCENT_PRESETS = [
  { color: DEFAULT_ACCENT, zh: "鼠尾草", en: "Sage" },
  { color: "#94b8b5", zh: "青瓷", en: "Celadon" },
  { color: "#98aecb", zh: "雾蓝", en: "Mist" },
  { color: "#b1a2c9", zh: "鸢尾", en: "Iris" },
  { color: "#c49eaa", zh: "烟玫瑰", en: "Rose" },
  { color: "#cca58d", zh: "陶土", en: "Clay" },
  { color: "#c5b581", zh: "麦穗", en: "Wheat" },
] as const;

export function normalizeAccent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().toLowerCase();
  if (/^#[\da-f]{6}$/.test(hex)) return hex;
  if (/^#[\da-f]{3}$/.test(hex))
    return `#${[...hex.slice(1)].map((digit) => digit + digit).join("")}`;
  return null;
}

export function systemTheme(): ResolvedTheme {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function rgb(hex: string) {
  return [1, 3, 5].map(
    (offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
}

export function contrastRatio(first: string, second: string): number {
  const luminance = (hex: string) =>
    rgb(hex)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const a = luminance(first),
    b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function mix(hex: string, target: string, amount: number): string {
  const end = rgb(target);
  return `#${rgb(hex)
    .map((c, i) =>
      Math.round((c + (end[i] - c) * amount) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function readableAccent(
  hex: string,
  background: string,
  target: string,
): string {
  for (let step = 0; step <= 100; step++) {
    const candidate = mix(hex, target, step / 100);
    if (contrastRatio(candidate, background) >= 4.5) return candidate;
  }
  return target;
}

export function hexToHsl(hex: string): string {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const delta = max - min,
    lightness = (max + min) / 2;
  let hue = 0;
  if (delta) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
  }
  const saturation = delta ? delta / (1 - Math.abs(2 * lightness - 1)) : 0;
  return `${((hue * 60 + 360) % 360).toFixed(2)} ${(saturation * 100).toFixed(2)}% ${(lightness * 100).toFixed(2)}%`;
}

export function accentPalette(color: string, theme: ResolvedTheme) {
  const accent = normalizeAccent(color) ?? DEFAULT_ACCENT;
  const dark = theme === "dark";
  const ink =
    contrastRatio(accent, "#2f3d34") >= 4.5
      ? "#2f3d34"
      : contrastRatio(accent, "#181818") >= 4.5
        ? "#181818"
        : contrastRatio(accent, "#ffffff") >= 4.5
          ? "#ffffff"
          : "#000000";
  const strong = readableAccent(
    accent,
    dark ? "#0f141d" : "#f9f9f9",
    dark ? "#ffffff" : "#181818",
  );
  let top = accent === DEFAULT_ACCENT ? "#b9cdbf" : mix(accent, "#ffffff", 0.2);
  // Keep foreground text readable across the entire selected-control gradient.
  if (contrastRatio(top, ink) < 4.5) top = accent;
  return {
    bottom: accent,
    top,
    ink,
    strong,
    muted: strong,
    soft: mix(accent, dark ? "#0f141d" : "#ffffff", dark ? 0.8 : 0.87),
  };
}

export function applyAppearance(theme: ResolvedTheme, accent: string): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  const palette = accentPalette(accent, theme);
  for (const [name, color] of Object.entries(palette)) {
    root.style.setProperty(`--cx-accent-${name}`, color);
    root.style.setProperty(`--cx-accent-${name}-hsl`, hexToHsl(color));
  }
}
