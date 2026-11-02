import type { AgentSession } from '../contracts.js';

/** Statuses a user stop (or an archived conversation) leaves on the owning session. */
export const PARENT_STOP_STATUSES = ['paused', 'stopping', 'cancelled', 'interrupted', 'failed'] as const;

export type ParentStopReason = 'runtime-control' | 'session-stopped';

/** The fields the fence needs; a full session satisfies this structurally. */
export type ParentFenceSession = Pick<AgentSession, 'status' | 'sessionMetadata'>;

/**
 * Why the owning conversation cannot host a merge worker right now.
 *
 * `manualStop` alone is deliberately not a stop: every stop path writes one of
 * PARENT_STOP_STATUSES together with the marker (session-runtime `stopOne`,
 * runtime-facade `stopSessionAuthoritative`). Only the status list and the
 * runtime control fence describe a stop that still governs the conversation.
 * A marker left behind on a conversation that has continued must not fence
 * later work, which is what made merge workers unlaunchable after a stop.
 */
export function parentStopReason(parent: ParentFenceSession): ParentStopReason | undefined {
  if (parent.sessionMetadata?.runtimeControl) return 'runtime-control';
  return (PARENT_STOP_STATUSES as readonly string[]).includes(parent.status) ? 'session-stopped' : undefined;
}

/** Structured evidence for fence diagnostics. It never decides the fence. */
export function parentFenceEvidence(parent: ParentFenceSession & { activeRunId?: string | null }) {
  return {
    status: parent.status,
    activeRunId: parent.activeRunId ?? null,
    manualStop: Boolean(parent.sessionMetadata?.manualStop),
    runtimeControl: parent.sessionMetadata?.runtimeControl ?? null,
  };
}
