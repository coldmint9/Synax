import { Shield } from 'lucide-react'
import type { GoalPermissionTier } from './goalAttachTypes'

const ORDER: GoalPermissionTier[] = ['readonly', 'readwrite', 'unrestricted']

interface Props {
  value: GoalPermissionTier
  onChange: (value: GoalPermissionTier) => void
  disabled?: boolean
}

/** Inline permission control: one click cycles readonly -> readwrite -> unrestricted. */
export function GoalPermissionCycle({ value, onChange, disabled }: Props) {
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
      className="goal-permission-cycle goal-dock-composer-chip inline-flex h-7 max-w-[7.5rem] shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] font-normal"
    >
      <Shield size={12} className="shrink-0" />
      <span className="truncate">{currentLabel}</span>
    </button>
  )
}
