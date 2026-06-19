import type { AgentSession } from '../../../lib/api/agentRuntime'
import type { PermissionDecision } from '../../../lib/api/agentRuntime'
import { listPendingGoalPermissions } from '../wiki/goal/GoalQuickApproval'

export function patchAgentSession(
  session: AgentSession,
  patch: Partial<AgentSession>,
): AgentSession {
  return { ...session, ...patch }
}

export function isSessionComposerLocked(
  session: AgentSession | undefined,
  options: {
    submitting?: boolean
    hasPendingPermissions?: boolean
  } = {},
): boolean {
  if (options.submitting) return true
  if (!session) return false

  if (session.status === 'waiting_permission') {
    return options.hasPendingPermissions ?? false
  }

  return session.status === 'running' && Boolean(session.activeRunId)
}

export function canEnqueueSessionInput(session: AgentSession | undefined): boolean {
  if (!session) return false
  if (session.status === 'running' && Boolean(session.activeRunId)) return true
  if (session.status === 'waiting_permission') return true
  return false
}

export function sessionHasPendingPermissions(
  sessionId: string | undefined,
  selectedSessionId: string | null,
  permissions: PermissionDecision[],
): boolean {
  if (!sessionId || sessionId !== selectedSessionId) return false
  return listPendingGoalPermissions(permissions).length > 0
}
