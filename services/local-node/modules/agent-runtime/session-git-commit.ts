import path from "node:path";
import {
  attachDetachedGitBranch,
  GitWorkspaceError,
} from "../git-workspaces.js";
import { logger } from "../../infrastructure/runtime/logger.js";
import {
  invalidateSessionEnvironment,
  resolveSessionRepository,
} from "./session-environment.js";
import { switchSessionGitBranch } from "./session-git-branches.js";
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

import {
  autoResolveWorkspaceConflicts,
  assertNoWorkspaceConflicts,
  assertNoStagedConflictMarkers,
  assertNoOutgoingConflictMarkers,
  assertNoSequencedGitOperation,
} from "./session-git-conflicts.js";
export { resolveConflictText } from "./session-git-conflict-text.js";

const MAX_BUFFER = 8 * 1024 * 1024;
const COMMIT_TIMEOUT_MS = 120_000;
const MAX_COMMIT_SUBJECT_LEN = 200;
const MAX_COMMIT_MESSAGE_LEN = 2_000;
const FENCE_RE = /^\s*(?:```|~~~)/;
/**
 * macOS Finder metadata must never be staged. The `glob` magic is required:
 * a literal `:(exclude).DS_Store` pathspec makes `git add` report the ignored
 * file and abort ("The following paths are ignored ... Use -f"), even though
 * that pathspec excludes it, while a non-glob double-star exclusion misses the
 * repository-root copy. `glob` makes one pattern cover root and nested files.
 */
const DS_STORE_EXCLUDE = ":(exclude,glob)**/.DS_Store";

export interface SessionGitCommitInput {
  rootId?: string;
  /** Name a detached branch, or select a different local branch before committing. */
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

export interface SessionGitPushResult {
  rootId: string;
  branch: string;
  pushed: true;
  upstream: string;
}

export interface SessionGitCommitSummary {
  sha: string;
  subject: string;
  body: string;
  author: string;
  email: string;
  authoredAt: string;
}

export interface SessionGitCommitsToPushResult {
  rootId: string;
  branch: string;
  headCommitSha: string;
  upstream: string;
  commits: SessionGitCommitSummary[];
}

/**
 * Read the commits that would be sent by the next push without mutating the
 * checkout. The range uses the configured upstream when present and falls
 * back to commits that are not reachable from any local remote tracking ref.
 */
export async function listSessionWorkspaceCommits(
  sessionId: string,
  input: { rootId?: string } = {},
): Promise<SessionGitCommitsToPushResult> {
  const session = getSession(sessionId);
  const root = resolveSessionRepository(sessionId, session.projectId, input.rootId, true);
  const workspacePath = root.path;
  const branch = (await runGit(workspacePath, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
  if (!branch || branch === "HEAD") {
    throw new AgentValidationError("Push requires a named Git branch.");
  }
  const upstreamRef = (
    await runGit(
      workspacePath,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      true,
    )
  ).stdout.trim();
  const format = "%H%x00%an%x00%ae%x00%aI%x00%s%x00%b";
  const headCommitSha = (await runGit(workspacePath, ["rev-parse", "--verify", "HEAD"], true)).stdout.trim();
  const logArgs = [
    "log",
    "--reverse",
    "-z",
    `--format=${format}`,
    ...(upstreamRef ? [`${upstreamRef}..${headCommitSha}`] : [headCommitSha, "--not", "--remotes"]),
  ];
  const log = await runGit(workspacePath, logArgs, true);
  if (!log.ok) {
    const head = await runGit(workspacePath, ["rev-parse", "--verify", "HEAD"], true);
    if (!head.ok) {
      return {
        rootId: root.id,
        branch,
        headCommitSha: "",
        upstream: upstreamRef || `origin/${branch}`,
        commits: [],
      };
    }
    throw new AgentRuntimeError(
      `Could not read commits to push${formatGitFailure(log) ? `: ${formatGitFailure(log)}` : ""}`,
      "GIT_LOG_FAILED",
      502,
    );
  }
  const fields = log.stdout.split("\0");
  const commits: SessionGitCommitSummary[] = [];
  for (let index = 0; index + 5 < fields.length; index += 6) {
    commits.push({
      sha: fields[index],
      author: fields[index + 1],
      email: fields[index + 2],
      authoredAt: fields[index + 3],
      subject: fields[index + 4],
      body: fields[index + 5].trim(),
    });
  }
  return {
    rootId: root.id,
    branch,
    headCommitSha,
    upstream: upstreamRef || `origin/${branch}`,
    commits,
  };
}

export async function pushSessionWorkspace(
  sessionId: string,
  input: { rootId?: string; expectedHeadSha?: string; expectedBranch?: string; expectedUpstream?: string } = {},
): Promise<SessionGitPushResult> {
  const session = getSession(sessionId);
  const root = resolveSessionRepository(sessionId, session.projectId, input.rootId, true);
  const workspacePath = root.path;
  const branch = (await runGit(workspacePath, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
  if (!branch || branch === "HEAD") {
    throw new AgentValidationError("Push requires a named Git branch.");
  }
  await assertNoWorkspaceConflicts(workspacePath, "push", false);
  await assertNoSequencedGitOperation(workspacePath, "push");
  const upstreamRef = (await runGit(
    workspacePath,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    true,
  )).stdout.trim();
  if (input.expectedHeadSha) {
    const head = (await runGit(workspacePath, ["rev-parse", "HEAD"])).stdout.trim();
    if (head !== input.expectedHeadSha || branch !== input.expectedBranch ||
        (upstreamRef || `origin/${branch}`) !== input.expectedUpstream) {
      throw new AgentRuntimeError("分支或待推送提交已变化，请刷新后重新审阅。", "GIT_PUSH_REVIEW_CHANGED", 409);
    }
  }
  // Pin the checked commit and publish only this branch, even when Git is
  // configured to push multiple refs or automatically include tags.
  const pushHead = input.expectedHeadSha ?? (await runGit(workspacePath, ["rev-parse", "HEAD"])).stdout.trim();
  const tracking = (await runGit(workspacePath, ["for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)", `refs/heads/${branch}`])).stdout.trim().split("\0");
  const pushArgs = ["push", "--no-follow-tags", "--", tracking[0] || "origin",
    `${pushHead}:${tracking[1] || `refs/heads/${branch}`}`];
  await assertNoStagedConflictMarkers(workspacePath);
  await assertNoOutgoingConflictMarkers(workspacePath, upstreamRef, pushHead);
  const push = await runGit(
    workspacePath,
    pushArgs,
    true,
  );
  if (!push.ok) {
    const detail = formatGitFailure(push);
    throw new AgentRuntimeError(
      `Push failed${detail ? `: ${detail}` : ""}`,
      "GIT_PUSH_FAILED",
      502,
    );
  }
  if (!upstreamRef) {
    // An explicit SHA refspec cannot set tracking automatically. Establish it
    // after publishing, without reporting a completed push as failed.
    const tracking = await runGit(workspacePath,
      ["branch", `--set-upstream-to=origin/${branch}`, branch], true);
    if (!tracking.ok) logger.warn({ sessionId, branch }, "[git-push] pushed but could not set upstream");
  }
  invalidateSessionEnvironment(sessionId);
  return {
    rootId: root.id,
    branch,
    pushed: true,
    upstream: upstreamRef || `origin/${branch}`,
  };
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

interface GitIdentity {
  name: string;
  email: string;
}

function remoteHost(value: string): string | null {
  const scp = /^(?:[^@/\s]+@)?([^:/$\s]+):/.exec(value);
  if (scp) return scp[1].toLowerCase();
  try {
    const url = new URL(value);
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function parseRemoteIdentity(raw: string, allowGitHubNoreply = false): GitIdentity | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const login =
      typeof value.login === "string"
        ? value.login.trim()
        : typeof value.username === "string"
          ? value.username.trim()
          : "";
    const name =
      typeof value.name === "string" && value.name.trim()
        ? value.name.trim()
        : login;
    const email = typeof value.email === "string" ? value.email.trim() : "";
    const id = value.id;
    if (email && name) return { name, email };
    // GitHub hides private emails from /user. Its noreply address is stable
    // when the numeric account id and login are available.
    if (allowGitHubNoreply && login && (typeof id === "number" || typeof id === "string")) {
      return { name, email: `${String(id)}+${login}@users.noreply.github.com` };
    }
  } catch {
    // An unavailable or non-JSON CLI response is treated as no remote identity.
  }
  return null;
}

async function readRemoteIdentity(workspacePath: string): Promise<GitIdentity | null> {
  const configured = (await runGit(
    workspacePath,
    ["config", "--get-regexp", "^remote\\..*\\.url$"],
    true,
  )).stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const separator = line.indexOf(" ");
      return separator === -1
        ? null
        : { name: line.slice(0, separator), url: line.slice(separator + 1).trim() };
    })
    .filter((item): item is { name: string; url: string } => Boolean(item));
  if (!configured.length) return null;
  const remote = configured.find((item) => item.name === "remote.origin.url") ?? configured[0];
  const url = remote.url;
  const host = remoteHost(url);
  if (!host) return null;
  const isGitHub = host === "github.com" || host.includes("github");
  const isGitLab = host === "gitlab.com" || host.includes("gitlab");
  const candidates: Array<[string, string[]]> = [];
  if (isGitHub || !isGitLab)
    candidates.push(["gh", ["api", "--hostname", host, "user"]]);
  if (isGitLab || !isGitHub)
    candidates.push(["glab", ["api", "--hostname", host, "user"]]);
  for (const [executable, args] of candidates) {
    const result = await runCommand(executable, args, {
      cwd: workspacePath,
      timeoutMs: 10_000,
      maxBufferBytes: 512 * 1024,
      inheritEnv: false,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        GIT_TERMINAL_PROMPT: "0",
        NO_COLOR: "1",
      },
    });
    if (result.status !== 0 || result.error || result.timedOut) continue;
    const identity = parseRemoteIdentity(result.stdout, executable === "gh");
    if (identity) return identity;
    if (executable === "gh") {
      const emails = await runCommand(executable, ["api", "--hostname", host, "user/emails"], {
        cwd: workspacePath,
        timeoutMs: 10_000,
        maxBufferBytes: 512 * 1024,
        inheritEnv: false,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
      });
      if (emails.status === 0 && !emails.error && !emails.timedOut) {
        try {
          const rows = JSON.parse(emails.stdout) as Array<Record<string, unknown>>;
          const primary = rows.find((row) => row.primary && row.verified) ?? rows.find((row) => row.verified);
          const email = typeof primary?.email === "string" ? primary.email.trim() : "";
          const user = parseRemoteIdentity(result.stdout, true);
          if (email && user) return { name: user.name, email };
        } catch {
          // Fall through to the local Git identity.
        }
      }
    }
  }
  return null;
}

async function readLocalIdentity(workspacePath: string): Promise<GitIdentity | null> {
  const values = (await runGit(
    workspacePath,
    ["config", "--get-regexp", "^user\\.(name|email)$"],
    true,
  )).stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const separator = line.indexOf(" ");
      return separator === -1
        ? null
        : { key: line.slice(0, separator), value: line.slice(separator + 1).trim() };
    })
    .filter((item): item is { key: string; value: string } => Boolean(item));
  const name = values.find((item) => item.key === "user.name")?.value ?? "";
  const email = values.find((item) => item.key === "user.email")?.value ?? "";
  return name && email ? { name, email } : null;
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
  await assertNoSequencedGitOperation(workspacePath, "commit");
  if (input.branchName && input.branchName !== branch &&
    (await runGit(workspacePath, ["ls-files", "-u", "-z"])).stdout) {
    throw new AgentRuntimeError("Resolve the current Git operation before changing branches.", "GIT_UNRESOLVED_CONFLICTS", 409);
  }

  if (branch && input.branchName && input.branchName !== branch) {
    try {
      branch = (
        await switchSessionGitBranch(
          sessionId,
          input.branchName,
          root.id,
          true,
        )
      ).current;
      invalidateSessionEnvironment(sessionId);
    } catch (error) {
      if (error instanceof GitWorkspaceError)
        throw new AgentRuntimeError(error.message, "GIT_BRANCH_ERROR", error.status);
      throw error;
    }
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

  try {
    await autoResolveWorkspaceConflicts(workspacePath, includeUntracked, { sessionId, projectId: session.projectId });
  } finally {
    invalidateSessionEnvironment(sessionId);
  }

  // A branch switch can restore a stash or expose another in-progress Git
  // operation. Recheck immediately before staging so the commit path cannot
  // turn an unmerged index or conflict marker into a normal commit.
  await assertNoWorkspaceConflicts(workspacePath, "commit", includeUntracked);

  await runGit(workspacePath, [
    "add",
    includeUntracked ? "-A" : "-u",
    "--",
    ".",
    DS_STORE_EXCLUDE,
  ]);
  const stagedOutput = (
    await runGit(workspacePath, ["diff", "--cached", "--name-only", "-z"])
  ).stdout;
  const staged = stagedOutput
    .split("\0")
    .map((file) => file.trim())
    .filter(Boolean);
  if (staged.some(file => file.split("/").at(-1) === ".DS_Store"))
    throw new AgentValidationError(".DS_Store must never be committed. Unstage it before committing.");
  // Only excluded metadata (`status` still lists it) leaves an empty index.
  if (staged.length === 0 && !(await runGit(workspacePath, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], true)).ok) {
    throw new AgentRuntimeError(
      "There is nothing to commit.",
      "GIT_NOTHING_TO_COMMIT",
      409,
    );
  }

  const identity =
    (await readRemoteIdentity(workspacePath)) ??
    (await readLocalIdentity(workspacePath));
  const commitArgs = [
    ...(identity ? ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`] : []),
    "commit",
    "-m",
    message,
  ];
  await assertNoStagedConflictMarkers(workspacePath);
  await assertNoSequencedGitOperation(workspacePath, "commit");
  const commit = await runGit(workspacePath, commitArgs, true);
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
    try {
      const push = await pushSessionWorkspace(sessionId, {
        rootId: root.id, expectedHeadSha: commitSha, expectedBranch: branch,
        expectedUpstream: upstreamRef || `origin/${branch}`,
      });
      pushed = true;
      upstream = push.upstream;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new AgentRuntimeError(
        `Committed ${commitSha.slice(0, 8)} locally, but the push failed.${detail ? ` ${detail}` : ""}`,
        error instanceof AgentRuntimeError ? error.code : "GIT_PUSH_FAILED",
        error instanceof AgentRuntimeError ? error.status : 502,
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
      files: staged.length,
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
    // Count what the commit actually contains, not every dirty status entry.
    committedFiles: staged.length,
  };
}
