import { useEffect } from "react";
import { useAgentSessionStore, scheduleSessionRefresh } from "./state/agentSessionStore";
import { subscribe } from "../../adapters/transport/runtimeEventBus";
import type { AgentSession } from "../../adapters/transport/agentRuntime";
import { hasRunRealtimeObservation } from "../../adapters/transport/runRealtime";

function isTerminalSessionStatus(status: AgentSession["status"] | undefined): boolean {
  return status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted" ||
    status === "paused";
}

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

function sessionIdFrom(event: MessageEvent): string | null {
  try {
    const data = JSON.parse(event.data) as { sessionId?: unknown };
    return typeof data.sessionId === "string" && data.sessionId
      ? data.sessionId
      : null;
  } catch {
    return null;
  }
}

/**
 * Live callbacks own every list mutation after the first read.
 *
 * The session list is read once per workspace and never reconciled on its own:
 * titles, statuses and summaries are patched into the exact row their event
 * names, a row that was never loaded is read by id, and a removed row is
 * dropped locally. Nothing here re-reads the page.
 */
export function useRuntimeSSE() {
  const patchSession = useAgentSessionStore((s) => s.patchSession);

  useEffect(() => {
    return subscribe({
      events: {
        session_changed: (e) => {
          const data = JSON.parse(e.data) as {
            sessionId: string;
            patch?: Partial<AgentSession> & {
              historyReset?: boolean;
              historyRevision?: number;
            };
          };
          const store = useAgentSessionStore.getState();
          const previous = store.sessions.find(
            (session) => session.id === data.sessionId,
          );
          if (!data.patch) {
            // A patch-less change carries no fields to apply; read this one
            // session so the row matches the runtime.
            void store.syncSessionSummary(data.sessionId);
            return;
          }

          if (data.patch.historyReset)
            store.resetConversationHistory(data.sessionId);
          const titleOnly = isTitleOnlyPatch(data.patch, previous);
          const realtime = hasRunRealtimeObservation(data.sessionId);
          const patch = { ...data.patch };
          // The run stream owns intermediate lifecycle transitions, but the
          // terminal session patch is the durable completion barrier. Keep it
          // visible to the list so a finished reply can stop its loader even
          // when the run realtime channel has not closed yet.
          if (realtime && !isTerminalSessionStatus(data.patch.status)) {
            // Run transport owns lifecycle until durable finalization. A
            // session-wide hint must not expose an early completed state or
            // start a competing full-history hydration for every token tick.
            delete patch.status; delete patch.activeRunId;
            delete patch.pendingResumeToken; delete patch.blockedReason;
          }
          const patched = patchSession(data.sessionId, patch);
          // A status change for a row outside the loaded page is fetched by
          // id; the page itself stays as it is. Titles for unknown rows are
          // handled inside `patchSession`, so this never doubles a read.
          if (!patched && typeof data.patch.status === "string")
            void store.syncSessionSummary(data.sessionId);
          const selected = useAgentSessionStore.getState().selectedSessionId;
          if (data.sessionId === selected && !titleOnly) {
            scheduleSessionRefresh(
              data.sessionId,
              realtime ? "usage" : "detail",
              data.patch.historyRevision,
            );
          }
        },
        session_step_completed: (e) => {
          const { sessionId } = JSON.parse(e.data) as { sessionId: string };
          const selected = useAgentSessionStore.getState().selectedSessionId;
          // Status and timestamps arrive as a `session_changed` patch; the step
          // itself only matters for the open transcript.
          if (sessionId === selected && !hasRunRealtimeObservation(sessionId)) scheduleSessionRefresh(sessionId, "detail");
        },
        session_input_queue_changed: (e) => {
          const { sessionId } = JSON.parse(e.data) as { sessionId: string };
          void useAgentSessionStore.getState().loadInputQueue(sessionId);
        },
        session_created: (e) => {
          const sessionId = sessionIdFrom(e);
          if (!sessionId) return;
          const store = useAgentSessionStore.getState();
          // A session this page already shows is done; a subagent child or a
          // session created in another window is read by id.
          if (store.sessions.some((session) => session.id === sessionId)) return;
          void store.syncSessionSummary(sessionId);
        },
        session_deleted: (e) => {
          const sessionId = sessionIdFrom(e);
          if (!sessionId) return;
          const { projectId, discardRemovedSessions } =
            useAgentSessionStore.getState();
          discardRemovedSessions([sessionId], projectId);
        },
        session_archived: (e) => {
          const sessionId = sessionIdFrom(e);
          if (!sessionId) return;
          const { projectId, discardRemovedSessions } =
            useAgentSessionStore.getState();
          discardRemovedSessions([sessionId], projectId);
        },
      },
    });
  }, [patchSession]);
}
