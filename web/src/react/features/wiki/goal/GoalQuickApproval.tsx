import { useLocale } from '../../../../hooks/useLocale'
import type { PermissionDecision } from '../../../../lib/api/agentRuntime'
import { AgentWorkingIndicator } from './AgentWorkingIndicator'

export function listPendingGoalPermissions(permissions: PermissionDecision[]): PermissionDecision[] {
  return permissions.filter(p => p.action === 'ask' && !p.resolvedAt)
}

interface ActionsProps {
  permissionId: string
  onReply: (permissionId: string, reply: 'once' | 'always' | 'reject') => void
  size?: 'mini' | 'strip'
}

export function GoalQuickApprovalActions({ permissionId, onReply, size = 'mini' }: ActionsProps) {
  const { t } = useLocale()
  const isMini = size === 'mini'

  return (
    <div
      className="goal-dock-approval-actions"
      data-size={size}
      onClick={e => e.stopPropagation()}
      onKeyDown={e => e.stopPropagation()}
    >
      <button
        type="button"
        className="goal-dock-approval-btn goal-dock-approval-btn--allow"
        aria-label={t('permAllowOnce')}
        onClick={() => onReply(permissionId, 'once')}
      >
        {isMini ? '✓' : t('goalPermAllowShort')}
      </button>
      {!isMini && (
        <button
          type="button"
          className="goal-dock-approval-btn goal-dock-approval-btn--muted"
          aria-label={t('permAlwaysAllow')}
          title={t('permAlwaysAllowHint')}
          onClick={() => onReply(permissionId, 'always')}
        >
          {t('goalPermAlwaysShort')}
        </button>
      )}
      <button
        type="button"
        className="goal-dock-approval-btn goal-dock-approval-btn--deny"
        aria-label={t('permReject')}
        onClick={() => onReply(permissionId, 'reject')}
      >
        {isMini ? '×' : t('goalPermDenyShort')}
      </button>
    </div>
  )
}

interface Props {
  permissions: PermissionDecision[]
  onReply: (permissionId: string, reply: 'once' | 'always' | 'reject') => void
  /** mini = icon chips inside mini pill; strip = text row above composer */
  variant?: 'mini' | 'strip'
  showIndicator?: boolean
  onLabelClick?: () => void
  className?: string
}

export function GoalQuickApproval({
  permissions,
  onReply,
  variant = 'strip',
  showIndicator = false,
  onLabelClick,
  className = '',
}: Props) {
  const pending = listPendingGoalPermissions(permissions)
  if (pending.length === 0) return null

  const permission = pending[0]!
  const label = permission.patterns[0] ?? permission.reason
  const isMini = variant === 'mini'

  const labelNode = (
    <span className="goal-dock-approval-label truncate">
      {label}
    </span>
  )

  return (
    <div
      className={`goal-dock-approval ${isMini ? 'goal-dock-approval--mini' : 'goal-dock-approval--strip'} ${className}`}
    >
      {showIndicator && <AgentWorkingIndicator status="waiting_permission" />}
      {onLabelClick ? (
        <button type="button" className="goal-dock-approval-label-btn min-w-0 flex-1 truncate" onClick={onLabelClick}>
          {label}
        </button>
      ) : labelNode}
      <GoalQuickApprovalActions permissionId={permission.id} onReply={onReply} size={isMini ? 'mini' : 'strip'} />
    </div>
  )
}
