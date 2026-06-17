import { memo, useEffect, useMemo, useState } from 'react'
import { Skeleton } from '@heroui/react'
import { useLocale } from '../../../hooks/useLocale'
import type { AgentRun, AgentRunStep, AgentRuntimeMessage, AgentSession, ToolCallRecord } from '../../../lib/api/agentRuntime'
import { buildConversationTimeline } from './buildConversationTimeline'
import { TimelineEntryView } from './TimelineEntryView'

const INITIAL_BATCH = 24
const BATCH_SIZE = 20

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
}: Props) {
  const { t } = useLocale()
  const sessionId = session?.id ?? null
  const [visibleCount, setVisibleCount] = useState(INITIAL_BATCH)

  const timeline = useMemo(
    () => buildConversationTimeline(
      runs,
      steps,
      messages,
      toolCalls,
      childSessions,
      { excludeStepId, session },
    ),
    [runs, steps, messages, toolCalls, childSessions, excludeStepId, session],
  )

  useEffect(() => {
    setVisibleCount(INITIAL_BATCH)
  }, [sessionId])

  const hiddenCount = Math.max(0, timeline.length - visibleCount)
  const visibleTimeline = hiddenCount > 0 ? timeline.slice(-visibleCount) : timeline

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
      {hiddenCount > 0 ? (
        <button
          type="button"
          className="self-center rounded-full border border-border/40 px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/30"
          onClick={() => setVisibleCount(count => Math.min(timeline.length, count + BATCH_SIZE))}
        >
          显示更早的 {Math.min(hiddenCount, BATCH_SIZE)} 条消息
        </button>
      ) : null}
      {visibleTimeline.map(entry => (
        <TimelineEntryView
          key={`${entry.kind}-${entry.id}`}
          entry={entry}
          onExpandChild={onExpandChild}
        />
      ))}
    </div>
  )
})
