import { memo } from 'react'
import { ListChecks } from 'lucide-react'
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

/**
 * A run of activity-only turns collapsed into one row, the way Codex collapses
 * a long think/tool stretch behind a single line and a `Worked for` divider.
 * The folded turns mount only when the reader opens the row.
 */
export const WorkLogEntry = memo(function WorkLogEntry({ entry, onExpandChild }: Props) {
  const { t } = useLocale()
  const { stepCount, toolCallCount, thinkingChars, elapsedMs } = entry.stats
  const duration = formatDurationMs(elapsedMs)
  const preview = firstThinking(entry)

  const meta = [
    t('sessionWorkLogSteps', { count: stepCount }),
    t('sessionWorkLogCalls', { count: toolCallCount }),
    thinkingChars > 0 ? t('sessionActivityChars', { count: formatCharCount(thinkingChars) }) : null,
    duration ? t('sessionTurnWorked', { duration }) : null,
  ].filter(Boolean).join(' · ')

  return (
    <ActivityRow
      icon={<ListChecks size={13} aria-hidden="true" />}
      label={t('sessionWorkLog')}
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
