import type { AgentSession } from '../../../lib/api/agentRuntime'
import type { PermissionDecision } from '../../../lib/api/agentRuntime'
import { listPendingGoalPermissions } from '../wiki/goal/GoalQuickApproval'
import { isAcpSession, readSynaxSessionMode } from './synaxSessionTypes'

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
    hasPendingInteractions?: boolean
    allowWaitingInputForPlanApproval?: boolean
  } = {},
): boolean {
  if (options.submitting) return true
  if (!session) return false
  if (session.status === 'stopping' || session.status === 'queued') return true
  if (options.hasPendingInteractions
    || (session.status === 'waiting_input' && !options.allowWaitingInputForPlanApproval)) return true

  if (session.status === 'waiting_permission') {
    return options.hasPendingPermissions ?? false
  }

  return session.status === 'running' && Boolean(session.activeRunId)
}

export function canSwitchSessionMode(
  session: AgentSession | undefined,
  options: { hasPendingInteractions?: boolean; hasPendingPermissions?: boolean; acp?: boolean } = {},
): boolean {
  if (options.acp || options.hasPendingInteractions || options.hasPendingPermissions) return false
  if (!session) return true
  if (isAcpSession(session) || session.parentSessionId || readSynaxSessionMode(session.sessionMetadata) === 'plan_node') return false
  if (session.profileId !== 'synax' && session.profileId !== 'goal') return false
  return !session.activeRunId && !session.pendingResumeToken
    && !['running', 'queued', 'waiting_permission', 'waiting_input'].includes(session.status)
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
