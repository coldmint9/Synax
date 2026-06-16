import { ChevronUp } from 'lucide-react'
import { GoalAsciiMood } from './GoalAsciiMood'
import type { GoalSessionStatus } from './goalSessionStream'
import type { GoalToolCall } from './goalSessionStream'

interface Props {
  status: GoalSessionStatus
  latestTool: GoalToolCall | undefined
  thinkingPreview: string
  statusLabel: string
  onClick: () => void
}

function previewText(
  status: GoalSessionStatus,
  latestTool: GoalToolCall | undefined,
  thinkingPreview: string,
  statusLabel: string,
): string {
  if (latestTool) {
    const suffix = latestTool.outputSummary ?? latestTool.summary
    return `${latestTool.tool} · ${suffix}`
  }
  const trimmedThinking = thinkingPreview.trim()
  if (trimmedThinking) return trimmedThinking.slice(-80)
  if (status === 'completed') return statusLabel
  if (status === 'failed') return statusLabel
  return statusLabel
}

export function GoalPreviewPill({
  status,
  latestTool,
  thinkingPreview,
  statusLabel,
  onClick,
}: Props) {
  const isRunning = status === 'running'
  const text = previewText(status, latestTool, thinkingPreview, statusLabel)

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={statusLabel}
      className={`goal-dock-preview-pill mb-1.5 flex w-[min(100%,20rem)] items-center gap-2 rounded-full border border-white/60 bg-white/45 px-3 py-1.5 text-left text-[11px] shadow-sm backdrop-blur-md transition-transform duration-150 active:scale-[0.98] dark:border-white/15 dark:bg-card/55 ${
        isRunning
          ? 'text-foreground'
          : status === 'failed'
            ? 'border-destructive/25 bg-destructive/5 text-destructive dark:border-destructive/30'
            : 'text-muted-foreground'
      }`}
    >
      <GoalAsciiMood />
      <span className="min-w-0 flex-1 truncate">
        {isRunning && <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary align-middle" />}
        {text}
      </span>
      <ChevronUp size={11} className="shrink-0 opacity-45" />
    </button>
  )
}
