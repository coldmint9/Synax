import { describe, it, expect } from "vitest";
import { canFinalize, moveSource, validateInput } from "./mergeUi";
import type { MergeRequest, MergeRequestInput } from "../../../lib/api/gitMr";
const input: MergeRequestInput = {
  title: "Batch merge",
  target: "master",
  sources: ["feature/a", "feature/b"],
  strategy: "merge_commit",
};
describe("local MR decisions", () => {
  it("preserves explicit source order and refuses test/beta flowing into feature", () => {
    expect(moveSource(input.sources, 1, -1)).toEqual([
      "feature/b",
      "feature/a",
    ]);
    expect(input.sources).toEqual(["feature/a", "feature/b"]);
    expect(moveSource(input.sources, 0, -1)).toEqual(input.sources);
    expect(validateInput(input)).toBeNull();
    expect(
      validateInput({ ...input, target: "feature/a", sources: ["test"] }),
    ).toContain("test");
    expect(
      validateInput({ ...input, target: "feature/a", sources: ["beta"] }),
    ).toContain("beta");
    expect(validateInput({ ...input, sources: ["master"] })).toContain("目标");
    expect(validateInput({ ...input, sources: ["a", "a"] })).toContain("重复");
  });
  it("gates finalize on every required check passing against the current tree", () => {
    const mr = {
      status: "ready",
      candidateTree: "tree-new",
      checks: [{ id: "test" }],
      checkResults: [{ id: "test", status: "passed", tree: "tree-old" }],
    } as MergeRequest;
    expect(canFinalize(mr)).toBe(false);
    expect(canFinalize({ ...mr, checkResults: [] })).toBe(false);
    expect(
      canFinalize({
        ...mr,
        checkResults: [{ ...mr.checkResults[0], tree: "tree-new" }],
      }),
    ).toBe(true);
    expect(
      canFinalize({
        ...mr,
        checkResults: [
          { ...mr.checkResults[0], tree: "tree-new" },
          { ...mr.checkResults[0], tree: "tree-new", status: "failed" },
        ],
      }),
    ).toBe(false);
    expect(canFinalize({ ...mr, checks: [] })).toBe(true);
    expect(canFinalize({ ...mr, status: "conflicted", checks: [] })).toBe(
      false,
    );
  });
});
