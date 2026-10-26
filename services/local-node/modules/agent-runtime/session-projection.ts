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
export function projectSessionState(session: AgentSession): AgentSession {
  const normalizedStatus = normalizeAgentSessionStatus(session.status);
  const normalized = normalizedStatus === session.status
    ? session
    : { ...session, status: normalizedStatus };
  const control = normalized.sessionMetadata?.runtimeControl as { state?: string; reason?: string } | undefined;

  if (control?.state === 'unconfirmed') {
    // A residual stop fence is runtime bookkeeping, not a decision the user has
    // to make: the runtime confirms the process exit in the background. Keep
    // the row terminal and quiet instead of surfacing the internal reason.
    return { ...normalized, status: 'completed', blockedReason: null };
  }
  if (SYNAX_PROFILES.has(normalized.profileId)) {
    if (normalized.status === 'waiting_permission' || normalized.status === 'waiting_input') {
      return normalized;
    }
    // A paused session must stay visibly paused: the trailing `completed`
    // fallback below would otherwise hide the one-click resume affordance.
    if (normalized.status === 'paused') return normalized;
    if (normalized.status === 'queued') return normalized;
    if (normalized.status === 'running' || normalized.status === 'stopping' || control?.state === 'stopping') {
      return { ...normalized, status: 'running' };
    }
    // A run that ended with an error keeps its failure state: the session list
    // must flag it (red dot) instead of reporting a successful completion.
    if (normalized.status === 'failed') return normalized;
    return { ...normalized, status: 'completed' };
  }
  if (control?.state === 'stopping') {
    return { ...normalized, status: 'stopping', blockedReason: control.reason ?? 'Stopping execution.' };
  }
  return normalized;
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
    inputQueue: _inputQueue,
    inputForceInjectId: _inputForceInjectId,
    ...sessionMetadata
  } = marked.sessionMetadata!;
  if (Object.keys(sessionMetadata).length === Object.keys(marked.sessionMetadata!).length)
    return marked;
  return { ...marked, sessionMetadata };
}
