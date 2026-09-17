import { useEffect } from "react";
import { useAgentSessionStore } from "./agentSessionStore";
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
  const refreshSessions = useAgentSessionStore((s) => s.refreshSessions);
  const refreshDetail = useAgentSessionStore((s) => s.refreshDetail);
  const patchSession = useAgentSessionStore((s) => s.patchSession);

  useEffect(() => {
    return subscribe({
      onConnect: () => void refreshSessions(),
      events: {
        session_changed: (e) => {
          const data = JSON.parse(e.data) as {
            sessionId: string;
            patch?: Partial<AgentSession>;
          };
          if (!data.patch) {
            void refreshSessions();
            return;
          }

          const previous = useAgentSessionStore
            .getState()
            .sessions.find((session) => session.id === data.sessionId);
          const titleOnly = isTitleOnlyPatch(data.patch, previous);
          const patched = patchSession(data.sessionId, data.patch);
          // patchSession already refreshes unknown title targets.
          if (!titleOnly && (patched || typeof data.patch.title !== "string")) {
            void refreshSessions();
          }
          const selected = useAgentSessionStore.getState().selectedSessionId;
          if (data.sessionId === selected && !titleOnly) {
            void refreshDetail();
          }
        },
        session_step_completed: (e) => {
          const { sessionId } = JSON.parse(e.data) as { sessionId: string };
          void refreshSessions();
          const selected = useAgentSessionStore.getState().selectedSessionId;
          if (sessionId === selected) void refreshDetail();
        },
        session_input_queue_changed: (e) => {
          const { sessionId } = JSON.parse(e.data) as { sessionId: string };
          void useAgentSessionStore.getState().loadInputQueue(sessionId);
        },
        session_created: () => void refreshSessions(),
        session_deleted: () => void refreshSessions(),
      },
    });
  }, [refreshSessions, refreshDetail, patchSession]);
}
