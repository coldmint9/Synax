import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { DATA_ROOT } from '../lib/env.js';

const execFileAsync = promisify(execFile);
const operationQueues = new Map<string, Promise<void>>();

export type GitWorkspaceSelection =
  | { kind: 'default' }
  | { kind: 'worktree'; path: string }
  | { kind: 'branch'; branch: string };

export interface GitBranchSummary {
  name: string;
  head: string;
  upstream: string | null;
  checkedOutPath: string | null;
}

export interface GitWorktreeSummary {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  primary: boolean;
  locked: boolean;
  prunable: boolean;
  managed: boolean;
  dirty: boolean;
  sessionCount: number;
}

export interface GitWorkspaceSummary {
  repositoryRoot: string;
  defaultPath: string;
  branches: GitBranchSummary[];
  worktrees: GitWorktreeSummary[];
}

export class GitWorkspaceError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'GitWorkspaceError';
  }
}

interface RawWorktree {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

interface GitOutput {
  stdout: string;
  stderr: string;
}

async function git(cwd: string, args: string[]): Promise<GitOutput> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const typed = error as Error & { stderr?: string; code?: string | number };
    const detail = typed.stderr?.trim() || typed.message;
    throw new GitWorkspaceError(detail || 'Git command failed.', typed.code === 'ENOENT' ? 503 : 400);
  }
}

