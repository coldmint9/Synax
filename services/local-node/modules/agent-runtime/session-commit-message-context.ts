import fs from "node:fs";
import path from "node:path";
import {
  canonicalWorkspaceDirectory,
  workspaceRootLocation,
} from "../project-workspace.js";
import { resolveSessionRepository } from "./session-environment.js";
import { agentRuntimeStore } from "./session-store.js";
import { runCommand } from "./tools/exec-async.js";
import {
  AgentNotFoundError,
  AgentRuntimeError,
  AgentValidationError,
} from "./runtime-errors.js";

const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_HISTORY_SUBJECT_CHARS = 160;
/** One file never needs its whole patch for a changelog line. */
const MAX_FILE_PATCH_CHARS = 1_200;
/** Paths per `git diff` call, so one call never buffers a whole commit. */
const PATCH_CHUNK_FILES = 48;
const MAX_PATCH_BUFFER = 4 * 1024 * 1024;
const MAX_UNTRACKED_BYTES = 64 * 1024;

/** One changed path with the facts a changelog entry can be built from. */
export interface CommitMessageFile {
  path: string;
  /** Porcelain status prefix: `M`, `A`, `D`, `R`, `??`, … */
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Bounded diff for this path; empty for a binary or unreadable file. */
  patch: string;
}

export interface CommitMessageContext {
  projectId: string;
  branch: string;
  stagedSummary: string;
  unstagedSummary: string;
  subjects: string[];
  /** Every changed path, so no changelog line can be silently dropped. */
  files: CommitMessageFile[];
  totals: { files: number; additions: number; deletions: number };
}

interface StatusEntry {
  status: string;
  path: string;
  previousPath?: string;
}

async function readGit(
  cwd: string,
  args: string[],
  allowFailure = false,
  maxBufferBytes = MAX_BUFFER,
): Promise<string> {
  const result = await runCommand("git", args, {
    cwd,
    maxBufferBytes,
    timeoutMs: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.status !== 0 || result.error || result.timedOut) {
    if (allowFailure) return "";
    throw new AgentRuntimeError(
      `git ${args[0]} failed: ${(result.stderr || result.error?.message || "Command timed out.").trim().slice(0, 400)}`,
      "GIT_COMMAND_FAILED",
      502,
    );
  }
  return result.stdout;
}

/** NUL-delimited output keeps spaces, quotes and unicode paths verbatim. */
function nulFields(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function parseStatus(output: string): StatusEntry[] {
  const fields = nulFields(output);
  const entries: StatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const status = field.slice(0, 2);
    const filePath = field.slice(3);
    if (!filePath) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      // `XY new\0old\0`: the visible path is the destination.
      entries.push({ status, path: filePath, previousPath: fields[index + 1] });
      index += 1;
      continue;
    }
    entries.push({ status, path: filePath });
  }
  return entries;
}

interface DiffStat {
  additions: number;
  deletions: number;
  binary: boolean;
}

function parseNumstat(output: string): Map<string, DiffStat> {
  const fields = nulFields(output);
  const stats = new Map<string, DiffStat>();
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(field);
    if (!match) continue;
    let filePath = match[3];
    if (!filePath) {
      // `A\tD\t\0old\0new\0` — a rename reports both sides.
      index += 1;
      filePath = fields[index + 1] ?? "";
      index += 1;
    }
    if (!filePath) continue;
    stats.set(filePath, {
      additions: match[1] === "-" ? 0 : Number(match[1]),
      deletions: match[2] === "-" ? 0 : Number(match[2]),
      binary: match[1] === "-" || match[2] === "-",
    });
  }
  return stats;
}

/** Find which of the requested paths a `diff --git` block belongs to. */
function blockPath(block: string, known: ReadonlySet<string>): string | null {
  for (const candidate of known) {
    if (
      block.startsWith(`diff --git a/${candidate} b/${candidate}`) ||
      block.includes(`\nrename to ${candidate}\n`) ||
      block.includes(`\ncopy to ${candidate}\n`)
    )
      return candidate;
  }
  const added = /^\+\+\+ b\/(.+)$/m.exec(block)?.[1];
  if (added && known.has(added)) return added;
  const removed = /^--- a\/(.+)$/m.exec(block)?.[1];
  if (removed && known.has(removed)) return removed;
  return null;
}

function splitDiffBlocks(output: string): string[] {
  if (!output.trim()) return [];
  return output
    .split(/(?=^diff --git )/m)
    .map((block) => block.trim())
    .filter(Boolean);
}

async function readTrackedPatches(
  cwd: string,
  paths: string[],
): Promise<Map<string, string>> {
  const patches = new Map<string, string>();
  for (let start = 0; start < paths.length; start += PATCH_CHUNK_FILES) {
    const chunk = paths.slice(start, start + PATCH_CHUNK_FILES);
    const known = new Set(chunk);
    const output = await readGit(
      cwd,
      [
        "-c",
        "core.quotePath=false",
        "diff",
        "HEAD",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--unified=1",
        "--",
        ...chunk,
      ],
      // An unborn branch has no HEAD to diff against; the inventory remains.
      true,
      MAX_PATCH_BUFFER,
    );
    for (const block of splitDiffBlocks(output)) {
      const filePath = blockPath(block, known);
      if (!filePath) continue;
      if (/^Binary files .* differ$/m.test(block) || /^GIT binary patch$/m.test(block))
        continue;
      const patch = block.slice(0, MAX_FILE_PATCH_CHARS);
      if (!patch || patches.has(filePath)) continue;
      patches.set(filePath, patch);
    }
  }
  return patches;
}

