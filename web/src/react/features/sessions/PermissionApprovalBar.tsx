import { Button, Tooltip } from '@heroui/react'
import { ShieldAlert, ShieldCheck, FileEdit, Zap, AlertTriangle } from 'lucide-react'
import type { PermissionDecision } from '../../../lib/api/agentRuntime'

interface PermissionApprovalBarProps {
  permissions: PermissionDecision[]
  onReply: (permissionId: string, reply: 'once' | 'always' | 'reject') => void
  isLoading?: boolean
}

const CATEGORY_CONFIG: Record<string, { label: string; color: string; icon: typeof ShieldAlert }> = {
  read: { label: '读取', color: 'bg-emerald-500/15 text-emerald-600', icon: ShieldCheck },
  write: { label: '写入', color: 'bg-amber-500/15 text-amber-600', icon: FileEdit },
  external_execution: { label: '外部执行', color: 'bg-orange-500/15 text-orange-600', icon: Zap },
  high_risk: { label: '高风险', color: 'bg-destructive/15 text-destructive', icon: AlertTriangle },
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
  const config = CATEGORY_CONFIG[permission.coarseCategory] ?? CATEGORY_CONFIG.high_risk
  const Icon = config.icon

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-t border-border/40 bg-card/80 backdrop-blur-sm animate-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${config.color}`}>
          <Icon size={11} />
          {config.label}
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
          variant="solid"
          color="primary"
          isDisabled={isLoading}
          onPress={() => onReply(permission.id, 'once')}
        >
          允许一次
        </Button>
        <Tooltip content="后续相同操作将自动通过">
          <Button
            size="sm"
            variant="ghost"
            isDisabled={isLoading}
            onPress={() => onReply(permission.id, 'always')}
          >
            始终允许
          </Button>
        </Tooltip>
        <Button
          size="sm"
          variant="ghost"
          color="danger"
          isDisabled={isLoading}
          onPress={() => onReply(permission.id, 'reject')}
        >
          拒绝
        </Button>
      </div>
    </div>
  )
}
