import { GitMrError } from "../git-mr/errors.js";
import { git, type Repo } from "../git-mr/repository.js";
import type { QuickMergeStep } from "./contracts.js";

const REMOTE = "origin";
const NETWORK_TIMEOUT_MS = 180_000;
const BRANCH = /^(?!-)[A-Za-z0-9._/-]{1,250}$/;

export function assertBranch(name: string, label: string): string {
  const value = name.trim();
  if (!BRANCH.test(value) || value.includes("..") || value.endsWith("/") || value.endsWith(".lock"))
    throw new GitMrError(`${label}名称无效。`, "INVALID_INPUT", 400);
  return value;
}

async function refExists(repo: Repo, ref: string): Promise<boolean> {
  const result = await git(repo, ["rev-parse", "--verify", "--quiet", ref], {
    allowFailure: true,
  });
  return result.status === 0;
}

export async function hasRemote(repo: Repo): Promise<boolean> {
  const result = await git(repo, ["remote", "get-url", REMOTE], { allowFailure: true });
  return result.status === 0;
}

/** The worktree that currently has `branch` checked out, if any. */
async function worktreeOf(repo: Repo, branch: string): Promise<string | null> {
  const result = await git(repo, ["worktree", "list", "--porcelain"], { allowFailure: true });
  if (result.status !== 0) return null;
  let path: string | null = null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
    else if (line === `branch refs/heads/${branch}` && path) return path;
  }
  return null;
}

async function count(repo: Repo, range: string): Promise<number> {
  const result = await git(repo, ["rev-list", "--count", range], { allowFailure: true });
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) ? value : 0;
}

export interface SyncResult {
  state: "no-remote" | "no-branch" | "unpublished" | "current" | "updated" | "diverged";
  behind: number;
  ahead: number;
  oid?: string;
}

/** Fast-forward one local branch to its remote without ever forcing history.
 * A branch checked out somewhere is advanced through that worktree. */
export async function syncBranch(repo: Repo, branch: string): Promise<SyncResult> {
  if (!(await refExists(repo, `refs/heads/${branch}`)))
    return { state: "no-branch", behind: 0, ahead: 0 };
  if (!(await hasRemote(repo))) return { state: "no-remote", behind: 0, ahead: 0 };
  if (!(await refExists(repo, `refs/remotes/${REMOTE}/${branch}`)))
    return { state: "unpublished", behind: 0, ahead: 0 };
  const behind = await count(repo, `${branch}..${REMOTE}/${branch}`);
  const ahead = await count(repo, `${REMOTE}/${branch}..${branch}`);
  if (!behind) return { state: "current", behind: 0, ahead };
  if (ahead) return { state: "diverged", behind, ahead };
  const worktree = await worktreeOf(repo, branch);
  if (worktree) {
    await git(repo, ["merge", "--ff-only", `${REMOTE}/${branch}`], {
      cwd: worktree,
      timeoutMs: NETWORK_TIMEOUT_MS,
    });
  } else {
    // Fast-forward only: git refuses a non-fast-forward fetch into a branch.
    await git(repo, ["fetch", REMOTE, `${branch}:${branch}`], {
      timeoutMs: NETWORK_TIMEOUT_MS,
    });
  }
  const oid = (await git(repo, ["rev-parse", branch])).stdout.trim();
  return { state: "updated", behind, ahead: 0, oid };
}

/** Refresh remote-tracking refs; a missing remote is not an error. */
export async function fetchRemote(repo: Repo): Promise<QuickMergeStep> {
  if (!(await hasRemote(repo)))
    return { command: `git fetch ${REMOTE} --prune`, status: "skipped", detail: "未配置 origin，仅使用本地分支" };
  await git(repo, ["fetch", "--prune", "--no-tags", REMOTE], {
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  return { command: `git fetch ${REMOTE} --prune`, status: "ok", detail: "远端引用已同步" };
}

export function syncStep(branch: string, result: SyncResult): QuickMergeStep {
  switch (result.state) {
    case "no-remote":
      return { command: `git pull --ff-only ${REMOTE} ${branch}`, status: "skipped", detail: "未配置 origin" };
    case "no-branch":
      return { command: `git pull --ff-only ${REMOTE} ${branch}`, status: "skipped", detail: `本地分支 ${branch} 不存在` };
    case "unpublished":
      return { command: `git pull --ff-only ${REMOTE} ${branch}`, status: "skipped", detail: "尚未发布到远端" };
    case "diverged":
      return {
        command: `git pull --ff-only ${REMOTE} ${branch}`,
        status: "failed",
        detail: `本地与远端分叉（落后 ${result.behind}、领先 ${result.ahead}）`,
      };
    case "updated":
      return {
        command: `git merge --ff-only ${REMOTE}/${branch}`,
        status: "ok",
        detail: `已快进到 ${result.oid?.slice(0, 7) ?? "远端最新"}`,
      };
    default:
      return { command: `git pull --ff-only ${REMOTE} ${branch}`, status: "ok", detail: "远端无新提交" };
  }
}

export interface PushResult {
  pushed: boolean;
  ahead: number;
  steps: QuickMergeStep[];
}

/** Push a local branch without force. Divergence aborts instead of overwriting. */
export async function pushBranch(repo: Repo, branch: string): Promise<PushResult> {
  if (!(await hasRemote(repo)))
    throw new GitMrError("未配置 origin 远端，无法推送。", "NO_REMOTE", 400);
  const fetched = await fetchRemote(repo);
  const steps: QuickMergeStep[] = [fetched];
  const sync = await syncBranch(repo, branch);
  steps.push(syncStep(branch, sync));
  if (sync.state === "diverged")
    throw new GitMrError(
      `本地 ${branch} 与远端已分叉。请先合并后再推送，不提供强制推送。`,
      "DIVERGED",
      409,
    );
  if (!sync.ahead) {
    steps.push({ command: `git push ${REMOTE} ${branch}`, status: "skipped", detail: "没有需要推送的提交" });
    return { pushed: false, ahead: 0, steps };
  }
  await git(repo, ["push", REMOTE, `${branch}:${branch}`], { timeoutMs: NETWORK_TIMEOUT_MS });
  steps.push({
    command: `git push ${REMOTE} ${branch}`,
    status: "ok",
    detail: `推送 ${sync.ahead} 个提交`,
  });
  return { pushed: true, ahead: 0, steps };
}

export async function aheadOfRemote(repo: Repo, branch: string): Promise<number | undefined> {
  if (!(await hasRemote(repo))) return undefined;
  if (!(await refExists(repo, `refs/remotes/${REMOTE}/${branch}`))) return undefined;
  if (!(await refExists(repo, `refs/heads/${branch}`))) return undefined;
  return count(repo, `${REMOTE}/${branch}..${branch}`);
}
