import { describe, expect, it } from "vitest";
import { alignMergeDocuments } from "./mergeAlignment";
import {
  normalizeEditorText,
  rawOffsetToEditor,
  restoreLineEndings,
} from "./mergeEditorText";

describe("three-way display alignment", () => {
  it("aligns common lines after unequal replacement blocks without editing source text", () => {
    const left = "start\nL1\nL2\nL3\nshared\nend";
    const middle = "start\nM1\nshared\nend";
    const right = "start\nR1\nR2\nshared\nend";
    const alignment = alignMergeDocuments(left, middle, right);
    expect(alignment.lineRows[0][4]).toBe(alignment.lineRows[1][2]);
    expect(alignment.lineRows[2][3]).toBe(alignment.lineRows[1][2]);
    expect(alignment.gaps[1]).toContainEqual({ beforeLine: 2, rows: 2 });
    expect(alignment.rowCount).toBe(6);
  });
  it("keeps every document line exactly once across multiple insertions and deletions", () => {
    const texts = ["a\nleft extra\nb\nx\ny\nz\nc\n", "a\nb\nc\n", "right prefix\na\nb\nright extra\nc\n"];
    const alignment = alignMergeDocuments(...texts as [string, string, string]);
    texts.forEach((text, side) => {
      expect(alignment.lineRows[side]).toHaveLength(text.split("\n").length);
      expect(new Set(alignment.lineRows[side]).size).toBe(text.split("\n").length);
      expect([...alignment.lineRows[side]].sort((a, b) => a - b)).toEqual(alignment.lineRows[side]);
      expect(alignment.gaps[side].reduce((sum, gap) => sum + gap.rows, 0) + text.split("\n").length).toBe(alignment.rowCount);
    });
    for (const common of ["a", "b", "c"]) {
      const positions = texts.map((text, side) => alignment.lineRows[side][text.split("\n").indexOf(common)]);
      expect(new Set(positions).size).toBe(1);
    }
  });
  it("does not create gaps solely because EOL styles differ", () => {
    expect(alignMergeDocuments("a\r\nb\r\n", "a\nb\n", "a\rb\r").gaps).toEqual([[], [], []]);
  });
  it("preserves alignment for repeated unchanged lines and empty documents", () => {
    for (const texts of [["", "", ""], ["same\nsame\n", "same\n", "same\nsame\nsame\n"]] as const) {
      const alignment = alignMergeDocuments(...texts);
      texts.forEach((text, side) => expect(alignment.lineRows[side].length + alignment.gaps[side].reduce((sum, gap) => sum + gap.rows, 0)).toBe(alignment.rowCount));
    }
  });
});
describe("editor EOL preservation", () => {
  it("keeps the document's own CRLF style when the editor inserts LF text", () => {
    expect(restoreLineEndings("a\r\nb\nc\r\n", "a\nX\nY\nc\n")).toBe(
      "a\r\nX\r\nY\r\nc\r\n",
    );
  });
  it("leaves an LF document untouched", () => {
    expect(restoreLineEndings("one\ntwo\n", "1\ntwo\n3\n")).toBe("1\ntwo\n3\n");
  });
  it("maps raw offsets onto the normalized editor text", () => {
    expect(normalizeEditorText("a\r\nb\r\n")).toBe("a\nb\n");
    expect(rawOffsetToEditor("a\r\nb\r\n", 4)).toBe(3);
  });
});
