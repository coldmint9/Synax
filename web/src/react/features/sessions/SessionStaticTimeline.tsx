import { memo, useMemo, type RefObject } from 'react'
import { Skeleton } from '@heroui/react'
import { useLocale } from '../../../hooks/useLocale'
import type {
  AgentRun,
  AgentRunStep,
  AgentRuntimeMessage,
  AgentSession,
  ToolCallRecord,
} from '../../../lib/api/agentRuntime'
import { buildConversationTimeline, type ConversationTimelineEntry } from './buildConversationTimeline'
import { TimelineEntryView } from './TimelineEntryView'
import { TimelineLazyEntry, estimateEntryHeight } from './TimelineLazyEntry'
import { groupActivityEntries } from './groupActivityEntries'
import { materializeLiveBlocks } from './streamingLiveBlocks'
import { useAgentSessionStore } from './agentSessionStore'
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
  scrollRootRef?: RefObject<HTMLElement | null>
}

type RowsProps = Pick<Props, 'onExpandChild' | 'scrollRootRef'> & {
  entries: ConversationTimelineEntry[]
  sessionId?: string
  streaming?: boolean
}

const TimelineRows = memo(function TimelineRows({
  entries,
  sessionId,
  streaming,
  onExpandChild,
  scrollRootRef,
}: RowsProps) {
  let latestActivityIndex = -1
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.kind === 'user') break
    if (entry.kind === 'agent' && entry.turn.blocks.some(block =>
      block.type === 'thinking' || block.type === 'tool_call' || block.type === 'tool_call_group')) {
      latestActivityIndex = index
      break
    }
  }
  return (
    <>
      {entries.map((entry, index) => {
        const key = `${sessionId ?? 'standalone'}:${entry.kind}-${entry.id}`
        return (
          <TimelineLazyEntry
            key={key}
            entryId={entry.id}
            cacheKey={key}
            estimate={estimateEntryHeight(entry)}
            scrollRootRef={scrollRootRef}
          >
            <TimelineEntryView
              entry={entry}
              onExpandChild={onExpandChild}
              isWorking={Boolean(streaming && index === latestActivityIndex)}
              isStreaming={Boolean(
                streaming &&
                entry.kind === 'agent' &&
                entry.turn.status === 'running' &&
                index === entries.length - 1,
              )}
            />
          </TimelineLazyEntry>
        )
      })}
    </>
  )
})

/** Only the unfinished activity group subscribes to token deltas. */
function LiveTimelineTail({ entries, ...props }: RowsProps) {
  const live = useAgentSessionStore((s) => s.streamingLive)
  const liveId = useAgentSessionStore((s) => s.streamingStepId)
  const combined = useMemo(
    () =>
      groupActivityEntries(
        liveId
          ? [
              ...entries,
              {
                id: liveId,
                kind: 'agent',
                createdAt: '',
                label: '',
                turn: {
                  stepId: liveId,
                  index: 0,
                  status: 'running',
                  duration: null,
                  blocks: materializeLiveBlocks(live),
                },
              } as ConversationTimelineEntry,
            ]
          : entries,
      ),
    [entries, live, liveId],
  )
  return <TimelineRows {...props} entries={combined} />
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
  const foldWorkRuns = useShellStore((s) => s.preferences.sessionFoldWorkRuns)
  const snapshots = useAgentSessionStore((s) => (unifiedLive ? s.streamingCompletedSteps : null))
  const liveId = useAgentSessionStore((s) => (unifiedLive ? s.streamingStepId : null))
  const showLive = Boolean(liveId && excludeStepId === liveId)
  const timeline = useMemo(() => {
    const entries = buildConversationTimeline(runs, steps, messages, toolCalls, childSessions, {
      excludeStepId,
      session,
      foldWorkRuns,
    })
    const stepIds = new Set(steps.map((step) => step.id))
    for (const snapshot of snapshots ?? []) {
      if (!stepIds.has(snapshot.stepId))
        entries.push({
          id: snapshot.stepId,
          kind: 'agent',
          createdAt: '',
          label: '',
          turn: {
            stepId: snapshot.stepId,
            index: snapshot.stepIndex,
            status: 'completed',
            duration: null,
            blocks: snapshot.blocks,
          },
        })
    }
    return entries
  }, [runs, steps, messages, toolCalls, childSessions, excludeStepId, session, foldWorkRuns, snapshots])
  const { history, tail } = useMemo(() => {
    let boundary = timeline.length
    if (showLive) while (boundary > 0 && timeline[boundary - 1].kind === 'agent') boundary--
    return { history: groupActivityEntries(timeline.slice(0, boundary)), tail: timeline.slice(boundary) }
  }, [timeline, showLive])

  if (timeline.length === 0 && !showLive)
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
  return (
    <div className="flex flex-col gap-5">
      <TimelineRows
        entries={history}
        streaming={isRunning && !showLive}
        sessionId={session?.id}
        onExpandChild={onExpandChild}
        scrollRootRef={scrollRootRef}
      />
      {showLive && (
        <LiveTimelineTail
          entries={tail}
          streaming={isRunning}
          sessionId={session?.id}
          onExpandChild={onExpandChild}
          scrollRootRef={scrollRootRef}
        />
      )}
    </div>
  )
})
