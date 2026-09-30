import type { ChangeSet } from "@codemirror/state";
export const normalizeEditorText = (text: string) => text.replace(/\r\n?/g, "\n");
/** Convert a CodeMirror position to the original text without normalizing saved EOLs. */
export function editorOffsetToRaw(text: string, position: number): number {
  let raw = 0, logical = 0;
  while (raw < text.length && logical < position) {
    if (text[raw] === "\r" && text[raw + 1] === "\n") raw++;
    raw++; logical++;
  }
  return raw;
}
export const rawOffsetToEditor = (text: string, position: number) => normalizeEditorText(text.slice(0, position)).length;
export function preserveRawChanges(text: string, changes: ChangeSet): string {
  const eol = text.match(/\r\n|\n|\r/)?.[0] ?? "\n";
  const edits: { from: number; to: number; insert: string }[] = [];
  changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    edits.push({ from: editorOffsetToRaw(text, from), to: editorOffsetToRaw(text, to), insert: inserted.toString().replace(/\n/g, eol) });
  });
  for (const edit of edits.reverse()) text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  return text;
}
