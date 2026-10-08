import { agentRuntimeStore, type AgentRuntimeStore } from "./session-store.js";
import { nowIso } from "./runtime-ids.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** Only call after the owning execution has stopped (or its worker has exited). */
export function finalizeStoppedSessions(
  sessionIds: Iterable<string>,
  reason: string,
  store: AgentRuntimeStore = agentRuntimeStore,
): void {
  const completedAt = nowIso();
  for (const sessionId of new Set(sessionIds)) {
    const session = store.tryGetSession(sessionId);
    if (!session) continue;
    for (const run of store.listRuns(sessionId)) {
      for (const step of store.listRunSteps(run.id)) {
        if (!TERMINAL_STATUSES.has(step.status))
          store.updateRunStep(step.id, {
            status: "interrupted",
            completedAt,
            finishReason: "execution_stopped",
          });
      }
      if (TERMINAL_STATUSES.has(run.status)) continue;
      store.updateRun(run.id, {
        status: "interrupted",
        completedAt,
        stopReason: reason,
      });
    }
    if (TERMINAL_STATUSES.has(session.status)) continue;
    store.updateSession(sessionId, {
      status: "interrupted",
      completedAt,
      updatedAt: completedAt,
      blockedReason: reason,
      activeRunId: null,
      pendingResumeToken: null,
    });
    if (session.parentSessionId)
      store.updateSessionMetadata(sessionId, {
        subagentTask: {
          ...(session.sessionMetadata?.subagentTask as Record<string, unknown> | undefined),
          state: "completed",
          phase: "interrupted",
          completedAt,
          leaseExpiresAt: completedAt,
        },
      });
  }
}
