import type { AgentSession } from '../../../lib/api/agentRuntime'

const SYNAX_PROFILE_IDS = new Set(['synax', 'goal'])

const VARIANT_LABELS: Record<string, string> = {
  planner: 'Planner',
  explorer: 'Explorer',
  reviewer: 'Reviewer',
}

const MODE_LABELS: Record<string, string> = {
  goal: 'Goal',
  plan_node: 'Plan',
  chat: 'Chat',
}

export function isSynaxSession(session: Pick<AgentSession, 'profileId'>): boolean {
  return SYNAX_PROFILE_IDS.has(session.profileId)
}

export function resolveSynaxMode(session: AgentSession): string | null {
  const mode = session.sessionMetadata?.mode
  if (typeof mode === 'string') return mode

  if (session.profileId === 'goal') {
    const source = session.sessionMetadata?.source
    return source === 'plan-execution' ? 'plan_node' : 'goal'
  }

  const source = session.sessionMetadata?.source
  if (source === 'plan-execution') return 'plan_node'
  if (source === 'goal-dock' || source === 'session-page') return 'goal'

  return isSynaxSession(session) ? 'chat' : null
}

export function resolveSynaxAgentLabel(session: AgentSession): string {
  if (!isSynaxSession(session)) return session.profileId

  const variant = session.sessionMetadata?.activeVariant
  if (typeof variant === 'string' && VARIANT_LABELS[variant]) {
    return `Synax · ${VARIANT_LABELS[variant]}`
  }

  const mode = resolveSynaxMode(session)
  if (mode && MODE_LABELS[mode] && mode !== 'chat') {
    return `Synax · ${MODE_LABELS[mode]}`
  }

  return 'Synax'
}

export function resolveSynaxRouteReason(session: AgentSession): string | null {
  const reason = session.sessionMetadata?.routeReason
  return typeof reason === 'string' && reason.trim() ? reason.trim() : null
}
