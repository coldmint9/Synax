import type { AgentSession } from '../../../lib/api/agentRuntime'

/** Primary sessions page vs wiki/automation workflow sub-page. */
export type SessionListView = 'goal' | 'workflow'

const WORKFLOW_PROFILE_IDS = new Set([
  'wiki-refresh',
  'plan-planner',
  'plan-generator',
])

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
  const meta = session.sessionMetadata
  const source = typeof meta?.source === 'string' ? meta.source : undefined

  return (
    session.profileId === 'goal'
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
