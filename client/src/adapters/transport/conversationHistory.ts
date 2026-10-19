import { apiRequest } from "./origin";
export type ForkWorkspaceMode = "new_worktree" | "reuse_worktree";
export type HistoryAction = "edit" | "rollback" | "fork";
export interface MessageCheckpoint {
  id: string;
  kind: "input" | "reply";
  messageId: string;
  stepId: string | null;
  available: boolean;
  reason: string | null;
  canRollback?: boolean;
  transcriptOnly?: boolean;
  destructive?: boolean;
  hasLaterHistory: boolean;
  initialInput: boolean;
}
export interface HistorySummary {
  sessionId: string;
  revision: number;
  rollbackEnabled?: boolean;
  recoveryRequired?: boolean;
  reason: string | null;
  forkReason?: string | null;
  stopRequired?: boolean;
  checkpoints: MessageCheckpoint[];
}
export interface HistoryPreview {
  checkpointId: string;
  revision: number;
  removedMessages: number;
  files: Array<{ root: string; path: string; action: "restore" | "delete" }>;
  conflicts: Array<{ root: string; path: string; reason: string }>;
  exclusions: string;
  canApply: boolean;
  warnings?: string[];
  preservedFiles?: Array<{
    root: string;
    path: string;
    reason: string;
    kind:
      "committed" | "git_unverified" | "expired" | "untracked" | "workspace";
  }>;
}
const base = (sessionId: string) =>
  `/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}`;
const post = <T>(sessionId: string, route: string, body: unknown) =>
  apiRequest<T>(`${base(sessionId)}/history/${route}`, {
    method: "POST",
    body: JSON.stringify(body),
    silent: true,
  });
export const conversationHistoryApi = {
  list: (sessionId: string, signal?: AbortSignal, messageIds?: readonly string[]) => {
    // 筛选只是响应优化。长会话使用无筛选查询，兼容旧服务的 64 条限制并避免 URL 超长。
    const encoded = messageIds && messageIds.length <= 64
      ? encodeURIComponent(JSON.stringify(messageIds))
      : undefined;
    const query = encoded !== undefined && encoded.length <= 6000 ? `?messageIds=${encoded}` : "";
    return apiRequest<HistorySummary>(`${base(sessionId)}/checkpoints${query}`, {
      signal,
      silent: true,
    });
  },
  preview: (
    sessionId: string,
    checkpointId: string,
    action: HistoryAction,
    includeFiles = true,
    workspaceMode?: ForkWorkspaceMode,
  ) =>
    post<HistoryPreview>(sessionId, "preview", {
      checkpointId,
      action,
      includeFiles,
      workspaceMode,
    }),
  apply: (
    sessionId: string,
    action: HistoryAction,
    body: {
      checkpointId: string;
      revision: number;
      requestId: string;
      message?: string;
      includeFiles?: boolean;
      workspaceMode?: ForkWorkspaceMode;
    },
  ) =>
    post<{ sessionId: string; revision?: number; runId?: string }>(
      sessionId,
      action,
      body,
    ),
  visit: (sessionId: string) =>
    post<{ visited: boolean }>(sessionId, "visit", {}),
  recover: (sessionId: string) =>
    post<{ recovered: boolean }>(sessionId, "recover", {}),
};
