import type { NormalizedTheme, PortableTheme, ThemeImportResult } from "./contract";
import { normalizeTheme, themeToExport } from "./normalize";

export const MAX_THEME_FILE_BYTES = 256 * 1024;

function asError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  return new Error(fallback);
}

/** Read and validate a user-supplied Synax theme file without mutating state. */
export async function readThemeFile(file: Blob): Promise<ThemeImportResult> {
  if (typeof file?.size === "number" && file.size > MAX_THEME_FILE_BYTES) {
    return {
      ok: false,
      error: new Error(`Theme file exceeds the ${MAX_THEME_FILE_BYTES} byte limit`),
    };
  }

  try {
    const text = await file.text();
    if (new TextEncoder().encode(text).byteLength > MAX_THEME_FILE_BYTES) {
      return {
        ok: false,
        error: new Error(`Theme file exceeds the ${MAX_THEME_FILE_BYTES} byte limit`),
      };
    }
    return { ok: true, theme: normalizeTheme(JSON.parse(text)) };
  } catch (error) {
    return {
      ok: false,
      error: asError(error, "Invalid Synax theme file"),
    };
  }
}

export function themeFileName(theme: Pick<NormalizedTheme, "id">): string {
  const id = theme.id.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "theme";
  return `${id}.synax-theme.json`;
}

/** Download a normalized theme in the browser. Safe to call in tests/SSR. */
export function downloadThemeFile(theme: NormalizedTheme | PortableTheme): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (typeof Blob === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return;

  const portable = "colors" in theme && "shape" in theme && "effects" in theme
    ? themeToExport(theme as NormalizedTheme)
    : theme;
  const blob = new Blob([JSON.stringify(portable, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = themeFileName(theme);
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
