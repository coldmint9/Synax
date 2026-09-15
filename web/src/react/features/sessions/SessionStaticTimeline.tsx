import { memo, useMemo, type RefObject } from 'react'
import { Skeleton } from '@heroui/react'
import { useLocale } from '../../../hooks/useLocale'
import type { AgentRun, AgentRunStep, AgentRuntimeMessage, AgentSession, ToolCallRecord } from '../../../lib/api/agentRuntime'
import { buildConversationTimeline } from './buildConversationTimeline'
import { TimelineEntryView } from './TimelineEntryView'
import { TimelineLazyEntry, estimateEntryHeight } from './TimelineLazyEntry'
import { groupActivityEntries } from './groupActivityEntries'
import { materializeLiveBlocks } from './streamingLiveBlocks'
import { useAgentSessionStore } from './agentSessionStore'
import type { ConversationTimelineEntry } from './buildConversationTimeline'
import { useShellStore } from '../../state/shellStore'

interface Props {
  unifiedLive?: boolean
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
  unifiedLive = false,
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

  const live = useAgentSessionStore(s => unifiedLive ? s.streamingLive : null)
  const snapshots = useAgentSessionStore(s => unifiedLive ? s.streamingCompletedSteps : null)
  const liveId = useAgentSessionStore(s => unifiedLive ? s.streamingStepId : null)
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

  const combined = useMemo(() => {
    const entries: ConversationTimelineEntry[] = [...timeline]
    const add = (id: string, blocks: import('./buildInterleavedTurns').TurnContentBlock[], index: number, status: string) => {
      entries.push({ id, kind: 'agent', createdAt: '', label: '', turn: { stepId: id, index, status, duration: null, blocks } })
    }
    for (const snapshot of snapshots ?? []) {
      if (!steps.some(step => step.id === snapshot.stepId)) add(snapshot.stepId, snapshot.blocks, snapshot.stepIndex, 'completed')
    }
    if (live && liveId && excludeStepId === liveId) add(liveId, materializeLiveBlocks(live), 0, 'running')
    return groupActivityEntries(entries)
  }, [timeline, snapshots, steps, live, liveId, excludeStepId])

  // Pair every entry with its height estimate once per timeline, instead of
  // re-deriving it on each render of the list.
  const rows = useMemo(
    () => combined.map(entry => ({
      entry,
      key: `${entry.kind}-${entry.id}`,
      estimate: estimateEntryHeight(entry),
    })),
    [combined],
  )

  if (combined.length === 0) {
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
          <TimelineEntryView isStreaming={entry.kind === 'agent' && entry.turn.status === 'running' && entry === combined[combined.length - 1]} entry={entry} onExpandChild={onExpandChild} />
        </TimelineLazyEntry>
      ))}
    </div>
  )
})
