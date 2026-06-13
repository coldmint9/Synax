import { Button, Tooltip } from '@heroui/react'
import { ShieldAlert, ShieldCheck, FileEdit, Zap, AlertTriangle } from 'lucide-react'
import { useLocale } from '../../../hooks/useLocale'
import type { PermissionDecision } from '../../../lib/api/agentRuntime'
import { iconBadgeClass, type IconTone } from '../../../lib/icon-tones'

interface PermissionApprovalBarProps {
  permissions: PermissionDecision[]
  onReply: (permissionId: string, reply: 'once' | 'always' | 'reject') => void
  isLoading?: boolean
}

export function PermissionApprovalBar({ permissions, onReply, isLoading }: PermissionApprovalBarProps) {
  const pending = permissions.filter(p => p.action === 'ask' && !p.resolvedAt)
  if (pending.length === 0) return null

  return (
    <div className="permission-approval-bar">
      {pending.map(perm => (
        <PermissionItem key={perm.id} permission={perm} onReply={onReply} isLoading={isLoading} />
      ))}
    </div>
  )
}

function PermissionItem({
  permission,
  onReply,
  isLoading,
}: {
  permission: PermissionDecision
  onReply: (id: string, reply: 'once' | 'always' | 'reject') => void
  isLoading?: boolean
}) {
  const { t } = useLocale()
  const CATEGORY_CONFIG: Record<string, { labelKey: 'permRead' | 'permWrite' | 'permExternalExecution' | 'permHighRisk'; tone: IconTone; icon: typeof ShieldAlert }> = {
    read: { labelKey: 'permRead', tone: 'success', icon: ShieldCheck },
    write: { labelKey: 'permWrite', tone: 'warning', icon: FileEdit },
    external_execution: { labelKey: 'permExternalExecution', tone: 'caution', icon: Zap },
    high_risk: { labelKey: 'permHighRisk', tone: 'danger', icon: AlertTriangle },
  }
  const config = CATEGORY_CONFIG[permission.coarseCategory] ?? CATEGORY_CONFIG.high_risk
  const Icon = config.icon

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-t border-border/40 bg-card/80 backdrop-blur-sm animate-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className={iconBadgeClass(config.tone, 'rounded-md px-1.5 py-0.5')} data-tone={config.tone}>
          <Icon size={11} />
          {t(config.labelKey)}
        </span>
        <span className="text-xs text-foreground truncate font-medium">
          {permission.patterns[0] ?? ''}
        </span>
        <span className="text-[11px] text-muted-foreground truncate">
          {permission.reason}
        </span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <Button
          size="sm"
          variant="primary"
          isDisabled={isLoading}
          onPress={() => onReply(permission.id, 'once')}
        >
          {t('permAllowOnce')}
        </Button>
        <Tooltip delay={0}>
          <Button
            size="sm"
            variant="ghost"
            isDisabled={isLoading}
            onPress={() => onReply(permission.id, 'always')}
          >
            {t('permAlwaysAllow')}
          </Button>
          <Tooltip.Content>{t('permAlwaysAllowHint')}</Tooltip.Content>
        </Tooltip>
        <Button
          size="sm"
          variant="danger-soft"
          isDisabled={isLoading}
          onPress={() => onReply(permission.id, 'reject')}
        >
          {t('permReject')}
        </Button>
      </div>
    </div>
  )
}
