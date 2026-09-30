import { describe, expect, it } from "vitest";
import { indexBranchSessions, GitEpicStore } from "../git-epics.js";
import { GitMrStore } from "../git-mr/store.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GitEpic } from "../git-epic-contracts.js";
const epic: GitEpic = { id: "epic", projectId: "p", rootId: "r", name: "Feature", description: "", refs: ["refs/remotes/origin/topic"], sessionIds: ["explicit", "archived"], archived: false, version: 1 };
describe("Git branch session index", () => {
  it("persists Epic edits, isolates repositories and rejects stale writes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "synax-epics-"));
    try {
      const store = new GitEpicStore(new GitMrStore(directory));
      const created = await store.save("p", "root-a", { name: "Feature", description: "Details", refs: ["refs/heads/topic"], sessionIds: ["session"], archived: false });
      const reopened = new GitEpicStore(new GitMrStore(directory));
      expect(await reopened.list("p", "root-a")).toEqual([created]);
      expect(await reopened.list("p", "root-b")).toEqual([]);
      expect(await reopened.list("another-project", "root-a")).toEqual([]);
      const archived = await reopened.save("p", "root-a", { ...created, archived: true, expectedVersion: created.version });
      expect(archived).toMatchObject({ archived: true, version: 2 });
      await expect(store.save("p", "root-a", { ...created, expectedVersion: 1 })).rejects.toMatchObject({ status: 409 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("separates remote and local refs, infers worktree links, and excludes absent archived sessions", () => {
    const result = indexBranchSessions(["refs/heads/topic", "refs/remotes/origin/topic"], [{ path: "/repo/work", branch: "topic" }], [
      { id: "local", title: "Local", status: "idle", workPaths: ["/repo/work"] },
      { id: "explicit", title: "Explicit", status: "idle", workPaths: ["/another/repo"] },
      { id: "other", title: "Other", status: "idle", workPaths: ["/another/repo"] },
    ], [epic]);
    expect(result[0].sessions.map(item => item.id)).toEqual(["local"]);
    expect(result[1].sessions.map(item => item.id)).toEqual(["explicit"]);
    expect(result[1].epicIds).toEqual(["epic"]);
  });
  it("drops archived Epic associations", () => {
    expect(indexBranchSessions([epic.refs[0]], [], [{ id: "explicit", title: "", status: "idle", workPaths: [] }], [{ ...epic, archived: true }])[0]).toEqual({ ref: epic.refs[0], sessions: [], epicIds: [] });
  });
});
