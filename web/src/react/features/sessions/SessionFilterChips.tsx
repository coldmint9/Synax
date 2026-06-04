import { Chip } from '@heroui/react'
import type { StatusFilter } from './useSessionList'

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
]

interface Props {
  value: StatusFilter
  onChange: (v: StatusFilter) => void
  countByStatus: Record<string, number>
  totalCount: number
}

export function SessionFilterChips({ value, onChange, countByStatus, totalCount }: Props) {
  if (totalCount === 0) return null

  return (
    <div className="flex gap-1 px-3 py-2 overflow-x-auto">
      {FILTERS.map(f => {
        const count = f.key === 'all' ? totalCount : (countByStatus[f.key] ?? 0)
        const active = value === f.key
        return (
          <Chip
            key={f.key}
            size="sm"
            variant={active ? 'solid' : 'flat'}
            color={active ? 'primary' : 'default'}
            className="cursor-pointer shrink-0 text-[10px] transition-colors"
            onClick={() => onChange(f.key)}
          >
            {f.label} <span className={active ? '' : 'text-muted-foreground/60'}>{count}</span>
          </Chip>
        )
      })}
    </div>
  )
}
