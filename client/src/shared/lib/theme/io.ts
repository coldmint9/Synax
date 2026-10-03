import { THEME_VERSION, type NormalizedTheme, type PortableTheme, type ThemeImportResult } from "./contract";
import { normalizeTheme, themeToExport } from "./normalize";

export const MAX_THEME_FILE_BYTES = 256 * 1024;

export type ThemeImportErrorKind =
  | "file-read"
  | "file-too-large"
  | "json-syntax"
  | "schema-invalid"
  | "unsupported-version";

export class ThemeImportError extends Error {
  constructor(
    public readonly kind: ThemeImportErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ThemeImportError";
  }
}

export function getThemeImportErrorKind(error: Error): ThemeImportErrorKind | null {
  return error instanceof ThemeImportError ? error.kind : null;
}

function asError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  return new Error(fallback);
}

function failedImport(kind: ThemeImportErrorKind, message: string): ThemeImportResult {
  return {
    ok: false,
    error: new ThemeImportError(kind, message),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Read and validate a user-supplied Synax theme file without mutating state. */
export async function readThemeFile(file: Blob): Promise<ThemeImportResult> {
  if (typeof file?.size === "number" && file.size > MAX_THEME_FILE_BYTES) {
    return failedImport(
      "file-too-large",
      `Theme file exceeds the ${MAX_THEME_FILE_BYTES} byte limit`,
    );
  }

  let text: string;
  try {
    text = await file.text();
  } catch (error) {
    const cause = asError(error, "Unable to read theme file");
    return failedImport("file-read", cause.message);
  }

  if (new TextEncoder().encode(text).byteLength > MAX_THEME_FILE_BYTES) {
    return failedImport(
      "file-too-large",
      `Theme file exceeds the ${MAX_THEME_FILE_BYTES} byte limit`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const cause = asError(error, "Theme file contains invalid JSON");
    return failedImport("json-syntax", cause.message);
  }

  if (isRecord(parsed) && "version" in parsed && parsed.version !== THEME_VERSION) {
    return failedImport(
      "unsupported-version",
      `Unsupported theme version: ${String(parsed.version)}`,
    );
  }

  try {
    return { ok: true, theme: normalizeTheme(parsed) };
  } catch (error) {
    const cause = asError(error, "Invalid Synax theme schema");
    return failedImport("schema-invalid", cause.message);
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
