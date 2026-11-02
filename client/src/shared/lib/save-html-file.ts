/**
 * Save generated HTML to a location the user picks.
 *
 * Order of preference:
 *   1. Desktop shell: native "save as" sheet, and the main process writes the
 *      file (the renderer never receives a path it could write itself).
 *   2. Browser with File System Access: the page asks for a location directly.
 *   3. Plain download: the browser owns the destination.
 */

export type SaveHtmlResult = "saved" | "canceled";

interface DesktopSaveApi {
  saveTextFile?: (request: {
    suggestedName: string;
    contents: string;
    filters?: { name: string; extensions: string[] }[];
  }) => Promise<{ canceled?: boolean; filePath?: string } | undefined>;
}

interface FilePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{
    createWritable(): Promise<{
      write(data: string): Promise<void>;
      close(): Promise<void>;
    }>;
  }>;
}

const HTML_FILTERS = [{ name: "HTML", extensions: ["html", "htm"] }];

/** Dialog default names stay readable and filesystem-safe. */
export function htmlFileName(title: string | undefined, fallback = "visualization"): string {
  const base = (title ?? "")
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "-")
    .replace(/^[.\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${(base || fallback).slice(0, 120)}.html`;
}

export async function saveHtmlFileToUserLocation({
  title,
  html,
}: {
  title?: string;
  html: string;
}): Promise<SaveHtmlResult> {
  const suggestedName = htmlFileName(title);
  const desktop = (window as Window & { electronAPI?: DesktopSaveApi }).electronAPI;
  if (desktop?.saveTextFile) {
    const result = await desktop.saveTextFile({
      suggestedName,
      contents: html,
      filters: HTML_FILTERS,
    });
    return result?.canceled ? "canceled" : "saved";
  }

  const picker = (window as unknown as FilePickerWindow).showSaveFilePicker;
  if (typeof picker === "function") {
    try {
      const handle = await picker({
        suggestedName,
        types: [{ description: "HTML", accept: { "text/html": [".html", ".htm"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(html);
      await writable.close();
      return "saved";
    } catch (cause) {
      // A closed picker is a decision, not an error; anything else (unsupported
      // context, blocked permission) falls back to the download path.
      if ((cause as { name?: string } | null)?.name === "AbortError") return "canceled";
    }
  }

  downloadHtmlFile(suggestedName, html);
  return "saved";
}

function downloadHtmlFile(name: string, html: string): void {
  if (typeof document === "undefined" || typeof URL?.createObjectURL !== "function") return;
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
