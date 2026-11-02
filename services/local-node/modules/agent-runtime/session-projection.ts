import type { AgentSession } from './contracts.js';

const SYNAX_PROFILES = new Set(['synax', 'goal']);
const CANONICAL_SESSION_STATUSES = new Set<AgentSession['status']>([
  'stopping',
  'queued',
  'running',
  'waiting_permission',
  'waiting_input',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
/**
 * Statuses a run only leaves. A stop fence is a request, never a verdict: it
 * must not overwrite one of these, or a finished run reads as `running` again
 * and every list keeps animating work that already ended.
 */
const SETTLED_SESSION_STATUSES = new Set<string>([
  'paused',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

/** Normalize legacy persisted/wire values at every AgentSession boundary. */
export function normalizeAgentSessionStatus(status: unknown): AgentSession['status'] {
  // `blocked` is a retired legacy value. `paused` is a first-class status again
  // (stopped by the user, or recovered after a forced process exit), so it must
  // never be folded away: the pause is what makes the session resumable.
  if (status === 'blocked') return 'completed';
  return CANONICAL_SESSION_STATUSES.has(status as AgentSession['status'])
    ? status as AgentSession['status']
    : 'completed';
}

/** Keep model-loop state distinct from a stop whose process cleanup is not yet confirmed. */
export function projectSessionState(session: any): any {
  const input = session as AgentSession;
  const normalizedStatus = normalizeAgentSessionStatus(input.status);
  const normalized = normalizedStatus === input.status ? input : { ...input, status: normalizedStatus };
  const control = normalized.sessionMetadata?.runtimeControl as { state?: string; reason?: string } | undefined;
  if (control?.state === 'unconfirmed') return { ...normalized, status: 'completed', blockedReason: null } as any;
  if (SYNAX_PROFILES.has(normalized.profileId)) {
    if (normalized.status === 'waiting_permission' || normalized.status === 'waiting_input' || normalized.status === 'paused' || normalized.status === 'queued') return normalized as any;
    if (normalized.status === 'running' || normalized.status === 'stopping') return { ...normalized, status: 'running' } as any;
    if (normalized.status === 'failed') return normalized as any;
    return { ...normalized, status: 'completed' } as any;
  }
  if (control?.state === 'stopping' && !SETTLED_SESSION_STATUSES.has(normalized.status)) return { ...normalized, status: 'stopping', blockedReason: control.reason ?? 'Stopping execution.' } as any;
  return normalized as any;
}

/**
 * Did this worker report that its run finished?
 *
 * A worker being released still owns the run it executed, and its terminal
 * `session_changed` is the only report that the run ended. It is accepted only
 * while nothing else settled the row, so a stop this process already recorded
 * (`paused` / `interrupted`) is never undone by a straggling worker.
 */
export function announcesWorkerSettle(
  message: { type: string; event?: unknown },
  current: AgentSession | undefined,
): boolean {
  if (message.type !== 'runtime:event' || !message.event || typeof message.event !== 'object')
    return false;
  const event = message.event as { type?: unknown; patch?: unknown };
  if (event.type !== 'session_changed' || !event.patch || typeof event.patch !== 'object')
    return false;
  const status = (event.patch as { status?: unknown }).status;
  if (typeof status !== 'string' || !SETTLED_SESSION_STATUSES.has(status))
    return false;
  return Boolean(
    current && !SETTLED_SESSION_STATUSES.has(normalizeAgentSessionStatus(current.status)),
  );
}

/**
 * Lifecycle fields a `session_changed` event contributes to its wire patch.
 *
 * This process only keeps a copy of a worker-owned session, and the worker's
 * event is usually the first place a terminal or waiting status exists.
 * Projecting that stale copy would rewrite the event's own `status` back to
 * the last status seen here, so the client kept a running row, showed only the
 * list dot from the run stream and never raised the completion/input reminder.
 * Fold the event patch onto the copy so the projection normalizes the incoming
 * status instead of discarding it.
 */
export function projectRuntimeSessionEvent(
  event: { patch?: Record<string, unknown> },
  current?: AgentSession,
): Partial<Pick<AgentSession, 'status' | 'activeRunId'>> | undefined {
  const patch = event.patch;
  if (!current || !patch) return undefined;
  if (
    !('status' in patch || 'activeRunId' in patch || 'sessionMetadata' in patch)
  )
    return undefined;
  const metadata = patch.sessionMetadata;
  const metadataPatch =
    metadata && typeof metadata === 'object'
      ? (metadata as Record<string, unknown>)
      : undefined;
  const projected = projectSessionState({
    ...current,
    ...(typeof patch.status === 'string'
      ? { status: patch.status as AgentSession['status'] }
      : {}),
    ...('activeRunId' in patch
      ? { activeRunId: patch.activeRunId as AgentSession['activeRunId'] }
      : {}),
    ...(metadataPatch
      ? { sessionMetadata: { ...current.sessionMetadata, ...metadataPatch } }
      : {}),
  });
  return {
    // Only lifecycle fields the event itself carries may reach the wire.
    // Replaying this process's copy on a metadata-only event rewinds a settled
    // row to `running` and dismisses the reminder the terminal event just sent.
    ...('status' in patch ? { status: projected.status } : {}),
    ...('activeRunId' in patch ? { activeRunId: projected.activeRunId } : {}),
    // A control verdict is the one metadata key that decides a status.
    ...(metadataPatch && 'runtimeControl' in metadataPatch
      ? { status: projected.status }
      : {}),
  };
}

/** All sessions are backed by the revisioned Rust history store. Keep the
 * capability marker on the wire so clients can use the bounded history-window
 * protocol instead of rebuilding an entire transcript on every refresh. */
export function markRevisionedHistory(session: AgentSession): AgentSession {
  if (session.sessionMetadata?.historyStorage === 3) return session;
  return {
    ...session,
    sessionMetadata: {
      ...(session.sessionMetadata ?? {}),
      historyStorage: 3,
    },
  };
}

/**
 * Wire projection for session list rows. The system-prompt preview is a debug
 * artifact written per step (tens of KB per row); it dominated list payloads
 * and has no list consumer, so it never leaves the server in list responses.
 */
export function projectSessionSummary(session: AgentSession): AgentSession {
  const marked = markRevisionedHistory(session);
  const {
    latestSystemPrompt: _latestSystemPrompt,
    mcpToolDefinitions: _mcpToolDefinitions,
    inputQueue: _inputQueue,
    inputForceInjectId: _inputForceInjectId,
    ...sessionMetadata
  } = marked.sessionMetadata!;
  if (Object.keys(sessionMetadata).length === Object.keys(marked.sessionMetadata!).length)
    return marked;
  return { ...marked, sessionMetadata };
}
