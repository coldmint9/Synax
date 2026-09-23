import { useEffect } from "react";
import { useAgentSessionStore, scheduleSessionRefresh } from "./state/agentSessionStore";
import { subscribe } from "../../../lib/api/runtimeEventBus";
import type { AgentSession } from "../../../lib/api/agentRuntime";

export function isTitleOnlyPatch(
  patch: Partial<AgentSession>,
  previous?: AgentSession,
): boolean {
  if (typeof patch.title !== "string" || !previous) return false;
  return Object.entries(patch).every(([key, value]) => {
    if (key === "title" || key === "updatedAt") return true;
    if (key === "status" || key === "activeRunId")
      return value === previous[key];
    if (key !== "sessionMetadata") return false;
    const before = { ...previous.sessionMetadata };
    const after = { ...patch.sessionMetadata };
    delete before.titleSummarized;
    delete after.titleSummarized;
    return JSON.stringify(before) === JSON.stringify(after);
  });
}

export function useRuntimeSSE() {
  const patchSession = useAgentSessionStore((s) => s.patchSession);

  useEffect(() => {
    return subscribe({
      onConnect: () => scheduleSessionRefresh(null, "list"),
      events: {
        session_changed: (e) => {
          const data = JSON.parse(e.data) as {
            sessionId: string;
            patch?: Partial<AgentSession> & {
              historyReset?: boolean;
              historyRevision?: number;
            };
          };
          if (!data.patch) {
            scheduleSessionRefresh(null, "list");
            return;
          }

          if (data.patch.historyReset)
            useAgentSessionStore
              .getState()
              .resetConversationHistory(data.sessionId);
          const previous = useAgentSessionStore
            .getState()
            .sessions.find((session) => session.id === data.sessionId);
          const titleOnly = isTitleOnlyPatch(data.patch, previous);
          const patched = patchSession(data.sessionId, data.patch);
          // patchSession already refreshes unknown title targets.
          if (!titleOnly && (patched || typeof data.patch.title !== "string")) {
            scheduleSessionRefresh(null, "list");
          }
          const selected = useAgentSessionStore.getState().selectedSessionId;
          if (data.sessionId === selected && !titleOnly) {
            scheduleSessionRefresh(data.sessionId, "detail", data.patch.historyRevision);
          }
        },
        session_step_completed: (e) => {
          const { sessionId } = JSON.parse(e.data) as { sessionId: string };
          scheduleSessionRefresh(null, "list");
          const selected = useAgentSessionStore.getState().selectedSessionId;
          if (sessionId === selected) scheduleSessionRefresh(sessionId, "detail");
        },
        session_input_queue_changed: (e) => {
          const { sessionId } = JSON.parse(e.data) as { sessionId: string };
          void useAgentSessionStore.getState().loadInputQueue(sessionId);
        },
        session_created: () => scheduleSessionRefresh(null, "list"),
        session_deleted: () => scheduleSessionRefresh(null, "list"),
      },
    });
  }, [patchSession]);
}
