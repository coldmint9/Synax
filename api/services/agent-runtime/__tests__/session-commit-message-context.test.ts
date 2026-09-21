import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectWorkspaceRoot } from "../../project-workspace.js";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), roots: vi.fn() }));
vi.mock("../session-store.js", () => ({
  agentRuntimeStore: { getSession: mocks.getSession },
}));
vi.mock("../tools/workspace.js", () => ({
  resolveSessionWorkspaceRoots: mocks.roots,
}));
import { collectCommitMessageContext } from "../session-commit-message-context.js";

let directory: string;
let roots: ProjectWorkspaceRoot[];
const git = (root: ProjectWorkspaceRoot, ...args: string[]) =>
  execFileSync("git", args, { cwd: root.path, encoding: "utf8" });
function state(root: ProjectWorkspaceRoot) {
  return {
    head: git(root, "rev-parse", "HEAD"),
    index: fs.readFileSync(path.join(root.path, ".git/index")),
    status: git(root, "status", "--porcelain=v1", "-uall"),
  };
}

beforeEach(() => {
  directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "synax-commit-context-")),
  );
  vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(directory, "global-gitconfig"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_OPTIONAL_LOCKS", "0");
  roots = (["primary", "reference"] as const).map((id, index) => {
    const root = {
      id,
      name: id,
      path: path.join(directory, id),
      role: index ? "reference" : "primary",
      status: "available",
    } as ProjectWorkspaceRoot;
    fs.mkdirSync(root.path);
    git(root, "init", "--quiet", "--initial-branch=main", "--template=");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    git(root, "config", "commit.gpgsign", "false");
    fs.writeFileSync(path.join(root.path, "file.txt"), "old\n");
    git(root, "add", "file.txt");
    git(
      root,
      "commit",
      "--quiet",
      "-m",
      index ? "docs: reference history" : "fix(ui): 修复按钮",
    );
    return root;
  });
  mocks.getSession.mockReturnValue({
    id: "s1",
    projectId: "p1",
    activeRunId: null,
  });
  mocks.roots.mockReturnValue(roots);
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("read-only commit message context", () => {
  it("samples only the selected branch and includes staged, unstaged and untracked changes without staging", async () => {
    const root = roots[0];
    fs.writeFileSync(path.join(root.path, "file.txt"), "staged\n");
    git(root, "add", "file.txt");
    fs.writeFileSync(path.join(root.path, "file.txt"), "working\n");
    fs.writeFileSync(path.join(root.path, "new.txt"), "untracked\n");
    const before = state(root);
    const other = state(roots[1]);
    const context = await collectCommitMessageContext("s1", root.id);
    expect(context.projectId).toBe("p1");
    expect(context.branch).toBe("main");
    expect(context.subjects).toEqual(["fix(ui): 修复按钮"]);
    expect(context.changedFiles).toContain("new.txt");
    expect(context.stagedSummary).toContain("file.txt");
    expect(context.unstagedSummary).toContain("file.txt");
    expect(context.diffExcerpt).toContain("working");
    expect(state(root)).toEqual(before);
    expect(state(roots[1])).toEqual(other);
  });

  it("supports an unborn branch with untracked files but no history", async () => {
    const root = roots[0];
    fs.rmSync(path.join(root.path, '.git'), { recursive: true, force: true });
    git(root, 'init', '--quiet', '--initial-branch=main', '--template=');
    const before = git(root, 'status', '--porcelain=v1', '-uall');
    const context = await collectCommitMessageContext('s1', root.id);
    expect(context.subjects).toEqual([]);
    expect(context.changedFiles).toContain('file.txt');
    expect(git(root, 'status', '--porcelain=v1', '-uall')).toBe(before);
  });
  it("bounds large diffs and historical subjects", async () => {
    const root = roots[0];
    for (let i = 0; i < 23; i++)
      git(
        root,
        "commit",
        "--allow-empty",
        "--quiet",
        "-m",
        `chore: sample ${i}`,
      );
    fs.writeFileSync(path.join(root.path, "file.txt"), "x".repeat(20_000));
    const context = await collectCommitMessageContext("s1", root.id);
    expect(context.subjects).toHaveLength(20);
    expect(context.subjects[0]).toBe("chore: sample 22");
    expect(context.diffExcerpt.length).toBeLessThanOrEqual(8_000);
  });
});
