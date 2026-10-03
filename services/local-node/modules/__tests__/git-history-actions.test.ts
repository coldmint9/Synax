import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitHistoryAction, gitHistoryState, gitHistoryConflict } from "../git-workspaces.js";
let root: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const head = () => git("rev-parse", "HEAD");
const commit = (file: string, text: string) => { writeFileSync(path.join(root, file), text); git("add", "."); git("commit", "-m", file); return head(); };
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "synax-actions-"));
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com"); commit("initial.txt", "initial\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe("history actions in disposable repositories", () => {
  it("fetches remote-only commits and creates a local tracking branch", async () => {
    const remote = mkdtempSync(path.join(os.tmpdir(), "synax-remote-"));
    try {
      execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
      git("remote", "add", "origin", remote);
      git("push", "origin", "main");
      git("checkout", "-b", "remote-topic"); const target = commit("remote.txt", "remote\n");
      git("push", "origin", "remote-topic"); git("checkout", "main"); git("branch", "-D", "remote-topic");
      git("update-ref", "-d", "refs/remotes/origin/remote-topic");
      await gitHistoryAction(root, { action: "fetch", expectedHead: head() });
      expect(git("rev-parse", "refs/remotes/origin/remote-topic")).toBe(target);
      const result = await gitHistoryAction(root, { action: "track", target: "refs/remotes/origin/remote-topic", branch: "local-topic", expectedHead: head(), confirmed: true });
      expect(result.branch).toBe("local-topic"); expect(result.head).toBe(target);
      expect(git("rev-parse", "--symbolic-full-name", "@{upstream}")).toBe("refs/remotes/origin/remote-topic");
    } finally { rmSync(remote, { recursive: true, force: true }); }
  });
  it("restores conflict state, saves drafts and resolves before continuing merge", async () => {
    git("checkout", "-b", "conflict"); commit("initial.txt", "incoming\n");
    git("checkout", "main"); commit("initial.txt", "local\n");
    await gitHistoryAction(root, { action: "merge", target: "refs/heads/conflict", expectedHead: head(), confirmed: true });
    expect((await gitHistoryState(root)).conflicts).toEqual(["initial.txt"]);
    const file = await gitHistoryConflict(root, "initial.txt");
    expect(file.target).toBe("local\n"); expect(file.source).toBe("incoming\n");
    const draft = await gitHistoryConflict(root, "initial.txt", { expectedRevision: file.revision, content: "combined\n", resolve: false });
    expect(draft.result).toBe("combined\n");
    expect((await gitHistoryState(root)).conflicts).toEqual(["initial.txt"]);
    await expect(gitHistoryConflict(root, "initial.txt", { expectedRevision: file.revision, content: "stale", resolve: true })).rejects.toThrow();
    await gitHistoryConflict(root, "initial.txt", { expectedRevision: draft.revision, content: "combined\n", resolve: true });
    expect((await gitHistoryState(root)).conflicts).toEqual([]);
    const result = await gitHistoryAction(root, { action: "continue", expectedHead: head() });
    expect(result.operation).toBeNull();
    expect(git("show", "HEAD:initial.txt")).toBe("combined");
  });
  it("merges a branch and refuses stale HEAD or dirty state", async () => {
    const original = head(); git("checkout", "-b", "topic"); const target = commit("topic.txt", "topic\n"); git("checkout", "main");
    const result = await gitHistoryAction(root, { action: "merge", expectedHead: original, target: "refs/heads/topic", confirmed: true });
    expect(result.head).toBe(target); expect(result.operation).toBeNull();
    await expect(gitHistoryAction(root, { action: "reset", expectedHead: original, target, resetMode: "hard", confirmed: true })).rejects.toMatchObject({ status: 409 });
    writeFileSync(path.join(root, "initial.txt"), "unsaved\n");
    await expect(gitHistoryAction(root, { action: "reset", expectedHead: target, target: original, resetMode: "hard", confirmed: true })).rejects.toMatchObject({ status: 409 });
  });
  it("cherry-picks and resets with each mode", async () => {
    const original = head(); git("checkout", "-b", "topic"); const target = commit("topic.txt", "topic\n"); git("checkout", "main");
    const picked = await gitHistoryAction(root, { action: "cherry-pick", expectedHead: original, target, confirmed: true });
    expect(git("show", "HEAD:topic.txt")).toBe("topic");
    await gitHistoryAction(root, { action: "reset", expectedHead: picked.head, target: original, resetMode: "soft", confirmed: true });
    expect(git("diff", "--cached", "--name-only")).toBe("topic.txt");
    git("reset", "--hard", target);
    await gitHistoryAction(root, { action: "reset", expectedHead: head(), target: original, resetMode: "mixed", confirmed: true });
    expect(git("status", "--porcelain")).toContain("?? topic.txt");
    git("add", "."); git("reset", "--hard", target);
    await gitHistoryAction(root, { action: "reset", expectedHead: head(), target: original, resetMode: "hard", confirmed: true });
    expect(head()).toBe(original); expect(git("status", "--porcelain")).toBe("");
  });
  it("reports merge conflict and can abort without losing the original HEAD", async () => {
    git("checkout", "-b", "topic"); commit("initial.txt", "topic\n"); git("checkout", "main"); const original = commit("initial.txt", "main\n");
    const result = await gitHistoryAction(root, { action: "merge", expectedHead: original, target: "refs/heads/topic", confirmed: true });
    expect(result.operation).toBe("merge"); expect(result.conflicts).toEqual(["initial.txt"]);
    const aborted = await gitHistoryAction(root, { action: "abort", expectedHead: result.head, confirmed: true });
    expect(aborted.operation).toBeNull(); expect(aborted.head).toBe(original);
  });
  it("rebases current branch onto another branch", async () => {
    git("checkout", "-b", "topic"); commit("topic.txt", "topic\n"); git("checkout", "main"); const base = commit("main.txt", "main\n"); git("checkout", "topic");
    const result = await gitHistoryAction(root, { action: "rebase", expectedHead: head(), target: "refs/heads/main", confirmed: true });
    expect(result.operation).toBeNull(); expect(git("rev-parse", "HEAD^")).toBe(base);
  });
});
