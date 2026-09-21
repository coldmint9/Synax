import { apiRequest } from "./origin";
export type HistoryAction = "edit" | "rollback" | "fork";
export interface MessageCheckpoint {
  id: string;
  kind: "input" | "reply";
  messageId: string;
  stepId: string | null;
  available: boolean;
  reason: string | null;
  hasLaterHistory: boolean;
  initialInput: boolean;
}
export interface HistorySummary {
  sessionId: string;
  revision: number;
  recoveryRequired?: boolean;
  reason: string | null;
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
  list: (sessionId: string, signal?: AbortSignal) =>
    apiRequest<HistorySummary>(`${base(sessionId)}/checkpoints`, {
      signal,
      silent: true,
    }),
  preview: (sessionId: string, checkpointId: string, action: HistoryAction) =>
    post<HistoryPreview>(sessionId, "preview", { checkpointId, action }),
  apply: (
    sessionId: string,
    action: HistoryAction,
    body: {
      checkpointId: string;
      revision: number;
      requestId: string;
      message?: string;
    },
  ) =>
    post<{ sessionId: string; revision?: number; runId?: string }>(
      sessionId,
      action,
      body,
    ),
  recover: (sessionId: string) =>
    post<{ recovered: boolean }>(sessionId, "recover", {}),
};
