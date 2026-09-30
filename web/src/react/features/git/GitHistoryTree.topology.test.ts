import { describe, expect, it } from "vitest";
import { buildTopology } from "./GitHistoryTree";
import type { GitCommitSummary } from "../../../lib/api/project";

const commit = (id: string, parents: string[] = []): GitCommitSummary => ({
  id,
  parents,
  subject: id,
  author: "tester",
  authoredAt: "2026-09-26T00:00:00Z",
  refs: [],
  rebase: false,
});

describe("Git history topology", () => {
  it("keeps pending parent lanes unchanged when another page is appended", () => {
    const first = [commit("merge", ["left", "right"]), commit("left", ["base"])];
    const partial = buildTopology(first);
    const complete = buildTopology([...first, commit("right", ["base"]), commit("base")]);
    expect(complete.slice(0, first.length)).toEqual(partial);
    expect(partial[1].connections).toContainEqual({ from: 1, to: 1, merge: false });
  });
  it("keeps a merge to two parents without growing stale lanes", () => {
    const commits = [
      commit("merge", ["left", "right"]),
      commit("left", ["base"]),
      commit("right", ["base"]),
      commit("base"),
    ];
    const rows = buildTopology(commits);

    expect(rows[0].connections).toEqual([
      { from: 0, to: 0, merge: true },
      { from: 0, to: 1, merge: true },
    ]);
    expect(Math.max(...rows.map((row) => row.nodeLane))).toBe(1);
  });
});
