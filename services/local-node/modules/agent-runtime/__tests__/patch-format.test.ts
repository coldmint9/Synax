import { describe, expect, it } from "vitest";
import { deriveNewContentsFromChunks, parseApplyPatchEnvelope } from "../tools/patch-format.js";
import { PatchApplyError, type PatchDiagnostic } from "../tools/patch-diagnostics.js";

const envelope = (body: string) => `*** Begin Patch\n*** Update File: sample.ts\n${body}\n*** End Patch`;
function apply(text: string, body: string): string {
  const hunk = parseApplyPatchEnvelope(envelope(body))[0];
  if (hunk.type !== "update") throw new Error("expected update");
  return deriveNewContentsFromChunks(hunk.path, hunk.chunks, text);
}
function diagnostic(operation: () => unknown): PatchDiagnostic {
  try { operation(); } catch (error) {
    expect(error).toBeInstanceOf(PatchApplyError);
    const failure = error as PatchApplyError;
    expect(JSON.parse(failure.message)).toEqual(failure.diagnostic);
    expect(failure.diagnostic).toMatchObject({ error: true, applied: false });
    expect(failure.diagnostic.recovery).toContain("do not retry");
    return failure.diagnostic;
  }
  throw new Error("expected patch to fail");
}

describe("patch matching and diagnostics", () => {
  it.each([
    ["exact", "a\nb\nc\n", "@@\n-b\n+B", "a\nB\nc\n"],
    ["whitespace", "  a  \n\tb\t\n", "@@\n-a\n-b\n+A\n+B", "A\nB\n"],
    ["CRLF", "a\r\nb\r\n", "@@\n-b\n+B", "a\nB\n"],
    ["unicode punctuation", "const s = ‘a’;\n", "@@\n-const s = 'a';\n+const s = 'b';", "const s = 'b';\n"],
    ["ordered disjoint hunks", "a\nb\nc\n", "@@\n-a\n+A\n@@\n-c\n+C", "A\nb\nC\n"],
    ["anchor", "first\na\nsecond\na\n", "@@ second\n-a\n+A", "first\na\nsecond\nA\n"],
    ["anchored insertion", "a\nb\n", "@@ a\n+new", "a\nnew\nb\n"],
    ["append", "a\n", "@@\n+b", "a\nb\n"],
    ["trailing empty context", "a\n\n", "@@\n-a\n+A\n ", "A\n\n"],
  ])("preserves %s matching", (_, source, body, expected) => {
    expect(apply(source, body)).toBe(expected);
  });

  it.each([
    ["stale text", "const n = 2;\n", "@@\n-const n = 1;\n+const n = 3;", "PATCH_CONTEXT_MISMATCH", 1],
    ["missing blank line", "a\n\nb\n", "@@\n a\n-b\n+B", "PATCH_CONTEXT_MISMATCH", 1],
    ["internal spaces", "const x=1;\n", "@@\n-const x = 1;\n+const x = 2;", "PATCH_CONTEXT_MISMATCH", 1],
    ["overlapping context", "a\nb\nc\n", "@@\n-a\n+A\n b\n@@\n b\n-c\n+C", "PATCH_HUNK_ORDER_CONFLICT", 2],
    ["reversed hunks", "a\nb\nc\n", "@@\n-c\n+C\n@@\n-a\n+A", "PATCH_HUNK_ORDER_CONFLICT", 2],
    ["post-edit text", "a\nb\n", "@@\n-a\n+A\n@@\n-A\n+AA", "PATCH_CONTEXT_MISMATCH", 2],
    ["repeated anchor", "function f() {\n  return 1;\n}\n", "@@ function f() {\n function f() {\n-  return 1;\n+  return 2;\n }", "PATCH_HUNK_ORDER_CONFLICT", 1],
    ["absent anchor", "a\n", "@@ absent\n-a\n+A", "PATCH_ANCHOR_NOT_FOUND", 1],
    ["truncated preview", 'const s = "long value";\n', '@@\n-const s = "long\n+const s = "new";', "PATCH_CONTEXT_MISMATCH", 1],
  ])("diagnoses %s without fuzzy writes", (_, source, body, code, hunkIndex) => {
    const result = diagnostic(() => apply(source, body));
    expect(result).toMatchObject({ code, path: "sample.ts", hunkIndex });
    expect(result.searchStartLine).toBeGreaterThan(0);
    expect(result.patchLine).toBeGreaterThan(0);
    expect(result.suggestedRead).toMatchObject({ path: "sample.ts" });
    expect(result.actualExcerpt?.lines.length).toBeLessThanOrEqual(12);
  });

  it("rejects ambiguous exact and whitespace matches", () => {
    for (const [source, body] of [
      ["a\nx\na\n", "@@\n-a\n+A"],
      [" a\nx\n  a\n", "@@\n-a\n+A"],
    ]) {
      expect(diagnostic(() => apply(source, body))).toMatchObject({
        code: "PATCH_AMBIGUOUS_MATCH", candidateLines: [1, 3],
      });
    }
  });

  // A repeated anchor only means "one of several lines starts here"; the hunk
  // body decides which one, so a common `@@ }` anchor must not reject a hunk
  // that is itself unambiguous.
  it("resolves a repeated anchor through the hunk that follows it", () => {
    expect(apply("anchor\na\nanchor\nb\n", "@@ anchor\n-a\n+A")).toBe("anchor\nA\nanchor\nb\n");
    expect(apply("anchor\nb\nanchor\na\n", "@@ anchor\n-a\n+A")).toBe("anchor\nb\nanchor\nA\n");
  });

  it("resolves a repeated anchor when the hunk body is only located after it", () => {
    expect(apply("anchor\nzzz\ntarget\nanchor\nyyy\n", "@@ anchor\n-target\n+TARGET"))
      .toBe("anchor\nzzz\nTARGET\nanchor\nyyy\n");
  });

  it("keeps ambiguity when the hunk follows several anchor occurrences", () => {
    expect(diagnostic(() => apply("anchor\na\nanchor\na\n", "@@ anchor\n-a\n+A")))
      .toMatchObject({ code: "PATCH_AMBIGUOUS_MATCH", candidateLines: [1, 3] });
  });

  it("keeps ambiguity for an anchored insertion with no body to disambiguate", () => {
    expect(diagnostic(() => apply("anchor\nb\nanchor\nc\n", "@@ anchor\n+new")))
      .toMatchObject({ code: "PATCH_AMBIGUOUS_MATCH", candidateLines: [1, 3] });
  });

  it("keeps body ambiguity under a unique anchor", () => {
    expect(diagnostic(() => apply("u\na\nx\na\n", "@@ u\n-a\n+A")))
      .toMatchObject({ code: "PATCH_AMBIGUOUS_MATCH" });
  });

  it("lets anchor proximity resolve a body that repeats elsewhere", () => {
    expect(apply("anchor\nsame\nmid\nanchor\ndiff\nsame\n", "@@ anchor\n-same\n+SAME"))
      .toBe("anchor\nSAME\nmid\nanchor\ndiff\nsame\n");
  });

  it("keeps EOF anchoring when the anchor repeats", () => {
    expect(apply("anchor\na\nanchor\na\n", "@@ anchor\n-a\n+A\n*** End of File"))
      .toBe("anchor\na\nanchor\nA\n");
  });

  it("treats a repeated anchor as the search start for ordered hunks", () => {
    expect(apply("anchor\na\nanchor\nc\n", "@@ anchor\n-a\n+A\n@@ anchor\n-c\n+C"))
      .toBe("anchor\nA\nanchor\nC\n");
  });

  it("prefers an exact match over looser candidates", () => {
    expect(apply(" a\na\n", "@@\n-a\n+A")).toBe(" a\nA\n");
  });

  it("honors EOF even with repeated text and continues to the next file", () => {
    const patch = "@@\n-x\n+X\n*** End of File";
    expect(apply("x\nmiddle\nx\n", patch)).toBe("x\nmiddle\nX\n");
    const hunks = parseApplyPatchEnvelope(envelope(patch).replace("*** End Patch", "*** Add File: second.ts\n+second\n*** End Patch"));
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ chunks: [{ isEndOfFile: true, patchLine: 3 }] });
  });

  it("does not fall back away from EOF", () => {
    expect(diagnostic(() => apply("x\nend\n", "@@\n-x\n+X\n*** End of File")))
      .toMatchObject({ code: "PATCH_CONTEXT_MISMATCH", candidateLines: [1] });
  });

  it("bounds source excerpts and marks truncated long lines", () => {
    const result = diagnostic(() => apply(`${"x".repeat(2000)}\n`, `@@\n-${"y".repeat(2000)}\n+z`));
    expect(result.actualExcerpt?.truncated).toBe(true);
    expect(result.expectedExcerpt?.truncated).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(3000);
  });

  it("bounds candidate collection for large repeated files", () => {
    expect(diagnostic(() => apply("a\n".repeat(2000), "@@\n-a\n+A")).candidateLines).toHaveLength(8);
  });

  it("retains added EOF blank lines and distinguishes deleting all content", () => {
    expect(apply("A\n", "@@ A\n+\n*** End of File")).toBe("A\n\n");
    expect(apply("A\n", "@@\n+\n+\n*** End of File")).toBe("A\n\n\n");
    expect(apply("A\n", "@@\n-A")).toBe("");
  });

  it.each(["@@\n-A\n-\n+B", "@@\n-A\n+B\n "])("never drops an unmatched blank line constraint: %s", body => {
    expect(diagnostic(() => apply("A\nX\n", body)).code).toBe("PATCH_CONTEXT_MISMATCH");
    expect(diagnostic(() => apply("A\n", `${body}\n*** End of File`)).code).toBe("PATCH_CONTEXT_MISMATCH");
  });
});

