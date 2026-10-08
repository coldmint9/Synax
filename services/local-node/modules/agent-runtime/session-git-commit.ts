import path from "node:path";
import { attachDetachedGitBranch, GitWorkspaceError } from "../git-workspaces.js";
import { logger } from "../../infrastructure/runtime/logger.js";
import {
  invalidateSessionEnvironment,
  resolveSessionRepository,
} from "./session-environment.js";
import { agentRuntimeStore } from "./session-store.js";
import {
  canonicalWorkspaceDirectory,
  workspaceRootLocation,
} from "../project-workspace.js";
import { runCommand } from "./tools/exec-async.js";
import {
  AgentNotFoundError,
  AgentRuntimeError,
  AgentValidationError,
} from "./runtime-errors.js";

const MAX_BUFFER = 8 * 1024 * 1024;
const COMMIT_TIMEOUT_MS = 120_000;
const MAX_COMMIT_SUBJECT_LEN = 200;
const MAX_COMMIT_MESSAGE_LEN = 2_000;
const FENCE_RE = /^\s*(?:```|~~~)/;

export interface SessionGitCommitInput {
  rootId?: string;
  /** Name a branch at a detached session worktree's HEAD before committing. */
  branchName?: string;
  /** Explicit, reviewed commit message; empty messages are rejected. */
  message?: string | null;
  /** Defaults to `true`. `false` commits locally without touching the remote. */
  push?: boolean | null;
  /**
   * Defaults to `true` (`git add -A`). `false` stages tracked changes only
   * (`git add -u`) so untracked files stay out of the commit.
   */
  includeUntracked?: boolean | null;
}

export interface SessionGitCommitResult {
  rootId: string;
  branch: string;
  commitSha: string;
  message: string;
  messageGenerated: boolean;
  /** `null` when the caller asked for a commit only, so no push was attempted. */
  pushed: boolean | null;
  /** Upstream branch the commit was pushed to; `null` for a commit-only run. */
  upstream: string | null;
  committedFiles: number;
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function formatGitFailure(result: GitResult): string {
  const detail = (result.stderr || result.stdout)
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-3)
    .join(" ");
  return detail;
}

export async function runGit(
  workspacePath: string,
  args: string[],
  allowFailure = false,
): Promise<GitResult> {
  const command = await runCommand("git", args, {
    cwd: workspacePath,
    maxBufferBytes: MAX_BUFFER,
    timeoutMs: COMMIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const result: GitResult = {
    ok: command.status === 0 && !command.error && !command.timedOut,
    stdout: command.stdout,
    stderr:
      command.stderr ||
      command.error?.message ||
      (command.timedOut ? "Command timed out." : ""),
  };
  if (!result.ok) {
    if (allowFailure) return result;
    const detail = formatGitFailure(result);
    throw new AgentRuntimeError(
      `git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
      "GIT_COMMAND_FAILED",
      502,
    );
  }
  return result;
}

function getSession(sessionId: string) {
  try {
    return agentRuntimeStore.getSession(sessionId);
  } catch {
    throw new AgentNotFoundError(sessionId);
  }
}

/**
 * Keep the generated text usable as a `git commit -m` argument: a conventional
 * subject plus an optional body, no code fences, wrapping quotes or
 * "Commit message:" preamble.
 */
