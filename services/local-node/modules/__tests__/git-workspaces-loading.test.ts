import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const trace = vi.hoisted(() => ({ commands: [] as string[][], active: 0, peak: 0 }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const run = promisify(actual.execFile);
  const execFile = Object.assign((...args: Parameters<typeof actual.execFile>) => actual.execFile(...args), {
    [promisify.custom]: async (command: string, args: string[], options: object) => {
      if (command === "git") trace.commands.push(args);
      const status = command === "git" && args.includes("status");
      if (status) { trace.active++; trace.peak = Math.max(trace.peak, trace.active); }
      try { return await run(command, args, options); }
      finally { if (status) trace.active--; }
    },
  });
  return { ...actual, execFile };
});
import { gitHistoryRefs, listGitWorkspaces } from "../git-workspaces.js";
let root: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" }).trim();
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-fast-git-"));
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
  git("commit", "--allow-empty", "-m", "initial");
  trace.commands = []; trace.active = trace.peak = 0;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it("loads inventory with no history, reflog or status commands and marks safety unknown", async () => {
  fs.writeFileSync(path.join(root, "untracked.txt"), "must not be considered clean");
  const result = await listGitWorkspaces(root, "probe", undefined, undefined, { includeHistory: false, inspectStatus: false });
  expect(result.commits).toEqual([]);
  expect(result.worktrees[0]).toMatchObject({ branch: "main", statusKnown: false });
  expect(trace.commands.some(args => args.some(arg => ["status", "log", "reflog"].includes(arg)))).toBe(false);
  const detail = await listGitWorkspaces(root, "probe", undefined, undefined, { includeHistory: false });
  expect(detail.worktrees[0]).toMatchObject({ statusKnown: true, dirty: true });
  expect(trace.commands.find(args => args.includes("status"))).toContain("--no-optional-locks");
});
it("enumerates association refs without traversing history or checking worktrees", async () => {
  git("tag", "v1");
  const refs = await gitHistoryRefs(root);
  expect(refs.map(ref => ref.fullName)).toEqual(expect.arrayContaining(["refs/heads/main", "refs/tags/v1"]));
  expect(trace.commands.some(args => args.some(arg => ["status", "log", "reflog", "worktree"].includes(arg)))).toBe(false);
});
it("limits concurrent filesystem scans and detects later edits without a stale status cache", async () => {
  for (let i = 0; i < 6; i++) git("worktree", "add", "-b", `topic-${i}`, path.join(root, `tree-${i}`));
  const list = () => listGitWorkspaces(root, "probe", undefined, undefined, { includeHistory: false });
  const first = await list();
  expect(first.worktrees).toHaveLength(7);
  expect(trace.peak).toBeLessThanOrEqual(4);
  fs.writeFileSync(path.join(root, "tree-0", "new.txt"), "untracked");
  expect((await list()).worktrees.find(tree => tree.branch === "topic-0")).toMatchObject({ dirty: true, statusKnown: true });
}, 20000);