async function canonical(input: string): Promise<string> {
  return path.normalize(await realpath(input));
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase()
    : path.normalize(left) === path.normalize(right);
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseWorktrees(output: string): RawWorktree[] {
  const records: RawWorktree[] = [];
  let current: Partial<RawWorktree> = {};
  const flush = () => {
    if (current.path && current.head) {
      records.push({
        path: path.normalize(current.path),
        head: current.head,
        branch: current.branch ?? null,
        detached: current.detached ?? false,
        locked: current.locked ?? false,
        prunable: current.prunable ?? false,
      });
    }
    current = {};
  };

  for (const field of output.split('\0')) {
    if (!field) {
      flush();
      continue;
    }
    const space = field.indexOf(' ');
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? '' : field.slice(space + 1);
    if (key === 'worktree') current.path = value;
    else if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') current.detached = true;
    else if (key === 'locked') current.locked = true;
    else if (key === 'prunable') current.prunable = true;
  }
  flush();
  return records;
}

async function rawWorktrees(repositoryPath: string): Promise<RawWorktree[]> {
  const { stdout } = await git(repositoryPath, ['worktree', 'list', '--porcelain', '-z']);
  const parsed = parseWorktrees(stdout);
  return Promise.all(parsed.map(async (item) => ({
    ...item,
    path: item.prunable
      ? path.normalize(path.resolve(item.path))
      : await canonical(item.path).catch(() => path.normalize(path.resolve(item.path))),
  })));
}

async function assertRepository(repositoryPath: string): Promise<string> {
  const candidate = await canonical(repositoryPath).catch(() => {
    throw new GitWorkspaceError('The project workspace does not exist.', 404);
  });
  const { stdout } = await git(candidate, ['rev-parse', '--show-toplevel']);
  if (!stdout.trim()) throw new GitWorkspaceError('The project workspace is not a Git repository.', 409);
  return canonical(stdout.trim());
}

async function assertBranchName(repositoryPath: string, branch: string): Promise<void> {
  const normalized = branch.trim();
  if (!normalized || normalized !== branch) throw new GitWorkspaceError('Branch name is invalid.');
  await git(repositoryPath, ['check-ref-format', '--branch', branch]);
}

async function branchExists(repositoryPath: string, branch: string): Promise<boolean> {
  try {
    await git(repositoryPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

function managedWorktreePath(projectId: string, branch: string): string {
  const slug = branch.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'branch';
  const suffix = createHash('sha256').update(branch).digest('hex').slice(0, 8);
  return path.resolve(DATA_ROOT, 'worktrees', projectId, `${slug}-${suffix}`);
}

async function withRepositoryLock<T>(repositoryPath: string, action: () => Promise<T>): Promise<T> {
  const key = path.normalize(repositoryPath);
  const previous = operationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  operationQueues.set(key, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (operationQueues.get(key) === queued) operationQueues.delete(key);
  }
}

export async function listGitWorkspaces(
  repositoryPath: string,
  projectId: string,
  sessionCounts: ReadonlyMap<string, number> = new Map(),
): Promise<GitWorkspaceSummary> {
  const defaultPath = await assertRepository(repositoryPath);
  const worktrees = await rawWorktrees(defaultPath);
  if (!worktrees.length) throw new GitWorkspaceError('Git did not report any worktrees.', 409);
  const managedRootInput = path.resolve(DATA_ROOT, 'worktrees', projectId);
  const managedRoot = await canonical(managedRootInput).catch(() => path.normalize(managedRootInput));
  const canonicalSessionCounts = new Map<string, number>();
  await Promise.all([...sessionCounts].map(async ([workDir, count]) => {
    const key = await canonical(workDir).catch(() => path.normalize(path.resolve(workDir)));
    canonicalSessionCounts.set(key, (canonicalSessionCounts.get(key) ?? 0) + count);
  }));
  const branchPaths = new Map(worktrees.filter((item) => item.branch).map((item) => [item.branch!, item.path]));
  const { stdout } = await git(defaultPath, [
    'for-each-ref',
    '--format=%(refname:short)%00%(objectname)%00%(upstream:short)',
    'refs/heads',
  ]);
  const branches = stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, head, upstream = ''] = line.split('\0');
    return { name, head, upstream: upstream || null, checkedOutPath: branchPaths.get(name) ?? null };
  });
  const dirtyResults = await Promise.all(worktrees.map(async (item) => {
    if (item.prunable) return false;
    try {
      const result = await git(item.path, ['status', '--porcelain', '--untracked-files=normal']);
      return Boolean(result.stdout.trim());
    } catch {
      return false;
    }
  }));

  return {
    repositoryRoot: worktrees[0].path,
    defaultPath,
    branches,
    worktrees: worktrees.map((item, index) => ({
      ...item,
      primary: index === 0,
      managed: isInside(managedRoot, item.path),
      dirty: dirtyResults[index],
      sessionCount: canonicalSessionCounts.get(path.normalize(item.path)) ?? 0,
    })),
  };
}

export async function createGitWorktree(
  repositoryPath: string,
  projectId: string,
  input: { branch: string; createBranch?: boolean; startPoint?: string },
): Promise<GitWorktreeSummary> {
  const root = await assertRepository(repositoryPath);
  return withRepositoryLock(root, async () => {
    await assertBranchName(root, input.branch);
    const existing = await rawWorktrees(root);
    if (existing.some((item) => item.branch === input.branch)) {
      throw new GitWorkspaceError(`Branch "${input.branch}" is already checked out in a worktree.`, 409);
    }
    const exists = await branchExists(root, input.branch);
    if (input.createBranch && exists) throw new GitWorkspaceError(`Branch "${input.branch}" already exists.`, 409);
    if (!input.createBranch && !exists) throw new GitWorkspaceError(`Branch "${input.branch}" does not exist.`, 404);

    const destination = managedWorktreePath(projectId, input.branch);
    await mkdir(path.dirname(destination), { recursive: true });
    const args = ['worktree', 'add'];
    if (input.createBranch) args.push('-b', input.branch);
    args.push(destination, input.createBranch ? (input.startPoint?.trim() || 'HEAD') : input.branch);
    await git(root, args);
    const canonicalDestination = await canonical(destination);
    const summary = await listGitWorkspaces(root, projectId);
    const created = summary.worktrees.find((item) => samePath(item.path, canonicalDestination));
    if (!created) throw new GitWorkspaceError('Git created the worktree but it could not be listed.', 500);
    return created;
  });
}

export async function removeGitWorktree(
  repositoryPath: string,
  projectId: string,
  worktreePath: string,
  options: { force?: boolean; inUsePaths?: ReadonlySet<string> } = {},
): Promise<void> {
  const root = await assertRepository(repositoryPath);
  await withRepositoryLock(root, async () => {
    const requested = await canonical(worktreePath).catch(() => path.normalize(path.resolve(worktreePath)));
    const summary = await listGitWorkspaces(root, projectId);
    const target = summary.worktrees.find((item) => samePath(item.path, requested));
    if (!target) throw new GitWorkspaceError('The selected path is not a worktree of this project.', 404);
    if (target.primary) throw new GitWorkspaceError('The primary worktree cannot be removed.', 409);
    const inUsePaths = await Promise.all([...(options.inUsePaths ?? [])].map((candidate) =>
      canonical(candidate).catch(() => path.normalize(path.resolve(candidate))),
    ));
    if (inUsePaths.some((candidate) => samePath(candidate, target.path))) {
      throw new GitWorkspaceError('This worktree is referenced by one or more sessions.', 409);
    }
    await git(root, ['worktree', 'remove', ...(options.force ? ['--force'] : []), target.path]);
  });
}

export async function pruneGitWorktrees(repositoryPath: string): Promise<void> {
  const root = await assertRepository(repositoryPath);
  await withRepositoryLock(root, async () => {
    await git(root, ['worktree', 'prune']);
  });
}

export async function resolveGitWorkspaceSelection(
  repositoryPath: string,
  projectId: string,
  selection: GitWorkspaceSelection,
): Promise<{ workDir: string; branch: string | null; kind: GitWorkspaceSelection['kind'] }> {
  const root = await assertRepository(repositoryPath);
  if (selection.kind === 'default') {
    const workDir = await canonical(root);
    const summary = await listGitWorkspaces(root, projectId);
    return { workDir, branch: summary.worktrees.find((item) => samePath(item.path, workDir))?.branch ?? null, kind: 'default' };
  }
  if (selection.kind === 'worktree') {
    const requested = await canonical(selection.path).catch(() => {
      throw new GitWorkspaceError('The selected worktree does not exist.', 404);
    });
    const summary = await listGitWorkspaces(root, projectId);
    const worktree = summary.worktrees.find((item) => samePath(item.path, requested));
    if (!worktree) throw new GitWorkspaceError('The selected path is not a worktree of this project.', 400);
    if (worktree.prunable) throw new GitWorkspaceError('The selected worktree is no longer available.', 409);
    return { workDir: worktree.path, branch: worktree.branch, kind: 'worktree' };
  }

  await assertBranchName(root, selection.branch);
  const summary = await listGitWorkspaces(root, projectId);
  const branch = summary.branches.find((item) => item.name === selection.branch);
  if (!branch) throw new GitWorkspaceError(`Branch "${selection.branch}" does not exist.`, 404);
  if (branch.checkedOutPath) {
    return { workDir: branch.checkedOutPath, branch: branch.name, kind: 'branch' as const };
  }
  const created = await createGitWorktree(root, projectId, { branch: branch.name });
  return { workDir: created.path, branch: created.branch, kind: 'branch' as const };
}