export function normalizeCommitMessage(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .filter((line) => !FENCE_RE.test(line))
    .map((line) => line.trimEnd());
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first === -1) return "";
  let last = lines.length - 1;
  while (last > first && lines[last].trim().length === 0) last -= 1;
  // Strip wrapping quotes first: a model often answers `"Commit message: ..."`,
  // and the preamble pattern below is anchored to the start of the string.
  let subject = lines[first].trim();
  subject = subject.replace(/^["'`“”「」]+|["'`“”「」]+$/g, "").trim();
  subject = subject.replace(
    /^(?:commit message|message|提交信息|提交说明)\s*[:：]\s*/i,
    "",
  );
  // Drop a markdown/bullet marker, but keep the message body intact.
  subject = subject.replace(/^[-*]\s+/, "");
  subject = subject.replace(/^["'`“”「」]+|["'`“”「」]+$/g, "").trim();
  subject = subject.slice(0, MAX_COMMIT_SUBJECT_LEN);
  if (!subject) return "";

  const body: string[] = [];
  for (const line of lines.slice(first + 1, last + 1)) {
    // Collapse runs of blank lines so the body stays readable in `git log`.
    if (!line.trim() && (body.length === 0 || !body[body.length - 1].trim()))
      continue;
    body.push(line);
  }
  const message = body.length
    ? `${subject}\n\n${body.join("\n")}`
    : subject;
  return message.slice(0, MAX_COMMIT_MESSAGE_LEN);
}

/**
 * Commit everything in the session workspace, attaching a branch first when detached.
 *
 * Explicit user action from the workspace panel: the commit message is either
 * explicitly supplied by the user after optional separate generation.
 * `push: false` stops after the local commit so the user can inspect it first.
 */
export async function commitSessionWorkspace(
  sessionId: string,
  input: SessionGitCommitInput = {},
): Promise<SessionGitCommitResult> {
  const session = getSession(sessionId);

  const root = resolveSessionRepository(
    sessionId,
    session.projectId,
    input.rootId,
    true,
  );
  const workspacePath = root.path;
  const topLevel = (
    await runGit(workspacePath, ["rev-parse", "--show-toplevel"], true)
  ).stdout.trim();
  const rootLocation = workspaceRootLocation(root);
  const matchesRoot =
    rootLocation.kind === "wsl"
      ? path.posix.normalize(topLevel) ===
        path.posix.normalize(rootLocation.path)
      : Boolean(topLevel) &&
        canonicalWorkspaceDirectory(topLevel) === workspacePath;
  if (!matchesRoot)
    throw new AgentValidationError(
      "The selected project must be a Git repository root.",
    );
  let branch = (
    await runGit(workspacePath, ["branch", "--show-current"])
  ).stdout.trim();
  if (!branch && !input.branchName) {
    throw new AgentValidationError(
      "Name a branch before committing from a detached worktree.",
    );
  }
  if (branch && input.branchName && input.branchName !== branch) {
    throw new AgentValidationError(
      "The requested branch does not match this worktree's current branch.",
    );
  }

  const status = await runGit(workspacePath, [
    "status",
    "--porcelain=v1",
    "-uall",
  ]);
  const changedFiles = status.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const includeUntracked = input.includeUntracked !== false;
  const eligibleFiles = includeUntracked
    ? changedFiles
    : changedFiles.filter((line) => !line.startsWith("??"));
  if (eligibleFiles.length === 0) {
    throw new AgentRuntimeError(
      includeUntracked
        ? "There is nothing to commit."
        : "There is nothing to commit among tracked files.",
      "GIT_NOTHING_TO_COMMIT",
      409,
    );
  }

  const message = normalizeCommitMessage(input.message ?? "");
  if (!message) {
    throw new AgentRuntimeError(
      "Enter a commit message or generate one first.",
      "GIT_COMMIT_MESSAGE_MISSING",
      422,
    );
  }

  if (!branch) {
    try {
      branch = await attachDetachedGitBranch(rootLocation, input.branchName!);
      invalidateSessionEnvironment(sessionId);
    } catch (error) {
      if (error instanceof GitWorkspaceError)
        throw new AgentRuntimeError(error.message, "GIT_BRANCH_ERROR", error.status);
      throw error;
    }
  }

  await runGit(workspacePath, ["add", includeUntracked ? "-A" : "-u"]);

  const commit = await runGit(workspacePath, ["commit", "-m", message], true);
  if (!commit.ok) {
    const detail = formatGitFailure(commit);
    throw new AgentRuntimeError(
      `Commit failed${detail ? `: ${detail}` : ""}`,
      "GIT_COMMIT_FAILED",
      409,
    );
  }

  const commitSha = (
    await runGit(workspacePath, ["rev-parse", "HEAD"])
  ).stdout.trim();
  // A failed push still leaves a successful local commit.
  invalidateSessionEnvironment(sessionId);

  const shouldPush = input.push !== false;
  let pushed: boolean | null = null;
  let upstream: string | null = null;
  if (shouldPush) {
    const upstreamRef = (
      await runGit(
        workspacePath,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        true,
      )
    ).stdout.trim();

    pushed = false;
    upstream = upstreamRef || null;
    const pushArgs = upstream
      ? ["push"]
      : ["push", "--set-upstream", "origin", branch];
    const push = await runGit(workspacePath, pushArgs, true);
    if (push.ok) {
      pushed = true;
      if (!upstream) upstream = `origin/${branch}`;
    } else {
      const detail = formatGitFailure(push);
      throw new AgentRuntimeError(
        `Committed ${commitSha.slice(0, 8)} locally, but the push failed.${detail ? ` ${detail}` : ""}`,
        "GIT_PUSH_FAILED",
        502,
      );
    }
  }

  invalidateSessionEnvironment(sessionId);
  logger.info(
    {
      sessionId,
      branch,
      commitSha,
      messageGenerated: false,
      files: eligibleFiles.length,
      pushed,
    },
    shouldPush
      ? "[git-commit] committed and pushed session workspace"
      : "[git-commit] committed session workspace",
  );

  return {
    rootId: root.id,
    branch,
    commitSha,
    message,
    messageGenerated: false,
    pushed,
    upstream,
    committedFiles: eligibleFiles.length,
  };
}
