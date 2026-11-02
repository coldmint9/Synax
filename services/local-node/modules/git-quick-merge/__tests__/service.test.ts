import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitMrService } from "../../git-mr/service.js";
import { GitMrStore } from "../../git-mr/store.js";
import { QuickMergeService } from "../service.js";

let directory: string;
let repo: string;
let origin: string;
let service: QuickMergeService;
let store: GitMrStore;

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const git = (...args: string[]) => run(repo, ...args);

function commit(file: string, text: string) {
  fs.writeFileSync(path.join(repo, file), text);
  git("--literal-pathspecs", "add", "--", file);
  git("commit", "-m", `${file}:${text.trim()}`);
}

function branch(name: string, file: string, text: string) {
  git("checkout", "-b", name, "main");
  commit(file, text);
  git("checkout", "main");
}

const location = () => ({ kind: "host" as const, path: repo });

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "synax-quick-"));
  repo = path.join(directory, "repo");
  origin = path.join(directory, "origin.git");
  fs.mkdirSync(repo);
  run(directory, "init", "--bare", origin);
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  git("remote", "add", "origin", origin);
  commit("app.ts", "export const x = 1;\n");
  git("branch", "test");
  branch("feature/ok", "ok.ts", "export const ok = 1;\n");
  branch("feature/conflict", "app.ts", "export const x = 2;\n");
  // Give `test` its own edit of the same line so the second rule conflicts.
  git("checkout", "test");
  commit("app.ts", "export const x = 3;\n");
  git("checkout", "main");
  git("push", "origin", "main", "test");
  store = new GitMrStore(path.join(directory, "state"));
  service = new QuickMergeService(store, new GitMrService(store));
});

afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

async function seededBoard() {
  const group = await service.createGroup("project", { name: "日常发布" });
  const ok = await service.createRule("project", {
    groupId: group.id,
    source: "feature/ok",
    target: "test",
  });
  const conflict = await service.createRule("project", {
    groupId: group.id,
    source: "feature/conflict",
    target: "test",
  });
  return { group, ok, conflict };
}

