import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnOwnedProcess } from '../agent-runtime/owned-process.js';
import { spawn } from 'node:child_process';
import { withDeadline } from '../agent-runtime/managed-process.js';
import { stopWslOwnedProcess } from '../../infrastructure/wsl/wsl.js';
import { runCommand } from "../agent-runtime/tools/exec-async.js";
import {
  workspaceLocationHostPath,
  type WorkspaceLocation,
} from "../workspace-location.js";
import { GitMrError } from "./errors.js";
import type { MergeRequest } from "./contracts.js";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_VIEW_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_FILE_PREVIEW_BYTES = 64 * 1024;
export const MAX_BLOB_BYTES = 128 * 1024 * 1024;
export const MAX_FILE_SLICE_BYTES = 256 * 1024;
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

/** Spool one immutable blob with stream backpressure; never buffer its full body. */
export async function spoolGitBlob(repo: Repo, oid: string, filename: string, expectedBytes: number, signal?: AbortSignal) {
  if (!/^[a-f0-9]{40,64}$/.test(oid) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > MAX_BLOB_BYTES)
    throw new GitMrError('Blob exceeds the bounded content reader.', 'FILE_TOO_LARGE');
  signal?.throwIfAborted();
  const child = spawnOwnedProcess('git', ['cat-file', 'blob', oid], {
    cwd: hostPath(repo, repo.repository), inheritEnv: false, stdin: 'ignore',
    env: { ...cleanEnvironment(), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  let stderr = '', stopped = false, bytes = 0, binary = false;
  const decoder = new TextDecoder('utf-8', { fatal: true }), hash = createHash('sha256');
  const stop = () => {
    if (stopped) return; stopped = true;
    if (repo.location?.kind === 'wsl') void stopWslOwnedProcess(repo.location.distribution, child.ownedProcessId).finally(() => { try { child.kill('SIGKILL'); } catch {} });
    else if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', () => { try { child.kill('SIGKILL'); } catch {} });
    } else { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} }
  };
  const onStderr = (chunk: Buffer) => { if (stderr.length < 8_192) stderr += chunk.toString('utf8').slice(0, 8_192 - stderr.length); };
  child.stderr?.on('data', onStderr);
  const completed = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  void completed.catch(() => {});
  const timer = setTimeout(stop, 120_000); timer.unref();
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  try {
    const inspect = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > expectedBytes || bytes > MAX_BLOB_BYTES) { callback(new GitMrError('Blob grew beyond its declared limit.', 'CONTENT_CHANGED')); return; }
      hash.update(chunk);
      if (chunk.includes(0)) binary = true;
      if (!binary) { try { decoder.decode(chunk, { stream: true }); } catch { binary = true; } }
      callback(null, chunk);
    } });
    await pipeline(child.stdout!, inspect, createWriteStream(filename, { flags: 'wx', mode: 0o600, highWaterMark: 64 * 1024 }));
    const code = await completed;
    await child.ownedProcessClosed;
    signal?.throwIfAborted();
    if (code !== 0 || bytes !== expectedBytes) throw new GitMrError(stderr || 'Git blob read did not complete.', 'COMMAND_FAILED');
    if (!binary) { try { decoder.decode(); } catch { binary = true; } }
    return { bytes, binary, digest: hash.digest('hex') };
  } catch (error) {
    stop();
    await withDeadline(Promise.allSettled([completed, child.ownedProcessClosed]), 10_000, 'Blob reader process cleanup could not be confirmed.');
    await fs.unlink(filename).catch(() => undefined); throw error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', stop); child.stderr?.off('data', onStderr);
  }
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
