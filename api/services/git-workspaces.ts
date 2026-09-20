import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DATA_ROOT } from "../lib/env.js";
import {
  canonicalizeWorkspaceLocation,
  type WorkspaceLocation,
} from "./workspace-location.js";
import { decodeWslOutput, wslCommandSpec, wslHomeDirectory } from "./wsl.js";

const execFileAsync = promisify(execFile);
const operationQueues = new Map<string, Promise<void>>();

type RepositoryInput = string | WorkspaceLocation;

export type GitWorkspaceSelection =
  | { kind: "default" }
  | { kind: "worktree"; path: string }
  | { kind: "branch"; branch: string };

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
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "GitWorkspaceError";
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
interface RepositoryContext {
  location: WorkspaceLocation;
  root: string;
}

const asLocation = (input: RepositoryInput): WorkspaceLocation =>
  typeof input === "string" ? { kind: "host", path: input } : input;
const pathApi = (location: WorkspaceLocation) =>
  location.kind === "wsl" ? path.posix : path;

async function execute(
  location: WorkspaceLocation,
  cwd: string,
  command: string,
  args: string[],
): Promise<GitOutput> {
  try {
    if (location.kind === "wsl") {
      const spec = wslCommandSpec(location.distribution, cwd, command, args);
      const result = await execFileAsync(spec.command, spec.args, {
        encoding: "buffer",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      });
      return {
        stdout: decodeWslOutput(result.stdout as unknown as Buffer),
        stderr: decodeWslOutput(result.stderr as unknown as Buffer),
      };
    }
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (error) {
    const typed = error as Error & {
      stderr?: string | Buffer;
      code?: string | number;
    };
    const stderr = Buffer.isBuffer(typed.stderr)
      ? decodeWslOutput(typed.stderr)
      : typed.stderr;
    const detail = stderr?.trim() || typed.message;
    throw new GitWorkspaceError(
      detail || "Git command failed.",
      typed.code === "ENOENT" ? 503 : 400,
    );
  }
}

const git = (location: WorkspaceLocation, cwd: string, args: string[]) =>
  execute(location, cwd, "git", args);

async function canonical(
  location: WorkspaceLocation,
  input: string,
): Promise<string> {
  if (location.kind === "wsl") {
    const normalized = await canonicalizeWorkspaceLocation({
      ...location,
      path: input,
    });
    return normalized.path;
  }
  return path.normalize(await realpath(input));
}

function normalized(location: WorkspaceLocation, input: string): string {
  const api = pathApi(location);
  return api.normalize(api.resolve(input));
}

function samePath(
  location: WorkspaceLocation,
  left: string,
  right: string,
): boolean {
  const api = pathApi(location);
  const a = api.normalize(left);
  const b = api.normalize(right);
  return location.kind === "host" && process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function isInside(
  location: WorkspaceLocation,
  parent: string,
  child: string,
): boolean {
  const api = pathApi(location);
  const relative = api.relative(parent, child);
  return (
    relative === "" || (!relative.startsWith("..") && !api.isAbsolute(relative))
  );
}

async function pathExists(
  location: WorkspaceLocation,
  cwd: string,
  candidate: string,
): Promise<boolean> {
  if (location.kind === "wsl") {
    try {
      await execute(location, cwd, "test", ["-e", candidate]);
      return true;
    } catch {
      return false;
    }
  }
  return access(path.resolve(cwd, candidate)).then(
    () => true,
    () => false,
  );
}

function parseWorktrees(
  output: string,
  location: WorkspaceLocation,
): RawWorktree[] {
  const records: RawWorktree[] = [];
  let current: Partial<RawWorktree> = {};
  const flush = () => {
    if (current.path && current.head)
      records.push({
        path: pathApi(location).normalize(current.path),
        head: current.head,
        branch: current.branch ?? null,
        detached: current.detached ?? false,
        locked: current.locked ?? false,
        prunable: current.prunable ?? false,
      });
    current = {};
  };
  for (const field of output.split("\0")) {
    if (!field) {
      flush();
      continue;
    }
    const space = field.indexOf(" ");
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? "" : field.slice(space + 1);
    if (key === "worktree") current.path = value;
    else if (key === "HEAD") current.head = value;
    else if (key === "branch")
      current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "detached") current.detached = true;
    else if (key === "locked") current.locked = true;
    else if (key === "prunable") current.prunable = true;
  }
  flush();
  return records;
}

async function rawWorktrees(
  context: RepositoryContext,
): Promise<RawWorktree[]> {
  const { stdout } = await git(context.location, context.root, [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  return Promise.all(
    parseWorktrees(stdout, context.location).map(async (item) => ({
      ...item,
      path: item.prunable
        ? normalized(context.location, item.path)
        : await canonical(context.location, item.path).catch(() =>
            normalized(context.location, item.path),
          ),
    })),
  );
}

async function assertRepository(
  input: RepositoryInput,
): Promise<RepositoryContext> {
  let location: WorkspaceLocation;
  try {
    location = await canonicalizeWorkspaceLocation(asLocation(input));
  } catch {
    throw new GitWorkspaceError("The project workspace does not exist.", 404);
  }
  const { stdout } = await git(location, location.path, [
    "rev-parse",
    "--show-toplevel",
  ]);
  if (!stdout.trim())
    throw new GitWorkspaceError(
      "The project workspace is not a Git repository.",
      409,
    );
  const root = await canonical(location, stdout.trim());
  return { location: { ...location, path: root }, root };
}

async function assertBranchName(
  context: RepositoryContext,
  branch: string,
): Promise<void> {
  if (!branch.trim() || branch.trim() !== branch)
    throw new GitWorkspaceError("Branch name is invalid.");
  await git(context.location, context.root, [
    "check-ref-format",
    "--branch",
    branch,
  ]);
}

async function branchExists(
  context: RepositoryContext,
  branch: string,
): Promise<boolean> {
  try {
    await git(context.location, context.root, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function managedWorktreePath(
  location: WorkspaceLocation,
  projectId: string,
  branch: string,
): Promise<string> {
  const slug =
    branch
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "branch";
  const suffix = createHash("sha256").update(branch).digest("hex").slice(0, 8);
  if (location.kind === "wsl") {
    const home = await wslHomeDirectory(location.distribution);
    return path.posix.join(
      home,
      ".local",
      "share",
      "synax",
      "worktrees",
      projectId,
      `${slug}-${suffix}`,
    );
  }
  return path.resolve(DATA_ROOT, "worktrees", projectId, `${slug}-${suffix}`);
}

async function ensureParent(
  location: WorkspaceLocation,
  destination: string,
): Promise<void> {
  const parent = pathApi(location).dirname(destination);
  if (location.kind === "wsl")
    await execute(location, "/", "mkdir", ["-p", "--", parent]);
  else await mkdir(parent, { recursive: true });
}

async function withRepositoryLock<T>(
  context: RepositoryContext,
  action: () => Promise<T>,
): Promise<T> {
  const key = `${context.location.kind}:${context.location.kind === "wsl" ? context.location.distribution.toLowerCase() : ""}:${context.root}`;
  const previous = operationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
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
  repositoryPath: RepositoryInput,
  projectId: string,
  sessionCounts: ReadonlyMap<string, number> = new Map(),
): Promise<GitWorkspaceSummary> {
  const context = await assertRepository(repositoryPath);
  const worktrees = await rawWorktrees(context);
  if (!worktrees.length)
    throw new GitWorkspaceError("Git did not report any worktrees.", 409);
  const managedRootInput = pathApi(context.location).dirname(
    await managedWorktreePath(context.location, projectId, "branch"),
  );
  const managedRoot = await canonical(context.location, managedRootInput).catch(
    () => normalized(context.location, managedRootInput),
  );
  const canonicalSessionCounts = new Map<string, number>();
  await Promise.all(
    [...sessionCounts].map(async ([workDir, count]) => {
      const key = await canonical(context.location, workDir).catch(() =>
        normalized(context.location, workDir),
      );
      canonicalSessionCounts.set(
        key,
        (canonicalSessionCounts.get(key) ?? 0) + count,
      );
    }),
  );
  const branchPaths = new Map(
    worktrees
      .filter((item) => item.branch)
      .map((item) => [item.branch!, item.path]),
  );
  const { stdout } = await git(context.location, context.root, [
    "for-each-ref",
    "--format=%(refname:short)%00%(objectname)%00%(upstream:short)",
    "refs/heads",
  ]);
  const branches = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, head, upstream = ""] = line.split("\0");
      return {
        name,
        head,
        upstream: upstream || null,
        checkedOutPath: branchPaths.get(name) ?? null,
      };
    });
  const dirtyResults = await Promise.all(
    worktrees.map(async (item) => {
      if (item.prunable) return false;
      try {
        return Boolean(
          (
            await git(context.location, item.path, [
              "status",
              "--porcelain",
              "--untracked-files=normal",
            ])
          ).stdout.trim(),
        );
      } catch {
        return false;
      }
    }),
  );
  return {
    repositoryRoot: worktrees[0].path,
    defaultPath: context.root,
    branches,
    worktrees: worktrees.map((item, index) => ({
      ...item,
      primary: index === 0,
      managed: isInside(context.location, managedRoot, item.path),
      dirty: dirtyResults[index],
      sessionCount:
        canonicalSessionCounts.get(
          pathApi(context.location).normalize(item.path),
        ) ?? 0,
    })),
  };
}

export async function createGitWorktree(
  repositoryPath: RepositoryInput,
  projectId: string,
  input: { branch: string; createBranch?: boolean; startPoint?: string },
): Promise<GitWorktreeSummary> {
  const context = await assertRepository(repositoryPath);
  return withRepositoryLock(context, async () => {
    await assertBranchName(context, input.branch);
    const existing = await rawWorktrees(context);
    if (existing.some((item) => item.branch === input.branch))
      throw new GitWorkspaceError(
        `Branch "${input.branch}" is already checked out in a worktree.`,
        409,
      );
    const exists = await branchExists(context, input.branch);
    if (input.createBranch && exists)
      throw new GitWorkspaceError(
        `Branch "${input.branch}" already exists.`,
        409,
      );
    if (!input.createBranch && !exists)
      throw new GitWorkspaceError(
        `Branch "${input.branch}" does not exist.`,
        404,
      );
    const destination = await managedWorktreePath(
      context.location,
      projectId,
      input.branch,
    );
    await ensureParent(context.location, destination);
    const args = ["worktree", "add"];
    if (input.createBranch) args.push("-b", input.branch);
    args.push(
      destination,
      input.createBranch ? input.startPoint?.trim() || "HEAD" : input.branch,
    );
    await git(context.location, context.root, args);
    const canonicalDestination = await canonical(context.location, destination);
    const summary = await listGitWorkspaces(context.location, projectId);
    const created = summary.worktrees.find((item) =>
      samePath(context.location, item.path, canonicalDestination),
    );
    if (!created)
      throw new GitWorkspaceError(
        "Git created the worktree but it could not be listed.",
        500,
      );
    return created;
  });
}

export async function removeGitWorktree(
  repositoryPath: RepositoryInput,
  projectId: string,
  worktreePath: string,
  options: { force?: boolean; inUsePaths?: ReadonlySet<string> } = {},
): Promise<void> {
  const context = await assertRepository(repositoryPath);
  await withRepositoryLock(context, async () => {
    const requested = await canonical(context.location, worktreePath).catch(
      () => normalized(context.location, worktreePath),
    );
    const summary = await listGitWorkspaces(context.location, projectId);
    const target = summary.worktrees.find((item) =>
      samePath(context.location, item.path, requested),
    );
    if (!target)
      throw new GitWorkspaceError(
        "The selected path is not a worktree of this project.",
        404,
      );
    if (target.primary)
      throw new GitWorkspaceError(
        "The primary worktree cannot be removed.",
        409,
      );
    const inUsePaths = await Promise.all(
      [...(options.inUsePaths ?? [])].map((candidate) =>
        canonical(context.location, candidate).catch(() =>
          normalized(context.location, candidate),
        ),
      ),
    );
    if (
      inUsePaths.some((candidate) =>
        samePath(context.location, candidate, target.path),
      )
    )
      throw new GitWorkspaceError(
        "This worktree is referenced by one or more sessions.",
        409,
      );
    await git(context.location, context.root, [
      "worktree",
      "remove",
      ...(options.force ? ["--force"] : []),
      target.path,
    ]);
  });
}

export async function pruneGitWorktrees(
  repositoryPath: RepositoryInput,
): Promise<void> {
  const context = await assertRepository(repositoryPath);
  await withRepositoryLock(context, async () => {
    await git(context.location, context.root, ["worktree", "prune"]);
  });
}

export async function resolveGitWorkspaceSelection(
  repositoryPath: RepositoryInput,
  projectId: string,
  selection: GitWorkspaceSelection,
): Promise<{
  workDir: string;
  branch: string | null;
  kind: GitWorkspaceSelection["kind"];
  location?: WorkspaceLocation;
}> {
  const context = await assertRepository(repositoryPath);
  if (selection.kind === "default") {
    const summary = await listGitWorkspaces(context.location, projectId);
    return {
      workDir: context.root,
      branch:
        summary.worktrees.find((item) =>
          samePath(context.location, item.path, context.root),
        )?.branch ?? null,
      kind: "default",
      location: context.location,
    };
  }
  if (selection.kind === "worktree") {
    const requested = await canonical(context.location, selection.path).catch(
      () => {
        throw new GitWorkspaceError(
          "The selected worktree does not exist.",
          404,
        );
      },
    );
    const summary = await listGitWorkspaces(context.location, projectId);
    const worktree = summary.worktrees.find((item) =>
      samePath(context.location, item.path, requested),
    );
    if (!worktree)
      throw new GitWorkspaceError(
        "The selected path is not a worktree of this project.",
        400,
      );
    if (worktree.prunable)
      throw new GitWorkspaceError(
        "The selected worktree is no longer available.",
        409,
      );
    return {
      workDir: worktree.path,
      branch: worktree.branch,
      kind: "worktree",
      location: { ...context.location, path: worktree.path },
    };
  }
  await assertBranchName(context, selection.branch);
  const summary = await listGitWorkspaces(context.location, projectId);
  const branch = summary.branches.find(
    (item) => item.name === selection.branch,
  );
  if (!branch)
    throw new GitWorkspaceError(
      `Branch "${selection.branch}" does not exist.`,
      404,
    );
  if (branch.checkedOutPath)
    return {
      workDir: branch.checkedOutPath,
      branch: branch.name,
      kind: "branch",
      location: { ...context.location, path: branch.checkedOutPath },
    };
  const created = await createGitWorktree(context.location, projectId, {
    branch: branch.name,
  });
  return {
    workDir: created.path,
    branch: created.branch,
    kind: "branch",
    location: { ...context.location, path: created.path },
  };
}

/** Change this worktree, never discard edits, auto-stash, or guess remote refs. */
export async function switchGitBranch(
  repositoryPath: RepositoryInput,
  branch: string,
  assertIdle: (root: string) => void = () => {},
): Promise<string> {
  const context = await assertRepository(repositoryPath);
  return withRepositoryLock(context, async () => {
    await assertBranchName(context, branch);
    if (!(await branchExists(context, branch)))
      throw new GitWorkspaceError("Local branch does not exist.", 404);
    const current = (
      await git(context.location, context.root, ["branch", "--show-current"])
    ).stdout.trim();
    if (current === branch) return current;
    const status = await git(context.location, context.root, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    if (status.stdout.trim())
      throw new GitWorkspaceError(
        "Commit or stash uncommitted changes before switching branches.",
        409,
      );
    for (const marker of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
      "BISECT_LOG",
      "sequencer",
    ]) {
      const location = (
        await git(context.location, context.root, [
          "rev-parse",
          "--git-path",
          marker,
        ])
      ).stdout.trim();
      if (await pathExists(context.location, context.root, location))
        throw new GitWorkspaceError(
          "A Git operation is in progress. Finish it before switching branches.",
          409,
        );
    }
    const occupied = (await rawWorktrees(context)).find(
      (item) =>
        item.branch === branch &&
        !samePath(context.location, item.path, context.root),
    );
    if (occupied)
      throw new GitWorkspaceError(
        "This branch is already checked out in another worktree.",
        409,
      );
    assertIdle(context.root);
    await git(context.location, context.root, ["switch", "--no-guess", branch]);
    return (
      await git(context.location, context.root, ["branch", "--show-current"])
    ).stdout.trim();
  });
}
