import { useAgentSessionStore } from './agentSessionStore'
import { SessionComposer } from './SessionComposer'
import { SessionFileChangeIsland } from './SessionFileChangeIsland'
import { GoalQuickApproval, listPendingGoalPermissions } from '../wiki/goal/GoalQuickApproval'
import { isGoalModeSession } from './sessionBuckets'

function statusLabel(status: string): string | null {
  switch (status) {
    case 'stopping': return '正在停止'
    case 'running': return '运行中'
    case 'waiting_permission': return '等待授权'
    case 'paused': return '已暂停'
    case 'blocked': return '已阻塞'
    case 'failed': return '失败'
    case 'interrupted': return '已中断'
    default: return null
  }
}

function statusClass(status: string): string {
  switch (status) {
    case 'running': return 'agent-command-status--running'
    case 'stopping':
    case 'waiting_permission': return 'agent-command-status--warning'
    case 'failed': return 'agent-command-status--danger'
    case 'paused':
    case 'blocked':
    case 'interrupted': return 'agent-command-status--warning'
    default: return ''
  }
}

export function AgentCommandRail({
  sessionId,
  readingHistory = false,
  projectId,
  focus,
  insetLeft,
  insetRight,
}: {
  sessionId: string
  readingHistory?: boolean
  projectId: string
  focus: boolean
  insetLeft: number
  insetRight: number
}) {
  const session = useAgentSessionStore(state => state.sessions.find(item => item.id === sessionId))
  const permissions = useAgentSessionStore(state => state.permissions)
  const replyPermission = useAgentSessionStore(state => state.replyPermission)
  const pendingPermissions = listPendingGoalPermissions(permissions)
  const goalMode = Boolean(session && isGoalModeSession(session))
  const label = session ? statusLabel(session.status) : null

  if (!session || (!goalMode && pendingPermissions.length === 0)) return null

  return (
    <div
      className="agent-command-rail"
      data-focus={focus ? 'true' : 'false'}
      style={{ left: insetLeft, right: insetRight }}
    >
      <div className="agent-command-rail-inner">
        {label ? (
          <div className="agent-command-status-row">
            <span className={`agent-command-status ${statusClass(session.status)}`}>
              <span className="agent-command-status-dot" />
              {label}
            </span>
          </div>
        ) : null}

        {pendingPermissions.length > 0 ? (
          <GoalQuickApproval
            permissions={permissions}
            onReply={(permissionId, reply) => void replyPermission(permissionId, reply)}
            variant="strip"
            showIndicator
          />
        ) : null}

        {goalMode ? (
          <SessionComposer
            session={session}
            readingHistory={readingHistory}
            projectId={projectId}
            layout="focusRail"
            statusSlot={<SessionFileChangeIsland sessionId={session.id} isRunning={session.status === 'running'} />}
          />
        ) : null}
      </div>
    </div>
  )
}
