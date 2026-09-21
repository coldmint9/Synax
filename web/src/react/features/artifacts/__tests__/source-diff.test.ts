import { describe, expect, it } from "vitest";
import { sourceDiff } from "../source-diff";
const file = (path: string, content: string) => ({
  path,
  content,
  encoding: "utf8" as const,
  mediaType: "text/plain",
});
describe("artifact source comparison", () => {
  it("identifies added, removed, changed and unchanged files without executing source", () => {
    expect(
      sourceDiff(
        [file("gone", "a"), file("same", "x"), file("edit", "old")],
        [file("new", "b"), file("same", "x"), file("edit", "new")],
      ).map(({ path, status }) => ({ path, status })),
    ).toEqual([
      { path: "edit", status: "changed" },
      { path: "gone", status: "removed" },
      { path: "new", status: "added" },
      { path: "same", status: "unchanged" },
    ]);
  });
});