describe("patch format validation", () => {
  it("does not treat a context End Patch line as the envelope terminator", () => {
    const hunks = parseApplyPatchEnvelope("*** Begin Patch\n*** Update File: a\n@@\n-x\n+X\n *** End Patch\n*** Update File: b\n@@\n-y\n+Y\n*** End Patch");
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ chunks: [{ oldLines: ["x", "*** End Patch"] }] });
  });

  it.each([
    "@@ -1,1 +1,1 @@\n-a\n+A",
    "@@\n-a\n+A\nunprefixed text",
    "@@\n",
    "*** End of File",
    "@@\n-a\n+A\n*** Unknown",
    "@@\n-a\n+A\n*** Move to: late.ts",
  ])("rejects malformed hunks with a recoverable format error: %s", body => {
    expect(diagnostic(() => parseApplyPatchEnvelope(envelope(body))).code).toBe("PATCH_INVALID_FORMAT");
  });

  it("rejects missing markers and unprefixed Add File lines", () => {
    for (const patch of ["@@\n-a\n+A", "*** Begin Patch\n*** Add File: a\nnot prefixed\n*** End Patch"]) {
      expect(diagnostic(() => parseApplyPatchEnvelope(patch)).code).toBe("PATCH_INVALID_FORMAT");
    }
  });

  it("accepts CRLF envelopes without adding CR characters to output", () => {
    const hunk = parseApplyPatchEnvelope(envelope("@@\n-a\n+A").replace(/\n/g, "\r\n"))[0];
    if (hunk.type !== "update") throw new Error("expected update");
    expect(deriveNewContentsFromChunks(hunk.path, hunk.chunks, "a\n")).toBe("A\n");
  });
});
