import { createHash, randomUUID } from "node:crypto";
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
import type { GitHistoryRef, GitHistoryPage, GitCommitDetail } from "./git-history-contracts.js";
import type { GitActionInput, GitActionResult } from "./git-history-contracts.js";
import type { MergeRequest, MergeFileSave } from "./git-mr/contracts.js";
import { readFile as readMergeFile, writeFile as writeMergeFile, fileId } from "./git-mr/files.js";
import { GitMrStore } from "./git-mr/store.js";

const execFileAsync = promisify(execFile);
const operationQueues = new Map<string, Promise<void>>();

type RepositoryInput = string | WorkspaceLocation;

export type GitWorkspaceSelection =
  | { kind: "default" }
  | { kind: "new-worktree" }
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

export interface GitCommitSummary {
  id: string;
  parents: string[];
  subject: string;
  author: string;
  authoredAt: string;
  refs: string[];
  rebase: boolean;
}

export interface GitWorkspaceSummary {
  repositoryRoot: string;
  defaultPath: string;
  branches: GitBranchSummary[];
  commits: GitCommitSummary[];
  worktrees: GitWorktreeSummary[];
}

/** A ref fingerprint rejects stale pages rather than silently skipping commits. */
export async function gitHistoryPage(
  repository: RepositoryInput,
  input: { offset?: number; limit?: number; snapshot?: string } = {},
): Promise<GitHistoryPage> {
  const context = await assertRepository(repository);
  const run = (args: string[]) => git(context.location, context.root, args);
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new GitWorkspaceError("Invalid history page.");
  const readRefs = async () => (await run(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(*objectname)", "refs/heads", "refs/remotes", "refs/tags"])).stdout;
  const raw = await readRefs();
  let head = "";
  try { head = (await run(["rev-parse", "--verify", "HEAD"])).stdout.trim(); } catch { /* unborn repository */ }
  const snapshot = createHash("sha256").update(raw).update(head).digest("hex");
  if (input.snapshot && input.snapshot !== snapshot)
    throw new GitWorkspaceError("Git history changed. Refresh the history to continue.", 409);
  const refs: GitHistoryRef[] = raw.trim().split("\n").filter(Boolean).map((line) => {
    const [fullName, object, peeled] = line.split("\0");
    const kind = fullName.startsWith("refs/heads/") ? "local" : fullName.startsWith("refs/remotes/") ? "remote" : "tag";
    return { fullName, name: fullName.replace(/^refs\/(heads|remotes|tags)\//, ""), head: peeled || object, kind };
  });
  if (!refs.length && !head) return { commits: [], refs, snapshot, nextOffset: null };
  const output = await run(["log", "--all", ...(head ? ["HEAD"] : []), "--topo-order", `--skip=${offset}`, `--max-count=${limit + 1}`, "--format=%H%x00%P%x00%s%x00%an%x00%aI%x00", "--"]);
  const fields = output.stdout.split("\0");
  const commits: GitCommitSummary[] = [];
  for (let i = 0; i + 4 < fields.length; i += 5) {
    const id = fields[i].trim();
    if (!id) continue;
    commits.push({ id, parents: fields[i + 1].split(" ").filter(Boolean), subject: fields[i + 2], author: fields[i + 3], authoredAt: fields[i + 4], refs: refs.filter((ref) => ref.head === id).map((ref) => ref.fullName), rebase: false });
  }
  // Detect concurrent fetch/commit before returning a mixed snapshot.
  let currentHead = "";
  try { currentHead = (await run(["rev-parse", "--verify", "HEAD"])).stdout.trim(); } catch { /* unborn */ }
  if (raw !== await readRefs() || currentHead !== head)
    throw new GitWorkspaceError("Git history changed. Refresh the history to continue.", 409);
  return { commits: commits.slice(0, limit), refs, snapshot, nextOffset: commits.length > limit ? offset + limit : null };
}

export async function gitCommitDetail(repository: RepositoryInput, id: string): Promise<GitCommitDetail> {
  if (!/^[a-f0-9]{40,64}$/i.test(id)) throw new GitWorkspaceError("A full commit SHA is required.");
  const context = await assertRepository(repository);
  const run = (args: string[]) => git(context.location, context.root, args);
  const metadata = await run(["show", "-s", "--format=%H%x00%P%x00%s%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B", id, "--"]);
  const [sha, parents, subject, author, authorEmail, authoredAt, committer, committerEmail, committedAt, ...message] = metadata.stdout.split("\0");
  const names = await run(["diff-tree", "--root", "--no-commit-id", "-r", "--name-status", "-z", "-M", ...(parents ? [parents.split(" ")[0], id] : [id]), "--"]);
  const tokens = names.stdout.split("\0");
  const files: GitCommitDetail["files"] = [];
  for (let i = 0; tokens[i];) {
    const status = tokens[i++];
    const first = tokens[i++];
    if (status.startsWith("R") || status.startsWith("C")) files.push({ status, previousPath: first, path: tokens[i++] });
    else files.push({ status, path: first });
  }
  const diff = parents
    ? await run(["diff", "--no-ext-diff", "--no-textconv", "-M", parents.split(" ")[0], id, "--"])
    : await run(["show", "--format=", "--no-ext-diff", "--no-textconv", "-M", id, "--"]);
  return { id: sha, parents: parents.split(" ").filter(Boolean), subject, author, authorEmail, authoredAt, committer, committerEmail, committedAt, message: message.join("\0").replace(/\n$/, ""), refs: [], rebase: false, files, diff: diff.stdout };
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

async function historyOperation(context: RepositoryContext): Promise<GitActionResult["operation"]> {
  for (const [marker, operation] of [["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["MERGE_HEAD", "merge"], ["CHERRY_PICK_HEAD", "cherry-pick"]] as const) {
    const markerPath = (await git(context.location, context.root, ["rev-parse", "--git-path", marker])).stdout.trim();
    const absolute = pathApi(context.location).resolve(context.root, markerPath);
    if (await pathExists(context.location, context.root, absolute)) return operation;
  }
  return null;
}

export async function gitHistoryState(repository: RepositoryInput): Promise<GitActionResult> {
  const context = await assertRepository(repository);
  const run = (args: string[]) => git(context.location, context.root, args);
  let head = "";
  try { head = (await run(["rev-parse", "--verify", "HEAD"])).stdout.trim(); } catch { /* unborn */ }
  return { head, branch: (await run(["branch", "--show-current"])).stdout.trim(), operation: await historyOperation(context), conflicts: (await run(["diff", "--name-only", "--diff-filter=U", "-z"])).stdout.split("\0").filter(Boolean), output: "" };
}

/** Reuse the merge file service's stage parsing, path checks and revision guard. */
export async function gitHistoryConflict(repository: RepositoryInput, filename: string, save?: MergeFileSave) {
  const context = await assertRepository(repository);
  return withRepositoryLock(context, async () => {
    const state = await gitHistoryState(repository);
    if (!state.operation || !state.conflicts.includes(filename)) throw new GitWorkspaceError("Active conflict not found.", 404);
    const run = (args: string[]) => git(context.location, context.root, args);
    const source = (await run(["rev-parse", state.operation === "merge" ? "MERGE_HEAD" : state.operation === "rebase" ? "REBASE_HEAD" : "CHERRY_PICK_HEAD"])).stdout.trim().split("\n")[0];
    const id = createHash("sha256").update(JSON.stringify(context)).update(state.head).update(source).update(filename).digest("hex");
    const mr: MergeRequest = { id, projectId: "git-workbench", title: "Working tree conflict", target: state.branch || "HEAD", targetOid: state.head, strategy: "merge_commit", steps: [{ branch: "incoming", oid: source, status: "conflicted" }], status: "conflicted", version: 1, currentStep: 0, worktree: context.root, location: context.location, repository: context.root, commonDir: context.root, autoFinalize: false, allowCheckedOutTarget: true, checks: [], checkResults: [], events: [], createdAt: "", updatedAt: "" };
    const store = new GitMrStore();
    try {
      if (save) {
        const previous = await writeMergeFile(mr, fileId(filename), save);
        if (save.resolve) return { ...previous, conflicted: false, result: save.content ?? (save.choice === "target" ? previous.target : save.choice === "source" ? previous.source : "") };
      }
      const result = await readMergeFile(mr, fileId(filename));
      result.targetLabel = state.operation === "rebase" ? "当前基底 · stage 2" : `${state.branch || "HEAD"} · 本地`;
      result.sourceLabel = state.operation === "rebase" ? "重放提交 · stage 3" : `${source.slice(0, 8)} · 来源`;
      if (save?.resolutionState) await store.write("history-drafts", { id, projectId: "git-workbench", revision: result.revision, resolutionState: save.resolutionState });
      else if (!save) {
        const draft = await store.read<{ revision: string; resolutionState: unknown }>("history-drafts", id).catch(() => null);
        if (draft?.revision === result.revision) result.resolutionState = draft.resolutionState;
      }
      return result;
    } catch (error) {
      if (error instanceof Error && "status" in error) throw new GitWorkspaceError(error.message, Number(error.status));
      throw error;
    }
  });
}

export async function gitHistoryAction(repository: RepositoryInput, input: GitActionInput): Promise<GitActionResult> {
  const context = await assertRepository(repository);
  return withRepositoryLock(context, async () => {
    const run = (args: string[]) => git(context.location, context.root, ["-c", "core.editor=true", "-c", "sequence.editor=true", ...args]);
    const head = (await run(["rev-parse", "HEAD"])).stdout.trim();
    if (head !== input.expectedHead) throw new GitWorkspaceError("HEAD changed. Refresh before performing this operation.", 409);
    const operation = await historyOperation(context);
    let args: string[];
    if (input.action === "continue" || input.action === "abort") {
      if (!operation) throw new GitWorkspaceError("No Git operation is in progress.", 409);
      if (input.action === "abort" && !input.confirmed) throw new GitWorkspaceError("Confirm aborting this operation.");
      args = [operation, `--${input.action}`];
    } else if (input.action === "fetch") {
      args = ["fetch", "--all", "--prune"];
    } else {
      await assertCheckoutSafe(context);
      if (!input.confirmed) throw new GitWorkspaceError("Confirm the target and working tree before changing Git state.");
      if (!input.target || (!/^[a-f0-9]{40,64}$/i.test(input.target) && !/^refs\/(heads|remotes|tags)\//.test(input.target)))
        throw new GitWorkspaceError("Select a full commit SHA or fully qualified ref.");
      const target = (await run(["rev-parse", "--verify", "--end-of-options", `${input.target}^{commit}`])).stdout.trim();
      if (input.action === "reset") {
        if (!["soft", "mixed", "hard"].includes(input.resetMode ?? "")) throw new GitWorkspaceError("Select a reset mode.");
        args = ["reset", `--${input.resetMode}`, target];
      } else if (input.action === "track") {
        if (!input.target.startsWith("refs/remotes/") || !input.branch) throw new GitWorkspaceError("Select a remote branch and a local branch name.");
        await assertBranchName(context, input.branch);
        if (await branchExists(context, input.branch)) throw new GitWorkspaceError("Local branch already exists.", 409);
        args = ["switch", "-c", input.branch, "--track", input.target];
      } else if (input.action === "merge") args = ["merge", "--no-edit", target];
      else if (input.action === "rebase") args = ["rebase", target];
      else if (input.action === "cherry-pick") args = ["cherry-pick", target];
      else throw new GitWorkspaceError("Unknown Git action.");
    }
    let output = "";
    try { const result = await run(args); output = result.stdout + result.stderr; }
    catch (error) {
      if (!await historyOperation(context)) throw error;
      output = error instanceof Error ? error.message : String(error);
    }
    return {
      head: (await run(["rev-parse", "HEAD"])).stdout.trim(),
      branch: (await run(["branch", "--show-current"])).stdout.trim(),
      operation: await historyOperation(context),
      conflicts: (await run(["diff", "--name-only", "--diff-filter=U", "-z"])).stdout.split("\0").filter(Boolean),
      output,
    };
  });
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
  const commitLog = await git(context.location, context.root, [
    "log",
    "--branches",
    "--full-history",
    "--topo-order",
    "-n",
    "180",
    "--date=iso-strict",
    "--format=%H%x00%P%x00%s%x00%an%x00%aI%x1e",
  ]);
  let rebaseIds = new Set<string>();
  try {
    const reflog = await git(context.location, context.root, [
      "reflog",
      "--all",
      "--date=iso-strict",
      "--format=%H%x00%gs%x1e",
      "-n",
      "300",
    ]);
    rebaseIds = new Set(
      reflog.stdout
        .split("\x1e")
        .map((record) => record.trim())
        .filter(Boolean)
        .filter((record) => /\brebase\b/i.test(record))
        .map((record) => record.split("\0", 1)[0]),
    );
  } catch {
    // Reflogs may be disabled; the commit graph remains authoritative.
  }
  const commits = commitLog.stdout
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [id, parents = "", subject, author, authoredAt] = record.split("\0");
      return {
        id,
        parents: parents ? parents.split(" ") : [],
        subject,
        author,
        authoredAt,
        refs: branches.filter((branch) => branch.head === id).map((branch) => branch.name),
        rebase: rebaseIds.has(id),
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
    commits,
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

/** A new session gets its own clean worktree at the source checkout's HEAD. */
export async function createDetachedGitWorktree(
  repositoryPath: RepositoryInput,
  projectId: string,
): Promise<GitWorktreeSummary> {
  const context = await assertRepository(repositoryPath);
  return withRepositoryLock(context, async () => {
    const destination = await managedWorktreePath(
      context.location,
      projectId,
      `session-${randomUUID()}`,
    );
    await ensureParent(context.location, destination);
    await git(context.location, context.root, [
      "worktree", "add", "--detach", destination, "HEAD",
    ]);
    const canonicalDestination = await canonical(context.location, destination);
    const summary = await listGitWorkspaces(context.location, projectId);
    const created = summary.worktrees.find((item) =>
      samePath(context.location, item.path, canonicalDestination),
    );
    if (!created)
      throw new GitWorkspaceError(
        "Git created the worktree but it could not be listed.", 500,
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
  if (selection.kind === "new-worktree") {
    const created = await createDetachedGitWorktree(context.location, projectId);
    return {
      workDir: created.path,
      branch: null,
      kind: "new-worktree",
      location: { ...context.location, path: created.path },
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

/** Count porcelain records, not lines: filenames may contain newlines or tabs. */
export async function countGitCheckoutChanges(
  repositoryPath: RepositoryInput,
): Promise<number> {
  const context = await assertRepository(repositoryPath);
  const { stdout } = await git(context.location, context.root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const records = stdout.split("\0").filter(Boolean);
  let count = 0;
  for (let index = 0; index < records.length; index++) {
    const status = records[index].slice(0, 2);
    if (status.includes("R") || status.includes("C")) index++; // original path
    count++;
  }
  return count;
}

async function assertCheckoutSafe(context: RepositoryContext): Promise<void> {
  if (await countGitCheckoutChanges(context.location))
    throw new GitWorkspaceError(
      "Commit or stash uncommitted changes before switching branches.",
      409,
    );
  await assertNoGitOperation(context);
}

async function assertNoGitOperation(context: RepositoryContext): Promise<void> {
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
      await git(context.location, context.root, ["rev-parse", "--git-path", marker])
    ).stdout.trim();
    if (await pathExists(context.location, context.root, location))
      throw new GitWorkspaceError(
        "A Git operation is in progress. Finish it before switching branches.",
        409,
      );
  }
}

/** Create a branch at this checkout's current HEAD without guessing a base branch. */
export async function createAndSwitchGitBranch(
  repositoryPath: RepositoryInput,
  branch: string,
  assertIdle: (root: string) => void = () => {},
): Promise<string> {
  const context = await assertRepository(repositoryPath);
  return withRepositoryLock(context, async () => {
    await assertBranchName(context, branch);
    if (await branchExists(context, branch))
      throw new GitWorkspaceError(`Branch "${branch}" already exists.`, 409);
    await assertCheckoutSafe(context);
    assertIdle(context.root);
    await git(context.location, context.root, ["switch", "-c", branch]);
    return (
      await git(context.location, context.root, ["branch", "--show-current"])
    ).stdout.trim();
  });
}

/** Give a detached session worktree a name at its own HEAD; preserve all edits. */
export async function attachDetachedGitBranch(
  repositoryPath: RepositoryInput,
  branch: string,
): Promise<string> {
  const context = await assertRepository(repositoryPath);
  return withRepositoryLock(context, async () => {
    await assertBranchName(context, branch);
    const current = (
      await git(context.location, context.root, ["branch", "--show-current"])
    ).stdout.trim();
    if (current)
      throw new GitWorkspaceError("This worktree already has a branch.", 409);
    if (await branchExists(context, branch))
      throw new GitWorkspaceError(`Branch "${branch}" already exists.`, 409);
    await assertNoGitOperation(context);
    await git(context.location, context.root, ["switch", "-c", branch]);
    return branch;
  });
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
    await assertCheckoutSafe(context);
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
