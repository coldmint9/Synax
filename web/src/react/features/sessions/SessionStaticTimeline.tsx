import { memo, useMemo, type RefObject } from 'react'
import { Skeleton } from '@heroui/react'
import { useLocale } from '../../../hooks/useLocale'
import type { AgentRun, AgentRunStep, AgentRuntimeMessage, AgentSession, ToolCallRecord } from '../../../lib/api/agentRuntime'
import { buildConversationTimeline } from './buildConversationTimeline'
import { TimelineEntryView } from './TimelineEntryView'
import { TimelineLazyEntry, estimateEntryHeight } from './TimelineLazyEntry'
import { useShellStore } from '../../state/shellStore'

interface Props {
  session?: AgentSession
  runs: AgentRun[]
  steps: AgentRunStep[]
  messages: AgentRuntimeMessage[]
  toolCalls: ToolCallRecord[]
  childSessions?: AgentSession[]
  excludeStepId?: string | null
  isRunning?: boolean
  onExpandChild?: (sessionId: string) => void
  /** Scroll container used as the IntersectionObserver root for lazy entries. */
  scrollRootRef?: RefObject<HTMLElement | null>
}

export const SessionStaticTimeline = memo(function SessionStaticTimeline({
  session,
  runs,
  steps,
  messages,
  toolCalls,
  childSessions,
  excludeStepId = null,
  isRunning = false,
  onExpandChild,
  scrollRootRef,
}: Props) {
  const { t } = useLocale()
  const foldWorkRuns = useShellStore(s => s.preferences.sessionFoldWorkRuns)

  const timeline = useMemo(
    () => buildConversationTimeline(
      runs,
      steps,
      messages,
      toolCalls,
      childSessions,
      { excludeStepId, session, foldWorkRuns },
    ),
    [runs, steps, messages, toolCalls, childSessions, excludeStepId, session, foldWorkRuns],
  )

  // Pair every entry with its height estimate once per timeline, instead of
  // re-deriving it on each render of the list.
  const rows = useMemo(
    () => timeline.map(entry => ({
      entry,
      key: `${entry.kind}-${entry.id}`,
      estimate: estimateEntryHeight(entry),
    })),
    [timeline],
  )

  if (timeline.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-8">
        {isRunning ? (
          <>
            <Skeleton className="h-4 w-3/4 rounded-lg" />
            <Skeleton className="h-4 w-1/2 rounded-lg" />
            <Skeleton className="h-4 w-2/3 rounded-lg" />
          </>
        ) : (
          <span className="text-sm text-muted-foreground/50">{t('sessionNoRecords')}</span>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {rows.map(({ entry, key, estimate }) => (
        <TimelineLazyEntry
          key={key}
          entryId={entry.id}
          cacheKey={key}
          estimate={estimate}
          scrollRootRef={scrollRootRef}
        >
          <TimelineEntryView entry={entry} onExpandChild={onExpandChild} />
        </TimelineLazyEntry>
      ))}
    </div>
  )
})
