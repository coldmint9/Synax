import { useEffect } from "react";
import { useAgentSessionStore, scheduleSessionRefresh } from "./state/agentSessionStore";
import { subscribe } from "../../adapters/transport/runtimeEventBus";
import type { AgentSession } from "../../adapters/transport/agentRuntime";
import { hasRunRealtimeObservation } from "../../adapters/transport/runRealtime";
import { reconcileUnsettledSessionRows } from "./sessionStatusReconcile";
import { useAutoResumeStore } from "./state/autoResumeStore";

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
    // The title generator writes its intent label in the same patch,
    // and like the title they only change list rows, never the transcript.
    for (const derived of ["titleSummarized", "intentCategory"]) {
      delete before[derived];
      delete after[derived];
    }
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
 * Safety net for a settle report the page never received while the stream kept
 * looking healthy (a worker's terminal event lost to its own teardown, for
 * example). Same low-frequency cadence as the open transcript's poll: live
 * callbacks stay the fast path, and an idle list costs no request because only
 * rows that still claim to be running are read.
 */
const SETTLE_WATCHDOG_MS = 30_000;

/**
 * Live callbacks own every list mutation after the first read.
 *
 * The session list is read once per workspace and then only reconciled from
 * callbacks: titles, statuses and summaries are patched into the exact row
 * their event names, a row that was never loaded is read by id, and a removed
 * row is dropped locally. Two exceptions read back instead of trusting a
 * callback that may never arrive: a session that settles — its transition
 * reorders the page and moves the counts, so the transition itself asks the
 * store for one coalesced list read — and a row that still claims to be
 * running when the callback stream resumes.
 */
export function useRuntimeSSE() {
  const patchSession = useAgentSessionStore((s) => s.patchSession);

  useEffect(() => {
    // A settle is reported once, by the callback for that transition. A gap in
    // the stream (a reconnect, the workbench unmounted, the window asleep)
    // drops that report for good, so the row keeps animating a finished run
    // until something reads it again. Every (re)connection therefore re-reads
    // the rows that still claim to be running.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible")
        reconcileUnsettledSessionRows();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const watchdog = window.setInterval(() => {
      if (document.visibilityState === "visible")
        reconcileUnsettledSessionRows({ force: true });
    }, SETTLE_WATCHDOG_MS);
    const unsubscribe = subscribe({
      onConnect: () => {
        reconcileUnsettledSessionRows();
        // The queue lives in the runtime: a reconnect may have missed the
        // events that changed it while this window was away.
        void useAutoResumeStore.getState().refresh();
      },
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
          // The run stream owns lifecycle only for the transcript this page
          // renders. Another holder of the same session's stream (the Dock, a
          // stream that is about to be released) patches its own state, so
          // dropping the row's lifecycle here left the session list frozen on
          // the last status it read — a `queued` row for a whole run — until
          // the row was read again.
          const realtime =
            hasRunRealtimeObservation(data.sessionId) &&
            data.sessionId === store.selectedSessionId;
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
          if (!titleOnly) {
            scheduleSessionRefresh(
              data.sessionId,
              data.sessionId === selected && realtime ? "usage" : "detail",
              data.patch.historyRevision,
            );
          }
        },
        session_step_completed: (e) => {
          const { sessionId } = JSON.parse(e.data) as { sessionId: string };
          const selected = useAgentSessionStore.getState().selectedSessionId;
          // Off-screen completions invalidate their cached page without a
          // request. The next visit reconciles it once, then stays hot again.
          if (sessionId !== selected || !hasRunRealtimeObservation(sessionId)) scheduleSessionRefresh(sessionId, "detail");
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
        session_auto_resume: (e) => {
          try {
            const data = JSON.parse(e.data) as {
              sessionId?: unknown;
              patch?: Record<string, unknown> | null;
            };
            if (typeof data.sessionId !== "string" || !data.sessionId) return;
            useAutoResumeStore.getState().applyChange({
              sessionId: data.sessionId,
              patch: data.patch ?? null,
            });
          } catch {
            /* a malformed event must not break the list */
          }
        },
      },
    });
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(watchdog);
      unsubscribe();
    };
  }, [patchSession]);
}
