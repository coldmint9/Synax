/**
 * Native "save as" for generated text (currently a standalone visualization).
 *
 * The renderer only supplies a suggested name and the contents; the main
 * process owns the dialog and the disk write, so no arbitrary path ever
 * crosses the IPC boundary. Host dependencies are injected to keep this
 * module testable without Electron.
 */

export interface SaveTextFileRequest {
  suggestedName: string;
  contents: string;
  filters?: SaveTextFileFilter[];
}

export interface SaveTextFileFilter {
  name: string;
  extensions: string[];
}

export interface SaveTextFileDialogs {
  showSaveDialog(
    options: SaveTextFileDialogOptions,
  ): Promise<{ canceled: boolean; filePath?: string }>;
  showSaveDialogWithParent?(
    parent: unknown,
    options: SaveTextFileDialogOptions,
  ): Promise<{ canceled: boolean; filePath?: string }>;
}

export interface SaveTextFileDialogOptions {
  title: string;
  defaultPath: string;
  filters: SaveTextFileFilter[];
}

export interface SaveTextFileHost {
  dialogs: SaveTextFileDialogs;
  writeFile(path: string, contents: string): Promise<void>;
  /** Parent window for a sheet-style dialog, when the sender has one. */
  parent?: unknown;
}

export interface SaveTextFileResult {
  canceled: boolean;
  filePath?: string;
}

/** Keep the dialog default a bare file name; the dialog owns the directory. */
export const MAX_SAVE_BYTES = 8 * 1024 * 1024;
const DEFAULT_FILTERS: SaveTextFileFilter[] = [
  { name: "HTML", extensions: ["html", "htm"] },
];

export function safeFileName(value: string, fallback = "export"): string {
  const base = value.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*]+/g, "-")
    .replace(/^[.\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || fallback).slice(0, 180);
}

/** Renderer payloads are untrusted: bound shape and size before any write. */
export function normalizeSaveTextRequest(
  value: unknown,
): SaveTextFileRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.suggestedName !== "string") return null;
  if (typeof record.contents !== "string") return null;
  const suggestedName = safeFileName(record.suggestedName);
  const contents = record.contents;
  if (!contents.trim()) return null;
  if (new TextEncoder().encode(contents).length > MAX_SAVE_BYTES) return null;
  const filters = Array.isArray(record.filters)
    ? record.filters.filter(
        (filter): filter is SaveTextFileFilter =>
          !!filter &&
          typeof filter === "object" &&
          typeof (filter as Record<string, unknown>).name === "string" &&
          Array.isArray((filter as Record<string, unknown>).extensions) &&
          ((filter as Record<string, unknown>).extensions as unknown[]).every(
            (extension) => typeof extension === "string" && extension.length > 0,
          ),
      )
    : [];
  return {
    suggestedName,
    contents,
    filters: filters.length ? filters : DEFAULT_FILTERS,
  };
}

export async function saveTextFile(
  request: SaveTextFileRequest,
  host: SaveTextFileHost,
): Promise<SaveTextFileResult> {
  const options: SaveTextFileDialogOptions = {
    title: "导出可视化",
    defaultPath: request.suggestedName,
    filters: request.filters ?? DEFAULT_FILTERS,
  };
  const result = host.parent && host.dialogs.showSaveDialogWithParent
    ? await host.dialogs.showSaveDialogWithParent(host.parent, options)
    : await host.dialogs.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { canceled: true };
  await host.writeFile(result.filePath, request.contents);
  return { canceled: false, filePath: result.filePath };
}
