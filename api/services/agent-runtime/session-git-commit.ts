import { normalizeResultUsage } from "../llm-runtime/usage.js";
import path from "node:path";
import { logger } from "../../lib/logger.js";
import { generateGatewayTextResult } from "../llm-runtime/gateway.js";
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
import { finishAuxUsage, startAuxUsage } from "./usage-projection.js";

const MAX_BUFFER = 8 * 1024 * 1024;
const COMMIT_TIMEOUT_MS = 120_000;
const MAX_COMMIT_MESSAGE_LEN = 200;
const MAX_DIFF_CHARS = 6_000;

export interface SessionGitCommitInput {
  rootId?: string;
  /** User supplied commit message. Empty/absent means "generate one". */
  message?: string | null;
  /** Explicit model override for generation; defaults to the session's model. */
  model?: string | null;
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

/** Model the session is currently running with, so generated text matches it. */
function resolveSessionModel(sessionId: string): string | null {
  const runs = agentRuntimeStore.listRuns(sessionId);
  return runs.find((run) => run.model?.trim())?.model?.trim() ?? null;
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

function buildCommitPrompt(input: {
  branch: string;
  branchSummary: string;
  changedFiles: string;
  diffExcerpt: string;
  locale: "zh" | "en";
}): string {
  const instruction =
    input.locale === "zh"
      ? "用一行中文写一条 Git 提交信息，使用约定式提交前缀（如 feat/fix/refactor/docs/chore），不超过 72 个字符。只输出提交信息本身，不要引号、句号或任何解释。"
      : "Write a single-line Git commit message with a conventional-commit prefix (feat/fix/refactor/docs/chore), at most 72 characters. Output only the message, without quotes, trailing period, or explanation.";
  return [
    instruction,
    "",
    `Branch: ${input.branch}`,
    "Changed files:",
    input.changedFiles || "(none)",
    "",
    "Staged diff summary:",
    input.branchSummary || "(empty)",
    "",
    "Staged diff excerpt:",
    input.diffExcerpt || "(empty)",
  ].join("\n");
}

async function generateCommitMessage(input: {
  sessionId: string;
  projectId: string;
  model: string | null;
  branch: string;
  branchSummary: string;
  changedFiles: string;
  diffExcerpt: string;
  locale: "zh" | "en";
}): Promise<string | null> {
  const usageId = startAuxUsage(input.sessionId, "git-commit-message");
  try {
    const result = await generateGatewayTextResult({
      projectId: input.projectId,
      purpose: "commit-message",
      ...(input.model ? { model: input.model } : {}),
      messages: [{ role: "user", content: buildCommitPrompt(input) }],
      maxTokens: 200,
      temperature: 0.2,
    });
    finishAuxUsage(usageId, normalizeResultUsage(result));
    return normalizeCommitMessage(String(result.text ?? "")) || null;
  } catch (err) {
    finishAuxUsage(usageId);
    logger.warn(
      { sessionId: input.sessionId, err },
      "[git-commit] commit message generation failed",
    );
    return null;
  }
}

/**
 * Commit everything in the session workspace on its current branch.
 *
 * Explicit user action from the workspace panel: the commit message is either
 * supplied by the user or generated with the session's current model.
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

  await runGit(workspacePath, ["add", "-A"]);

  const stagedNames = (
    await runGit(workspacePath, ["diff", "--cached", "--name-status"])
  ).stdout.trim();
  const stagedSummary = (
    await runGit(workspacePath, ["diff", "--cached", "--stat"])
  ).stdout.trim();
  const stagedPatch = (
    await runGit(workspacePath, ["diff", "--cached"])
  ).stdout.slice(0, MAX_DIFF_CHARS);

  let message = normalizeCommitMessage(input.message ?? "");
  let messageGenerated = false;
  if (!message) {
    message =
      (await generateCommitMessage({
        sessionId,
        projectId: session.projectId,
        model: input.model?.trim() || resolveSessionModel(sessionId),
        branch,
        branchSummary: stagedSummary,
        changedFiles: stagedNames,
        diffExcerpt: stagedPatch,
        locale: /[\u4e00-\u9fff]/.test(session.prompt ?? "") ? "zh" : "en",
      })) ?? "";
    messageGenerated = true;
  }
  if (!message) {
    throw new AgentRuntimeError(
      "Could not generate a commit message. Enter one manually.",
      "GIT_COMMIT_MESSAGE_MISSING",
      422,
    );
  }

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
      messageGenerated,
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
    messageGenerated,
    pushed,
    upstream,
    committedFiles: changedFiles.length,
  };
}
