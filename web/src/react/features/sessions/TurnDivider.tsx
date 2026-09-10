import { memo } from 'react'
import { useLocale } from '../../../hooks/useLocale'

interface Props {
  status: string
  duration: string | null
}

type DividerKey = 'sessionTurnWorking' | 'sessionTurnWorked' | 'sessionTurnStopped'

function dividerKey(status: string): DividerKey {
  if (status === 'running' || status === 'waiting_permission') return 'sessionTurnWorking'
  if (status === 'cancelled' || status === 'interrupted') return 'sessionTurnStopped'
  return 'sessionTurnWorked'
}

/**
 * One hairline per turn separating agent activity from the answer, mirroring
 * Codex's `Worked for 12s` / `Stopped after 40s` turn divider. Turns the old
 * bare duration string into a label that also tells the reader *how* it ended.
 */
export const TurnDivider = memo(function TurnDivider({ status, duration }: Props) {
  const { t } = useLocale()
  if (!duration) return null

  return (
    <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground/45">
      <span className="shrink-0 tabular-nums">{t(dividerKey(status), { duration })}</span>
      <span className="h-px min-w-0 flex-1 bg-border/40" />
    </div>
  )
})