describe("quick merge rules", () => {
  it("groups rules and rejects invalid directions", async () => {
    const { group, ok } = await seededBoard();
    const board = await service.board("project");
    expect(board.groups).toHaveLength(1);
    expect(board.rules.map((rule) => rule.id)).toEqual([ok.id, expect.any(String)]);

    await expect(
      service.createRule("project", { groupId: group.id, source: "test", target: "test" }),
    ).rejects.toThrow(/不能相同/);
    await expect(
      service.createRule("project", { groupId: group.id, source: "test", target: "feature/x" }),
    ).rejects.toThrow(/功能分支/);
    await expect(
      service.createRule("project", { groupId: group.id, source: "feature/ok", target: "test" }),
    ).rejects.toThrow(/相同指令/);
  });

  it("swaps direction and clears the previous run", async () => {
    const { group } = await seededBoard();
    const rule = await service.createRule("project", {
      groupId: group.id,
      source: "test",
      target: "beta",
    });
    const swapped = await service.updateRule("project", rule.id, {
      source: "beta",
      target: "test",
    });
    expect(swapped).toMatchObject({ source: "beta", target: "test", status: "idle" });
    // Reversing is allowed; the repository policy reports the problem at run time.
    const reversed = await service.updateRule("project", rule.id, {
      source: "test",
      target: "feature/ok",
    });
    expect(reversed).toMatchObject({ source: "test", target: "feature/ok" });
    await expect(service.merge("project", rule.id, location())).rejects.toThrow(/功能分支/);
  });

  it("merges the rule locally without pushing", async () => {
    const { ok } = await seededBoard();
    const published = run(origin, "rev-parse", "test");
    const result = await service.merge("project", ok.id, location());
    expect(result.status).toBe("merged");
    expect(result.steps?.map((step) => step.command)).toContain("git fetch origin --prune");
    // The merge landed on the local target…
    expect(git("log", "-1", "--format=%s", "test")).toContain("Merge feature/ok");
    // One feature commit plus the merge commit, none of them published.
    expect(git("rev-list", "--count", "origin/test..test")).toBe("2");
    expect(result.ahead).toBe(2);
    // …and was not pushed.
    expect(run(origin, "rev-parse", "test")).toBe(published);
  });

  it("finishes inside the worktree that already has the target checked out", async () => {
    const { ok } = await seededBoard();
    const checkout = path.join(directory, "checkout");
    git("worktree", "add", checkout, "test");

    const result = await service.merge("project", ok.id, location());

    // No branch switching or extra authorization asked of the user.
    expect(result.status).toBe("merged");
    expect(
      result.steps?.find((step) => step.command === "git merge feature/ok")?.detail,
    ).toMatch(/检出工作树/);
    // The checked-out worktree received the result and stayed clean.
    expect(run(checkout, "log", "-1", "--format=%s")).toContain("Merge feature/ok");
    expect(fs.existsSync(path.join(checkout, "ok.ts"))).toBe(true);
    expect(run(checkout, "status", "--porcelain")).toBe("");
    expect(git("log", "-1", "--format=%s", "test")).toContain("Merge feature/ok");
  });

  it("explains a dirty checked-out target instead of merging around it", async () => {
    const { ok } = await seededBoard();
    const checkout = path.join(directory, "checkout");
    git("worktree", "add", checkout, "test");
    fs.writeFileSync(path.join(checkout, "app.ts"), "user draft");
    const target = git("rev-parse", "test");

    await expect(service.merge("project", ok.id, location())).rejects.toThrow(/未提交改动/);

    // The draft is untouched and the target did not move.
    expect(fs.readFileSync(path.join(checkout, "app.ts"), "utf8")).toBe("user draft");
    expect(git("rev-parse", "test")).toBe(target);
    const board = await service.board("project");
    expect(board.rules.find((rule) => rule.id === ok.id)?.status).toBe("failed");
    expect(board.rules.find((rule) => rule.id === ok.id)?.message).toMatch(/未提交改动/);
  });

  it("stops at a conflict and keeps the merge request for resolution", async () => {
    const { conflict } = await seededBoard();
    const result = await service.merge("project", conflict.id, location());
    expect(result.status).toBe("conflicted");
    expect(result.mrId).toBeTruthy();
    expect(result.message).toMatch(/冲突/);
    const board = await service.board("project");
    expect(board.rules.find((rule) => rule.id === conflict.id)?.status).toBe("conflicted");
    expect(board.rules.find((rule) => rule.id === conflict.id)?.message).toMatch(/冲突/);
  });

  it("pushes through a pull and refuses a diverged branch", async () => {
    const { ok } = await seededBoard();
    await service.merge("project", ok.id, location());

    const pushed = await service.push("project", ok.id, location());
    expect(pushed.status).toBe("pushed");
    expect(run(origin, "rev-parse", "test")).toBe(git("rev-parse", "test"));

    // Diverge: local gains a commit, the remote gains a different one.
    git("checkout", "test");
    commit("app.ts", "export const x = 4;\n");
    git("checkout", "main");
    const other = path.join(directory, "other");
    run(directory, "clone", "--branch", "test", origin, other);
    run(other, "config", "user.name", "Other");
    run(other, "config", "user.email", "other@example.test");
    fs.writeFileSync(path.join(other, "app.ts"), "export const x = 5;\n");
    run(other, "commit", "-am", "remote edit");
    run(other, "push", "origin", "test");
    const remoteTip = run(origin, "rev-parse", "test");

    await expect(service.push("project", ok.id, location())).rejects.toThrow(/分叉/);
    expect(run(origin, "rev-parse", "test")).toBe(remoteTip);
    const board = await service.board("project");
    expect(board.rules.find((rule) => rule.id === ok.id)?.status).toBe("failed");
  });
});
