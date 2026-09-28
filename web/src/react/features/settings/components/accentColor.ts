import { normalizeAccent } from "../../../../lib/appearance";
import { parseSafeCssColor } from "../../../../lib/theme/schema";

export interface Hsv {
  /** Degrees in [0, 360). */
  h: number;
  /** Saturation and value in [0, 1]. */
  s: number;
  v: number;
}

export function normalizeHex(input: string): string | null {
  const hex = input.trim();
  return normalizeAccent(hex.startsWith("#") ? hex : `#${hex}`);
}

/** Convert a supported semantic CSS color into the editor's opaque HEX form. */
export function cssColorToHex(input: string): string | null {
  const parsed = parseSafeCssColor(input);
  if (!parsed) return null;
  return `#${parsed.rgb
    .map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function wrapHue(hue: number): number {
  return Number.isFinite(hue) ? ((hue % 360) + 360) % 360 : 0;
}

function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export function hexToHsv(input: string, previousHue = 0): Hsv {
  const hex = normalizeHex(input);
  if (!hex) throw new TypeError("Invalid HEX color");
  const [r, g, b] = [1, 3, 5].map(
    (offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  // Achromatic RGB cannot encode hue; keep the editor's last chosen hue.
  let hue = previousHue;
  if (delta > 0) {
    if (max === r) hue = 60 * ((g - b) / delta);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  return { h: wrapHue(hue), s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const sector = wrapHue(h) / 60;
  const value = clampUnit(v);
  const chroma = value * clampUnit(s);
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  const rgb =
    sector < 1
      ? [chroma, x, 0]
      : sector < 2
        ? [x, chroma, 0]
        : sector < 3
          ? [0, chroma, x]
          : sector < 4
            ? [0, x, chroma]
            : sector < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return `#${rgb
    .map((channel) =>
      Math.round((channel + value - chroma) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
