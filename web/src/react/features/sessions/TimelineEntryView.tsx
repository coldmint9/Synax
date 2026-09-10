import { memo } from 'react'
import type { ConversationTimelineEntry } from './buildConversationTimeline'
import { TurnBody } from './TurnBody'
import { UserMessageBlock } from './UserMessageBlock'
import { WorkLogEntry } from './WorkLogEntry'

/**
 * Body of a single transcript entry. The scroll anchor id / data attribute live
 * on the wrapping `TimelineLazyEntry`, which is always in the DOM, so this
 * component must not repeat them.
 */
export const TimelineEntryView = memo(function TimelineEntryView({
  entry,
  onExpandChild,
}: {
  entry: ConversationTimelineEntry
  onExpandChild?: (sessionId: string) => void
}) {
  if (entry.kind === 'user') {
    return <UserMessageBlock content={entry.content} />
  }

  if (entry.kind === 'work_log') {
    return <WorkLogEntry entry={entry} onExpandChild={onExpandChild} />
  }

  return <TurnBody turn={entry.turn} entryId={entry.id} onExpandChild={onExpandChild} />
})
