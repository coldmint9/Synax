import type { AgentSession } from '../../../lib/api/agentRuntime'

/** Primary sessions page vs wiki/automation workflow sub-page. */
export type SessionListView = 'sessions' | 'workflow'

const WORKFLOW_PROFILE_IDS = new Set([
  'wiki-refresh',
  'plan-planner',
  'plan-generator',
])

const LEGACY_GOAL_PROFILE_ID = 'goal'
const SYNAX_PROFILE_ID = 'synax'

const GOAL_MODE_VALUES = new Set(['goal', 'plan_node'])
const GOAL_MODE_SOURCES = new Set(['goal-dock', 'session-page', 'plan-execution'])

function isSynaxProfile(profileId: string): boolean {
  return profileId === SYNAX_PROFILE_ID || profileId === LEGACY_GOAL_PROFILE_ID
}

function resolveSynaxMode(session: AgentSession): string | null {
  const mode = session.sessionMetadata?.mode
  if (typeof mode === 'string') return mode

  if (session.profileId === LEGACY_GOAL_PROFILE_ID) {
    const source = session.sessionMetadata?.source
    return source === 'plan-execution' ? 'plan_node' : 'goal'
  }

  const source = session.sessionMetadata?.source
  if (typeof source === 'string' && GOAL_MODE_SOURCES.has(source)) {
    return source === 'plan-execution' ? 'plan_node' : 'goal'
  }

  return isSynaxProfile(session.profileId) ? 'chat' : null
}

export function isWorkflowSession(session: AgentSession): boolean {
  const { profileId, sessionMetadata } = session

  if (profileId.startsWith('wiki-') || WORKFLOW_PROFILE_IDS.has(profileId)) {
    return true
  }

  if (sessionMetadata && typeof sessionMetadata.snapshotId === 'string' && sessionMetadata.snapshotId) {
    return true
  }

  return false
}

/** Synax session running in goal or plan_node mode (not a separate agent profile). */
export function isGoalModeSession(session: AgentSession): boolean {
  const mode = resolveSynaxMode(session)
  if (mode && GOAL_MODE_VALUES.has(mode)) return true

  const source = typeof session.sessionMetadata?.source === 'string'
    ? session.sessionMetadata.source
    : undefined

  return (
    session.profileId === LEGACY_GOAL_PROFILE_ID
    || source === 'goal-dock'
    || source === 'session-page'
    || source === 'plan-execution'
  )
}

/** Sessions page shows interactive Synax sessions; workflow page shows wiki/plan automation. */
export function classifySession(session: AgentSession): SessionListView {
  if (isWorkflowSession(session)) return 'workflow'
  return 'sessions'
}

export const SESSION_LIST_VIEW_LABELS: Record<SessionListView, { zh: string; en: string }> = {
  sessions: { zh: '会话', en: 'Sessions' },
  workflow: { zh: 'Workflow', en: 'Workflows' },
}
