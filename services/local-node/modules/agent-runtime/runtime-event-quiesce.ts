/**
 * Quiesce scope for terminal lifecycle operations.
 *
 * Archiving a session runs a shutdown pipeline (interrupt the run, close ACP
 * peers, stop background processes, cancel queued work) that legitimately
 * produces a burst of intermediate runtime events: stopping flags, cancelled
 * steps, interrupted runs. No consumer needs that play-by-play — the session
 * is about to disappear — and relaying it makes every client refetch state
 * for a session that is already gone.
 *
 * The pipeline therefore quiesces the affected subtree for its duration:
 * progress events for quiesced sessions are dropped at the bus boundary,
 * while the terminal lifecycle events that announce the outcome always pass.
 * Both buses (the global runtime bus and the per-session live bus) consult
 * this gate, so every producer — in-process or IPC-forwarded — is covered by
 * a single choke point.
 */

/** Events that announce a lifecycle verdict and must never be suppressed. */
const TERMINAL_EVENT_TYPES = new Set(["session_archived", "session_deleted"]);

const quiescedSessions = new Set<string>();

export function isSessionEventsQuiesced(sessionId: string): boolean {
  return quiescedSessions.has(sessionId);
}

/** True when the event may be relayed to subscribers. */
export function allowsRuntimeBusEvent(event: {
  type: string;
  sessionId: string;
}): boolean {
  return (
    !quiescedSessions.has(event.sessionId) ||
    TERMINAL_EVENT_TYPES.has(event.type)
  );
}

/**
 * Quiesce the given sessions until the returned disposer runs. Always pair
 * with try/finally (or use {@link withSessionEventsQuiesced}) so a failed
 * shutdown cannot leave the subtree permanently silent.
 */
export function quiesceSessionEvents(sessionIds: Iterable<string>): () => void {
  const ids = [...sessionIds];
  for (const id of ids) quiescedSessions.add(id);
  return () => {
    for (const id of ids) quiescedSessions.delete(id);
  };
}

export async function withSessionEventsQuiesced<T>(
  sessionIds: Iterable<string>,
  run: () => Promise<T> | T,
): Promise<T> {
  const unquiesce = quiesceSessionEvents(sessionIds);
  try {
    return await run();
  } finally {
    unquiesce();
  }
}
