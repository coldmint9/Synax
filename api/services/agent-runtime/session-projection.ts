import type { AgentSession } from './contracts.js';

/** Keep model-loop state distinct from a stop whose process cleanup is not yet confirmed. */
export function projectSessionState(session: AgentSession): AgentSession {
  const control = session.sessionMetadata?.runtimeControl as { state?: string; reason?: string } | undefined;
  if (control?.state === 'stopping') return { ...session, status: 'stopping', blockedReason: control.reason ?? 'Stopping execution.' };
  if (control?.state === 'unconfirmed') return { ...session, status: 'blocked', blockedReason: control.reason ?? 'Execution shutdown requires inspection.' };
  return session;
}
