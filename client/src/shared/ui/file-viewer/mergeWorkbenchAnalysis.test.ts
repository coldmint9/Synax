import { describe, expect, it } from "vitest";
import {
  analyzeMerge,
  findConflictRanges,
  mapMergeLine,
} from "./mergeWorkbenchAnalysis";

describe("merge workbench analysis", () => {
  it("finds whole conflict ranges with CRLF and preserves incomplete markers", () => {
    expect(
      findConflictRanges(
        "a\r\n<<<<<<< ours\r\nx\r\n=======\r\ny\r\n>>>>>>> theirs\r\nz\r\n<<<<<<< ours\r\nw",
      ),
    ).toEqual([
      { start: 2, end: 6 },
      { start: 8, end: 9 },
    ]);
  });
  it("maps unchanged line anchors across inserted blocks in both directions", () => {
    const result = analyzeMerge({
      generation: 2,
      version: 3,
      target: "a\nb\nc\nd",
      result: "a\nb\nnew\nc\nd",
      source: "a\nb\nnew\nc\nd",
    });
    expect(result.degraded).toBe(false);
    expect(mapMergeLine(4, result.target, 5, 4)).toBe(3);
    expect(mapMergeLine(3, result.target, 4, 5, true)).toBe(4);
  });
  it("bounds expensive diff work for a large file while preserving conflict locations", () => {
    const text =
      "ordinary\n".repeat(100_000) +
      "<<<<<<< a\nleft\n=======\nright\n>>>>>>> b";
    const result = analyzeMerge({
      generation: 1,
      version: 1,
      target: text,
      result: text,
      source: text,
    });
    expect(result.degraded).toBe(true);
    expect(result.conflicts).toEqual([{ start: 100001, end: 100005 }]);
    expect(result.target).toEqual([]);
  });
});

it("avoids a quadratic fallback for repeated and reversed line inputs", () => {
  const repetitive = "same\n".repeat(70000);
  const first = analyzeMerge({
    generation: 1,
    version: 1,
    target: repetitive,
    result: repetitive,
    source: repetitive,
  });
  expect(first.target.length).toBeLessThanOrEqual(1);
  const lines = Array.from({ length: 60000 }, (_, index) => String(index));
  const second = analyzeMerge({
    generation: 2,
    version: 2,
    target: lines.slice().reverse().join("\n"),
    result: lines.join("\n"),
    source: lines.join("\n"),
  });
  expect(second.target).toHaveLength(1);
  expect(second.source).toHaveLength(1);
});
