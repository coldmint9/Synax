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

/** The collector never mutates the index or worktree. */
export async function collectCommitMessageContext(
  sessionId: string,
  rootId?: string,
): Promise<CommitMessageContext> {
  let session: ReturnType<typeof agentRuntimeStore.getSession>;
  try {
    session = agentRuntimeStore.getSession(sessionId);
  } catch {
    throw new AgentNotFoundError(sessionId);
  }
  if (session.activeRunId)
    throw new AgentRuntimeError(
      "The session is still running. Wait for it to finish before generating.",
      "GIT_SESSION_BUSY",
      409,
    );
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
  const branch = (
    await readGit(root.path, ["branch", "--show-current"])
  ).trim();
  if (!branch)
    throw new AgentValidationError(
      "Cannot generate: the workspace is in a detached HEAD state.",
    );
  const status = (
    await readGit(root.path, ["status", "--porcelain=v1", "-uall"])
  ).trim();
  if (!status)
    throw new AgentRuntimeError(
      "There is nothing to commit.",
      "GIT_NOTHING_TO_COMMIT",
      409,
    );
  const [stagedSummary, unstagedSummary, stagedPatch, unstagedPatch] =
    await Promise.all([
      readGit(root.path, ["diff", "--cached", "--stat"]),
      readGit(root.path, ["diff", "--stat"]),
      readGit(root.path, ["diff", "--cached", "--no-ext-diff"]),
      readGit(root.path, ["diff", "--no-ext-diff"]),
    ]);
  let history = "";
  try {
    history = await readGit(root.path, ["log", "-20", "--format=%s"]);
  } catch (error) {
    // An unborn branch has no HEAD; every other log error must remain visible.
    if (await readGit(root.path, ["rev-parse", "--verify", "HEAD"], true))
      throw error;
  }
  return {
    projectId: session.projectId,
    branch,
    changedFiles: status.slice(0, MAX_STATUS_CHARS),
    stagedSummary: stagedSummary.slice(0, 2_000),
    unstagedSummary: unstagedSummary.slice(0, 2_000),
    diffExcerpt: `${stagedPatch}\n${unstagedPatch}`.slice(0, MAX_DIFF_CHARS),
    subjects: history
      .split(/\r?\n/)
      .map((line) => line.trim().slice(0, MAX_HISTORY_SUBJECT_CHARS))
      .filter(Boolean)
      .slice(0, 20),
  };
}
