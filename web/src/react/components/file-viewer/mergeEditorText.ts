/** The editor always works on LF text; documents may be stored with another EOL. */
export const normalizeEditorText = (text: string) => text.replace(/\r\n?/g, "\n");

export const documentLineEnding = (text: string) =>
  text.match(/\r\n|\n|\r/)?.[0] ?? "\n";

/** Map an offset in the raw document onto the normalized editor text. */
export const rawOffsetToEditor = (text: string, position: number) =>
  normalizeEditorText(text.slice(0, position)).length;

/** Re-apply the document's own EOL style to text the editor produced with LF. */
export function restoreLineEndings(original: string, next: string): string {
  const eol = documentLineEnding(original);
  return eol === "\n" ? next : next.replace(/\n/g, eol);
}
