import { diffArrays } from "diff";

export interface MergeAlignment {
  /** Visual row for each real (zero-based) document line. No document is padded. */
  lineRows: number[][];
  gaps: { beforeLine: number; rows: number }[][];
  rowCount: number;
}
function pairLines(center: string[], side: string[]) {
  const mapped: (number | null)[] = Array(center.length).fill(null);
  const inserted = new Map<number, number[]>();
  const chunks = diffArrays(center, side);
  let c = 0, s = 0;
  for (let i = 0; i < chunks.length;) {
    const chunk = chunks[i];
    if (!chunk.added && !chunk.removed) {
      for (let n = 0; n < chunk.value.length; n++) mapped[c++] = s++;
      i++;
      continue;
    }
    let removed = 0, added = 0;
    while (i < chunks.length && (chunks[i].added || chunks[i].removed)) {
      if (chunks[i].removed) removed += chunks[i].value.length;
      else added += chunks[i].value.length;
      i++;
    }
    for (let n = 0; n < Math.min(removed, added); n++) mapped[c + n] = s + n;
    if (added > removed) inserted.set(c + removed, Array.from({ length: added - removed }, (_, n) => s + removed + n));
    c += removed; s += added;
  }
  return { mapped, inserted };
}
/** Align both sides against the editable result using display-only spacer widgets. */
export function alignMergeDocuments(target: string, result: string, source: string): MergeAlignment {
  const documents = [target, result, source].map(text => text.replace(/\r\n?/g, "\n").split("\n"));
  const left = pairLines(documents[1], documents[0]);
  const right = pairLines(documents[1], documents[2]);
  const slots: (number | null)[][] = [];
  for (let line = 0; line <= documents[1].length; line++) {
    const a = left.inserted.get(line) ?? [], b = right.inserted.get(line) ?? [];
    for (let index = 0; index < Math.max(a.length, b.length); index++) slots.push([a[index] ?? null, null, b[index] ?? null]);
    if (line < documents[1].length) slots.push([left.mapped[line], line, right.mapped[line]]);
  }
  const lineRows = documents.map(() => [] as number[]);
  const gaps = documents.map(() => [] as MergeAlignment["gaps"][number]);
  documents.forEach((lines, side) => {
    let pending = 0;
    slots.forEach((slot, visualRow) => {
      const line = slot[side];
      if (line === null) { pending++; return; }
      if (pending) { gaps[side].push({ beforeLine: line, rows: pending }); pending = 0; }
      lineRows[side][line] = visualRow;
    });
    if (pending) gaps[side].push({ beforeLine: lines.length, rows: pending });
  });
  return { lineRows, gaps, rowCount: slots.length };
}
