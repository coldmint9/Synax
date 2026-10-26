import { apiRequest } from "./origin";
export type ForkWorkspaceMode = "new_worktree" | "reuse_worktree";
export type HistoryAction = "rollback" | "fork";
export type HistoryTruncateMode = "session" | "session_and_workspace";
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
  readOnlyMessageIds?: string[];
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
  edit: (sessionId: string, body: { messageId: string; message: string; requestId: string }) =>
    post<{ sessionId: string; revision: number }>(sessionId, "edit", body),
  list: (sessionId: string, signal?: AbortSignal, messageIds?: readonly string[]) => {
    // Large loaded windows use a request body instead of falling back to a
    // full-history query. Empty initial windows retain the existing summary.
    const encoded = messageIds && messageIds.length > 0
      ? encodeURIComponent(JSON.stringify(messageIds))
      : undefined;
    const query = encoded !== undefined && encoded.length <= 6000 ? `?messageIds=${encoded}` : "";
    return apiRequest<HistorySummary>(`${base(sessionId)}/checkpoints${query}`, {
      signal,
      silent: true,
      ...(encoded && encoded.length > 6000 ? { method: "POST", body: JSON.stringify({ messageIds }) } : {}),
    });
  },
  preview: (
    sessionId: string,
    checkpointId: string,
    action: HistoryAction,
    modeOrIncludeFiles: HistoryTruncateMode | boolean = "session",
    workspaceMode?: ForkWorkspaceMode,
  ) => {
    // Fork keeps its historical includeFiles request shape. Rollback uses the
    // explicit truncation mode required by the history API.
    if (action === "fork") {
      const includeFiles = typeof modeOrIncludeFiles === "boolean" ? modeOrIncludeFiles : false;
      return post<HistoryPreview>(sessionId, "preview", {
        checkpointId,
        action,
        includeFiles,
        workspaceMode,
      });
    }
    const mode = typeof modeOrIncludeFiles === "string" ? modeOrIncludeFiles : "session";
    return post<HistoryPreview>(sessionId, "preview", {
      checkpointId,
      action: "truncate_history",
      mode,
    });
  },
  apply: (
    sessionId: string,
    action: HistoryAction,
    body: {
      checkpointId: string;
      revision: number;
      requestId: string;
      message?: string;
      includeFiles?: boolean;
      mode?: HistoryTruncateMode;
      workspaceMode?: ForkWorkspaceMode;
    },
  ) =>
    post<{ sessionId: string; revision?: number; runId?: string }>(
      sessionId,
      action === "rollback" ? "truncate_history" : action,
      body,
    ),
  visit: (sessionId: string) =>
    post<{ visited: boolean }>(sessionId, "visit", {}),
  recover: (sessionId: string) =>
    post<{ recovered: boolean }>(sessionId, "recover", {}),
};
