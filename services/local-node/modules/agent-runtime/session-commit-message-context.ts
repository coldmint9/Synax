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
const MAX_DIFF_CHARS = 8_000;
const MAX_STATUS_CHARS = 6_000;
const MAX_HISTORY_SUBJECT_CHARS = 160;

export interface CommitMessageContext {
  projectId: string;
  branch: string;
  changedFiles: string;
  stagedSummary: string;
  unstagedSummary: string;
  diffExcerpt: string;
  subjects: string[];
}

async function readGit(
  cwd: string,
  args: string[],
  allowFailure = false,
): Promise<string> {
  const result = await runCommand("git", args, {
    cwd,
    maxBufferBytes: MAX_BUFFER,
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

async function readUntrackedDiff(cwd: string, files: string[]): Promise<string> {
  const patches = await Promise.all(
    files.map(async (file) => {
      const result = await runCommand(
        "git",
        ["diff", "--no-index", "--no-ext-diff", "--", "/dev/null", file],
        {
          cwd,
          maxBufferBytes: MAX_BUFFER,
          timeoutMs: 30_000,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_OPTIONAL_LOCKS: "0",
          },
        },
      );
      // git diff --no-index returns 1 when the files differ, which is
      // expected for an untracked file.
      if (
        result.error ||
        result.timedOut ||
        (result.status !== 0 && result.status !== 1)
      ) {
        throw new AgentRuntimeError(
          `git diff failed: ${(result.stderr || result.error?.message || "Command timed out.").trim().slice(0, 400)}`,
          "GIT_COMMAND_FAILED",
          502,
        );
      }
      return result.stdout;
    }),
  );
  return patches.join("\n");
}

function statusPath(line: string): string {
  if (line.startsWith("?? ")) return line.slice(3);
  const value = line.slice(3);
  const renamed = value.split(" -> ");
  return renamed[renamed.length - 1] ?? value;
}

function isCommitEligiblePath(file: string): boolean {
  return file.split(/[\\/]/).at(-1) !== ".DS_Store";
}

async function readDiffExcerpt(
  cwd: string,
  files: string[],
  includeUntracked: boolean,
  untrackedFiles: ReadonlySet<string>,
): Promise<string> {
  const eligibleFiles = files.filter(isCommitEligiblePath);
  if (!eligibleFiles.length) return "(none)";
  const trackedFiles = eligibleFiles.filter((file) => !untrackedFiles.has(file));
  const untracked = eligibleFiles.filter((file) => untrackedFiles.has(file));
  const [trackedPatch, untrackedPatch] = await Promise.all([
    trackedFiles.length
      ? readGit(cwd, ["diff", "HEAD", "--no-ext-diff", "--no-textconv", "--", ...trackedFiles], true)
      : Promise.resolve(""),
    includeUntracked && untracked.length
      ? readUntrackedDiff(cwd, untracked)
      : Promise.resolve(""),
  ]);
  const fileList = eligibleFiles.map((file) => `File: ${file}`).join("\n");
  const content = [
    "Pending files:",
    fileList,
    "",
    trackedPatch.trim(),
    untrackedPatch.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
  return content.slice(0, MAX_DIFF_CHARS);
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
  const status = (
    await readGit(root.path, ["status", "--porcelain=v1", "-uall"])
  ).trim();
  if (!status)
    throw new AgentRuntimeError(
      "There is nothing to commit.",
      "GIT_NOTHING_TO_COMMIT",
      409,
    );
  const changedFileLines = status
    .split(/\r?\n/)
    .filter(
      (line) =>
        line &&
        isCommitEligiblePath(statusPath(line)) &&
        (includeUntracked || !line.startsWith("?? ")),
    );
  const changedPaths = changedFileLines.map(statusPath);
  const untrackedFiles = new Set(
    changedFileLines
      .filter((line) => line.startsWith("?? "))
      .map(statusPath),
  );
  const [stagedSummary, unstagedSummary, diffExcerpt] =
    await Promise.all([
      readGit(root.path, ["diff", "--cached", "--stat"]),
      readGit(root.path, ["diff", "--stat"]),
      readDiffExcerpt(root.path, changedPaths, includeUntracked, untrackedFiles),
    ]);
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
    changedFiles: changedFileLines.join("\n").slice(0, MAX_STATUS_CHARS),
    stagedSummary: stagedSummary.slice(0, 2_000),
    unstagedSummary: unstagedSummary.slice(0, 2_000),
    diffExcerpt,
    subjects: history
      .split(/\r?\n/)
      .map((line) => line.trim().slice(0, MAX_HISTORY_SUBJECT_CHARS))
      .filter(Boolean)
      .slice(0, 20),
  };
}
