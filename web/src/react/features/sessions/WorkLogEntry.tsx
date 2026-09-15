import { memo } from 'react'
import { useLocale } from '../../../hooks/useLocale'
import type { ConversationTimelineEntry } from './buildConversationTimeline'
import { ActivityRow } from './ActivityRow'
import { TurnBody } from './TurnBody'
import { activityPreview, formatCharCount, formatDurationMs } from './activityText'

type WorkLogEntryData = Extract<ConversationTimelineEntry, { kind: 'work_log' }>

interface Props {
  entry: WorkLogEntryData
  onExpandChild?: (sessionId: string) => void
}

function firstThinking(entry: WorkLogEntryData): string | null {
  for (const turn of entry.turns) {
    for (const block of turn.blocks) {
      if (block.type === 'thinking' && block.content.trim()) return block.content
    }
  }
  return null
}

function workDuration(elapsedMs: number): string {
  const minutes = elapsedMs / 60_000
  if (minutes >= 1) return `${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)} 分钟`
  return `${Math.max(1, Math.round(elapsedMs / 1_000))} 秒`
}

/** Completed activity from one round, collapsed into a compact expandable row. */
export const WorkLogEntry = memo(function WorkLogEntry({ entry, onExpandChild }: Props) {
  const { t } = useLocale()
  const { stepCount, toolCallCount, thinkingChars, elapsedMs } = entry.stats
  const preview = firstThinking(entry)
  const meta = [
    `${stepCount} 步`,
    `${toolCallCount} 次调用`,
    thinkingChars > 0 ? t('sessionActivityChars', { count: formatCharCount(thinkingChars) }) : null,
  ].filter(Boolean).join(' · ')

  return (
    <ActivityRow
      label={`工作用时 ${workDuration(elapsedMs)}`}
      meta={meta}
      preview={preview ? activityPreview(preview) : null}
      bodyContent={(
        <div className="flex flex-col gap-2 py-1">
          {entry.turns.map(turn => (
            <TurnBody
              key={turn.stepId}
              turn={turn}
              entryId={turn.stepId}
              onExpandChild={onExpandChild}
            />
          ))}
        </div>
      )}
      bodyMaxHeight={420}
      rememberKey={entry.id}
    />
  )
})

export type { WorkLogEntryData }
