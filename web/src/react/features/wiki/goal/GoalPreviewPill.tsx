import { ChevronUp } from 'lucide-react'
import { AgentWorkingIndicator } from './AgentWorkingIndicator'
import type { GoalSessionStatus } from './goalSessionStream'
import type { GoalToolCall } from './goalSessionStream'

interface Props {
  status: GoalSessionStatus
  latestTool: GoalToolCall | undefined
  thinkingPreview: string
  sessionTitle: string
  onClick: () => void
}

function previewText(
  sessionTitle: string,
  latestTool: GoalToolCall | undefined,
  thinkingPreview: string,
): string {
  if (latestTool) {
    const suffix = latestTool.outputSummary ?? latestTool.summary
    return `${latestTool.tool} · ${suffix}`
  }
  const trimmedThinking = thinkingPreview.trim()
  if (trimmedThinking) return trimmedThinking.slice(-80)
  return sessionTitle.trim()
}

export function GoalPreviewPill({
  status,
  latestTool,
  thinkingPreview,
  sessionTitle,
  onClick,
}: Props) {
  const isRunning = status === 'running'
  const text = previewText(sessionTitle, latestTool, thinkingPreview)

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={sessionTitle}
      className={`goal-dock-preview-pill mb-1.5 flex w-[min(100%,20rem)] self-center items-center gap-2 rounded-full px-3 py-1.5 text-left text-[11px] transition-transform duration-150 active:scale-[0.98] ${
        isRunning
          ? 'text-foreground'
          : status === 'failed'
            ? 'goal-dock-preview-pill--failed text-destructive'
            : 'text-muted-foreground'
      }`}
    >
      <AgentWorkingIndicator status={status} />
      <span className="min-w-0 flex-1 truncate">
        {text}
      </span>
      <ChevronUp size={11} className="shrink-0 opacity-45" />
    </button>
  )
}
