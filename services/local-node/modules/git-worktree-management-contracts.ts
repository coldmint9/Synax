/** Browser-safe contracts shared by worktree management clients and the server. */
export interface GitWorktreeSummary {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  primary: boolean;
  locked: boolean;
  prunable: boolean;
  managed: boolean;
  dirty: boolean;
  sessionCount: number;
  activeSessionCount?: number;
  statusKnown?: boolean;
}

export interface GitWorktreePathPreview { path: string }
export interface GitWorktreeCleanupPreview {
  candidates: GitWorktreeSummary[];
  retained: { worktree: GitWorktreeSummary; reasons: string[] }[];
}
export interface GitWorktreeCleanupInput { rootId?: string; paths: string[] }
export interface GitWorktreeCleanupResult {
  path: string;
  branch: string | null;
  status: "removed" | "skipped" | "failed";
  reason?: string;
}
export interface GitWorktreeCleanupResponse { results: GitWorktreeCleanupResult[] }
export const MAX_WORKTREE_CLEANUP_PATHS = 100;

export function isTerminalWorktreeSession(status: unknown): boolean {
  return typeof status === "string" && ["completed", "failed", "cancelled", "interrupted"].includes(status);
}

/** Missing safety information is never evidence that deletion is safe. */
export function cleanupReasons(worktree: GitWorktreeSummary): string[] {
  const reasons: string[] = [];
  if (worktree.primary) reasons.push("主工作树不可删除");
  if (worktree.locked) reasons.push("工作树已锁定");
  if (worktree.prunable) reasons.push("工作树目录缺失，需单独确认清理元数据");
  if (worktree.statusKnown !== true) reasons.push("无法确认 Git 状态");
  if (worktree.dirty) reasons.push("工作树包含未提交或未跟踪的修改");
  if ((worktree.activeSessionCount ?? worktree.sessionCount) > 0) reasons.push("工作树仍被活跃会话占用");
  return reasons;
}

export function cleanupReason(worktree: GitWorktreeSummary): string | null {
  return cleanupReasons(worktree)[0] ?? null;
}
