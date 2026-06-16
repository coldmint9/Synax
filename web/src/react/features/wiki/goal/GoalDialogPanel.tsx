import { Sparkles } from 'lucide-react'
import { useLocale } from '../../../../hooks/useLocale'
import { GoalToolRow } from './GoalToolRow'

interface ToolCall {
  tool: string
  summary: string
}

interface Props {
  statusLabel: string
  toolCalls: ToolCall[]
  phase: string | null
  error: string | null
  onOpenSession?: () => void
}

export function GoalDialogPanel({
  statusLabel,
  toolCalls,
  phase,
  error,
  onOpenSession,
}: Props) {
  const { t } = useLocale()
  const recent = toolCalls.slice(-12)
  const runningIndex = recent.length - 1

  return (
    <div className="goal-dock-dialog w-full rounded-2xl border border-border/50 bg-card/90 p-3.5 pb-3 shadow-lg backdrop-blur-xl">
      <div className="mb-2.5 flex items-center gap-1.5 text-[13px] font-medium text-foreground">
        <Sparkles size={12} className="text-primary" />
        {statusLabel}
        {phase && (
          <span className="text-[11px] font-normal text-muted-foreground/60">· {phase}</span>
        )}
      </div>

      {error && (
        <p className="mb-2 text-[11px] text-destructive/90">{error}</p>
      )}

      <div className="goal-dock-tool-list max-h-[8.75rem] overflow-y-auto">
        {recent.length === 0 ? (
          <p className="py-1 text-[11px] text-muted-foreground/50">{t('goalWorking')}</p>
        ) : (
          recent.map((tc, i) => (
            <GoalToolRow
              key={`${tc.tool}-${i}`}
              toolId={tc.tool}
              summary={tc.summary}
              running={i === runningIndex}
            />
          ))
        )}
      </div>

      {onOpenSession && (
        <button
          type="button"
          onClick={onOpenSession}
          className="mt-2.5 w-full text-center text-[11px] text-muted-foreground/45 transition-colors hover:text-muted-foreground/70"
        >
          {t('goalOpenFullSession')} →
        </button>
      )}
    </div>
  )
}
