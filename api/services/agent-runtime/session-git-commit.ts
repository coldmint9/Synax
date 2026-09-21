import path from "node:path";
import { logger } from "../../lib/logger.js";
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
const MAX_COMMIT_MESSAGE_LEN = 200;

export interface SessionGitCommitInput {
  rootId?: string;
  /** Explicit, reviewed commit message; empty messages are rejected. */
  message?: string | null;
  /** Defaults to `true`. `false` commits locally without touching the remote. */
  push?: boolean | null;
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

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function formatGitFailure(result: GitResult): string {
  const detail = (result.stderr || result.stdout)
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-3)
    .join(" ");
  return detail;
}

async function runGit(
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
 * Keep the generated text usable as a `git commit -m` argument: one line,
 * no wrapping quotes, no "Commit message:" preamble.
 */
export function normalizeCommitMessage(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  let message = lines[0];
  // Strip wrapping quotes first: a model often answers `"Commit message: ..."`,
  // and the preamble pattern below is anchored to the start of the string.
  message = message.replace(/^["'`“”「」]+|["'`“”「」]+$/g, "").trim();
  message = message.replace(
    /^(?:commit message|message|提交信息|提交说明)\s*[:：]\s*/i,
    "",
  );
  // Drop a markdown/bullet marker, but keep the message body intact.
  message = message.replace(/^[-*]\s+/, "");
  message = message.replace(/^["'`“”「」]+|["'`“”「」]+$/g, "").trim();
  return message.slice(0, MAX_COMMIT_MESSAGE_LEN);
}

/**
 * Commit everything in the session workspace on its current branch.
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
  if (session.activeRunId) {
    throw new AgentRuntimeError(
      "The session is still running. Wait for it to finish before committing.",
      "GIT_SESSION_BUSY",
      409,
    );
  }

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
  const branch = (
    await runGit(workspacePath, ["branch", "--show-current"])
  ).stdout.trim();
  if (!branch) {
    throw new AgentValidationError(
      "Cannot commit: the workspace is in a detached HEAD state.",
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
  if (changedFiles.length === 0) {
    throw new AgentRuntimeError(
      "There is nothing to commit.",
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

  await runGit(workspacePath, ["add", "-A"]);

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
      files: changedFiles.length,
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
    committedFiles: changedFiles.length,
  };
}
