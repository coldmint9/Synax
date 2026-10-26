export const MAX_FILES = 120;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_SCRIPT_CHARS = 65_536;

export function generationTimeout(value = 30_000): number {
  return Number.isFinite(value) ? Math.max(1_000, Math.min(120_000, value)) : 30_000;
}

export function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.includes("\0")) throw new Error("file.generate only supports UTF-8 text without NUL bytes.");
  return text;
}
