import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DATA_ROOT } from '../../lib/env.js';
import {
  createGitWorktree,
  listGitWorkspaces,
  removeGitWorktree,
  resolveGitWorkspaceSelection,
} from '../git-workspaces.js';

const projectId = 'git-workspaces-test';
const gitTestTimeoutMs = 20_000;
let repository: string;

function git(args: string[], cwd = repository): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  repository = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-git-workspaces-'));
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'synax@example.test']);
  git(['config', 'user.name', 'Synax Test']);
  fs.writeFileSync(path.join(repository, 'README.md'), '# test\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'initial']);
});

afterEach(() => {
  try {
    const canonicalRepository = fs.realpathSync(repository);
    for (const line of git(['worktree', 'list', '--porcelain']).split(/\r?\n/)) {
      if (!line.startsWith('worktree ')) continue;
      const worktree = line.slice('worktree '.length);
      if (fs.realpathSync(worktree) !== canonicalRepository) {
        git(['worktree', 'remove', '--force', worktree]);
      }
    }
  } catch {
    // Best-effort cleanup after an assertion or Git failure.
  }
  fs.rmSync(repository, { recursive: true, force: true });
  fs.rmSync(path.join(DATA_ROOT, 'worktrees', projectId), { recursive: true, force: true });
});

describe('git workspace maintenance', () => {
  it('lists branches and reports dirty state and session usage', async () => {
    const clean = await listGitWorkspaces(repository, projectId, new Map([[path.normalize(repository), 2]]));
    expect(clean.branches.map((branch) => branch.name)).toEqual(['main']);
    expect(clean.worktrees).toHaveLength(1);
    expect(clean.worktrees[0]).toMatchObject({ primary: true, dirty: false, sessionCount: 2 });

    fs.appendFileSync(path.join(repository, 'README.md'), 'changed\n');
    const dirty = await listGitWorkspaces(repository, projectId);
    expect(dirty.worktrees[0]?.dirty).toBe(true);
  }, gitTestTimeoutMs);

  it('creates and reuses a managed worktree for a selected branch', async () => {
    git(['branch', 'feature/session-workspace']);

    const selected = await resolveGitWorkspaceSelection(repository, projectId, {
      kind: 'branch',
      branch: 'feature/session-workspace',
    });
    expect(selected.branch).toBe('feature/session-workspace');
    expect(selected.workDir).not.toBe(repository);

    const listed = await listGitWorkspaces(repository, projectId);
    expect(listed.worktrees.find((item) => item.path === selected.workDir)).toMatchObject({
      managed: true,
      branch: 'feature/session-workspace',
    });

    const selectedAgain = await resolveGitWorkspaceSelection(repository, projectId, {
      kind: 'branch',
      branch: 'feature/session-workspace',
    });
    expect(selectedAgain.workDir).toBe(selected.workDir);
  }, gitTestTimeoutMs);

  it('protects primary and in-use worktrees, then removes an unused worktree', async () => {
    git(['branch', 'feature/remove']);
    const created = await createGitWorktree(repository, projectId, { branch: 'feature/remove' });

    await expect(removeGitWorktree(repository, projectId, repository)).rejects.toThrow('primary worktree');
    await expect(removeGitWorktree(repository, projectId, created.path, {
      inUsePaths: new Set([path.normalize(created.path)]),
    })).rejects.toThrow('referenced by one or more sessions');

    await removeGitWorktree(repository, projectId, created.path);
    const summary = await listGitWorkspaces(repository, projectId);
    expect(summary.worktrees.map((item) => item.path)).not.toContain(created.path);
  }, gitTestTimeoutMs);

  it('creates a new branch and rejects paths outside the repository worktree set', async () => {
    const created = await createGitWorktree(repository, projectId, {
      branch: 'feature/new',
      createBranch: true,
      startPoint: 'main',
    });
    expect(created.branch).toBe('feature/new');
    expect(git(['show-ref', '--verify', '--quiet', 'refs/heads/feature/new'])).toBe('');

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-not-worktree-'));
    try {
      await expect(resolveGitWorkspaceSelection(repository, projectId, {
        kind: 'worktree',
        path: outside,
      })).rejects.toThrow('not a worktree of this project');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }, gitTestTimeoutMs);
});
