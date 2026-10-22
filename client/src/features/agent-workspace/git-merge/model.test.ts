import { describe, expect, it } from "vitest";
import { layoutCommitGraph } from "./model";

const commit = (oid: string, parents: string[]) => ({ oid, parents, subject: oid, author: "Mint", date: "2026-10-22", refs: [] });
describe("conversation commit graph", () => {
  it("keeps two merge parents on distinct lanes until they reach their common ancestor", () => {
    const rows = layoutCommitGraph([
      commit("merge", ["target", "source"]),
      commit("target", ["base"]),
      commit("source", ["base"]),
      commit("base", []),
    ]);
    expect(rows[0].lane).toBe(rows[1].lane);
    expect(rows[1].lane).not.toBe(rows[2].lane);
    expect(rows[3].lane).toBe(rows[1].lane);
    expect(rows.flatMap(row => row.commit.parents)).toEqual(["target", "source", "base", "base"]);
  });
  it("does not require parents outside the bounded history window", () => {
    expect(layoutCommitGraph([commit("one", ["outside"])]).map(row => row.lane)).toEqual([0]);
  });
});
