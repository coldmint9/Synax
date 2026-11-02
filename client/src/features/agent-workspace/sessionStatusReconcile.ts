import type { AgentSession } from "../../adapters/transport/agentRuntime";
import { useAgentSessionStore } from "./state/agentSessionStore";

/**
 * Statuses whose row still claims work is in flight.
 *
 * A list row animates — a pixel loader instead of a settled status dot — for
 * exactly these statuses, so a transition this page never received leaves a
 * finished conversation looking busy.
 */
const UNSETTLED_STATUSES = new Set<AgentSession["status"]>([
  "running",
  "stopping",
  "queued",
]);

/** Reads one summary per unsettled row; a workspace never has many at once. */
const MAX_ROWS_PER_PASS = 8;
/** Reconnect, visibility and watchdog reports of one gap share a single read. */
const RECONCILE_INTERVAL_MS = 2_000;
/** Rows keep their own entry; a workspace never remembers thousands. */
const REMEMBERED_ROWS = 256;

const inFlight = new Set<string>();
/** Least recently read first, so a long backlog is not starved by its head. */
const lastReadAt = new Map<string, number>();

function isDue(sessionId: string, now: number): boolean {
  return now - (lastReadAt.get(sessionId) ?? 0) >= RECONCILE_INTERVAL_MS;
}

/**
 * Re-read the rows whose animated status may have outlived its run.
 *
 * The list is otherwise reconciled by live callbacks only, and a transition is
 * reported exactly once. If that callback is missed — the event stream
 * reconnected, the workbench was unmounted, the window was asleep — nothing
 * ever retries it, so the row keeps its loader until the user opens it and the
 * detail poller reads the durable status. Reading just the unsettled rows
 * restores the status the callback would have carried.
 */
export function reconcileUnsettledSessionRows(
  options: { force?: boolean } = {},
): void {
  const now = Date.now();
  const store = useAgentSessionStore.getState();
  const { projectId } = store;
  if (!projectId) return;
  const unsettled = store.sessions.filter(
    (session) =>
      session.projectId === projectId &&
      UNSETTLED_STATUSES.has(session.status),
  );
  if (unsettled.length === 0) {
    // Nothing is animating: forget the history so a later run reads promptly.
    lastReadAt.clear();
    return;
  }
  const candidates = unsettled.filter(
    (session) =>
      !inFlight.has(session.id) && (options.force || isDue(session.id, now)),
  );
  if (candidates.length === 0) return;
  if (lastReadAt.size > REMEMBERED_ROWS) lastReadAt.clear();
  candidates.sort(
    (a, b) => (lastReadAt.get(a.id) ?? 0) - (lastReadAt.get(b.id) ?? 0),
  );
  for (const session of candidates.slice(0, MAX_ROWS_PER_PASS)) {
    const settleRead = () => {
      inFlight.delete(session.id);
    };
    inFlight.add(session.id);
    lastReadAt.set(session.id, now);
    void store.syncSessionSummary(session.id).then(settleRead, settleRead);
  }
}

/** Test seam: forget the in-flight reads, the read history and the last pass. */
export function resetSessionStatusReconcile(): void {
  inFlight.clear();
  lastReadAt.clear();
}
