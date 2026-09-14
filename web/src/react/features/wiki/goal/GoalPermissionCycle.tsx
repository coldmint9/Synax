import { useLocale } from '../../../../hooks/useLocale'
import { Shield } from 'lucide-react'
import type { GoalPermissionTier } from './goalAttachTypes'

const ORDER: GoalPermissionTier[] = ['readonly', 'readwrite', 'unrestricted']

interface Props {
  value: GoalPermissionTier
  onChange: (value: GoalPermissionTier) => void
  disabled?: boolean
  backendId?: string
}

/** Inline permission control: one click cycles readonly -> readwrite -> unrestricted. */
export function GoalPermissionCycle({ value, onChange, disabled, backendId }: Props) {
  const { locale } = useLocale()
  if (backendId === 'codex' || backendId === 'claude-code') {
    const label = locale === 'zh' ? 'CLI 原生审批' : 'Native CLI approvals'
    return <span role="note" aria-label={label} data-native-policy="true"
      title={locale === 'zh' ? '由 CLI 沙箱及原生审批控制，不使用 Synax 权限档位。' : 'Controlled by the CLI sandbox and native approval prompts, not Synax permission tiers.'}
      className="goal-permission-cycle goal-dock-composer-chip inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] font-normal">
      <Shield size={12} aria-hidden /><span>{label}</span>
    </span>
  }
  const labelMap: Record<GoalPermissionTier, string> = {
    readonly: '只读',
    readwrite: '读写',
    unrestricted: '无限制',
  }
  const currentLabel = labelMap[value]
  const index = ORDER.indexOf(value)
  const next = ORDER[(index + 1) % ORDER.length]

  return (
    <button
      type="button"
      aria-label={`${currentLabel}，点击切换为${labelMap[next]}`}
      title={`${currentLabel} · 点击切换为${labelMap[next]}`}
      disabled={disabled}
      onClick={() => onChange(next)}
      data-tier={value}
      className="goal-permission-cycle goal-dock-composer-chip inline-flex h-7 max-w-[7.5rem] shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] font-normal"
    >
      <Shield size={12} className="goal-permission-cycle-icon shrink-0" />
      {/* Keyed so the swap replays the roll animation on every tier change. */}
      <span key={value} className="goal-permission-cycle-label truncate">{currentLabel}</span>
    </button>
  )
}
