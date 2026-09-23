import path from "node:path";
import fs from "node:fs/promises";
import { runCommand } from "../agent-runtime/tools/exec-async.js";
import {
  workspaceLocationHostPath,
  type WorkspaceLocation,
} from "../workspace-location.js";
import { GitMrError } from "./errors.js";
import type { MergeRequest } from "./contracts.js";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export type Repo = Pick<MergeRequest, "repository" | "location">;
export function hostPath(repo: Repo, location: string): string {
  return repo.location?.kind === "wsl"
    ? workspaceLocationHostPath({ ...repo.location, path: location })
    : location;
}
export function repoPath(repo: Repo) {
  return repo.location?.kind === "wsl" ? path.posix : path;
}
export function cleanEnvironment(): NodeJS.ProcessEnv {
  const keys = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "SSH_AUTH_SOCK",
  ];
  return Object.fromEntries(
    keys.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  );
}
export async function command(
  repo: Repo,
  cwd: string,
  executable: string,
  args: string[],
  options: { timeoutMs?: number; stdin?: string; signal?: AbortSignal } = {},
) {
  // UNC cwd selects the owned WSL execution path, including Linux PID tracking and cancellation.
  const result = await runCommand(executable, args, {
    cwd: hostPath(repo, cwd),
    timeoutMs: options.timeoutMs ?? 120_000,
    stdin: options.stdin,
    signal: options.signal,
    maxBufferBytes: 8 * 1024 * 1024,
    inheritEnv: false,
    env: {
      ...cleanEnvironment(),
      GIT_TERMINAL_PROMPT: "0",
      GIT_MERGE_AUTOEDIT: "no",
      GIT_LITERAL_PATHSPECS: "1",
    },
  });
  if (
    result.timedOut ||
    result.error ||
    result.stdoutTruncated ||
    result.stderrTruncated
  )
    throw new GitMrError(
      result.error?.message ??
        (result.timedOut
          ? "Command timed out."
          : "Git output exceeds the supported limit."),
      "COMMAND_FAILED",
      400,
    );
  return result;
}
export async function git(
  repo: Repo,
  args: string[],
  options: {
    cwd?: string;
    allowFailure?: boolean;
    stdin?: string;
    signal?: AbortSignal;
  } = {},
) {
  const result = await command(
    repo,
    options.cwd ?? repo.repository,
    "git",
    args,
    options,
  );
  if (result.status !== 0 && !options.allowFailure)
    throw new GitMrError(
      result.stderr.trim() || result.stdout.trim() || "Git command failed.",
      "GIT_COMMAND_FAILED",
      400,
    );
  return result;
}
export async function oid(repo: Repo, ref: string) {
  return (
    await git(repo, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ])
  ).stdout.trim();
}
export async function inspect(location: WorkspaceLocation) {
  const repo: Repo = { repository: location.path, location };
  repo.repository = (
    await git(repo, ["rev-parse", "--show-toplevel"])
  ).stdout.trim();
  const common = (
    await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  ).stdout.trim();
  const canonical = await fs.realpath(hostPath(repo, common));
  return { ...repo, commonDir: canonical };
}
export async function branchOid(repo: Repo, name: string) {
  if (
    !name ||
    name.startsWith("-") ||
    name.startsWith("refs/") ||
    /[\x00-\x20]/.test(name)
  )
    throw new GitMrError(
      "Select a valid local branch name.",
      "INVALID_BRANCH",
      400,
    );
  await git(repo, ["check-ref-format", `refs/heads/${name}`]);
  return oid(repo, `refs/heads/${name}`);
}
export function assertBranchPolicy(target: string, sources: string[]) {
  if (sources.includes(target) || new Set(sources).size !== sources.length)
    throw new GitMrError(
      "Source branches must be distinct and different from the target.",
      "INVALID_BRANCHES",
      400,
    );
  if (
    /^(?:feature(?:\/|$)|codex\/)/.test(target) &&
    sources.some((source) => /^(test|beta)(\/|$)/.test(source))
  )
    throw new GitMrError(
      "test/beta must never be merged into a feature branch.",
      "BRANCH_POLICY",
      400,
    );
}
export async function worktrees(repo: Repo) {
  const output = (await git(repo, ["worktree", "list", "--porcelain", "-z"]))
    .stdout;
  const records: { path: string; branch?: string; head?: string }[] = [];
  let current: { path: string; branch?: string; head?: string } | undefined;
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) {
      current = { path: field.slice(9) };
      records.push(current);
    } else if (current && field.startsWith("branch "))
      current.branch = field.slice(7);
    else if (current && field.startsWith("HEAD "))
      current.head = field.slice(5);
  }
  return records;
}
export async function ensureClean(repo: Repo, cwd: string) {
  const status = await git(
    repo,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd },
  );
  if (status.stdout)
    throw new GitMrError(
      "The worktree has uncommitted or untracked changes.",
      "DIRTY_WORKTREE",
    );
  for (const item of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
  ]) {
    const located = (
      await git(repo, ["rev-parse", "--git-path", item], { cwd })
    ).stdout.trim();
    const absolute = repoPath(repo).isAbsolute(located)
      ? located
      : repoPath(repo).resolve(cwd, located);
    if (
      await fs.lstat(hostPath(repo, absolute)).then(
        () => true,
        () => false,
      )
    )
      throw new GitMrError(
        "Another Git operation is in progress.",
        "GIT_OPERATION_BUSY",
      );
  }
}
export async function safeWorktreeFile(
  repo: Repo,
  cwd: string,
  file: string,
): Promise<string> {
  if (
    !file ||
    file.includes("\0") ||
    file
      .split(/[\\/]/)
      .some((part) => part === ".." || part.toLowerCase() === ".git") ||
    path.isAbsolute(file) ||
    /^[a-z]:/i.test(file)
  )
    throw new GitMrError("Invalid file path.", "INVALID_PATH", 400);
  const root = await fs.realpath(hostPath(repo, cwd));
  const candidate = path.resolve(root, file);
  if (!candidate.startsWith(root + path.sep))
    throw new GitMrError("Path escapes worktree.", "INVALID_PATH", 400);
  let cursor = path.dirname(candidate);
  while (cursor !== root) {
    const stat = await fs
      .lstat(cursor)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    if (stat?.isSymbolicLink())
      throw new GitMrError("Symlink parent cannot be edited.", "UNSAFE_PATH");
    cursor = path.dirname(cursor);
  }
  return candidate;
}
