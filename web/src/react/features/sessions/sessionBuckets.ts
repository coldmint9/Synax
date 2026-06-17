import type { AgentSession } from '../../../lib/api/agentRuntime'

/** Primary sessions page vs wiki/automation workflow sub-page. */
export type SessionListView = 'goal' | 'workflow'

const WORKFLOW_PROFILE_IDS = new Set([
  'wiki-refresh',
  'plan-planner',
  'plan-generator',
])

const LEGACY_GOAL_PROFILE_ID = 'goal'
const SYNAX_PROFILE_ID = 'synax'

const GOAL_LIKE_MODES = new Set(['goal', 'plan_node'])
const GOAL_LIKE_SOURCES = new Set(['goal-dock', 'session-page', 'plan-execution'])

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
  if (typeof source === 'string' && GOAL_LIKE_SOURCES.has(source)) {
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

export function isGoalSession(session: AgentSession): boolean {
  const mode = resolveSynaxMode(session)
  if (mode && GOAL_LIKE_MODES.has(mode)) return true

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

/** Goal page shows user goals; workflow page shows wiki/plan automation sessions. */
export function classifySession(session: AgentSession): SessionListView {
  if (isWorkflowSession(session)) return 'workflow'
  return 'goal'
}

export const SESSION_LIST_VIEW_LABELS: Record<SessionListView, { zh: string; en: string }> = {
  goal: { zh: 'Goal', en: 'Goals' },
  workflow: { zh: 'Workflow', en: 'Workflows' },
}
