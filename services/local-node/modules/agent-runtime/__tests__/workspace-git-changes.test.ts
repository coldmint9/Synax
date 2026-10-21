import * as commands from "../tools/exec-async.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  tryGetSession: vi.fn(),
  listToolCalls: vi.fn(),
  listMessages: vi.fn(),
  resolveSessionWorkspaceRoots: vi.fn(),
  resolveWorkspaceRootsFromSession: vi.fn(),
}));

vi.mock("../session-store.js", () => ({ agentRuntimeStore: mocks }));
vi.mock("../tools/workspace.js", () => ({
  resolveSessionWorkspaceRoots: mocks.resolveSessionWorkspaceRoots,
  resolveWorkspaceRootsFromSession: mocks.resolveWorkspaceRootsFromSession,
}));

import {
  getWorkspaceGitChanges,
  invalidateAllWorkspaceGit,
} from "../workspace-git-changes.js";
import { invalidateSessionEnvironment } from "../session-environment.js";

const projectId = "project";
const sessionId = "workspace-git-changes-test";
let workspace: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
}

function write(file: string, content: string): void {
  const target = path.join(workspace, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateAllWorkspaceGit();
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "synax-workspace-git-"));
  workspace = fs.realpathSync(workspace);
  git("init", "--quiet");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  write(".gitignore", "generated/*\n!generated/keep.ts\n*.log\n");
  write("src/main.ts", "before\n");
  write("generated/keep.ts", "before\n");
  write("generated/build.js", "before\n");
  write("generated/deleted.js", "before\n");
  write("generated/缓存.js", "before\n");
  write("generated/with space.js", "before\n");
  write("generated/with\nnewline.js", "before\n");
  git("add", "--force", ".");
  git("commit", "--quiet", "-m", "fixture");
  mocks.tryGetSession.mockImplementation((id: string) => ({
    id,
    projectId,
    childSessionIds: [],
  }));
  mocks.getSession.mockImplementation((id: string) => ({
    id,
    projectId,
    childSessionIds: [],
  }));
  mocks.listToolCalls.mockReturnValue([]);
  mocks.listMessages.mockReturnValue([]);
  mocks.resolveSessionWorkspaceRoots.mockReturnValue([
    {
      id: projectId,
      name: "Project",
      path: workspace,
      role: "primary",
      status: "available",
    },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
  invalidateAllWorkspaceGit();
  fs.rmSync(workspace, { recursive: true, force: true });
  vi.clearAllMocks();
});

const read = (id: string = sessionId) =>
  getWorkspaceGitChanges({ projectId, sessionId: id });
const primary = (changes: Awaited<ReturnType<typeof read>>) =>
  changes.repositories.find((repository) => repository.role === "primary")!;

describe("workspace Git changes", () => {
  it("excludes ignored tracked and untracked changes from files and line totals", async () => {
    write("src/main.ts", "after\nextra\n");
    write("src/new.ts", "new\n");
    write("generated/keep.ts", "after\n");
    write("generated/build.js", "after\nignored\n");
    write("generated/缓存.js", "after\n");
    write("generated/with space.js", "after\n");
    write("generated/with\nnewline.js", "after\n");
    write("generated/new.js", "ignored\n");
    write("debug.log", "ignored\n");
    write("generated/staged.js", "ignored\n");
    git("add", "--force", "generated/staged.js");
    git("rm", "--quiet", "generated/deleted.js");

    const repository = primary(await read());

    expect(repository.changedFiles.map((file) => file.path).sort()).toEqual([
      "generated/keep.ts",
      "src/main.ts",
      "src/new.ts",
    ]);
    expect(repository.additions).toBe(4);
    expect(repository.deletions).toBe(2);
    expect(repository.dirty).toBe(true);
  });

  it("reports no changes when only ignored files changed, including nested ignore rules", async () => {
    write("generated/build.js", "ignored change\n");
    write("debug.log", "ignored\n");
    write("src/.gitignore", "cache/\n!keep.log\n");
    git("add", "src/.gitignore");
    git("commit", "--quiet", "-m", "nested rules");
    write("src/cache/tracked.ts", "before\n");
    git("add", "--force", "src/cache/tracked.ts");
    git("commit", "--quiet", "-m", "tracked cache");
    write("src/cache/tracked.ts", "after\n");

    const repository = primary(await read());

    expect(repository.changedFiles).toEqual([]);
    expect(repository.additions).toBe(0);
    expect(repository.deletions).toBe(0);
    expect(repository.dirty).toBe(false);
  });

  it("preserves ordinary staged changes", async () => {
    write("src/main.ts", "after\n");
    git("add", "src/main.ts");

    expect(primary(await read()).changedFiles).toEqual([
      {
        path: "src/main.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        staged: true,
        untracked: false,
      },
    ]);
  });

  it("filters renamed files by destination while retaining visible rename paths", async () => {
    write("src/main.ts", "one\ntwo\nthree\nfour\nfive\n");
    git("add", "src/main.ts");
    git("commit", "--quiet", "-m", "rename fixture");
    git("mv", "src/main.ts", "src/renamed 文件.ts");
    write("src/renamed 文件.ts", "one\ntwo\nthree\nfour\nfive\nsix\n");
    git("mv", "generated/keep.ts", "generated/ignored.ts");

    const repository = primary(await read());

    expect(repository.changedFiles).toEqual([
      {
        path: "src/renamed 文件.ts",
        status: "renamed",
        additions: 1,
        deletions: 0,
        staged: true,
        untracked: false,
      },
    ]);
    expect(repository.additions).toBe(1);
    expect(repository.deletions).toBe(0);
  });

  it("shares one probe between sessions in the same worktree", async () => {
    const run = vi.spyOn(commands, "runCommand");
    await Promise.all([read("first-session"), read("second-session")]);
    const statusCalls = () =>
      run.mock.calls.filter(
        ([command, args]) => command === "git" && (args as string[])[0] === "status",
      ).length;
    expect(statusCalls()).toBe(1);
  });

  it("answers with an unchanged revision instead of a file list", async () => {
    const first = await read();
    expect(first.unchanged).toBe(false);
    expect(first.repositories).toHaveLength(1);

    const again = await getWorkspaceGitChanges({
      projectId,
      sessionId,
      clientRevision: first.revision,
    });
    expect(again.unchanged).toBe(true);
    expect(again.revision).toBe(first.revision);
    expect(again.repositories).toEqual([]);
  });

  it("bumps the revision and re-probes after a write tool invalidates the checkout", async () => {
    const run = vi.spyOn(commands, "runCommand");
    const first = await read();
    const statusCalls = () =>
      run.mock.calls.filter(
        ([command, args]) => command === "git" && (args as string[])[0] === "status",
      ).length;
    expect(statusCalls()).toBe(1);

    write("new.txt", "new contents");
    invalidateSessionEnvironment(sessionId);

    const next = await getWorkspaceGitChanges({
      projectId,
      sessionId,
      clientRevision: first.revision,
    });
    expect(next.unchanged).toBe(false);
    expect(next.revision).not.toBe(first.revision);
    expect(primary(next).changedFiles.some((file) => file.path === "new.txt")).toBe(true);
    expect(statusCalls()).toBe(2);
  });

  it("reports a workspace that is not a Git repository without failing", async () => {
    fs.rmSync(path.join(workspace, ".git"), { recursive: true, force: true });
    const repository = primary(await read());
    expect(repository.status).toBe("not_repository");
    expect(repository.changedFiles).toEqual([]);
  });
});
