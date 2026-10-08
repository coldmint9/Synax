import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_ROOT } from "../infrastructure/runtime/env.js";
import {
  cleanupGitWorktrees, createGitWorktree, listGitWorkspaces, previewGitWorktreeCleanup,
  previewGitWorktreePath, previewGitWorktreePrune, pruneGitWorktrees, removeGitWorktree,
  type WorktreeSessionUsage,
} from "./git-workspaces.js";
import { cleanupReasons, isTerminalWorktreeSession, type GitWorktreeSummary } from "./git-worktree-management-contracts.js";

let temp: string;
let repository: string;
let projectId: string;
function git(args: string[], cwd = repository) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function linked(name: string) {
  const target = path.join(temp, name);
  git(["worktree", "add", "-b", name, target]);
  return fs.realpathSync(target);
}
function usage(target: string, active = 0): WorktreeSessionUsage {
  return { sessionCounts: new Map([[target, 2]]), activeSessionCounts: new Map([[target, active]]) };
}
beforeEach(() => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synax-worktree-safety-")));
  repository = path.join(temp, "repo");
  projectId = `worktree-safety-${randomUUID()}`;
  fs.mkdirSync(repository);
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@example.test"]);
  git(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repository, "tracked.txt"), "initial\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
});
afterEach(() => {
  fs.rmSync(temp, { recursive: true, force: true });
  fs.rmSync(path.join(DATA_ROOT, "worktrees", projectId), { recursive: true, force: true });
});

