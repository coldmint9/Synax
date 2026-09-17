import type { AgentSession } from './contracts.js';

const SYNAX_PROFILES = new Set(['synax', 'goal']);
const CANONICAL_SESSION_STATUSES = new Set<AgentSession['status']>([
  'stopping',
  'queued',
  'running',
  'waiting_permission',
  'waiting_input',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

/** Normalize legacy persisted/wire values at every AgentSession boundary. */
export function normalizeAgentSessionStatus(status: unknown): AgentSession['status'] {
  if (status === 'blocked' || status === 'paused') return 'completed';
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
    return {
      ...normalized,
      status: 'completed',
      blockedReason: control.reason ?? 'Execution shutdown requires inspection.',
    };
  }
  if (SYNAX_PROFILES.has(normalized.profileId)) {
    if (normalized.status === 'waiting_permission' || normalized.status === 'waiting_input') {
      return normalized;
    }
    if (normalized.status === 'queued') return normalized;
    if (normalized.status === 'running' || normalized.status === 'stopping' || control?.state === 'stopping') {
      return { ...normalized, status: 'running' };
    }
    return { ...normalized, status: 'completed' };
  }
  if (control?.state === 'stopping') {
    return { ...normalized, status: 'stopping', blockedReason: control.reason ?? 'Stopping execution.' };
  }
  return normalized;
}
