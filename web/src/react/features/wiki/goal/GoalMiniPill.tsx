import { useEffect, useMemo, useState } from 'react'
import { GoalAsciiMood } from './GoalAsciiMood'
import type { GoalSessionStatus, GoalToolCall } from './goalSessionStream'

interface Props {
  status: GoalSessionStatus
  toolCalls: GoalToolCall[]
  thinking: string
  statusLabel: string
  hovered?: boolean
  onClick: () => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}

function buildCarouselItems(
  status: GoalSessionStatus,
  toolCalls: GoalToolCall[],
  thinking: string,
  statusLabel: string,
): string[] {
  const items: string[] = []
  if (status === 'running' || status === 'waiting_permission') items.push(statusLabel)
  const tail = thinking.trim()
  if (tail) items.push(tail.slice(-100))
  for (const call of toolCalls.slice(-4)) {
    items.push(`${call.tool} · ${call.outputSummary ?? call.summary}`)
  }
  if (status === 'completed') items.push(statusLabel)
  if (status === 'failed') items.push(statusLabel)
  if (items.length === 0) items.push(statusLabel)
  return items
}

export function GoalMiniPill({
  status,
  toolCalls,
  thinking,
  statusLabel,
  hovered = false,
  onClick,
  onMouseEnter,
  onMouseLeave,
}: Props) {
  const items = useMemo(
    () => buildCarouselItems(status, toolCalls, thinking, statusLabel),
    [status, toolCalls, thinking, statusLabel],
  )
  const [index, setIndex] = useState(0)

  useEffect(() => {
    setIndex(0)
  }, [items])

  useEffect(() => {
    if (items.length <= 1) return
    const timer = window.setInterval(() => {
      setIndex(i => (i + 1) % items.length)
    }, 2800)
    return () => window.clearInterval(timer)
  }, [items])

  const isRunning = status === 'running'
  const isWaiting = status === 'waiting_permission'
  const text = items[index] ?? statusLabel

  return (
    <button
      type="button"
      className={`goal-dock-mini-inner flex h-full w-full items-center gap-2 px-3 text-[11px] transition-all duration-150 ${
        hovered ? 'goal-dock-mini-inner--hover' : ''
      }`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      aria-label={statusLabel}
    >
      <GoalAsciiMood />
      <span className="relative min-h-[1.25rem] min-w-0 flex-1 overflow-hidden text-muted-foreground">
        <span
          key={index}
          className="goal-dock-mini-carousel-item absolute inset-0 flex items-center truncate"
        >
          {isRunning && (
            <span className="mr-1.5 inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
          )}
          {isWaiting && (
            <span className="mr-1.5 inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
          )}
          <span className={`truncate ${isRunning || isWaiting ? 'text-foreground' : ''}`}>
            {text}
          </span>
        </span>
      </span>
      <span className={`shrink-0 text-[9px] transition-transform duration-150 ${hovered ? 'text-muted-foreground/70' : 'text-muted-foreground/40'}`}>
        ▲
      </span>
    </button>
  )
}