function readUntrackedPatches(
  cwd: string,
  paths: string[],
): Map<string, string> {
  const patches = new Map<string, string>();
  for (const file of paths) {
    const absolute = path.join(cwd, file);
    let bytes: Buffer;
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) continue;
      const fd = fs.openSync(absolute, "r");
      try {
        const length = Math.min(stat.size, MAX_UNTRACKED_BYTES);
        bytes = Buffer.alloc(length);
        fs.readSync(fd, bytes, 0, length, 0);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    if (bytes.includes(0)) continue;
    const header = [
      `diff --git a/${file} b/${file}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${file}`,
    ].join("\n");
    const body = `${header}\n${bytes
      .toString("utf8")
      .split(/\r?\n/)
      .map((line) => `+${line}`)
      .join("\n")}`;
    patches.set(file, body.slice(0, MAX_FILE_PATCH_CHARS));
  }
  return patches;
}

function isCommitEligiblePath(file: string): boolean {
  return file.split(/[\\/]/).at(-1) !== ".DS_Store";
}

/** The collector never mutates the index or worktree. */
export async function collectCommitMessageContext(
  sessionId: string,
  rootId?: string,
  includeUntracked = true,
  targetBranch?: string,
): Promise<CommitMessageContext> {
  let session: ReturnType<typeof agentRuntimeStore.getSession>;
  try {
    session = agentRuntimeStore.getSession(sessionId);
  } catch {
    throw new AgentNotFoundError(sessionId);
  }
  const root = resolveSessionRepository(
    sessionId,
    session.projectId,
    rootId,
    true,
  );
  const location = workspaceRootLocation(root);
  const topLevel = (
    await readGit(root.path, ["rev-parse", "--show-toplevel"])
  ).trim();
  const matches =
    location.kind === "wsl"
      ? path.posix.normalize(topLevel) === path.posix.normalize(location.path)
      : Boolean(topLevel) &&
        canonicalWorkspaceDirectory(topLevel) === root.path;
  if (!matches)
    throw new AgentValidationError(
      "The selected project must be a Git repository root.",
    );
  const currentBranch = (
    await readGit(root.path, ["branch", "--show-current"])
  ).trim();
  if (!currentBranch)
    throw new AgentValidationError(
      "Cannot generate: the workspace is in a detached HEAD state.",
    );
  const branch = targetBranch?.trim() || currentBranch;
  if (targetBranch && targetBranch !== branch)
    throw new AgentValidationError("The target branch name cannot contain surrounding spaces.");
  if (targetBranch && targetBranch !== currentBranch) {
    const target = await readGit(
      root.path,
      ["rev-parse", "--verify", `refs/heads/${targetBranch}`],
      true,
    );
    if (!target.trim())
      throw new AgentValidationError("The selected target branch does not exist locally.");
  }
  const statusEntries = parseStatus(
    await readGit(root.path, ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "-uall"]),
  ).filter(
    (entry) =>
      isCommitEligiblePath(entry.path) &&
      (includeUntracked || !entry.status.startsWith("??")),
  );
  if (!statusEntries.length)
    throw new AgentRuntimeError(
      "There is nothing to commit.",
      "GIT_NOTHING_TO_COMMIT",
      409,
    );

  const untracked = new Set(
    statusEntries
      .filter((entry) => entry.status.startsWith("??"))
      .map((entry) => entry.path),
  );
  const trackedPaths = statusEntries
    .filter((entry) => !untracked.has(entry.path))
    .map((entry) => entry.path);
  const [stagedSummary, unstagedSummary, numstat] = await Promise.all([
    readGit(root.path, ["diff", "--cached", "--stat"]),
    readGit(root.path, ["diff", "--stat"]),
    trackedPaths.length
      ? readGit(
          root.path,
          [
            "-c",
            "core.quotePath=false",
            "diff",
            "HEAD",
            "--numstat",
            "-z",
            "--",
            ...trackedPaths,
          ],
          true,
        ).then(parseNumstat)
      : Promise.resolve(new Map<string, DiffStat>()),
  ]);

  // Every path carries a bounded diff: the caller splits paths into batches, so
  // no single prompt has to hold the whole commit.
  const [trackedPatches, untrackedPatches] = await Promise.all([
    readTrackedPatches(root.path, trackedPaths),
    Promise.resolve(readUntrackedPatches(root.path, [...untracked])),
  ]);

  const files: CommitMessageFile[] = statusEntries.map((entry) => {
    const stat = numstat.get(entry.path);
    const patch = trackedPatches.get(entry.path) ?? untrackedPatches.get(entry.path) ?? "";
    const untrackedAdditions =
      entry.status.startsWith("??") && patch
        ? patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length
        : 0;
    return {
      path: entry.path,
      status: entry.status.trim() || "M",
      additions: stat?.additions ?? untrackedAdditions,
      deletions: stat?.deletions ?? 0,
      binary: stat?.binary === true,
      patch: stat?.binary ? "" : patch,
    };
  });

  let history = "";
  try {
    history = await readGit(
      root.path,
      [
        "log",
        "-20",
        "--format=%s",
        ...(targetBranch ? [`refs/heads/${branch}`] : []),
      ],
    );
  } catch (error) {
    // An unborn branch has no HEAD; every other log error must remain visible.
    if (await readGit(root.path, ["rev-parse", "--verify", "HEAD"], true))
      throw error;
  }
  return {
    projectId: session.projectId,
    branch,
    stagedSummary: stagedSummary.slice(0, 2_000),
    unstagedSummary: unstagedSummary.slice(0, 2_000),
    subjects: history
      .split(/\r?\n/)
      .map((line) => line.trim().slice(0, MAX_HISTORY_SUBJECT_CHARS))
      .filter(Boolean)
      .slice(0, 20),
    files,
    totals: {
      files: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    },
  };
}