describe("safe worktree management with real Git", () => {
  it("retains a worktree when a session starts while Git status is being read", async () => {
    const target = linked("late-session");
    let checks = 0;
    await expect(removeGitWorktree(repository, projectId, target, { readUsage: () => usage(target, checks++ ? 1 : 0) })).rejects.toThrow("sessions");
    expect(fs.existsSync(target)).toBe(true);
  }, 20_000);
  it("previews the same managed path used by creation without creating a directory", async () => {
    const preview = await previewGitWorktreePath(repository, projectId, "feature/preview");
    expect(fs.existsSync(preview.path)).toBe(false);
    const created = await createGitWorktree(repository, projectId, { branch: "feature/preview", createBranch: true });
    expect(fs.realpathSync(preview.path)).toBe(created.path);
    await expect(previewGitWorktreePath(repository, projectId, "--bad")).rejects.toThrow();
  }, 20_000);

  it("keeps primary, dirty, locked, prunable and actively used trees; counts history separately", async () => {
    const clean = linked("clean");
    const dirty = linked("dirty");
    const locked = linked("locked");
    const missing = linked("missing");
    const busy = linked("busy");
    fs.writeFileSync(path.join(dirty, "untracked.txt"), "do not lose\n");
    git(["worktree", "lock", locked]);
    fs.rmSync(missing, { recursive: true, force: true });
    const readUsage = () => ({ sessionCounts: new Map([[clean, 4], [busy, 1]]), activeSessionCounts: new Map([[busy, 1]]) });
    const preview = await previewGitWorktreeCleanup(repository, projectId, readUsage);
    expect(preview.candidates.map(item => item.path)).toEqual([clean]);
    expect(preview.candidates[0]).toMatchObject({ sessionCount: 4, activeSessionCount: 0, statusKnown: true });
    expect(preview.retained.map(item => item.worktree.path).sort()).toEqual([repository, dirty, locked, missing, busy].sort());
    for (const item of preview.retained) expect(item.reasons.length).toBeGreaterThan(0);
    for (const target of [repository, dirty, locked, missing, busy]) {
      await expect(removeGitWorktree(repository, projectId, target, { force: true, readUsage })).rejects.toThrow();
    }
    expect(fs.readFileSync(path.join(dirty, "untracked.txt"), "utf8")).toBe("do not lose\n");
    await removeGitWorktree(repository, projectId, clean, { force: true, readUsage });
    expect(fs.existsSync(clean)).toBe(false);
  }, 30_000);

  it("does not treat unreadable status as clean", async () => {
    const target = linked("broken");
    // Git still lists the registration, but status cannot resolve its .git pointer.
    fs.writeFileSync(path.join(target, ".git"), "gitdir: /nonexistent/synax-git-dir\n");
    const summary = await listGitWorkspaces(repository, projectId);
    const broken = summary.worktrees.find(item => item.path === target)!;
    expect(broken.statusKnown).toBe(false);
    expect(cleanupReasons(broken)).toContain("无法确认 Git 状态");
    await expect(removeGitWorktree(repository, projectId, target, { force: true })).rejects.toThrow();
    expect(fs.existsSync(target)).toBe(true);
  }, 20_000);

  it("rechecks changes after preview and protects sessions inside a worktree", async () => {
    const changed = linked("changed-after-preview");
    const busy = linked("nested-session");
    const preview = await previewGitWorktreeCleanup(repository, projectId);
    expect(preview.candidates).toHaveLength(2);
    fs.appendFileSync(path.join(changed, "tracked.txt"), "changed after confirmation\n");
    const subdirectory = path.join(busy, "src");
    fs.mkdirSync(subdirectory);
    const result = await cleanupGitWorktrees(repository, projectId, [changed, busy], () => usage(subdirectory, 1));
    expect(result.results.map(item => item.status)).toEqual(["skipped", "skipped"]);
    expect(fs.readFileSync(path.join(changed, "tracked.txt"), "utf8")).toContain("changed after confirmation");
    expect(fs.existsSync(busy)).toBe(true);
  }, 20_000);

  it("rechecks every confirmed item, deduplicates, preserves unconfirmed trees, and continues after skips", async () => {
    const first = linked("first");
    const second = linked("second");
    const unconfirmed = linked("unconfirmed");
    await previewGitWorktreeCleanup(repository, projectId, () => usage(first));
    let calls = 0;
    const result = await cleanupGitWorktrees(repository, projectId, [first, second, second, path.join(temp, "foreign")], () => {
      calls++;
      return usage(first, 1);
    });
    expect(result.results.map(item => item.status)).toEqual(["skipped", "removed", "skipped"]);
    expect(result.results[0]).toMatchObject({ path: first, branch: "first" });
    expect(result.results[1]).toMatchObject({ path: second, branch: "second" });
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(unconfirmed)).toBe(true);
    expect(fs.existsSync(second)).toBe(false);
    await expect(cleanupGitWorktrees(repository, projectId, Array(101).fill(first))).rejects.toThrow();
  }, 20_000);

  it("continues after a Git removal failure", async () => {
    const failed = linked("nested-repo");
    const clean = linked("after-failure");
    // Clean worktrees containing initialized submodules require --force; we never pass it.
    git(["-c", "protocol.file.allow=always", "submodule", "add", repository, "nested"], failed);
    git(["commit", "-am", "add submodule"], failed);
    const result = await cleanupGitWorktrees(repository, projectId, [failed, clean]);
    expect(result.results.map(item => item.status)).toEqual(["failed", "removed"]);
    expect(fs.existsSync(failed)).toBe(true);
  }, 20_000);

  it("requires the complete current prune list and refuses active registrations", async () => {
    const stale = linked("stale");
    fs.rmSync(stale, { recursive: true, force: true });
    const preview = await previewGitWorktreePrune(repository);
    expect(preview.paths).toEqual([stale]);
    await expect(pruneGitWorktrees(repository)).rejects.toThrow();
    await expect(pruneGitWorktrees(repository, [])).rejects.toThrow();
    await expect(pruneGitWorktrees(repository, preview.paths, () => usage(stale, 1))).rejects.toThrow();
    const another = linked("another-stale");
    fs.rmSync(another, { recursive: true, force: true });
    await expect(pruneGitWorktrees(repository, preview.paths)).rejects.toThrow();
    await pruneGitWorktrees(repository, (await previewGitWorktreePrune(repository)).paths, () => usage(stale));
    expect((await previewGitWorktreePrune(repository)).paths).toEqual([]);
  }, 20_000);
});

describe("browser-safe protection rules", () => {
  it.each(["queued", "running", "stopping", "waiting_permission", "waiting_input", "paused", "unknown", undefined])("protects nonterminal status %s", status => {
    expect(isTerminalWorktreeSession(status)).toBe(false);
  });
  it.each(["completed", "failed", "cancelled", "interrupted"])("releases terminal status %s", status => {
    expect(isTerminalWorktreeSession(status)).toBe(true);
  });
  it("protects old summaries that do not carry known status", () => {
    expect(cleanupReasons({ primary: false, dirty: false, sessionCount: 0 } as GitWorktreeSummary)).toContain("无法确认 Git 状态");
  });
});
