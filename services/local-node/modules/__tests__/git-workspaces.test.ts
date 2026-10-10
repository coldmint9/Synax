import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_ROOT } from "../../infrastructure/runtime/env.js";
import {
  switchGitBranch,
  createGitWorktree,
  attachDetachedGitBranch,
  listGitWorkspaces,
  removeGitWorktree,
  resolveGitWorkspaceSelection,
} from "../git-workspaces.js";

const projectId = "git-workspaces-test";
const gitTestTimeoutMs = 20_000;
let repository: string;

function git(args: string[], cwd = repository): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

beforeEach(() => {
  repository = fs.mkdtempSync(path.join(os.tmpdir(), "synax-git-workspaces-"));
  git(["init", "-b", "main"]);
  git(["config", "user.email", "synax@example.test"]);
  git(["config", "user.name", "Synax Test"]);
  fs.writeFileSync(path.join(repository, "README.md"), "# test\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "initial"]);
});

afterEach(() => {
  try {
    const canonicalRepository = fs.realpathSync(repository);
    for (const line of git(["worktree", "list", "--porcelain"]).split(
      /\r?\n/,
    )) {
      if (!line.startsWith("worktree ")) continue;
      const worktree = line.slice("worktree ".length);
      if (fs.realpathSync(worktree) !== canonicalRepository) {
        git(["worktree", "remove", "--force", worktree]);
      }
    }
  } catch {
    // Best-effort cleanup after an assertion or Git failure.
  }
  fs.rmSync(repository, { recursive: true, force: true });
  fs.rmSync(path.join(DATA_ROOT, "worktrees", projectId), {
    recursive: true,
    force: true,
  });
});

describe("git workspace maintenance", () => {
  it.each([false, true])("preserves the backup and reports partial switching when restore fails (staged: %s)", async (staged) => {
    git(["switch", "-c", "feature/conflict"]);
    fs.writeFileSync(path.join(repository, "README.md"), "target branch\n");
    git(["commit", "-am", "target change"]);
    git(["switch", "main"]);
    fs.writeFileSync(path.join(repository, "README.md"), "local edits\n");
    if (staged) git(["add", "README.md"]);

    await expect(switchGitBranch(repository, "feature/conflict", undefined, { transferChanges: true }))
      .rejects.toThrow(/restoring local changes or the index failed/);

    expect(git(["branch", "--show-current"])).toBe("feature/conflict");
    expect(git(["stash", "list"])).toContain("synax-branch-transfer-");
    expect(git(["show", "stash@{0}:README.md"])).toBe("local edits");
    if (!staged) expect(git(["diff", "--name-only", "--diff-filter=U"])).toContain("README.md");
  }, gitTestTimeoutMs);

  it(
    "lists branches and reports dirty state and session usage",
    async () => {
      const clean = await listGitWorkspaces(
        repository,
        projectId,
        new Map([[path.normalize(repository), 2]]),
      );
      expect(clean.branches.map((branch) => branch.name)).toEqual(["main"]);
      expect(clean.worktrees).toHaveLength(1);
      expect(clean.worktrees[0]).toMatchObject({
        primary: true,
        dirty: false,
        sessionCount: 2,
      });

      fs.appendFileSync(path.join(repository, "README.md"), "changed\n");
      const dirty = await listGitWorkspaces(repository, projectId);
      expect(dirty.worktrees[0]?.dirty).toBe(true);
    },
    gitTestTimeoutMs,
  );

  it(
    "creates and reuses a managed worktree for a selected branch",
    async () => {
      git(["branch", "feature/session-workspace"]);

      const selected = await resolveGitWorkspaceSelection(
        repository,
        projectId,
        {
          kind: "branch",
          branch: "feature/session-workspace",
        },
      );
      expect(selected.branch).toBe("feature/session-workspace");
      expect(selected.workDir).not.toBe(repository);

      const listed = await listGitWorkspaces(repository, projectId);
      expect(
        listed.worktrees.find((item) => item.path === selected.workDir),
      ).toMatchObject({
        managed: true,
        branch: "feature/session-workspace",
      });

      const selectedAgain = await resolveGitWorkspaceSelection(
        repository,
        projectId,
        {
          kind: "branch",
          branch: "feature/session-workspace",
        },
      );
      expect(selectedAgain.workDir).toBe(selected.workDir);
    },
    gitTestTimeoutMs,
  );

  it(
    "protects primary and in-use worktrees, then removes an unused worktree",
    async () => {
      git(["branch", "feature/remove"]);
      const created = await createGitWorktree(repository, projectId, {
        branch: "feature/remove",
      });

      await expect(
        removeGitWorktree(repository, projectId, repository),
      ).rejects.toThrow("主工作树不可删除");
      await expect(
        removeGitWorktree(repository, projectId, created.path, {
          inUsePaths: new Set([path.normalize(created.path)]),
        }),
      ).rejects.toThrow("referenced by one or more sessions");

      await removeGitWorktree(repository, projectId, created.path);
      const summary = await listGitWorkspaces(repository, projectId);
      expect(summary.worktrees.map((item) => item.path)).not.toContain(
        created.path,
      );
    },
    gitTestTimeoutMs,
  );

  it(
    "creates a new branch and rejects paths outside the repository worktree set",
    async () => {
      const created = await createGitWorktree(repository, projectId, {
        branch: "feature/new",
        createBranch: true,
        startPoint: "main",
      });
      expect(created.branch).toBe("feature/new");
      expect(
        git(["show-ref", "--verify", "--quiet", "refs/heads/feature/new"]),
      ).toBe("");

      const outside = fs.mkdtempSync(
        path.join(os.tmpdir(), "synax-not-worktree-"),
      );
      try {
        await expect(
          resolveGitWorkspaceSelection(repository, projectId, {
            kind: "worktree",
            path: outside,
          }),
        ).rejects.toThrow("not a worktree of this project");
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
    gitTestTimeoutMs,
  );
});

describe("safe branch switching", () => {
  it("switches existing local branches without creating a worktree", async () => {
    git(["branch", "feature/ui"]);
    expect(await switchGitBranch(repository, "feature/ui")).toBe("feature/ui");
    expect(git(["branch", "--show-current"])).toBe("feature/ui");
    expect(
      (await listGitWorkspaces(repository, projectId)).worktrees,
    ).toHaveLength(1);
    await expect(
      switchGitBranch(repository, "--discard-changes"),
    ).rejects.toThrow();
    await expect(switchGitBranch(repository, "missing")).rejects.toThrow();
    expect(git(["branch", "--show-current"])).toBe("feature/ui");
  }, gitTestTimeoutMs);
  it("rejects dirty files, occupied branches and unfinished merges without changing HEAD", async () => {
    git(["branch", "feature/busy"]);
    fs.writeFileSync(path.join(repository, "untracked.txt"), "keep me");
    await expect(switchGitBranch(repository, "feature/busy")).rejects.toThrow(
      /uncommitted/i,
    );
    fs.unlinkSync(path.join(repository, "untracked.txt"));
    const worktree = await createGitWorktree(repository, projectId, {
      branch: "feature/busy",
    });
    await expect(switchGitBranch(repository, "feature/busy")).rejects.toThrow(
      /worktree/i,
    );
    await removeGitWorktree(repository, projectId, worktree.path);
    fs.writeFileSync(
      path.join(repository, ".git", "MERGE_HEAD"),
      git(["rev-parse", "HEAD"]),
    );
    await expect(switchGitBranch(repository, "feature/busy")).rejects.toThrow(
      /progress/i,
    );
    expect(git(["branch", "--show-current"])).toBe("main");
  }, gitTestTimeoutMs);
});

describe('fresh session worktree', () => {
  it('creates a unique detached worktree from current HEAD without moving a branch', async () => {
    git(['switch', '-c', 'topic/source']);
    fs.appendFileSync(path.join(repository, 'README.md'), 'source\n');
    git(['add', '.']); git(['commit', '-m', 'source']);
    const head = git(['rev-parse', 'HEAD']);
    const first = await resolveGitWorkspaceSelection(repository, projectId, { kind: 'new-worktree' });
    const second = await resolveGitWorkspaceSelection(repository, projectId, { kind: 'new-worktree' });
    expect(first.workDir).not.toBe(second.workDir);
    expect(first.kind).toBe('new-worktree');
    expect(first.branch).toBeNull();
    expect(git(['rev-parse', 'HEAD'], first.workDir)).toBe(head);
    expect(git(['branch', '--show-current'], first.workDir)).toBe('');
    expect(git(['branch', '--show-current'])).toBe('topic/source');
    expect(git(['rev-parse', 'HEAD'], second.workDir)).toBe(head);
  }, gitTestTimeoutMs);
});

describe('attach a branch to detached work', () => {
  it('keeps tracked and untracked edits while attaching a new branch at HEAD', async () => {
    git(['switch', '--detach']);
    fs.appendFileSync(path.join(repository, 'README.md'), 'working\n');
    fs.writeFileSync(path.join(repository, 'draft.txt'), 'new');
    const base = git(['rev-parse', 'HEAD']);
    await attachDetachedGitBranch(repository, 'topic/from-detached');
    expect(git(['branch', '--show-current'])).toBe('topic/from-detached');
    expect(git(['rev-parse', 'HEAD'])).toBe(base);
    expect(git(['status', '--porcelain', '--untracked-files=all'])).toContain('draft.txt');
    expect(fs.readFileSync(path.join(repository, 'README.md'), 'utf8')).toContain('working');
  }, gitTestTimeoutMs);
});
